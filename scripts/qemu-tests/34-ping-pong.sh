#!/usr/bin/env bash
# 34-ping-pong.sh — Migrate a sandbox back and forth 20 times between two workers
#
# Verifies: migration reliability, data persistence, route cache invalidation,
# agent reconnection, and that the sandbox stays fully responsive throughout.

source "$(dirname "$0")/common.sh"

SB=""
cleanup() { [ -n "$SB" ] && destroy_sandbox "$SB"; }
trap cleanup EXIT INT TERM

# Get workers
WORKERS=$(api "$API_URL/api/workers" 2>/dev/null)
W1=$(echo "$WORKERS" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['worker_id'])" 2>/dev/null)
W2=$(echo "$WORKERS" | python3 -c "import sys,json; print(json.load(sys.stdin)[1]['worker_id'])" 2>/dev/null)

if [ -z "$W1" ] || [ -z "$W2" ]; then
    echo "Need 2 workers. Found: $WORKERS"
    exit 1
fi

echo "Workers: $W1 ↔ $W2"
echo ""

# Create sandbox
h "Setup"
SB=$(create_sandbox 0)
echo "  Sandbox: $SB"

# Write a marker file we'll verify after every migration
exec_run "$SB" "sh" "-c" "echo ping-pong-marker-12345 > /workspace/marker.txt" >/dev/null 2>&1
MARKER=$(exec_stdout "$SB" "cat" "/workspace/marker.txt" 2>/dev/null)
echo "  Marker: $MARKER"

# Figure out which worker it's on now
CURRENT=$(api "$API_URL/api/sandboxes/$SB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null)
echo "  Starting on: $CURRENT"

h "Ping Pong — 20 migrations"

PASS_COUNT=0
FAIL_COUNT=0

for i in $(seq 1 20); do
    # Pick target (the other worker)
    if [ "$CURRENT" = "$W1" ]; then
        TARGET="$W2"
    else
        TARGET="$W1"
    fi

    printf "  %2d. %s → %s ... " "$i" "$CURRENT" "$TARGET"

    # Migrate
    START=$(python3 -c "import time; print(int(time.time()*1000))")
    RESULT=$(TIMEOUT=180 api -X POST "$API_URL/api/sandboxes/$SB/migrate" -d "{\"targetWorker\":\"$TARGET\"}" 2>/dev/null)
    END=$(python3 -c "import time; print(int(time.time()*1000))")
    DURATION=$((END - START))

    # Check for errors
    if echo "$RESULT" | grep -qi "error"; then
        printf "\033[31mFAIL\033[0m migration error: %s\n" "$RESULT"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify exec works
    OUT=$(exec_stdout "$SB" "echo" "alive" 2>/dev/null)
    if [ "$OUT" != "alive" ]; then
        printf "\033[31mFAIL\033[0m exec returned: %s (%dms)\n" "$OUT" "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify marker file survived
    CHECK=$(exec_stdout "$SB" "cat" "/workspace/marker.txt" 2>/dev/null)
    if [ "$CHECK" != "$MARKER" ]; then
        printf "\033[31mFAIL\033[0m marker lost: got '%s' (%dms)\n" "$CHECK" "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Verify it's on the expected worker now
    NEW_WORKER=$(api "$API_URL/api/sandboxes/$SB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerID',''))" 2>/dev/null)
    if [ "$NEW_WORKER" != "$TARGET" ]; then
        printf "\033[31mFAIL\033[0m worker mismatch: expected %s got %s (%dms)\n" "$TARGET" "$NEW_WORKER" "$DURATION"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    printf "\033[32m✓\033[0m %dms\n" "$DURATION"
    PASS_COUNT=$((PASS_COUNT + 1))
    CURRENT="$TARGET"
done

echo ""
h "Results"
echo "  $PASS_COUNT/20 successful migrations"
echo "  $FAIL_COUNT/20 failures"

PASS=0; FAIL=0; SKIP=0
[ "$PASS_COUNT" -eq 20 ] && pass "All 20 ping-pong migrations succeeded" || fail "$FAIL_COUNT/20 migrations failed"
[ "$FAIL_COUNT" -eq 0 ] && pass "Sandbox stayed alive through all migrations" || fail "Sandbox died or lost data"

summary
