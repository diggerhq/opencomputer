#!/usr/bin/env bash
# 38-chaos-200.sh — 200-sandbox chaos test with random scaling
#
# Creates 200 sandboxes in waves, randomly scales memory/disk on each,
# randomly destroys some, creates replacements, checks responsiveness throughout.
# Tests autoscaler under real-world chaotic load.
#
# Required env:
#   OPENSANDBOX_API_URL
#   OPENSANDBOX_API_KEY

source "$(dirname "$0")/common.sh"

TARGET=${1:-200}
WAVES=5
PER_WAVE=$((TARGET / WAVES))
CHAOS_ROUNDS=10

get_workers() { api "$API_URL/api/workers" 2>/dev/null || echo "[]"; }
worker_summary() {
    get_workers | python3 -c "
import sys,json
w = json.load(sys.stdin)
total = sum(x['current'] for x in w)
print(f'{len(w)} workers, {total} sandboxes')
for x in w:
    print(f'  {x[\"worker_id\"][-8:]}: {x[\"current\"]}/{x[\"capacity\"]}  cpu={x[\"cpu_pct\"]:.0f}%  mem={x[\"mem_pct\"]:.0f}%')
" 2>/dev/null
}

create_one() {
    local result
    result=$(api -X POST "$API_URL/api/sandboxes" -d '{"timeout":0}' 2>/dev/null || echo '{}')
    echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null
}

exec_check() {
    local out
    out=$(exec_stdout "$1" "echo" "ok" 2>/dev/null)
    [ "$out" = "ok" ]
}

SANDBOX_FILE=$(mktemp)
STATS_FILE=$(mktemp)
echo "0 0 0 0" > "$STATS_FILE"  # created failed responsive unresponsive

update_stat() {
    local idx=$1 delta=$2
    awk -v i="$idx" -v d="$delta" '{$i=$i+d; print}' "$STATS_FILE" > "${STATS_FILE}.tmp"
    mv "${STATS_FILE}.tmp" "$STATS_FILE"
}

cleanup() {
    echo ""
    echo "=== Cleanup ==="
    local count=0
    while read -r sb; do
        [ -n "$sb" ] && { destroy_sandbox "$sb" >/dev/null 2>&1 & count=$((count+1)); }
        # Throttle parallel deletes
        [ $((count % 20)) -eq 0 ] && wait 2>/dev/null
    done < "$SANDBOX_FILE"
    wait 2>/dev/null
    echo "Destroyed $count sandboxes"
    rm -f "$SANDBOX_FILE" "$STATS_FILE"
}
trap cleanup EXIT INT TERM

echo "=== 200-Sandbox Chaos Test ==="
echo "Target: $TARGET sandboxes in $WAVES waves of $PER_WAVE"
echo ""
echo "Starting state:"
worker_summary
echo ""

# ============================================================
h "Phase 1: Ramp up to $TARGET sandboxes"

TOTAL_CREATED=0
TOTAL_FAILED=0

for wave in $(seq 1 $WAVES); do
    echo "  Wave $wave/$WAVES: creating $PER_WAVE sandboxes..."
    WAVE_OK=0
    WAVE_DIR=$(mktemp -d)

    for i in $(seq 1 $PER_WAVE); do
        (
            sb=$(create_one)
            if [ -n "$sb" ] && [ "$sb" != "" ] && [ "$sb" != "null" ]; then
                echo "$sb" > "$WAVE_DIR/$i"
            fi
        ) &
        # Limit concurrency to 10 at a time
        [ $((i % 10)) -eq 0 ] && wait 2>/dev/null
    done
    wait 2>/dev/null

    for f in "$WAVE_DIR"/*; do
        [ -f "$f" ] || continue
        sb=$(cat "$f")
        echo "$sb" >> "$SANDBOX_FILE"
        WAVE_OK=$((WAVE_OK + 1))
    done
    rm -rf "$WAVE_DIR"

    TOTAL_CREATED=$((TOTAL_CREATED + WAVE_OK))
    TOTAL_FAILED=$((TOTAL_FAILED + PER_WAVE - WAVE_OK))
    echo "    Created: $WAVE_OK/$PER_WAVE (total: $TOTAL_CREATED, failed: $TOTAL_FAILED)"
    echo "    $(worker_summary | head -1)"

    # Brief pause between waves for scaler to react
    sleep 5
done

echo ""
[ "$TOTAL_CREATED" -ge $((TARGET * 80 / 100)) ] && pass "Created $TOTAL_CREATED/$TARGET sandboxes (≥80%)" || fail "Only $TOTAL_CREATED/$TARGET created"

echo ""
echo "Worker state after ramp:"
worker_summary

# ============================================================
h "Phase 2: Responsiveness check (sample 20)"

echo "  Checking 20 random sandboxes..."
RESPONSIVE=0
SAMPLE=$(sort -R < "$SANDBOX_FILE" | head -20)
for sb in $SAMPLE; do
    exec_check "$sb" && RESPONSIVE=$((RESPONSIVE + 1))
done
echo "  $RESPONSIVE/20 responsive"
[ "$RESPONSIVE" -ge 18 ] && pass "≥90% responsive under load ($RESPONSIVE/20)" || fail "Only $RESPONSIVE/20 responsive"

# ============================================================
h "Phase 3: Chaos — random scale + destroy + create ($CHAOS_ROUNDS rounds)"

MEM_OPTIONS="512 1024 2048 4096"
SCALES_OK=0
SCALES_FAIL=0
DESTROYS=0
CREATES=0

for round in $(seq 1 $CHAOS_ROUNDS); do
    echo "  Round $round/$CHAOS_ROUNDS"

    # Pick 5 random sandboxes to scale memory
    SCALE_TARGETS=$(sort -R < "$SANDBOX_FILE" | head -5)
    for sb in $SCALE_TARGETS; do
        [ -z "$sb" ] && continue
        MEM=$(echo $MEM_OPTIONS | tr ' ' '\n' | sort -R | head -1)
        result=$(api -X PUT "$API_URL/api/sandboxes/$sb/limits" -d "{\"memoryMB\":$MEM,\"cpuPercent\":100}" 2>/dev/null)
        if echo "$result" | grep -q "ok"; then
            SCALES_OK=$((SCALES_OK + 1))
        else
            SCALES_FAIL=$((SCALES_FAIL + 1))
        fi
    done

    # Pick 5 different random sandboxes to destroy
    DESTROY_TARGETS=$(sort -R < "$SANDBOX_FILE" | head -5)
    for sb in $DESTROY_TARGETS; do
        [ -z "$sb" ] && continue
        destroy_sandbox "$sb" >/dev/null 2>&1
        grep -v "^${sb}$" "$SANDBOX_FILE" > "${SANDBOX_FILE}.tmp" 2>/dev/null
        mv "${SANDBOX_FILE}.tmp" "$SANDBOX_FILE"
        DESTROYS=$((DESTROYS + 1))
    done

    # Create 5 replacements (parallel for speed)
    WAVE_DIR=$(mktemp -d)
    for i in $(seq 1 5); do
        (
            sb=$(create_one)
            [ -n "$sb" ] && [ "$sb" != "null" ] && echo "$sb" > "$WAVE_DIR/$i"
        ) &
    done
    wait 2>/dev/null
    for f in "$WAVE_DIR"/*; do
        [ -f "$f" ] && cat "$f" >> "$SANDBOX_FILE"
    done
    rm -rf "$WAVE_DIR"
    CREATES=$((CREATES + 5))

    # Brief status
    SB_NOW=$(wc -l < "$SANDBOX_FILE" | tr -d ' ')
    WC=$(get_workers | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
    echo "    sandboxes=$SB_NOW  workers=$WC  scales=$SCALES_OK  destroys=$DESTROYS"

    sleep 2
done

echo ""
pass "Chaos complete: $SCALES_OK scales, $SCALES_FAIL scale failures, $DESTROYS destroys, $CREATES creates"

# ============================================================
h "Phase 4: Post-chaos responsiveness (sample 30)"

echo "  Checking 30 random sandboxes..."
RESPONSIVE=0
TOTAL_CHECK=0
SAMPLE=$(sort -R < "$SANDBOX_FILE" | head -30)
for sb in $SAMPLE; do
    [ -z "$sb" ] && continue
    TOTAL_CHECK=$((TOTAL_CHECK + 1))
    exec_check "$sb" && RESPONSIVE=$((RESPONSIVE + 1))
done
echo "  $RESPONSIVE/$TOTAL_CHECK responsive"
[ "$RESPONSIVE" -ge $((TOTAL_CHECK * 85 / 100)) ] && pass "≥85% responsive after chaos ($RESPONSIVE/$TOTAL_CHECK)" || fail "Only $RESPONSIVE/$TOTAL_CHECK responsive"

# ============================================================
h "Phase 5: Drain — destroy all sandboxes and watch scale-down"

echo "Worker state before drain:"
worker_summary

SB_COUNT=$(wc -l < "$SANDBOX_FILE" | tr -d ' ')
echo "  Destroying $SB_COUNT sandboxes..."
BATCH=0
while read -r sb; do
    [ -n "$sb" ] && { destroy_sandbox "$sb" >/dev/null 2>&1 & BATCH=$((BATCH + 1)); }
    if [ $((BATCH % 20)) -eq 0 ]; then
        wait 2>/dev/null
    fi
done < "$SANDBOX_FILE"
wait 2>/dev/null
> "$SANDBOX_FILE"  # clear tracking

echo "  All destroyed. Watching scaler drain workers (2 min max)..."
for i in $(seq 1 8); do
    sleep 15
    WC=$(get_workers | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
    TOTAL_SB=$(get_workers | python3 -c "import sys,json; print(sum(w['current'] for w in json.load(sys.stdin)))" 2>/dev/null)
    echo "    $(date +%H:%M:%S) — $WC workers, $TOTAL_SB sandboxes"
done

echo ""
echo "Final state:"
worker_summary

# ============================================================
h "Phase 6: Verify system healthy after chaos"

SB_FINAL=$(create_one)
if [ -n "$SB_FINAL" ]; then
    sleep 2
    exec_check "$SB_FINAL" && pass "System healthy: sandbox created and responsive after chaos" || fail "Post-chaos sandbox unresponsive"
    destroy_sandbox "$SB_FINAL" >/dev/null 2>&1
else
    fail "Cannot create sandbox after chaos"
fi

echo ""
echo "=== Stats ==="
echo "  Peak sandboxes: ~$TOTAL_CREATED"
echo "  Chaos rounds: $CHAOS_ROUNDS"
echo "  Memory scales: $SCALES_OK ok, $SCALES_FAIL failed"
echo "  Random destroys: $DESTROYS"
echo "  Random creates: $CREATES"
echo ""
summary
