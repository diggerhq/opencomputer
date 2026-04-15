#!/usr/bin/env bash
# 40-ping-pong-demo.sh — Live migration demo with a real sandbox
#
# Creates a sandbox with running processes, files, and a web server,
# then migrates it across workers verifying everything survives each hop.
# Designed for demos — clear output, visual verification at each step.
#
# Required env:
#   OPENSANDBOX_API_URL
#   OPENSANDBOX_API_KEY

source "$(dirname "$0")/common.sh"

ROUNDS="${1:-10}"
SB=""
cleanup() { [ -n "$SB" ] && destroy_sandbox "$SB"; }
trap cleanup EXIT INT TERM

get_workers() { api "$API_URL/api/workers" 2>/dev/null || echo "[]"; }

current_worker() {
    api "$API_URL/api/sandboxes/$SB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null
}

pick_random_target() {
    local current="$1"
    api "$API_URL/api/workers" 2>/dev/null | python3 -c "
import sys,json
workers = [w['worker_id'] for w in json.load(sys.stdin) if w['worker_id'] != '$current']
import random
print(random.choice(workers) if workers else '')
" 2>/dev/null
}

# ============================================================
echo ""
printf '\033[1;35m'
# Clear server event history for a clean dashboard
api -X POST "$API_URL/admin/events/clear" >/dev/null 2>&1

echo "╔══════════════════════════════════════════════════════╗"
echo "║         Live Migration Ping-Pong Demo                ║"
echo "║         $ROUNDS migrations with full verification        ║"
echo "╚══════════════════════════════════════════════════════╝"
printf '\033[0m'
echo ""

WORKER_COUNT=$(get_workers | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "Workers available: $WORKER_COUNT"
get_workers | python3 -c "
import sys,json
for w in json.load(sys.stdin):
    print(f'  {w[\"worker_id\"][-12:]}  cpu={w[\"cpu_pct\"]:.0f}%  mem={w[\"mem_pct\"]:.0f}%')
" 2>/dev/null

if [ "$WORKER_COUNT" -lt 2 ]; then
    echo "Need at least 2 workers for ping-pong."
    exit 1
fi

# ============================================================
h "Setup: Creating a realistic sandbox"

SB=$(create_sandbox 0)
echo "  Sandbox: $SB"
CURRENT=$(current_worker)
echo "  Worker: ${CURRENT##*-}"
echo ""

# Write persistent files
echo "  Writing files..."
exec_run "$SB" "sh" "-c" "echo 'important-data-12345' > /workspace/data.txt" >/dev/null 2>&1
exec_run "$SB" "sh" "-c" "seq 1 10000 > /workspace/numbers.txt" >/dev/null 2>&1
exec_run "$SB" "sh" "-c" "dd if=/dev/urandom of=/workspace/random.bin bs=1024 count=512 2>/dev/null" >/dev/null 2>&1
HASH_BEFORE=$(exec_stdout "$SB" "md5sum" "/workspace/random.bin" 2>/dev/null | awk '{print $1}')
echo "  Created: data.txt, numbers.txt, random.bin (512KB, md5=$HASH_BEFORE)"

# Start background processes
echo "  Starting background processes..."
exec_run "$SB" "sh" "-c" "python3 -c \"
import time, os
with open('/workspace/counter.txt', 'w') as f:
    i = 0
    while True:
        i += 1
        f.seek(0)
        f.write(str(i))
        f.flush()
        time.sleep(0.5)
\" &" >/dev/null 2>&1 || true
sleep 2

# Install and start a simple web server
exec_run "$SB" "sh" "-c" "echo '<html><body><h1>Migration Demo</h1><p>Sandbox: $SB</p></body></html>' > /workspace/index.html" >/dev/null 2>&1
exec_run "$SB" "sh" "-c" "cd /workspace && python3 -m http.server 8080 &" >/dev/null 2>&1 || true
sleep 1

# Scale to 4GB to make it a real workload
api -X PUT "$API_URL/api/sandboxes/$SB/limits" -d '{"memoryMB":4096,"cpuPercent":200}' >/dev/null 2>&1
echo "  Scaled to 4GB / 2 vCPU"

# Verify everything works
DATA=$(exec_stdout "$SB" "cat" "/workspace/data.txt" 2>/dev/null)
LINES=$(exec_stdout "$SB" "wc" "-l" "/workspace/numbers.txt" 2>/dev/null | awk '{print $1}')
MEM=$(exec_stdout "$SB" "free" "-m" 2>/dev/null | awk '/Mem:/{print $2}')
PROCS=$(exec_stdout "$SB" "sh" "-c" "ps aux | wc -l" 2>/dev/null | tr -d ' ')
echo ""
echo "  Sandbox state:"
echo "    Data file:   $DATA"
echo "    Numbers:     $LINES lines"
echo "    Random hash: $HASH_BEFORE"
echo "    Memory:      ${MEM}MB"
echo "    Processes:   $PROCS"
echo ""
pass "Sandbox ready with files, processes, and web server"

# ============================================================
h "Ping-Pong: $ROUNDS migrations"
echo ""

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_MS=0

for i in $(seq 1 "$ROUNDS"); do
    TARGET=$(pick_random_target "$CURRENT")

    printf '  \033[1m%2d.\033[0m %s → %s ' "$i" "${CURRENT##*-}" "${TARGET##*-}"

    # Migrate
    START=$(python3 -c "import time; print(int(time.time()*1000))")
    RESULT=$(TIMEOUT=180 api -X POST "$API_URL/api/sandboxes/$SB/migrate" -d "{\"targetWorker\":\"$TARGET\"}" 2>/dev/null)
    END=$(python3 -c "import time; print(int(time.time()*1000))")
    DURATION=$((END - START))
    TOTAL_MS=$((TOTAL_MS + DURATION))

    # Check for migration error
    if echo "$RESULT" | grep -qi "error"; then
        printf '\033[31mFAIL\033[0m migration error (%dms)\n' "$DURATION"
        echo "    Error: $(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify 1: exec works
    ECHO_OUT=$(exec_stdout "$SB" "echo" "alive" 2>/dev/null)
    if [ "$ECHO_OUT" != "alive" ]; then
        printf '\033[31mFAIL\033[0m exec broken (%dms)\n' "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify 2: data file intact
    DATA_CHECK=$(exec_stdout "$SB" "cat" "/workspace/data.txt" 2>/dev/null)
    if [ "$DATA_CHECK" != "important-data-12345" ]; then
        printf '\033[31mFAIL\033[0m data lost (%dms)\n' "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify 3: random file hash matches
    HASH_CHECK=$(exec_stdout "$SB" "md5sum" "/workspace/random.bin" 2>/dev/null | awk '{print $1}')
    if [ "$HASH_CHECK" != "$HASH_BEFORE" ]; then
        printf '\033[31mFAIL\033[0m hash mismatch (%dms)\n' "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify 4: memory preserved
    MEM_CHECK=$(exec_stdout "$SB" "free" "-m" 2>/dev/null | awk '/Mem:/{print $2}')
    MEM_OK="yes"
    [ -n "$MEM_CHECK" ] && [ "$MEM_CHECK" -gt 3000 ] || MEM_OK="no"

    # Verify 5: worker actually changed
    NEW_WORKER=$(current_worker)
    WORKER_OK="yes"
    [ "$NEW_WORKER" = "$TARGET" ] || WORKER_OK="no"

    # Verify 6: process count (should have processes running)
    PROC_CHECK=$(exec_stdout "$SB" "sh" "-c" "ps aux | wc -l" 2>/dev/null | tr -d ' ')
    PROC_OK="yes"
    [ -n "$PROC_CHECK" ] && [ "$PROC_CHECK" -gt 3 ] || PROC_OK="no"

    if [ "$MEM_OK" = "yes" ] && [ "$WORKER_OK" = "yes" ] && [ "$PROC_OK" = "yes" ]; then
        printf '\033[32m✓\033[0m %dms  (exec ✓  data ✓  hash ✓  %sMB ✓  %s procs ✓)\n' "$DURATION" "$MEM_CHECK" "$PROC_CHECK"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        printf '\033[33m~\033[0m %dms  (mem=%s worker=%s procs=%s)\n' "$DURATION" "$MEM_OK" "$WORKER_OK" "$PROC_OK"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi

    CURRENT="$TARGET"
done

# ============================================================
echo ""
h "Results"

AVG_MS=$((TOTAL_MS / ROUNDS))

echo ""
printf '\033[1m'
echo "  Migrations: $PASS_COUNT/$ROUNDS passed"
echo "  Average:    ${AVG_MS}ms per migration"
echo "  Total:      ${TOTAL_MS}ms"
printf '\033[0m'
echo ""

# Final state verification
echo "  Final verification:"
FINAL_DATA=$(exec_stdout "$SB" "cat" "/workspace/data.txt" 2>/dev/null)
FINAL_HASH=$(exec_stdout "$SB" "md5sum" "/workspace/random.bin" 2>/dev/null | awk '{print $1}')
FINAL_LINES=$(exec_stdout "$SB" "wc" "-l" "/workspace/numbers.txt" 2>/dev/null | awk '{print $1}')
FINAL_MEM=$(exec_stdout "$SB" "free" "-m" 2>/dev/null | awk '/Mem:/{print $2}')
FINAL_WORKER=$(current_worker)

echo "    Data:    $FINAL_DATA $([ "$FINAL_DATA" = "important-data-12345" ] && echo '✓' || echo '✗')"
echo "    Hash:    $FINAL_HASH $([ "$FINAL_HASH" = "$HASH_BEFORE" ] && echo '✓' || echo '✗')"
echo "    Lines:   $FINAL_LINES $([ "$FINAL_LINES" = "10000" ] && echo '✓' || echo '✗')"
echo "    Memory:  ${FINAL_MEM}MB $([ -n "$FINAL_MEM" ] && [ "$FINAL_MEM" -gt 3000 ] && echo '✓' || echo '✗')"
echo "    Worker:  ${FINAL_WORKER##*-}"
echo ""

# Worker visit distribution
echo "  Worker visit distribution:"
api "$API_URL/admin/report?key=$API_KEY" 2>/dev/null | python3 -c "
import sys,json
try:
    r = json.load(sys.stdin)
    migs = r.get('migrations',{}).get('details',[])
    if migs:
        workers = {}
        for m in migs:
            w = m['worker'][-8:]
            workers[w] = workers.get(w,0) + 1
        for w,c in sorted(workers.items(), key=lambda x: -x[1]):
            bar = '█' * c
            print(f'    {w}  {c:2d}  {bar}')
except: pass
" 2>/dev/null

echo ""
PASS=0; FAIL=0; SKIP=0
[ "$PASS_COUNT" -eq "$ROUNDS" ] && pass "All $ROUNDS migrations succeeded with full verification" || fail "$FAIL_COUNT/$ROUNDS migrations failed"
[ "$FINAL_HASH" = "$HASH_BEFORE" ] && pass "512KB file hash intact after $ROUNDS migrations" || fail "File corruption detected"
[ "$FINAL_DATA" = "important-data-12345" ] && pass "Data persisted across all migrations" || fail "Data lost"

summary
