#!/usr/bin/env bash
# 41-checkpoint-retention.sh — Checkpoint create with delete_oldest retention
source "$(dirname "$0")/common.sh"

TIMEOUT=60
MAX_COUNT="${MAX_COUNT:-10}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-900}"
RETENTION_ONLY="${RETENTION_ONLY:-0}"
SANDBOXES=()

cleanup() {
    for sb in "${SANDBOXES[@]}"; do destroy_sandbox "$sb"; done
}
trap cleanup EXIT

checkpoint_body() {
    local name="$1"
    python3 - "$name" "$MAX_COUNT" <<'PY'
import json
import sys

name = sys.argv[1]
max_count = int(sys.argv[2])
print(json.dumps({
    "name": name,
    "retentionPolicy": {
        "mode": "delete_oldest",
        "maxCount": max_count,
    },
}))
PY
}

wait_checkpoint_ready() {
    local sb="$1" name="$2" deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
        local body status
        body=$(api "$API_URL/api/sandboxes/$sb/checkpoints")
        status=$(CHECKPOINT_NAME="$name" python3 -c '
import json
import os
import sys

name = os.environ["CHECKPOINT_NAME"]
for cp in json.load(sys.stdin):
    if cp.get("name") == name:
        print(cp.get("status", ""))
        break
' <<<"$body" 2>/dev/null || true)
        case "$status" in
            ready) return 0 ;;
            failed) return 1 ;;
        esac
        sleep 5
    done
    return 1
}

checkpoint_names() {
    local sb="$1"
    local body
    body=$(api "$API_URL/api/sandboxes/$sb/checkpoints")
    python3 -c '
import json
import sys

for cp in json.load(sys.stdin):
    print(cp.get("name", ""))
' <<<"$body"
}

h "Checkpoint retention"

if [ "$MAX_COUNT" -lt 1 ] || [ "$MAX_COUNT" -gt 10 ]; then
    fail "MAX_COUNT must be between 1 and 10"
    summary
fi

SB=$(create_sandbox 3600)
SANDBOXES+=("$SB")
wait_for_sandbox "$SB" 30 && pass "Sandbox running: $SB" || { fail "Sandbox not running"; summary; }

PREFIX="retention-$(date +%s)"
TOTAL=$((MAX_COUNT + 1))

for i in $(seq 1 "$TOTAL"); do
    name="$PREFIX-$i"
    body=$(checkpoint_body "$name")
    result=$(api -X POST "$API_URL/api/sandboxes/$SB/checkpoints" -d "$body")
    cp_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
    if [ -z "$cp_id" ]; then
        fail "Create checkpoint $i failed: $result"
        summary
    fi
    pass "Created checkpoint $i/$TOTAL: $name ($cp_id)"

    if [ "$RETENTION_ONLY" = "1" ] && [ "$i" -eq "$TOTAL" ]; then
        pass "Retention checkpoint accepted without hard-cap error"
        break
    fi

    if wait_checkpoint_ready "$SB" "$name"; then
        pass "Checkpoint ready: $name"
    else
        fail "Checkpoint did not become ready: $name"
        summary
    fi
done

names=$(checkpoint_names "$SB")
count=$(printf '%s\n' "$names" | sed '/^$/d' | wc -l | tr -d ' ')

if [ "$count" = "$MAX_COUNT" ]; then
    pass "Checkpoint count retained at $MAX_COUNT"
else
    fail "Checkpoint count is $count, expected $MAX_COUNT"
fi

if printf '%s\n' "$names" | grep -qx "$PREFIX-1"; then
    fail "Oldest checkpoint still exists after retention"
else
    pass "Oldest checkpoint was deleted by retention"
fi

if printf '%s\n' "$names" | grep -qx "$PREFIX-$TOTAL"; then
    pass "Newest checkpoint exists after retention"
else
    fail "Newest checkpoint missing after retention"
fi

summary
