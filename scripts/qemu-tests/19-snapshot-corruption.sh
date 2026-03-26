#!/usr/bin/env bash
# 19-snapshot-corruption.sh — Reproduce snapshot corruption scenarios
# Tests the most likely corruption vectors:
#   1. Kill during hibernate (async archive race)
#   2. Heavy I/O during checkpoint (guest sync insufficiency)
#   3. Rapid hibernate/wake cycles (state machine race)
#   4. Fork under load (concurrent qcow2 access)
#   5. Checkpoint + autosave collision
set +u
source "$(dirname "$0")/common.sh"

TIMEOUT=120
SANDBOXES=()
cleanup() {
    set +u
    for sb in "${SANDBOXES[@]}"; do destroy_sandbox "$sb" 2>/dev/null; done
    set -u
}
trap cleanup EXIT

# ── Test 1: Kill shortly after hibernate ──────────────────────────────
# Reproduces: async archive race — Kill arrives before tar finishes
h "Kill During Hibernate (archive race)"

SB=$(create_sandbox)
SANDBOXES+=("$SB")

# Write a large file to make the archive take longer
exec_run "$SB" "bash" "-c" "dd if=/dev/urandom of=/workspace/large.bin bs=1M count=200 2>/dev/null" >/dev/null
HASH_BEFORE=$(exec_stdout "$SB" "bash" "-c" "sha256sum /workspace/large.bin | cut -d' ' -f1")
pass "Wrote 200MB, hash: ${HASH_BEFORE:0:16}..."

# Hibernate — returns immediately, archive runs async
api -X POST "$API_URL/api/sandboxes/$SB/hibernate" >/dev/null

# Kill immediately — should race with the archive
sleep 0.5
KILL_RESULT=$(api -X DELETE "$API_URL/api/sandboxes/$SB")
pass "Kill sent 500ms after hibernate"

# Try to wake — if archive was corrupted, wake will fail or data will be wrong
sleep 5
WAKE_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB/wake" -d '{"timeout":3600}')
if echo "$WAKE_RESULT" | grep -q '"running"'; then
    HASH_AFTER=$(exec_stdout "$SB" "bash" "-c" "sha256sum /workspace/large.bin | cut -d' ' -f1")
    if [ "$HASH_BEFORE" = "$HASH_AFTER" ]; then
        pass "Wake succeeded, 200MB file intact after kill-during-hibernate"
    else
        fail "CORRUPTION: hash mismatch after kill-during-hibernate: $HASH_BEFORE vs $HASH_AFTER"
    fi
    destroy_sandbox "$SB"
else
    # Wake failed — could be because kill won, or archive was corrupted
    if echo "$WAKE_RESULT" | grep -qi 'not found\|stopped\|gone'; then
        pass "Kill won the race (sandbox destroyed before archive completed) — no corruption possible"
    else
        fail "Wake failed unexpectedly: $WAKE_RESULT"
    fi
fi

# ── Test 2: Checkpoint during heavy I/O ──────────────────────────────
# Reproduces: guest sync not completing before savevm
h "Checkpoint During Heavy I/O"

SB2=$(create_sandbox)
SANDBOXES+=("$SB2")

# Start continuous I/O in background
exec_run "$SB2" "bash" "-c" "setsid bash -c 'while true; do dd if=/dev/urandom of=/workspace/churn.bin bs=1M count=50 conv=notrunc 2>/dev/null; sync; done' </dev/null >/dev/null 2>&1 &" >/dev/null
pass "Background I/O started (50MB writes in loop)"

# Write a known marker file
exec_run "$SB2" "bash" "-c" "echo checkpoint-marker-42 > /workspace/marker.txt && sync" >/dev/null
sleep 1

# Create checkpoint while I/O is happening
CP_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB2/checkpoints" -d '{"name":"io-stress-test"}')
CP_ID=$(echo "$CP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$CP_ID" ] && [ "$CP_ID" != "None" ] && pass "Checkpoint during I/O: $CP_ID" || { fail "Checkpoint failed: $CP_RESULT"; }

# Wait for checkpoint to process
sleep 5

# Fork from checkpoint — verify marker file
FORK_RESULT=$(api -X POST "$API_URL/api/sandboxes/from-checkpoint/$CP_ID" -d '{"timeout":3600}')
FORK_ID=$(echo "$FORK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)
if [ -n "$FORK_ID" ] && [ "$FORK_ID" != "None" ]; then
    SANDBOXES+=("$FORK_ID")
    sleep 8
    MARKER=$(exec_stdout "$FORK_ID" "cat" "/workspace/marker.txt")
    if [ "$MARKER" = "checkpoint-marker-42" ]; then
        pass "Fork has correct marker file — checkpoint captured consistent state"
    else
        fail "CORRUPTION: marker file wrong in fork: '$MARKER' (expected 'checkpoint-marker-42')"
    fi
else
    fail "Fork from I/O-stress checkpoint failed: $FORK_RESULT"
fi

# ── Test 3: Rapid hibernate/wake cycles ──────────────────────────────
# Reproduces: state machine race, stale agent connections
h "Rapid Hibernate/Wake Cycles (5x)"

SB3=$(create_sandbox)
SANDBOXES+=("$SB3")

exec_run "$SB3" "bash" "-c" "echo cycle-test > /workspace/cycle.txt" >/dev/null

CYCLE_OK=0
CYCLE_FAIL=0
for i in $(seq 1 5); do
    # Hibernate
    H_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB3/hibernate")
    if ! echo "$H_RESULT" | grep -q '"hibernated"'; then
        CYCLE_FAIL=$((CYCLE_FAIL+1))
        fail "Cycle $i: hibernate failed: $H_RESULT"
        continue
    fi

    # Wake immediately
    W_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB3/wake" -d '{"timeout":3600}')
    if ! echo "$W_RESULT" | grep -q '"running"'; then
        CYCLE_FAIL=$((CYCLE_FAIL+1))
        fail "Cycle $i: wake failed: $W_RESULT"
        continue
    fi

    # Verify data
    OUT=$(exec_stdout "$SB3" "cat" "/workspace/cycle.txt")
    if [ "$OUT" = "cycle-test" ]; then
        CYCLE_OK=$((CYCLE_OK+1))
    else
        CYCLE_FAIL=$((CYCLE_FAIL+1))
        fail "CORRUPTION: cycle $i data wrong: '$OUT'"
    fi
done
[ "$CYCLE_FAIL" -eq 0 ] && pass "All 5 hibernate/wake cycles preserved data" || fail "$CYCLE_FAIL/5 cycles had issues"

# ── Test 4: Multiple forks from same checkpoint under load ───────────
# Reproduces: concurrent qcow2 reflink races
h "Concurrent Forks From Same Checkpoint"

SB4=$(create_sandbox)
SANDBOXES+=("$SB4")

exec_run "$SB4" "bash" "-c" "echo fork-source > /workspace/source.txt && python3 -c 'print(1+1)'" >/dev/null
CP2_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB4/checkpoints" -d '{"name":"fork-stress"}')
CP2_ID=$(echo "$CP2_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$CP2_ID" ] && pass "Checkpoint for fork stress: $CP2_ID" || { fail "Checkpoint failed"; summary; }

sleep 5

# Fire 5 forks simultaneously
TMPDIR=$(mktemp -d)
PIDS=()
for i in $(seq 1 5); do
    (
        RESULT=$(api -X POST "$API_URL/api/sandboxes/from-checkpoint/$CP2_ID" -d '{"timeout":300}')
        FORK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID','FAIL'))" 2>/dev/null)
        echo "$FORK" > "$TMPDIR/fork-$i"
    ) &
    PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

# Verify each fork
FORK_OK=0
FORK_FAIL=0
for i in $(seq 1 5); do
    FORK_ID=$(cat "$TMPDIR/fork-$i" 2>/dev/null)
    if [ -n "$FORK_ID" ] && [ "$FORK_ID" != "FAIL" ]; then
        SANDBOXES+=("$FORK_ID")
        sleep 3
        OUT=$(exec_stdout "$FORK_ID" "cat" "/workspace/source.txt")
        if [ "$OUT" = "fork-source" ]; then
            FORK_OK=$((FORK_OK+1))
        else
            FORK_FAIL=$((FORK_FAIL+1))
            fail "CORRUPTION: fork $i has wrong data: '$OUT'"
        fi
    else
        FORK_FAIL=$((FORK_FAIL+1))
        fail "Fork $i creation failed"
    fi
done
rm -rf "$TMPDIR"
[ "$FORK_FAIL" -eq 0 ] && pass "All 5 concurrent forks have correct data" || fail "$FORK_FAIL/5 forks corrupted"

# ── Test 5: Checkpoint + immediate exec (autosave collision sim) ─────
# Reproduces: concurrent agent operations during savevm
h "Exec During Checkpoint (autosave collision)"

SB5=$(create_sandbox)
SANDBOXES+=("$SB5")

exec_run "$SB5" "bash" "-c" "echo pre-checkpoint > /workspace/state.txt && sync" >/dev/null

# Fire checkpoint and exec simultaneously
(
    CP3_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB5/checkpoints" -d '{"name":"exec-collision"}')
    echo "$CP3_RESULT" > /tmp/cp3-result.json
) &
CP3_PID=$!

# Immediately fire exec commands while checkpoint is processing
for j in $(seq 1 5); do
    exec_run "$SB5" "bash" "-c" "echo writing-during-checkpoint-$j >> /workspace/during.txt" >/dev/null 2>&1 &
done
wait $CP3_PID 2>/dev/null

CP3_ID=$(cat /tmp/cp3-result.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$CP3_ID" ] && [ "$CP3_ID" != "None" ]; then
    pass "Checkpoint created during concurrent execs: $CP3_ID"

    sleep 5
    # Fork and verify pre-checkpoint state is correct
    FORK5_RESULT=$(api -X POST "$API_URL/api/sandboxes/from-checkpoint/$CP3_ID" -d '{"timeout":300}')
    FORK5_ID=$(echo "$FORK5_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)
    if [ -n "$FORK5_ID" ] && [ "$FORK5_ID" != "None" ]; then
        SANDBOXES+=("$FORK5_ID")
        sleep 8
        STATE=$(exec_stdout "$FORK5_ID" "cat" "/workspace/state.txt")
        if [ "$STATE" = "pre-checkpoint" ]; then
            pass "Fork has correct pre-checkpoint state despite concurrent execs"
        else
            fail "CORRUPTION: fork state wrong: '$STATE'"
        fi
    else
        fail "Fork from exec-collision checkpoint failed: $FORK5_RESULT"
    fi
else
    fail "Checkpoint during concurrent execs failed: $(cat /tmp/cp3-result.json)"
fi
rm -f /tmp/cp3-result.json

# ── Test 6: Hibernate with large dirty pages ─────────────────────────
# Reproduces: sync returning before flush completes
h "Hibernate With Dirty Pages"

SB6=$(create_sandbox)
SANDBOXES+=("$SB6")

# Write 100MB, then immediately hibernate without waiting for sync
exec_run "$SB6" "bash" "-c" "dd if=/dev/urandom of=/workspace/dirty.bin bs=1M count=100 2>/dev/null" >/dev/null
DIRTY_HASH=$(exec_stdout "$SB6" "bash" "-c" "sha256sum /workspace/dirty.bin | cut -d' ' -f1")
pass "Wrote 100MB dirty data, hash: ${DIRTY_HASH:0:16}..."

# Hibernate immediately — guest may still have dirty pages
RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB6/hibernate")
echo "$RESULT" | grep -q '"hibernated"' && pass "Hibernated with dirty pages" || fail "Hibernate: $RESULT"

# Wake and verify
RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB6/wake" -d '{"timeout":3600}')
echo "$RESULT" | grep -q '"running"' && pass "Woke" || { fail "Wake: $RESULT"; summary; }

DIRTY_HASH_AFTER=$(exec_stdout "$SB6" "bash" "-c" "sha256sum /workspace/dirty.bin | cut -d' ' -f1")
if [ "$DIRTY_HASH" = "$DIRTY_HASH_AFTER" ]; then
    pass "100MB file intact after hibernate with dirty pages"
else
    fail "CORRUPTION: dirty page hash mismatch: $DIRTY_HASH vs $DIRTY_HASH_AFTER"
fi

summary
