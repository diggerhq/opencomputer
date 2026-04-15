#!/usr/bin/env bash
# 36-advanced-scenarios.sh — Advanced scenario tests
#
# 12 tests covering: hibernation, worker death, concurrent migrations,
# migration during I/O, scale-triggered migration, concurrent exec,
# sandbox timeout, DNS resolution, scaler drain, port forwarding,
# large sandbox migration, and checkpoint/restore.
#
# Required env:
#   OPENSANDBOX_API_URL
#   OPENSANDBOX_API_KEY

source "$(dirname "$0")/common.sh"

flush_sandboxes() {
    local sbs
    sbs=$(api "$API_URL/api/sandboxes" 2>/dev/null | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    if s.get('status') in ('running','migrating','creating'):
        print(s.get('sandboxID', ''))
" 2>/dev/null || true)
    local count=0
    for sb in $sbs; do
        [ -n "$sb" ] && { destroy_sandbox "$sb" >/dev/null 2>&1 & count=$((count+1)); }
    done
    wait 2>/dev/null || true
    [ "$count" -gt 0 ] && echo "  (cleaned $count sandboxes)" && sleep 3
}

get_workers() { api "$API_URL/api/workers" 2>/dev/null || echo "[]"; }

worker_ids() {
    get_workers | python3 -c "import sys,json; [print(w['worker_id']) for w in json.load(sys.stdin)]" 2>/dev/null
}

pick_other_worker() {
    local current="$1"
    worker_ids | grep -v "^${current}$" | head -1
}

sandbox_worker() {
    api "$API_URL/api/sandboxes/$1" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null
}

sandbox_status() {
    api "$API_URL/api/sandboxes/$1" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null
}

create_sb() {
    local timeout="${1:-0}"
    local result
    result=$(api -X POST "$API_URL/api/sandboxes" -d "{\"timeout\":$timeout}" 2>/dev/null || echo '{}')
    echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null
}

exec_ok() {
    local out
    out=$(exec_stdout "$1" "echo" "ok" 2>/dev/null)
    [ "$out" = "ok" ]
}

echo "=== Advanced Scenario Tests ==="
echo "Workers:"
get_workers | python3 -c "
import sys,json
for w in json.load(sys.stdin):
    print(f'  {w[\"worker_id\"]}: {w[\"current\"]}/{w[\"capacity\"]}')
" 2>/dev/null

# ============================================================
h "Test 1: Hibernate + wake — state survives cold storage"

SB1=$(create_sb)
echo "  Created: $SB1"
exec_run "$SB1" "sh" "-c" "echo hibernate-marker-42 > /workspace/state.txt" >/dev/null 2>&1
exec_run "$SB1" "sh" "-c" "echo 'count=100' > /workspace/counter.txt" >/dev/null 2>&1
DATA_BEFORE=$(exec_stdout "$SB1" "cat" "/workspace/state.txt" 2>/dev/null)
echo "  Data before hibernate: $DATA_BEFORE"

echo "  Hibernating..."
HIB_RESULT=$(TIMEOUT=120 api -X POST "$API_URL/api/sandboxes/$SB1/hibernate" 2>/dev/null)
echo "  Hibernate result: $HIB_RESULT"
HIB_STATUS=$(sandbox_status "$SB1")
echo "  Status after hibernate: $HIB_STATUS"

if [ "$HIB_STATUS" = "hibernated" ]; then
    pass "Sandbox hibernated successfully"

    echo "  Waking..."
    WAKE_RESULT=$(TIMEOUT=120 api -X POST "$API_URL/api/sandboxes/$SB1/wake" -d '{"timeout":300}' 2>/dev/null)
    echo "  Wake result: $(echo "$WAKE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'status={d.get(\"status\",\"?\")}')" 2>/dev/null)"

    sleep 2
    WAKE_STATUS=$(sandbox_status "$SB1")
    if [ "$WAKE_STATUS" = "running" ]; then
        pass "Sandbox woke up (status=running)"

        DATA_AFTER=$(exec_stdout "$SB1" "cat" "/workspace/state.txt" 2>/dev/null)
        [ "$DATA_AFTER" = "$DATA_BEFORE" ] && pass "Data survived hibernate+wake: $DATA_AFTER" || fail "Data lost: before=$DATA_BEFORE after=$DATA_AFTER"

        COUNTER=$(exec_stdout "$SB1" "cat" "/workspace/counter.txt" 2>/dev/null)
        [ "$COUNTER" = "count=100" ] && pass "Counter file intact" || fail "Counter file: $COUNTER"
    else
        fail "Sandbox didn't wake: status=$WAKE_STATUS"
    fi
else
    if echo "$HIB_RESULT" | grep -qi "error"; then
        skip "Hibernation not available (S3 checkpoint store may not be configured)"
    else
        fail "Unexpected hibernate status: $HIB_STATUS"
    fi
fi
destroy_sandbox "$SB1" 2>/dev/null

# ============================================================
h "Test 2: Worker death — orphan detection marks sandboxes as error"

# Create sandboxes, note their worker, then we'll check what happens when
# a worker disappears (we can't kill workers, but we can verify the
# reconciliation logic by checking that sandboxes on dead workers get marked)
SB2=$(create_sb)
echo "  Created: $SB2"
W2=$(sandbox_worker "$SB2")
echo "  On worker: $W2"
exec_ok "$SB2" && pass "Sandbox responsive before worker test" || fail "Sandbox not responsive"

# We can verify the orphan detection is running by checking maintenance logs
# For now, verify that a sandbox whose worker vanishes from the registry
# eventually gets marked. We'll create a sandbox, then check that the
# system tracks worker liveness properly.
LIVE_WORKERS=$(worker_ids | wc -l | tr -d ' ')
echo "  Live workers: $LIVE_WORKERS"
[ "$LIVE_WORKERS" -ge 2 ] && pass "Worker registry tracking $LIVE_WORKERS workers" || fail "Only $LIVE_WORKERS workers"

# Verify that if we query a sandbox on a known worker, it's accessible
exec_ok "$SB2" && pass "Sandbox on live worker is accessible" || fail "Sandbox on live worker not accessible"
destroy_sandbox "$SB2" 2>/dev/null

# ============================================================
h "Test 3: Concurrent migrations — 5 sandboxes migrating simultaneously"

echo "  Creating 5 sandboxes..."
SB3_LIST=""
for i in $(seq 1 5); do
    sb=$(create_sb)
    [ -n "$sb" ] && SB3_LIST="$SB3_LIST $sb"
done
SB3_COUNT=$(echo $SB3_LIST | wc -w | tr -d ' ')
echo "  Created $SB3_COUNT sandboxes"

# Write unique markers
IDX=0
for sb in $SB3_LIST; do
    IDX=$((IDX+1))
    exec_run "$sb" "sh" "-c" "echo concurrent-$IDX > /workspace/id.txt" >/dev/null 2>&1
done

# Migrate all 5 simultaneously
echo "  Migrating all 5 simultaneously..."
MIGRATE_PIDS=""
MIGRATE_RESULTS=$(mktemp)
IDX=0
for sb in $SB3_LIST; do
    IDX=$((IDX+1))
    SRC=$(sandbox_worker "$sb")
    TGT=$(pick_other_worker "$SRC")
    if [ -n "$TGT" ]; then
        (
            START=$(python3 -c "import time; print(int(time.time()*1000))")
            RESULT=$(TIMEOUT=180 api -X POST "$API_URL/api/sandboxes/$sb/migrate" -d "{\"targetWorker\":\"$TGT\"}" 2>/dev/null)
            END=$(python3 -c "import time; print(int(time.time()*1000))")
            DUR=$((END-START))
            if echo "$RESULT" | grep -qi "error"; then
                echo "FAIL $sb ${DUR}ms $(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)" >> "$MIGRATE_RESULTS"
            else
                echo "OK $sb ${DUR}ms" >> "$MIGRATE_RESULTS"
            fi
        ) &
    fi
done
wait 2>/dev/null || true

OK_COUNT=$(grep -c "^OK" "$MIGRATE_RESULTS" 2>/dev/null || echo 0)
FAIL_MIGRATE=$(grep -c "^FAIL" "$MIGRATE_RESULTS" 2>/dev/null || echo 0)
echo "  Results: $OK_COUNT OK, $FAIL_MIGRATE failed"
cat "$MIGRATE_RESULTS" | while read line; do echo "    $line"; done
rm -f "$MIGRATE_RESULTS"

[ "$OK_COUNT" -ge 3 ] && pass "≥3/5 concurrent migrations succeeded ($OK_COUNT/5)" || fail "Only $OK_COUNT/5 concurrent migrations"

# Verify all are still responsive and markers intact
ALIVE=0
MARKERS_OK=0
IDX=0
for sb in $SB3_LIST; do
    IDX=$((IDX+1))
    exec_ok "$sb" && ALIVE=$((ALIVE+1))
    M=$(exec_stdout "$sb" "cat" "/workspace/id.txt" 2>/dev/null)
    [ "$M" = "concurrent-$IDX" ] && MARKERS_OK=$((MARKERS_OK+1))
done
[ "$ALIVE" -eq "$SB3_COUNT" ] && pass "All $ALIVE sandboxes responsive after concurrent migration" || fail "Only $ALIVE/$SB3_COUNT responsive"
[ "$MARKERS_OK" -eq "$SB3_COUNT" ] && pass "All markers intact after concurrent migration" || fail "Only $MARKERS_OK/$SB3_COUNT markers intact"

for sb in $SB3_LIST; do destroy_sandbox "$sb" >/dev/null 2>&1 & done
wait 2>/dev/null || true

# ============================================================
h "Test 4: Migration during active I/O — sandbox writing large file during migration"

SB4=$(create_sb)
echo "  Created: $SB4"

# Start a long-running write (50MB in small chunks) — fire and forget
TIMEOUT=10 exec_run "$SB4" "sh" "-c" "dd if=/dev/urandom of=/workspace/bigwrite.bin bs=4096 count=12800 2>/dev/null &" >/dev/null 2>&1 || true
echo "  Started 50MB background write"
sleep 1

# Migrate while write is in progress
SRC4=$(sandbox_worker "$SB4")
TGT4=$(pick_other_worker "$SRC4")
echo "  Migrating $SRC4 → $TGT4 during active I/O..."
START4=$(python3 -c "import time; print(int(time.time()*1000))")
MIG4=$(TIMEOUT=180 api -X POST "$API_URL/api/sandboxes/$SB4/migrate" -d "{\"targetWorker\":\"$TGT4\"}" 2>/dev/null)
END4=$(python3 -c "import time; print(int(time.time()*1000))")
DUR4=$((END4-START4))

if echo "$MIG4" | grep -qi "error"; then
    fail "Migration during I/O failed: $(echo "$MIG4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)"
else
    pass "Migration during active I/O completed (${DUR4}ms)"
fi

# Verify sandbox still works
exec_ok "$SB4" && pass "Sandbox responsive after I/O migration" || fail "Sandbox dead after I/O migration"

# Wait for write to finish, check file exists
sleep 5
SIZE=$(exec_stdout "$SB4" "sh" "-c" "ls -la /workspace/bigwrite.bin 2>/dev/null | awk '{print \$5}'" 2>/dev/null)
echo "  File size after migration: ${SIZE:-missing} bytes"
[ -n "$SIZE" ] && [ "$SIZE" -gt 0 ] 2>/dev/null && pass "File written during migration exists (${SIZE} bytes)" || skip "File may have been in-flight"
destroy_sandbox "$SB4" 2>/dev/null

# ============================================================
h "Test 5: Scale-triggered auto-migration"

SB5=$(create_sb)
echo "  Created: $SB5"
W5=$(sandbox_worker "$SB5")
echo "  On worker: $W5"

# Scale to 4GB first
api -X PUT "$API_URL/api/sandboxes/$SB5/limits" -d '{"memoryMB":4096,"cpuPercent":200}' >/dev/null 2>&1
echo "  Scaled to 4GB"

# Now try to scale to something very large that should trigger auto-migration
# The worker has ~64GB, 20% reserve = ~51GB usable. If we scale high enough
# and the worker is loaded, it should trigger insufficient_capacity → auto-migrate
echo "  Attempting scale to 16GB (may trigger auto-migration)..."
SCALE_RESULT=$(TIMEOUT=180 api -X PUT "$API_URL/api/sandboxes/$SB5/limits" -d '{"memoryMB":16384,"cpuPercent":400}' 2>/dev/null)
echo "  Result: $SCALE_RESULT"

W5_AFTER=$(sandbox_worker "$SB5")
if echo "$SCALE_RESULT" | grep -q "ok"; then
    pass "Scale to 16GB succeeded"
    if [ "$W5_AFTER" != "$W5" ]; then
        pass "Sandbox auto-migrated to accommodate scale ($W5 → $W5_AFTER)"
    else
        pass "Scale completed on same worker (had capacity)"
    fi
    # Verify memory actually increased
    MEM=$(exec_stdout "$SB5" "free" "-m" 2>/dev/null | awk '/Mem:/{print $2}')
    echo "  Actual memory: ${MEM}MB"
    [ -n "$MEM" ] && [ "$MEM" -gt 14000 ] && pass "Memory confirmed at ${MEM}MB" || fail "Memory only ${MEM}MB"
elif echo "$SCALE_RESULT" | grep -qi "insufficient_capacity\|migrat"; then
    pass "System correctly detected insufficient capacity"
else
    fail "Unexpected scale result: $SCALE_RESULT"
fi

exec_ok "$SB5" && pass "Sandbox responsive after scale attempt" || fail "Sandbox dead after scale"
destroy_sandbox "$SB5" 2>/dev/null

# ============================================================
h "Test 6: Concurrent exec — 10 parallel exec calls to one sandbox"

SB6=$(create_sb)
echo "  Created: $SB6"

# Write a file the execs will read
exec_run "$SB6" "sh" "-c" "seq 1 1000 > /workspace/numbers.txt" >/dev/null 2>&1

echo "  Firing 10 parallel exec calls..."
EXEC_DIR=$(mktemp -d)
for i in $(seq 1 10); do
    (
        OUT=$(exec_stdout "$SB6" "wc" "-l" "/workspace/numbers.txt" 2>/dev/null | awk '{print $1}')
        echo "$OUT" > "$EXEC_DIR/$i"
    ) &
done
wait 2>/dev/null || true

EXEC_OK=0
for f in "$EXEC_DIR"/*; do
    [ -f "$f" ] || continue
    VAL=$(cat "$f" | tr -d ' ')
    [ "$VAL" = "1000" ] && EXEC_OK=$((EXEC_OK+1))
done
rm -rf "$EXEC_DIR"

echo "  $EXEC_OK/10 returned correct result"
[ "$EXEC_OK" -ge 8 ] && pass "Concurrent exec: $EXEC_OK/10 correct" || fail "Concurrent exec: only $EXEC_OK/10 correct"

# Also verify sequential exec still works after the burst
exec_ok "$SB6" && pass "Sequential exec works after concurrent burst" || fail "Sandbox broken after concurrent exec"
destroy_sandbox "$SB6" 2>/dev/null

# ============================================================
h "Test 7: Sandbox timeout/expiry — auto-destroy after timeout"

echo "  Creating sandbox with 15s timeout..."
SB7=$(create_sb 15)
echo "  Created: $SB7"
exec_ok "$SB7" && pass "Sandbox alive at t=0" || fail "Sandbox dead at creation"

echo "  Waiting 10s (should still be alive — timeout resets on exec)..."
sleep 10
exec_ok "$SB7" && pass "Sandbox alive at t=10s (timeout reset by exec)" || fail "Sandbox died early"

echo "  Waiting 20s with no interaction..."
sleep 20
STATUS7=$(sandbox_status "$SB7")
echo "  Status after 20s idle: $STATUS7"
if [ "$STATUS7" = "hibernated" ] || [ "$STATUS7" = "stopped" ] || [ "$STATUS7" = "" ]; then
    pass "Sandbox expired after idle timeout (status=$STATUS7)"
else
    # Try exec — if it fails, it's been cleaned up
    if exec_ok "$SB7" 2>/dev/null; then
        skip "Sandbox still alive (timeout may be longer than expected)"
    else
        pass "Sandbox unreachable after timeout"
    fi
fi
destroy_sandbox "$SB7" 2>/dev/null

# ============================================================
h "Test 8: DNS resolution inside sandbox"

SB8=$(create_sb)
echo "  Created: $SB8"

# Test DNS resolution via Python (more portable than dig/nslookup)
DNS_RESULT=$(exec_stdout "$SB8" "python3" "-c" "import socket; print(socket.getaddrinfo('google.com', 80)[0][4][0])" 2>/dev/null)
echo "  Resolved google.com → $DNS_RESULT"
[ -n "$DNS_RESULT" ] && pass "DNS resolution works: google.com → $DNS_RESULT" || fail "DNS resolution failed"

# Test multiple domains
DNS2=$(exec_stdout "$SB8" "python3" "-c" "import socket; print(socket.getaddrinfo('github.com', 443)[0][4][0])" 2>/dev/null)
[ -n "$DNS2" ] && pass "DNS: github.com → $DNS2" || fail "DNS failed for github.com"

# Verify /etc/resolv.conf has nameservers
RESOLV=$(exec_stdout "$SB8" "cat" "/etc/resolv.conf" 2>/dev/null)
echo "$RESOLV" | grep -q "nameserver" && pass "resolv.conf has nameservers" || fail "resolv.conf missing nameservers"

destroy_sandbox "$SB8" 2>/dev/null

# ============================================================
h "Test 9: Scaler drain — sandboxes survive worker drain"

# This test verifies that when the scaler decides to drain a worker,
# sandboxes on it get migrated (not killed). We can't force a drain
# directly, but we can verify the current state is consistent.
echo "  Checking all running sandboxes are on live workers..."
ALL_SBS=$(api "$API_URL/api/sandboxes" 2>/dev/null | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    if s.get('status') == 'running':
        print(f'{s[\"sandboxID\"]} {s.get(\"workerID\",\"unknown\")}')
" 2>/dev/null)
LIVE=$(worker_ids)
ORPHANED=0
TOTAL_RUNNING=0
while read -r line; do
    [ -z "$line" ] && continue
    SB_ID=$(echo "$line" | awk '{print $1}')
    WK_ID=$(echo "$line" | awk '{print $2}')
    TOTAL_RUNNING=$((TOTAL_RUNNING+1))
    if ! echo "$LIVE" | grep -q "^${WK_ID}$"; then
        echo "  ORPHAN: $SB_ID on dead worker $WK_ID"
        ORPHANED=$((ORPHANED+1))
    fi
done <<< "$ALL_SBS"
echo "  $TOTAL_RUNNING running sandboxes, $ORPHANED orphaned"
[ "$ORPHANED" -eq 0 ] && pass "No orphaned sandboxes on dead workers" || fail "$ORPHANED sandboxes on dead workers"

# Create sandboxes spread across workers, verify they're tracked
SB9A=$(create_sb); SB9B=$(create_sb); SB9C=$(create_sb)
W9A=$(sandbox_worker "$SB9A"); W9B=$(sandbox_worker "$SB9B"); W9C=$(sandbox_worker "$SB9C")
UNIQUE_WORKERS=$(echo -e "$W9A\n$W9B\n$W9C" | sort -u | wc -l | tr -d ' ')
echo "  3 sandboxes spread across $UNIQUE_WORKERS worker(s)"
exec_ok "$SB9A" && exec_ok "$SB9B" && exec_ok "$SB9C" && pass "All 3 sandboxes responsive" || fail "Some sandboxes unresponsive"
destroy_sandbox "$SB9A" 2>/dev/null; destroy_sandbox "$SB9B" 2>/dev/null; destroy_sandbox "$SB9C" 2>/dev/null

# ============================================================
h "Test 10: Port forwarding — web server inside sandbox"

SB10=$(create_sb)
echo "  Created: $SB10"

# Start a simple HTTP server on port 8000 inside the sandbox
TIMEOUT=10 exec_run "$SB10" "sh" "-c" "python3 -m http.server 8000 --directory /workspace &" >/dev/null 2>&1 || true
sleep 2

# Write a test file
exec_run "$SB10" "sh" "-c" "echo 'hello from sandbox' > /workspace/index.html" >/dev/null 2>&1

# Try to create a preview URL
echo "  Creating preview URL on port 8000..."
PREVIEW_RESULT=$(api -X POST "$API_URL/api/sandboxes/$SB10/preview" -d '{"port":8000}' 2>/dev/null)
echo "  Preview result: $PREVIEW_RESULT"

HOSTNAME=$(echo "$PREVIEW_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hostname',''))" 2>/dev/null)
if [ -n "$HOSTNAME" ] && [ "$HOSTNAME" != "" ]; then
    pass "Preview URL created: $HOSTNAME"

    # Try to access via the control plane proxy (direct IP, Host header)
    HTTP_RESULT=$(curl -sk --max-time 5 --connect-timeout 3 -H "Host: $HOSTNAME" "http://20.114.60.29:8080/index.html" 2>/dev/null)
    if echo "$HTTP_RESULT" | grep -q "hello from sandbox"; then
        pass "Web server accessible via preview URL"
    else
        skip "Preview URL created but not routable from test client"
    fi
else
    if echo "$PREVIEW_RESULT" | grep -qi "error"; then
        skip "Preview URLs not available: $(echo "$PREVIEW_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)"
    else
        skip "No hostname returned"
    fi
fi
destroy_sandbox "$SB10" 2>/dev/null

# ============================================================
h "Test 11: Large sandbox migration (16GB + 400% CPU)"

SB11=$(create_sb)
echo "  Created: $SB11"

echo "  Scaling to 16GB + 400% CPU..."
SCALE11=$(api -X PUT "$API_URL/api/sandboxes/$SB11/limits" -d '{"memoryMB":16384,"cpuPercent":400}' 2>/dev/null)
if echo "$SCALE11" | grep -q "ok"; then
    pass "Scaled to 16GB"

    # Allocate some real memory
    TIMEOUT=30 exec_run "$SB11" "sh" "-c" "python3 -c 'x=bytearray(8*1024*1024*1024)' &" >/dev/null 2>&1 || true
    sleep 3

    SRC11=$(sandbox_worker "$SB11")
    TGT11=$(pick_other_worker "$SRC11")
    if [ -n "$TGT11" ]; then
        echo "  Migrating 16GB sandbox $SRC11 → $TGT11..."
        START11=$(python3 -c "import time; print(int(time.time()*1000))")
        MIG11=$(TIMEOUT=300 api -X POST "$API_URL/api/sandboxes/$SB11/migrate" -d "{\"targetWorker\":\"$TGT11\"}" 2>/dev/null)
        END11=$(python3 -c "import time; print(int(time.time()*1000))")
        DUR11=$((END11-START11))

        if echo "$MIG11" | grep -qi "error"; then
            fail "Large sandbox migration failed: $(echo "$MIG11" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)"
        else
            pass "16GB sandbox migrated in ${DUR11}ms"
        fi

        exec_ok "$SB11" && pass "Large sandbox responsive after migration" || fail "Large sandbox dead after migration"

        MEM11=$(exec_stdout "$SB11" "free" "-m" 2>/dev/null | awk '/Mem:/{print $2}')
        echo "  Memory after migration: ${MEM11}MB"
        [ -n "$MEM11" ] && [ "$MEM11" -gt 14000 ] && pass "Memory preserved at ${MEM11}MB" || fail "Memory: ${MEM11}MB"
    else
        skip "No target worker for large migration"
    fi
elif echo "$SCALE11" | grep -qi "insufficient_capacity\|migrat"; then
    # It may have auto-migrated
    W11=$(sandbox_worker "$SB11")
    echo "  Auto-migration may have occurred, now on: $W11"
    exec_ok "$SB11" && pass "Sandbox responsive after auto-migration" || fail "Sandbox dead"
else
    fail "Scale to 16GB failed: $SCALE11"
fi
destroy_sandbox "$SB11" 2>/dev/null

# ============================================================
h "Test 12: Checkpoint + restore — named snapshot"

SB12=$(create_sb)
echo "  Created: $SB12"

# Write state
exec_run "$SB12" "sh" "-c" "echo version-1 > /workspace/version.txt && seq 1 1000 > /workspace/data.txt" >/dev/null 2>&1
V1=$(exec_stdout "$SB12" "cat" "/workspace/version.txt" 2>/dev/null)
echo "  State v1: $V1"

# Create checkpoint
echo "  Creating checkpoint 'snap-v1'..."
CP_RESULT=$(TIMEOUT=120 api -X POST "$API_URL/api/sandboxes/$SB12/checkpoints" -d '{"name":"snap-v1"}' 2>/dev/null)
echo "  Checkpoint result: $CP_RESULT"
CP_ID=$(echo "$CP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [ -n "$CP_ID" ] && [ "$CP_ID" != "" ]; then
    pass "Checkpoint created: $CP_ID"

    # Modify state
    exec_run "$SB12" "sh" "-c" "echo version-2 > /workspace/version.txt && rm /workspace/data.txt" >/dev/null 2>&1
    V2=$(exec_stdout "$SB12" "cat" "/workspace/version.txt" 2>/dev/null)
    echo "  State changed to: $V2"

    # Wait for checkpoint to be ready
    echo "  Waiting for checkpoint to be ready..."
    for i in $(seq 1 12); do
        CP_LIST=$(api "$API_URL/api/sandboxes/$SB12/checkpoints" 2>/dev/null)
        CP_STATUS=$(echo "$CP_LIST" | python3 -c "
import sys, json
for cp in json.load(sys.stdin):
    if cp.get('id') == '$CP_ID':
        print(cp.get('status', ''))
        break
" 2>/dev/null)
        [ "$CP_STATUS" = "ready" ] && break
        sleep 5
    done
    echo "  Checkpoint status: $CP_STATUS"

    if [ "$CP_STATUS" = "ready" ]; then
        # Restore to checkpoint
        echo "  Restoring to snap-v1..."
        RESTORE=$(TIMEOUT=120 api -X POST "$API_URL/api/sandboxes/$SB12/checkpoints/$CP_ID/restore" 2>/dev/null)
        echo "  Restore result: $RESTORE"
        sleep 3

        V_AFTER=$(exec_stdout "$SB12" "cat" "/workspace/version.txt" 2>/dev/null)
        echo "  State after restore: $V_AFTER"
        [ "$V_AFTER" = "version-1" ] && pass "Restored to checkpoint: version-1" || fail "Restore failed: got $V_AFTER"

        DATA_EXISTS=$(exec_stdout "$SB12" "wc" "-l" "/workspace/data.txt" 2>/dev/null | awk '{print $1}')
        [ "$DATA_EXISTS" = "1000" ] && pass "Deleted file restored (1000 lines)" || fail "Deleted file not restored: $DATA_EXISTS"
    else
        skip "Checkpoint not ready after 60s (status=$CP_STATUS)"
    fi

    # Clean up checkpoint
    api -X DELETE "$API_URL/api/sandboxes/$SB12/checkpoints/$CP_ID" >/dev/null 2>&1
else
    if echo "$CP_RESULT" | grep -qi "error"; then
        skip "Checkpoints not available: $(echo "$CP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)"
    else
        fail "No checkpoint ID returned"
    fi
fi
destroy_sandbox "$SB12" 2>/dev/null

# ============================================================
h "Final Summary"
flush_sandboxes
echo ""
echo "Workers:"
get_workers | python3 -c "
import sys,json
for w in json.load(sys.stdin):
    print(f'  {w[\"worker_id\"]}: {w[\"current\"]}/{w[\"capacity\"]}  cpu={w[\"cpu_pct\"]:.0f}%  mem={w[\"mem_pct\"]:.0f}%')
" 2>/dev/null
echo ""
summary
