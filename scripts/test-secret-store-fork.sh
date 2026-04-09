#!/usr/bin/env bash
# test-secret-store-fork.sh — Test attaching a secret store at snapshot fork time
#
# Tests the new feature: creating from a snapshot that has NO secret store,
# but attaching one at fork time.
#
# Usage:
#   OPENSANDBOX_API_URL=http://20.114.60.29:8080 \
#   OPENSANDBOX_API_KEY=osb_xxx \
#   bash scripts/test-secret-store-fork.sh

set -eo pipefail

API="${OPENSANDBOX_API_URL:?}"
KEY="${OPENSANDBOX_API_KEY:?}"

api() {
    curl -s -H "X-API-Key: $KEY" -H "Content-Type: application/json" "$@"
}

exec_run() {
    # Execute a command and return stdout
    local sb="$1"; shift
    local cmd="$1"; shift
    api -X POST "$API/api/sandboxes/$sb/exec/run" -d "{\"cmd\":\"$cmd\"}" | \
        python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout',''))" 2>/dev/null
}

pass() { printf "  \033[32m✓ %s\033[0m\n" "$1"; }
fail() { printf "  \033[31m✗ %s\033[0m\n" "$1"; exit 1; }
h()    { printf "\n\033[1;34m=== %s ===\033[0m\n" "$1"; }

# Cleanup on exit
SANDBOX_IDS=()
STORE_ID=""
SNAP_NAME="test-no-secrets-snap-$$"
cleanup() {
    echo ""
    echo "=== Cleanup ==="
    for sb in "${SANDBOX_IDS[@]}"; do
        api -X DELETE "$API/api/sandboxes/$sb" >/dev/null 2>&1 || true
        echo "  Destroyed $sb"
    done
    api -X DELETE "$API/api/snapshots/$SNAP_NAME" >/dev/null 2>&1 || true
    echo "  Deleted snapshot $SNAP_NAME"
    if [ -n "$STORE_ID" ]; then
        api -X DELETE "$API/api/secret-stores/$STORE_ID" >/dev/null 2>&1 || true
        echo "  Deleted secret store $STORE_ID"
    fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────
h "Step 1: Create a secret store with a test secret"

STORE=$(api -X POST "$API/api/secret-stores" -d '{"name":"test-fork-store"}')
STORE_ID=$(echo "$STORE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Store ID: $STORE_ID"

# Add a secret
api -X PUT "$API/api/secret-stores/$STORE_ID/secrets/MY_SECRET" \
    -d '{"value":"super-secret-value-123"}' >/dev/null
pass "Created store 'test-fork-store' with MY_SECRET"

# ─────────────────────────────────────────────────────────
h "Step 2: Create a named snapshot (no secret store)"

echo "  Creating snapshot '$SNAP_NAME' from default image..."
SNAP_RESULT=$(api -X POST "$API/api/snapshots" \
    -d "{\"name\":\"$SNAP_NAME\",\"image\":{\"template\":\"default\"}}")
echo "  Result: $(echo "$SNAP_RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('status', r.get('error','unknown')))" 2>/dev/null)"

# Wait for snapshot to be ready
echo "  Waiting for snapshot to be ready..."
for i in $(seq 1 30); do
    SNAP_STATUS=$(api "$API/api/snapshots/$SNAP_NAME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
    [ "$SNAP_STATUS" = "ready" ] && break
    [ "$SNAP_STATUS" = "failed" ] && fail "Snapshot creation failed"
    sleep 2
done
[ "$SNAP_STATUS" = "ready" ] && pass "Snapshot ready" || fail "Snapshot not ready after 60s (status=$SNAP_STATUS)"

# ─────────────────────────────────────────────────────────
h "Step 3: Fork from snapshot WITHOUT secrets (baseline)"

SB1=$(api -X POST "$API/api/sandboxes" -d "{\"snapshot\":\"$SNAP_NAME\"}")
SB1_ID=$(echo "$SB1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)
if [ -z "$SB1_ID" ]; then
    echo "  Response: $SB1"
    fail "Failed to create baseline sandbox"
fi
SANDBOX_IDS+=("$SB1_ID")
echo "  Sandbox: $SB1_ID"
sleep 5

ENV_OUT=$(exec_run "$SB1_ID" "env")
if echo "$ENV_OUT" | grep -q "MY_SECRET"; then
    fail "Baseline sandbox has MY_SECRET — should be clean"
else
    pass "Baseline fork has no MY_SECRET (clean)"
fi

# ─────────────────────────────────────────────────────────
h "Step 4: Fork from snapshot WITH secret store attached (new feature)"

SB2=$(api -X POST "$API/api/sandboxes" \
    -d "{\"snapshot\":\"$SNAP_NAME\",\"secretStore\":\"test-fork-store\"}")
SB2_ID=$(echo "$SB2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)

if [ -z "$SB2_ID" ] || [ "$SB2_ID" = "null" ]; then
    echo "  Response: $SB2"
    fail "Fork with secret store failed"
fi
SANDBOX_IDS+=("$SB2_ID")
echo "  Sandbox: $SB2_ID"
pass "Fork with secret store created"

sleep 5

# ─────────────────────────────────────────────────────────
h "Step 5: Verify secret is available in forked sandbox"

ENV_OUT2=$(exec_run "$SB2_ID" "env")

if echo "$ENV_OUT2" | grep -q "MY_SECRET=osb_sealed_"; then
    SEALED=$(echo "$ENV_OUT2" | grep MY_SECRET)
    echo "  $SEALED"
    pass "Secret injected as sealed token (proxy substitutes on HTTPS)"
elif echo "$ENV_OUT2" | grep -q "MY_SECRET=super-secret"; then
    fail "SECRET LEAKED AS PLAINTEXT — security issue"
elif echo "$ENV_OUT2" | grep -q "MY_SECRET"; then
    SEALED=$(echo "$ENV_OUT2" | grep MY_SECRET)
    echo "  $SEALED"
    pass "Secret injected (format may vary)"
else
    echo "  env output (no MY_SECRET found):"
    echo "$ENV_OUT2" | head -10
    fail "MY_SECRET not found in forked sandbox"
fi

# Check for proxy env vars (indicates secrets proxy is active)
if echo "$ENV_OUT2" | grep -q "HTTP_PROXY\|HTTPS_PROXY"; then
    pass "Secrets proxy configured (HTTP_PROXY/HTTPS_PROXY set)"
else
    echo "  Warning: no HTTP_PROXY in env — proxy may not be configured"
fi

# ─────────────────────────────────────────────────────────
h "Step 6: Verify baseline sandbox still clean"

ENV_OUT3=$(exec_run "$SB1_ID" "env")
if echo "$ENV_OUT3" | grep -q "MY_SECRET"; then
    fail "Baseline sandbox now has MY_SECRET — contamination"
else
    pass "Baseline sandbox still clean"
fi

echo ""
echo "=== All tests passed ==="
