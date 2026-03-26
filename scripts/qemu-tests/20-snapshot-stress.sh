#!/usr/bin/env bash
# 20-snapshot-stress.sh — Stress test for snapshot corruption
# Runs corruption-prone operations in tight loops to maximize race window exposure.
# Each iteration creates a sandbox, writes data, and tests one corruption vector.
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

ITERATIONS="${1:-10}"

# ── Stress 1: Kill-during-hibernate loop ─────────────────────────────
h "Kill-During-Hibernate Stress ($ITERATIONS iterations)"

RACE_WINS=0
RACE_CLEAN=0
RACE_CORRUPT=0
for i in $(seq 1 "$ITERATIONS"); do
    SB=$(create_sandbox)
    SANDBOXES+=("$SB")

    # Write data + get hash
    exec_run "$SB" "bash" "-c" "dd if=/dev/urandom of=/workspace/test.bin bs=1M count=50 2>/dev/null && sync" >/dev/null
    HASH=$(exec_stdout "$SB" "bash" "-c" "sha256sum /workspace/test.bin | cut -d' ' -f1")

    # Hibernate then kill with varying delays (0ms, 100ms, 200ms, etc)
    api -X POST "$API_URL/api/sandboxes/$SB/hibernate" >/dev/null
    DELAY=$(( (i % 5) * 100 ))
    [ "$DELAY" -gt 0 ] && sleep "0.${DELAY}"
    api -X DELETE "$API_URL/api/sandboxes/$SB" >/dev/null

    # Try to wake
    sleep 3
    WAKE=$(api -X POST "$API_URL/api/sandboxes/$SB/wake" -d '{"timeout":300}')
    if echo "$WAKE" | grep -q '"running"'; then
        HASH_AFTER=$(exec_stdout "$SB" "bash" "-c" "sha256sum /workspace/test.bin | cut -d' ' -f1")
        if [ "$HASH" = "$HASH_AFTER" ]; then
            RACE_CLEAN=$((RACE_CLEAN+1))
        else
            RACE_CORRUPT=$((RACE_CORRUPT+1))
            fail "  Iteration $i: CORRUPTION — hash mismatch (delay=${DELAY}ms)"
        fi
        destroy_sandbox "$SB"
    else
        RACE_WINS=$((RACE_WINS+1))
    fi
done
printf '  Kill won: %d | Clean wake: %d | Corrupt: %d\n' "$RACE_WINS" "$RACE_CLEAN" "$RACE_CORRUPT"
[ "$RACE_CORRUPT" -eq 0 ] && pass "No corruption in $ITERATIONS kill-during-hibernate iterations" || fail "$RACE_CORRUPT/$ITERATIONS iterations had corruption"

# ── Stress 2: Rapid checkpoint + fork loop ───────────────────────────
h "Rapid Checkpoint+Fork Stress ($ITERATIONS iterations)"

SB_BASE=$(create_sandbox)
SANDBOXES+=("$SB_BASE")

FORK_OK=0
FORK_FAIL=0
for i in $(seq 1 "$ITERATIONS"); do
    # Write unique marker
    MARKER="marker-$i-$RANDOM"
    exec_run "$SB_BASE" "bash" "-c" "echo $MARKER > /workspace/marker.txt && sync && sync" >/dev/null
    sleep 1

    # Checkpoint
    CP_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB_BASE/checkpoints" -d "{\"name\":\"stress-$i-$RANDOM\"}")
    CP_ID=$(echo "$CP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    [ -z "$CP_ID" ] || [ "$CP_ID" = "None" ] && { fail "  Checkpoint $i failed"; continue; }

    sleep 5

    # Fork and verify
    FORK_RESULT=$(api -X POST "$API_URL/api/sandboxes/from-checkpoint/$CP_ID" -d '{"timeout":120}')
    FORK_ID=$(echo "$FORK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)
    if [ -n "$FORK_ID" ] && [ "$FORK_ID" != "None" ]; then
        SANDBOXES+=("$FORK_ID")
        sleep 5
        GOT=$(exec_stdout "$FORK_ID" "cat" "/workspace/marker.txt")
        if [ "$GOT" = "$MARKER" ]; then
            FORK_OK=$((FORK_OK+1))
        else
            FORK_FAIL=$((FORK_FAIL+1))
            fail "  Iteration $i: CORRUPTION — expected '$MARKER' got '$GOT'"
        fi
        destroy_sandbox "$FORK_ID"
    else
        FORK_FAIL=$((FORK_FAIL+1))
        fail "  Fork $i failed: $FORK_RESULT"
    fi
done
[ "$FORK_FAIL" -eq 0 ] && pass "All $FORK_OK/$ITERATIONS checkpoint+fork iterations clean" || fail "$FORK_FAIL/$ITERATIONS had issues"

# ── Stress 3: Hibernate/wake rapid cycles ────────────────────────────
h "Hibernate/Wake Rapid Cycles ($ITERATIONS iterations)"

SB_CYCLE=$(create_sandbox)
SANDBOXES+=("$SB_CYCLE")

exec_run "$SB_CYCLE" "bash" "-c" "dd if=/dev/urandom of=/workspace/persist.bin bs=1M count=20 2>/dev/null && sync" >/dev/null
PERSIST_HASH=$(exec_stdout "$SB_CYCLE" "bash" "-c" "sha256sum /workspace/persist.bin | cut -d' ' -f1")

CYCLE_OK=0
CYCLE_FAIL=0
for i in $(seq 1 "$ITERATIONS"); do
    H=$(api -X POST "$API_URL/api/sandboxes/$SB_CYCLE/hibernate")
    if ! echo "$H" | grep -q '"hibernated"'; then
        CYCLE_FAIL=$((CYCLE_FAIL+1))
        fail "  Cycle $i: hibernate failed"
        # Try to recover
        sleep 2
        continue
    fi

    W=$(api -X POST "$API_URL/api/sandboxes/$SB_CYCLE/wake" -d '{"timeout":3600}')
    if ! echo "$W" | grep -q '"running"'; then
        CYCLE_FAIL=$((CYCLE_FAIL+1))
        fail "  Cycle $i: wake failed: $W"
        sleep 2
        continue
    fi

    GOT_HASH=$(exec_stdout "$SB_CYCLE" "bash" "-c" "sha256sum /workspace/persist.bin | cut -d' ' -f1")
    if [ "$PERSIST_HASH" = "$GOT_HASH" ]; then
        CYCLE_OK=$((CYCLE_OK+1))
    else
        CYCLE_FAIL=$((CYCLE_FAIL+1))
        fail "  CORRUPTION: cycle $i hash mismatch"
    fi
done
[ "$CYCLE_FAIL" -eq 0 ] && pass "All $CYCLE_OK/$ITERATIONS hibernate/wake cycles clean" || fail "$CYCLE_FAIL/$ITERATIONS cycles had issues"

summary
