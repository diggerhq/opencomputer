#!/usr/bin/env bash
# 35-ping-pong-random.sh — Migrate a sandbox 20 times to a random worker each time
#
# With 5+ workers, each migration picks a different random target.
# Verifies: multi-worker migration, data persistence, agent reconnection.

source "$(dirname "$0")/common.sh"

ROUNDS="${1:-20}"
SB=""
cleanup() { [ -n "$SB" ] && destroy_sandbox "$SB"; }
trap cleanup EXIT INT TERM

# Get workers
WORKERS_JSON=$(api "$API_URL/api/workers" 2>/dev/null)
WORKER_COUNT=$(echo "$WORKERS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
WORKER_IDS=$(echo "$WORKERS_JSON" | python3 -c "
import sys,json
for w in json.load(sys.stdin):
    print(w['worker_id'])
" 2>/dev/null)

echo "Workers ($WORKER_COUNT):"
echo "$WORKERS_JSON" | python3 -c "
import sys,json
for w in json.load(sys.stdin):
    print(f'  {w[\"worker_id\"]}  ({w[\"current\"]}/{w[\"capacity\"]})')
" 2>/dev/null

if [ "$WORKER_COUNT" -lt 2 ]; then
    echo "Need at least 2 workers."
    exit 1
fi

# Create sandbox
h "Setup"
SB=$(create_sandbox 0)
echo "  Sandbox: $SB"

exec_run "$SB" "sh" "-c" "echo random-ping-pong-$(date +%s) > /workspace/marker.txt" >/dev/null 2>&1
MARKER=$(exec_stdout "$SB" "cat" "/workspace/marker.txt" 2>/dev/null)
echo "  Marker: $MARKER"

CURRENT=$(api "$API_URL/api/sandboxes/$SB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null)
echo "  Starting on: $CURRENT"

h "Random Ping Pong — $ROUNDS migrations across $WORKER_COUNT workers"

PASS_COUNT=0
FAIL_COUNT=0
VISIT_LOG=$(mktemp)

for i in $(seq 1 "$ROUNDS"); do
    # Pick random target from live workers (refreshed each round) that isn't the current
    LIVE_IDS=$(api "$API_URL/api/workers" 2>/dev/null | python3 -c "import sys,json; [print(w['worker_id']) for w in json.load(sys.stdin)]" 2>/dev/null)
    TARGET=$(echo "$LIVE_IDS" | grep -v "^${CURRENT}$" | sort -R | head -1)
    if [ -z "$TARGET" ]; then
        printf "  %2d. SKIP — no live target available\n" "$i"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    printf "  %2d. %s → %s ... " "$i" "${CURRENT##*-}" "${TARGET##*-}"

    START=$(python3 -c "import time; print(int(time.time()*1000))")
    RESULT=$(TIMEOUT=180 api -X POST "$API_URL/api/sandboxes/$SB/migrate" -d "{\"targetWorker\":\"$TARGET\"}" 2>/dev/null)
    END=$(python3 -c "import time; print(int(time.time()*1000))")
    DURATION=$((END - START))

    if echo "$RESULT" | grep -qi "error"; then
        ERR_MSG=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)
        printf "\033[31mFAIL\033[0m %s\n" "$ERR_MSG"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        # Update CURRENT in case sandbox moved or is still on source
        ACTUAL=$(api "$API_URL/api/sandboxes/$SB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null)
        [ -n "$ACTUAL" ] && CURRENT="$ACTUAL"
        continue
    fi

    # Verify exec
    OUT=$(exec_stdout "$SB" "echo" "alive" 2>/dev/null)
    if [ "$OUT" != "alive" ]; then
        printf "\033[31mFAIL\033[0m exec='%s' (%dms)\n" "$OUT" "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify marker
    CHECK=$(exec_stdout "$SB" "cat" "/workspace/marker.txt" 2>/dev/null)
    if [ "$CHECK" != "$MARKER" ]; then
        printf "\033[31mFAIL\033[0m marker lost (%dms)\n" "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify worker assignment
    NEW_WORKER=$(api "$API_URL/api/sandboxes/$SB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null)
    if [ "$NEW_WORKER" != "$TARGET" ]; then
        printf "\033[31mFAIL\033[0m wrong worker: %s (%dms)\n" "${NEW_WORKER##*-}" "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    printf "\033[32m✓\033[0m %dms\n" "$DURATION"
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "$TARGET" >> "$VISIT_LOG"
    CURRENT="$TARGET"
done

echo ""
h "Results"
echo "  $PASS_COUNT/$ROUNDS successful, $FAIL_COUNT failed"
echo ""
echo "  Worker visit distribution:"
UNIQUE_VISITED=0
if [ -s "$VISIT_LOG" ]; then
    for wid in $(sort -u "$VISIT_LOG"); do
        count=$(grep -c "^${wid}$" "$VISIT_LOG" 2>/dev/null || echo "0")
        count=$((count + 0))  # ensure numeric
        bar=$(printf '%*s' "$count" '' | tr ' ' '█')
        printf "    %s  %2d  %s\n" "${wid##*-}" "$count" "$bar"
        UNIQUE_VISITED=$((UNIQUE_VISITED + 1))
    done
fi
rm -f "$VISIT_LOG"

PASS=0; FAIL=0; SKIP=0
[ "$PASS_COUNT" -eq "$ROUNDS" ] && pass "All $ROUNDS random migrations succeeded" || fail "$FAIL_COUNT/$ROUNDS failed"
[ "$UNIQUE_VISITED" -ge 3 ] && pass "Visited $UNIQUE_VISITED unique workers" || fail "Only visited $UNIQUE_VISITED workers"

summary
