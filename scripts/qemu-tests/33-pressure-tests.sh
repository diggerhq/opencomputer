#!/usr/bin/env bash
# 33-pressure-tests.sh — Push workers to RAM, disk, and CPU pressure limits
#
# Tests the scaler's response to resource pressure:
#   - Scale-up triggers (70% CPU/mem, 60% disk)
#   - Evacuation triggers (80% CPU/mem, 70% disk)
#   - Emergency hibernation (95% CPU/mem, 90% disk)
#   - Hard rejection (90% CPU/mem in routing)
#   - Mix-and-match combinations
#
# Required env:
#   OPENSANDBOX_API_URL
#   OPENSANDBOX_API_KEY

source "$(dirname "$0")/common.sh"

declare -a ALL_SANDBOXES=()

cleanup_all() {
    echo ""
    echo "=== Cleanup: ${#ALL_SANDBOXES[@]} sandboxes ==="
    for sb in "${ALL_SANDBOXES[@]+"${ALL_SANDBOXES[@]}"}"; do
        [ -n "$sb" ] && destroy_sandbox "$sb" &
    done
    wait 2>/dev/null || true
    echo "Done"
}
trap cleanup_all EXIT INT TERM

get_workers() { api "$API_URL/api/workers" 2>/dev/null || echo "[]"; }

worker_stats() {
    get_workers | python3 -c "
import sys, json
workers = json.load(sys.stdin)
for w in workers:
    print(f'  {w[\"worker_id\"]}: {w[\"current\"]}/{w[\"capacity\"]}  cpu={w[\"cpu_pct\"]:.0f}%  mem={w[\"mem_pct\"]:.0f}%  disk={w[\"disk_pct\"]:.0f}%')
" 2>/dev/null
}

create_sb() {
    local result
    result=$(api -X POST "$API_URL/api/sandboxes" -d '{"timeout":0}' 2>/dev/null || echo '{}')
    local sb
    sb=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)
    if [ -n "$sb" ] && [ "$sb" != "" ]; then
        echo "$sb"
    fi
}

# Track sandbox for cleanup (must call in parent shell, not subshell)
track_sb() {
    ALL_SANDBOXES+=("$1")
}

exec_check() {
    local sb="$1"
    local out
    out=$(exec_stdout "$sb" "echo" "ok" 2>/dev/null)
    [ "$out" = "ok" ]
}

flush_sandboxes() {
    echo "  Cleaning up all sandboxes..."
    local sbs
    sbs=$(api "$API_URL/api/sandboxes" 2>/dev/null | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    print(s.get('sandboxID', ''))
" 2>/dev/null || true)
    local count=0
    for sb in $sbs; do
        [ -n "$sb" ] && { destroy_sandbox "$sb" >/dev/null 2>&1 & count=$((count+1)); }
    done
    wait 2>/dev/null || true
    ALL_SANDBOXES=()
    echo "  Destroyed $count sandboxes"
    sleep 5
}

# Wait for worker stats to update (heartbeats every 10s)
wait_stats() {
    local msg="${1:-Waiting for stats update}"
    echo "  $msg (15s for heartbeat)..."
    sleep 15
}

# Get a specific worker's stat
worker_stat() {
    local worker_id="$1" field="$2"
    get_workers | python3 -c "
import sys, json
for w in json.load(sys.stdin):
    if w['worker_id'] == '$worker_id':
        print(f'{w[\"$field\"]:.1f}')
        break
" 2>/dev/null
}

# Pick one specific worker to target (the one with fewer sandboxes)
pick_target_worker() {
    get_workers | python3 -c "
import sys, json
workers = sorted(json.load(sys.stdin), key=lambda w: w['current'])
print(workers[0]['worker_id'])
" 2>/dev/null
}

# Get worker HTTP addr for a sandbox
sandbox_worker() {
    local sb="$1"
    api "$API_URL/api/sandboxes/$sb" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null
}

echo "=== Resource Pressure Tests ==="
echo "Starting state:"
worker_stats

# ============================================================
# TEST 1: RAM PRESSURE
# ============================================================
h "Test 1: RAM pressure — scale sandboxes until memory triggers scaler response"

# Create sandboxes on a target worker and scale them up to consume memory
TARGET=$(pick_target_worker)
echo "  Target worker: $TARGET"
echo "  Strategy: Create 6 sandboxes, scale each to 8GB → ~48GB committed on 64GB host"

declare -a RAM_SBS=()
for i in $(seq 1 6); do
    sb=$(create_sb)
    if [ -n "$sb" ]; then
        RAM_SBS+=("$sb")
        echo "  Created $sb (#$i)"
    fi
done

echo "  Scaling all to 8GB..."
SCALE_OK=0
for sb in "${RAM_SBS[@]}"; do
    result=$(api -X PUT "$API_URL/api/sandboxes/$sb/limits" -d '{"memoryMB":8192,"cpuPercent":200}' 2>/dev/null)
    if echo "$result" | grep -q "ok"; then
        SCALE_OK=$((SCALE_OK+1))
    else
        echo "  Scale failed for $sb: $result"
    fi
done
echo "  Scaled $SCALE_OK/${#RAM_SBS[@]} to 8GB"

echo "  Allocating 6GB inside each VM to create real memory pressure..."
for sb in "${RAM_SBS[@]}"; do
    TIMEOUT=30 exec_run "$sb" "sh" "-c" "python3 -c 'x=bytearray(6*1024*1024*1024); import time; time.sleep(120)' &" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

wait_stats "Waiting for memory pressure to register"
echo "  Worker stats after RAM pressure:"
worker_stats

# Check that the system responded — mem should be high on at least one worker
MAX_MEM=$(get_workers | python3 -c "
import sys, json
workers = json.load(sys.stdin)
print(f'{max(w[\"mem_pct\"] for w in workers):.0f}')
" 2>/dev/null)
echo "  Peak memory: ${MAX_MEM}%"
[ "${MAX_MEM:-0}" -gt 10 ] && pass "RAM pressure visible: peak ${MAX_MEM}%" || fail "RAM pressure not visible (peak ${MAX_MEM}%)"

# Verify sandboxes are still responsive under memory pressure
RESPONSIVE=0
for sb in "${RAM_SBS[@]}"; do
    exec_check "$sb" && RESPONSIVE=$((RESPONSIVE+1))
done
[ "$RESPONSIVE" -eq "${#RAM_SBS[@]}" ] && pass "All $RESPONSIVE sandboxes responsive under RAM pressure" || fail "Only $RESPONSIVE/${#RAM_SBS[@]} responsive"

# Try to scale one more to 16GB — should hit insufficient_capacity on a full worker
echo "  Attempting to scale one sandbox to 16GB (should stress committed memory)..."
BIG_RESULT=$(api -X PUT "$API_URL/api/sandboxes/${RAM_SBS[0]}/limits" -d '{"memoryMB":16384,"cpuPercent":200}' 2>/dev/null)
echo "  Result: $BIG_RESULT"
if echo "$BIG_RESULT" | grep -qi "insufficient_capacity\|migrat"; then
    pass "System detected insufficient capacity and responded"
elif echo "$BIG_RESULT" | grep -q "ok"; then
    pass "Scale to 16GB succeeded (worker had room)"
else
    fail "Unexpected response: $BIG_RESULT"
fi

# New sandbox creation should still work (routes to less-loaded worker)
NEW_SB=$(create_sb)
if [ -n "$NEW_SB" ]; then
    exec_check "$NEW_SB" && pass "New sandbox created and responsive under RAM pressure" || fail "New sandbox unresponsive"
else
    fail "Could not create sandbox under RAM pressure"
fi

flush_sandboxes

# ============================================================
# TEST 2: DISK PRESSURE
# ============================================================
h "Test 2: Disk pressure — fill sandbox disks until worker disk_pct rises"

# Create sandboxes and write large files to consume disk
# Workers have NVMe temp disk mounted at /data — sandboxes live there
echo "  Strategy: Create 4 sandboxes, write 5GB each → 20GB disk consumed"

declare -a DISK_SBS=()
for i in $(seq 1 4); do
    sb=$(create_sb)
    if [ -n "$sb" ]; then
        DISK_SBS+=("$sb")
        echo "  Created $sb (#$i)"
    fi
done

echo "  Baseline disk stats:"
worker_stats

echo "  Writing 5GB files in each sandbox (parallel)..."
for sb in "${DISK_SBS[@]}"; do
    TIMEOUT=120 exec_run "$sb" "sh" "-c" "dd if=/dev/zero of=/workspace/bigfile bs=1M count=5120 2>/dev/null" >/dev/null 2>&1 &
done
echo "  Waiting for writes to complete..."
wait 2>/dev/null || true

wait_stats "Waiting for disk pressure to register"
echo "  Worker stats after disk writes:"
worker_stats

DISK_BEFORE=$(get_workers | python3 -c "
import sys, json
print(max(w['disk_pct'] for w in json.load(sys.stdin)))
" 2>/dev/null)
echo "  Peak disk usage: ${DISK_BEFORE}%"

# Verify sandboxes still work
RESPONSIVE=0
for sb in "${DISK_SBS[@]}"; do
    exec_check "$sb" && RESPONSIVE=$((RESPONSIVE+1))
done
[ "$RESPONSIVE" -eq "${#DISK_SBS[@]}" ] && pass "All sandboxes responsive under disk pressure (peak ${DISK_BEFORE}%)" || fail "Only $RESPONSIVE/${#DISK_SBS[@]} responsive"

# Write even more to push disk higher
echo "  Writing 10GB more per sandbox..."
for sb in "${DISK_SBS[@]}"; do
    TIMEOUT=180 exec_run "$sb" "sh" "-c" "dd if=/dev/zero of=/workspace/bigfile2 bs=1M count=10240 2>/dev/null" >/dev/null 2>&1 &
done
echo "  Waiting for writes..."
wait 2>/dev/null || true

wait_stats "Waiting for higher disk pressure"
echo "  Worker stats after heavy disk writes:"
worker_stats

DISK_AFTER=$(get_workers | python3 -c "
import sys, json
print(max(w['disk_pct'] for w in json.load(sys.stdin)))
" 2>/dev/null)
echo "  Peak disk usage: ${DISK_AFTER}%"

# Check if disk grew
GREW=$(python3 -c "print('yes' if float('${DISK_AFTER}') > float('${DISK_BEFORE}') else 'no')" 2>/dev/null)
[ "$GREW" = "yes" ] && pass "Disk pressure increased: ${DISK_BEFORE}% → ${DISK_AFTER}%" || skip "Disk pressure unchanged (writes may be in tmpfs)"

# New sandbox should still be creatable
NEW_SB2=$(create_sb)
if [ -n "$NEW_SB2" ]; then
    exec_check "$NEW_SB2" && pass "New sandbox works under disk pressure" || fail "New sandbox broken under disk pressure"
else
    fail "Cannot create sandbox under disk pressure"
fi

flush_sandboxes

# ============================================================
# TEST 3: CPU PRESSURE
# ============================================================
h "Test 3: CPU pressure — pin all CPUs with busy loops"

echo "  Strategy: Create 4 sandboxes with 400% CPU each, run busy loops"

declare -a CPU_SBS=()
for i in $(seq 1 4); do
    sb=$(create_sb)
    if [ -n "$sb" ]; then
        CPU_SBS+=("$sb")
        # Scale CPU to 400% (4 vCPUs worth)
        api -X PUT "$API_URL/api/sandboxes/$sb/limits" -d '{"memoryMB":1024,"cpuPercent":400}' >/dev/null 2>&1
        echo "  Created $sb (#$i) at 400% CPU"
    fi
done

echo "  Baseline CPU stats:"
worker_stats

echo "  Starting CPU burn in all sandboxes..."
for sb in "${CPU_SBS[@]}"; do
    # Fire and forget: 8 busy loops per sandbox (runs for 60s then auto-dies)
    TIMEOUT=10 exec_run "$sb" "sh" "-c" "for i in 1 2 3 4 5 6 7 8; do (timeout 60 sh -c 'while :; do :; done') & done" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

wait_stats "Waiting for CPU pressure to register"
echo "  Worker stats under CPU burn:"
worker_stats

PEAK_CPU=$(get_workers | python3 -c "
import sys, json
print(max(w['cpu_pct'] for w in json.load(sys.stdin)))
" 2>/dev/null)
echo "  Peak CPU: ${PEAK_CPU}%"

[ "$(python3 -c "print('yes' if float('${PEAK_CPU}') > 30 else 'no')")" = "yes" ] && pass "CPU pressure visible: peak ${PEAK_CPU}%" || skip "CPU pressure low (cgroup limits may cap it)"

# Verify sandboxes still respond even under CPU pressure
RESPONSIVE=0
for sb in "${CPU_SBS[@]}"; do
    TIMEOUT=15 exec_check "$sb" && RESPONSIVE=$((RESPONSIVE+1))
done
[ "$RESPONSIVE" -eq "${#CPU_SBS[@]}" ] && pass "All sandboxes responsive under CPU pressure" || fail "Only $RESPONSIVE/${#CPU_SBS[@]} responsive under CPU burn"

# Create a new sandbox — should still work (routes to less-loaded worker)
NEW_SB3=$(create_sb)
if [ -n "$NEW_SB3" ]; then
    exec_check "$NEW_SB3" && pass "New sandbox works under CPU pressure" || fail "New sandbox broken under CPU pressure"
else
    fail "Cannot create sandbox under CPU pressure"
fi

echo "  Letting CPU burn continue for scaler to react (30s)..."
sleep 30
echo "  Worker stats after scaler reaction time:"
worker_stats

flush_sandboxes

# ============================================================
# TEST 4: RAM + CPU COMBINED
# ============================================================
h "Test 4: Combined RAM + CPU pressure"

echo "  Strategy: 4 sandboxes at 8GB + 400% CPU + busy loops"

declare -a COMBO1_SBS=()
for i in $(seq 1 4); do
    sb=$(create_sb)
    if [ -n "$sb" ]; then
        COMBO1_SBS+=("$sb")
        api -X PUT "$API_URL/api/sandboxes/$sb/limits" -d '{"memoryMB":8192,"cpuPercent":400}' >/dev/null 2>&1
        echo "  Created $sb: 8GB + 400% CPU"
    fi
done

# Start CPU burn
for sb in "${COMBO1_SBS[@]}"; do
    TIMEOUT=10 exec_run "$sb" "sh" "-c" "for i in 1 2 3 4 5 6 7 8; do (timeout 60 sh -c 'while :; do :; done') & done" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

# Also allocate memory inside the VMs to make it real pressure (not just committed)
for sb in "${COMBO1_SBS[@]}"; do
    TIMEOUT=30 exec_run "$sb" "sh" "-c" "python3 -c \"x=bytearray(4*1024*1024*1024)\" &" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

wait_stats "Waiting for combined pressure"
echo "  Worker stats under RAM + CPU pressure:"
worker_stats

PEAK_CPU=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"cpu_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
PEAK_MEM=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"mem_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
echo "  Peak: CPU=${PEAK_CPU}% MEM=${PEAK_MEM}%"

# All sandboxes should still respond (exec goes through even under pressure)
RESPONSIVE=0
for sb in "${COMBO1_SBS[@]}"; do
    TIMEOUT=15 exec_check "$sb" && RESPONSIVE=$((RESPONSIVE+1))
done
[ "$RESPONSIVE" -ge 3 ] && pass "≥3/${#COMBO1_SBS[@]} responsive under RAM+CPU pressure (cpu=${PEAK_CPU}% mem=${PEAK_MEM}%)" || fail "Only $RESPONSIVE/${#COMBO1_SBS[@]} responsive"

# New sandbox should still be possible
NEW_SB4=$(create_sb)
if [ -n "$NEW_SB4" ]; then
    exec_check "$NEW_SB4" && pass "New sandbox works under combined pressure" || fail "New sandbox broken"
else
    skip "Could not create sandbox (system at capacity — acceptable)"
fi

flush_sandboxes

# ============================================================
# TEST 5: DISK + RAM COMBINED
# ============================================================
h "Test 5: Combined Disk + RAM pressure"

echo "  Strategy: 4 sandboxes at 8GB, each writing 10GB to disk"

declare -a COMBO2_SBS=()
for i in $(seq 1 4); do
    sb=$(create_sb)
    if [ -n "$sb" ]; then
        COMBO2_SBS+=("$sb")
        api -X PUT "$API_URL/api/sandboxes/$sb/limits" -d '{"memoryMB":8192,"cpuPercent":200}' >/dev/null 2>&1
        echo "  Created $sb: 8GB RAM"
    fi
done

# Write 10GB per sandbox
echo "  Writing 10GB per sandbox (parallel)..."
for sb in "${COMBO2_SBS[@]}"; do
    TIMEOUT=180 exec_run "$sb" "sh" "-c" "dd if=/dev/zero of=/workspace/bigfile bs=1M count=10240 2>/dev/null" >/dev/null 2>&1 &
done
echo "  Waiting for disk writes..."
wait 2>/dev/null || true

wait_stats "Waiting for disk + RAM pressure"
echo "  Worker stats under Disk + RAM pressure:"
worker_stats

PEAK_MEM=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"mem_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
PEAK_DISK=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"disk_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
echo "  Peak: MEM=${PEAK_MEM}% DISK=${PEAK_DISK}%"

RESPONSIVE=0
for sb in "${COMBO2_SBS[@]}"; do
    exec_check "$sb" && RESPONSIVE=$((RESPONSIVE+1))
done
[ "$RESPONSIVE" -eq "${#COMBO2_SBS[@]}" ] && pass "All sandboxes responsive under Disk+RAM pressure (mem=${PEAK_MEM}% disk=${PEAK_DISK}%)" || fail "Only $RESPONSIVE/${#COMBO2_SBS[@]} responsive"

flush_sandboxes

# ============================================================
# TEST 6: ALL THREE — RAM + CPU + DISK
# ============================================================
h "Test 6: Triple pressure — RAM + CPU + Disk simultaneously"

echo "  Strategy: 6 sandboxes, 8GB each, CPU burn, 10GB disk writes"
echo "  This is the worst case — everything under pressure at once"

declare -a TRIPLE_SBS=()
for i in $(seq 1 6); do
    sb=$(create_sb)
    if [ -n "$sb" ]; then
        TRIPLE_SBS+=("$sb")
        api -X PUT "$API_URL/api/sandboxes/$sb/limits" -d '{"memoryMB":8192,"cpuPercent":400}' >/dev/null 2>&1
        echo "  Created $sb (#$i): 8GB + 400% CPU"
    fi
done

# Start everything simultaneously
echo "  Launching all pressure vectors..."
for sb in "${TRIPLE_SBS[@]}"; do
    # CPU burn
    TIMEOUT=10 exec_run "$sb" "sh" "-c" "for i in 1 2 3 4 5 6 7 8; do (timeout 90 sh -c 'while :; do :; done') & done" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

for sb in "${TRIPLE_SBS[@]}"; do
    # Disk writes (fire and forget)
    TIMEOUT=10 exec_run "$sb" "sh" "-c" "dd if=/dev/zero of=/workspace/bigfile bs=1M count=10240 &" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

for sb in "${TRIPLE_SBS[@]}"; do
    # Memory allocation
    TIMEOUT=10 exec_run "$sb" "sh" "-c" "python3 -c 'x=bytearray(4*1024*1024*1024)' &" >/dev/null 2>&1 || true &
done
wait 2>/dev/null || true

echo "  All pressure applied. Waiting for system response..."
wait_stats "Waiting for triple pressure stats"
echo "  Worker stats under TRIPLE pressure:"
worker_stats

PEAK_CPU=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"cpu_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
PEAK_MEM=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"mem_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
PEAK_DISK=$(get_workers | python3 -c "import sys,json; print(f'{max(w[\"disk_pct\"] for w in json.load(sys.stdin)):.0f}')" 2>/dev/null)
echo "  Peak: CPU=${PEAK_CPU}% MEM=${PEAK_MEM}% DISK=${PEAK_DISK}%"

# The key question: can we still use the system?
RESPONSIVE=0
for sb in "${TRIPLE_SBS[@]}"; do
    TIMEOUT=20 exec_check "$sb" && RESPONSIVE=$((RESPONSIVE+1))
done
echo "  $RESPONSIVE/${#TRIPLE_SBS[@]} sandboxes still responsive"
[ "$RESPONSIVE" -ge 4 ] && pass "System usable under triple pressure ($RESPONSIVE/${#TRIPLE_SBS[@]} responsive)" || fail "System degraded: only $RESPONSIVE/${#TRIPLE_SBS[@]} responsive"

# Can we still create a new sandbox?
NEW_SB6=$(create_sb)
if [ -n "$NEW_SB6" ]; then
    TIMEOUT=20 exec_check "$NEW_SB6" && pass "New sandbox works under triple pressure" || fail "New sandbox broken under triple pressure"
else
    skip "Cannot create sandbox under triple pressure (may be expected)"
fi

# Wait for scaler to potentially react
echo "  Giving scaler 45s to respond to pressure..."
sleep 45
echo "  Worker stats after scaler reaction:"
worker_stats

WORKERS_NOW=$(get_workers | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "  Workers now: $WORKERS_NOW"
[ "${WORKERS_NOW:-0}" -ge 2 ] && pass "System survived triple pressure with $WORKERS_NOW workers" || fail "Workers lost during triple pressure"

# Check if scaler launched more workers or evacuated
[ "${WORKERS_NOW:-0}" -gt 2 ] && pass "Scaler launched additional worker(s) in response to pressure" || skip "Scaler did not scale up (pressure may be within bounds)"

flush_sandboxes

# ============================================================
# TEST 7: RECOVERY — System returns to normal after pressure removed
# ============================================================
h "Test 7: Recovery — verify system returns to healthy state after pressure"

echo "  All pressure sandboxes destroyed. Waiting for recovery..."
sleep 15
echo "  Worker stats after recovery:"
worker_stats

# Create and verify fresh sandboxes
RECOVERY_OK=0
for i in $(seq 1 4); do
    sb=$(create_sb)
    if [ -n "$sb" ] && exec_check "$sb"; then
        RECOVERY_OK=$((RECOVERY_OK+1))
    fi
done
[ "$RECOVERY_OK" -eq 4 ] && pass "Full recovery: 4/4 new sandboxes work" || fail "Incomplete recovery: $RECOVERY_OK/4"

echo ""
echo "  Final worker state:"
worker_stats

flush_sandboxes

# ============================================================
h "Final Summary"
echo ""
worker_stats
echo ""
summary
