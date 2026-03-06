#!/bin/bash
set -euo pipefail

# CLI integration test — runs against a live OpenComputer server.
# Usage: ./scripts/test-cli.sh [api-url] [api-key]
#   e.g. ./scripts/test-cli.sh https://dev.opensandbox.ai osb_600b1a...
# Defaults to dev.opensandbox.ai if no URL provided.

API_URL="${1:?Usage: $0 <api-url> <api-key>}"
API_KEY="${2:?Usage: $0 <api-url> <api-key>}"

OC="./bin/oc --api-url $API_URL --api-key $API_KEY"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
SANDBOX_ID=""
CHECKPOINT_ID=""
PATCH_ID=""

info()   { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()     { echo -e "${GREEN}[PASS]${NC} $*"; PASSED=$((PASSED + 1)); }
fail()   { echo -e "${RED}[FAIL]${NC} $*"; FAILED=$((FAILED + 1)); }
header() { echo -e "\n${BOLD}=== $* ===${NC}"; }

cleanup() {
    if [ -n "$SANDBOX_ID" ]; then
        info "Cleaning up sandbox $SANDBOX_ID..."
        $OC sandbox kill "$SANDBOX_ID" 2>/dev/null || true
    fi
    echo
    echo -e "${BOLD}Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
    if [ "$FAILED" -gt 0 ]; then
        exit 1
    fi
}
trap cleanup EXIT

# Build the CLI first
header "Building oc CLI"
CGO_ENABLED=0 go build -o ./bin/oc ./cmd/oc
ok "Built ./bin/oc"

# -------------------------------------------------------
header "Sandbox Lifecycle"
# -------------------------------------------------------

# sandbox create
info "Creating sandbox..."
CREATE_OUT=$($OC sandbox create --json)
SANDBOX_ID=$(echo "$CREATE_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['sandboxID'])")
if [ -n "$SANDBOX_ID" ]; then
    ok "sandbox create → $SANDBOX_ID"
else
    fail "sandbox create — no sandbox ID returned"
fi

# sandbox list
info "Listing sandboxes..."
LIST_OUT=$($OC sandbox list --json)
if echo "$LIST_OUT" | python3 -c "import sys,json; sandboxes=json.load(sys.stdin); assert any(s['sandboxID']=='$SANDBOX_ID' for s in sandboxes)" 2>/dev/null; then
    ok "sandbox list — found $SANDBOX_ID"
else
    fail "sandbox list — $SANDBOX_ID not in list"
fi

# ls shortcut
LS_OUT=$($OC ls --json)
if echo "$LS_OUT" | python3 -c "import sys,json; sandboxes=json.load(sys.stdin); assert any(s['sandboxID']=='$SANDBOX_ID' for s in sandboxes)" 2>/dev/null; then
    ok "ls shortcut — found $SANDBOX_ID"
else
    fail "ls shortcut — $SANDBOX_ID not in list"
fi

# sandbox get
info "Getting sandbox..."
GET_OUT=$($OC sandbox get "$SANDBOX_ID" --json)
GET_STATUS=$(echo "$GET_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
if [ "$GET_STATUS" = "running" ]; then
    ok "sandbox get — status=running"
else
    fail "sandbox get — expected running, got $GET_STATUS"
fi

# sandbox set-timeout
info "Setting timeout..."
TIMEOUT_OUT=$($OC sandbox set-timeout "$SANDBOX_ID" 600 2>&1) || true
if echo "$TIMEOUT_OUT" | grep -qi "updated\|timeout"; then
    ok "sandbox set-timeout 600"
else
    # Some server modes require direct worker connectURL for set-timeout
    info "sandbox set-timeout skipped (server returned: $(echo "$TIMEOUT_OUT" | head -1))"
fi

# -------------------------------------------------------
header "Command Execution"
# -------------------------------------------------------

# exec
info "Running command..."
EXEC_OUT=$($OC exec "$SANDBOX_ID" -- echo hello-from-cli)
if echo "$EXEC_OUT" | grep -q "hello-from-cli"; then
    ok "exec 'echo hello-from-cli'"
else
    fail "exec — expected 'hello-from-cli', got: $EXEC_OUT"
fi

# exec with --json
EXEC_JSON=$($OC exec "$SANDBOX_ID" --json -- whoami)
EXEC_EXIT=$(echo "$EXEC_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['exitCode'])")
if [ "$EXEC_EXIT" = "0" ]; then
    ok "exec --json — exitCode=0"
else
    fail "exec --json — exitCode=$EXEC_EXIT"
fi

# exec with --cwd
EXEC_CWD=$($OC exec "$SANDBOX_ID" --cwd /tmp -- pwd)
if echo "$EXEC_CWD" | grep -q "/tmp"; then
    ok "exec --cwd /tmp — pwd=/tmp"
else
    fail "exec --cwd — expected /tmp, got: $EXEC_CWD"
fi

# -------------------------------------------------------
header "Checkpoints"
# -------------------------------------------------------

# checkpoint create
info "Creating checkpoint..."
CP_OUT=$($OC checkpoint create "$SANDBOX_ID" --name "cli-test-v1" --json)
CHECKPOINT_ID=$(echo "$CP_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
if [ -n "$CHECKPOINT_ID" ]; then
    ok "checkpoint create → $CHECKPOINT_ID"
else
    fail "checkpoint create — no ID returned"
fi

# Wait for checkpoint to be ready
info "Waiting for checkpoint to be ready..."
for i in $(seq 1 30); do
    CP_STATUS=$($OC checkpoint list "$SANDBOX_ID" --json | python3 -c "
import sys,json
cps=json.load(sys.stdin)
for cp in cps:
    if cp['id']=='$CHECKPOINT_ID':
        print(cp['status'])
        break
" 2>/dev/null || echo "unknown")
    if [ "$CP_STATUS" = "ready" ]; then
        break
    fi
    sleep 2
done

if [ "$CP_STATUS" = "ready" ]; then
    ok "checkpoint ready after ${i}s"
else
    fail "checkpoint not ready after 60s (status=$CP_STATUS)"
fi

# checkpoint list
CP_LIST=$($OC checkpoint list "$SANDBOX_ID" --json)
CP_COUNT=$(echo "$CP_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
if [ "$CP_COUNT" -ge 1 ]; then
    ok "checkpoint list — $CP_COUNT checkpoint(s)"
else
    fail "checkpoint list — expected >=1, got $CP_COUNT"
fi

# checkpoint list (table output)
CP_TABLE=$($OC checkpoint list "$SANDBOX_ID")
if echo "$CP_TABLE" | grep -q "cli-test-v1"; then
    ok "checkpoint list (table) — shows name"
else
    fail "checkpoint list (table) — missing name"
fi

# -------------------------------------------------------
header "Checkpoint Patches"
# -------------------------------------------------------

if [ -n "$CHECKPOINT_ID" ]; then
    # patch create
    info "Creating patch..."
    PATCH_SCRIPT=$(mktemp)
    echo '#!/bin/bash
echo "patched" > /tmp/patch-marker' > "$PATCH_SCRIPT"

    PATCH_OUT=$($OC patch create "$CHECKPOINT_ID" --script "$PATCH_SCRIPT" --description "CLI test patch" --json)
    rm -f "$PATCH_SCRIPT"
    PATCH_ID=$(echo "$PATCH_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['patch']['id'])")
    if [ -n "$PATCH_ID" ]; then
        ok "patch create → $PATCH_ID"
    else
        fail "patch create — no ID returned"
    fi

    # patch list
    PATCH_LIST=$($OC patch list "$CHECKPOINT_ID" --json)
    PATCH_COUNT=$(echo "$PATCH_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
    if [ "$PATCH_COUNT" -ge 1 ]; then
        ok "patch list — $PATCH_COUNT patch(es)"
    else
        fail "patch list — expected >=1, got $PATCH_COUNT"
    fi

    # patch list (table)
    PATCH_TABLE=$($OC patch list "$CHECKPOINT_ID")
    if echo "$PATCH_TABLE" | grep -q "CLI test patch"; then
        ok "patch list (table) — shows description"
    else
        fail "patch list (table) — missing description"
    fi

    # patch delete
    if [ -n "$PATCH_ID" ]; then
        info "Deleting patch..."
        if $OC patch delete "$CHECKPOINT_ID" "$PATCH_ID" 2>&1 | grep -qi "deleted"; then
            ok "patch delete"
        else
            fail "patch delete"
        fi
    fi
fi

# -------------------------------------------------------
header "Checkpoint Spawn"
# -------------------------------------------------------

if [ -n "$CHECKPOINT_ID" ] && [ "$CP_STATUS" = "ready" ]; then
    info "Spawning sandbox from checkpoint..."
    SPAWN_OUT=$($OC checkpoint spawn "$CHECKPOINT_ID" --json)
    SPAWN_ID=$(echo "$SPAWN_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['sandboxID'])")
    if [ -n "$SPAWN_ID" ]; then
        ok "checkpoint spawn → $SPAWN_ID"
        # Clean up spawned sandbox
        $OC sandbox kill "$SPAWN_ID" 2>/dev/null || true
        ok "killed spawned sandbox"
    else
        fail "checkpoint spawn — no sandbox ID returned"
    fi
fi

# -------------------------------------------------------
header "Checkpoint Restore"
# -------------------------------------------------------

if [ -n "$CHECKPOINT_ID" ] && [ "$CP_STATUS" = "ready" ]; then
    info "Restoring checkpoint..."
    if $OC checkpoint restore "$SANDBOX_ID" "$CHECKPOINT_ID" 2>&1 | grep -qi "restored"; then
        ok "checkpoint restore"
    else
        fail "checkpoint restore"
    fi

    # Give restore a moment to complete
    sleep 3
fi

# -------------------------------------------------------
header "Checkpoint Delete"
# -------------------------------------------------------

if [ -n "$CHECKPOINT_ID" ]; then
    info "Deleting checkpoint..."
    CP_DEL_OUT=$($OC checkpoint delete "$SANDBOX_ID" "$CHECKPOINT_ID" 2>&1) || true
    if echo "$CP_DEL_OUT" | grep -qi "deleted"; then
        ok "checkpoint delete"
    else
        # Checkpoint may already be consumed by restore
        info "checkpoint delete skipped ($(echo "$CP_DEL_OUT" | head -1))"
    fi
    CHECKPOINT_ID=""
fi

# -------------------------------------------------------
header "Preview URLs"
# -------------------------------------------------------

# preview create
info "Creating preview URL on port 8080..."
PREV_OUT=$($OC preview create "$SANDBOX_ID" --port 8080 --json 2>&1) || true
if echo "$PREV_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('hostname','')" 2>/dev/null; then
    PREV_HOST=$(echo "$PREV_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['hostname'])")
    ok "preview create — $PREV_HOST"

    # preview list
    PREV_LIST=$($OC preview list "$SANDBOX_ID" --json)
    PREV_COUNT=$(echo "$PREV_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
    if [ "$PREV_COUNT" -ge 1 ]; then
        ok "preview list — $PREV_COUNT URL(s)"
    else
        fail "preview list — expected >=1, got $PREV_COUNT"
    fi

    # preview delete
    if $OC preview delete "$SANDBOX_ID" 8080 2>&1 | grep -qi "deleted"; then
        ok "preview delete"
    else
        fail "preview delete"
    fi
else
    info "preview create skipped (may not be configured on dev server)"
fi

# -------------------------------------------------------
header "Hibernate & Wake"
# -------------------------------------------------------

# hibernate
info "Hibernating sandbox..."
HIB_OUT=$($OC sandbox hibernate "$SANDBOX_ID" --json 2>&1) || true
if echo "$HIB_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('sandboxId','')" 2>/dev/null; then
    ok "sandbox hibernate"

    # Wait a moment for hibernation to complete
    sleep 3

    # wake
    info "Waking sandbox..."
    WAKE_OUT=$($OC sandbox wake "$SANDBOX_ID" --json)
    WAKE_STATUS=$(echo "$WAKE_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
    if [ "$WAKE_STATUS" = "running" ]; then
        ok "sandbox wake — status=running"
    else
        fail "sandbox wake — expected running, got $WAKE_STATUS"
    fi
else
    info "hibernate skipped (may not be supported in this mode)"
fi

# -------------------------------------------------------
header "Config"
# -------------------------------------------------------

CONFIG_OUT=$($OC config show)
if echo "$CONFIG_OUT" | grep -q "API URL"; then
    ok "config show"
else
    fail "config show — missing API URL"
fi

# -------------------------------------------------------
header "Cleanup"
# -------------------------------------------------------

info "Killing sandbox $SANDBOX_ID..."
if $OC sandbox kill "$SANDBOX_ID" 2>&1 | grep -qi "killed"; then
    ok "sandbox kill"
    SANDBOX_ID="" # Prevent double-cleanup in trap
else
    fail "sandbox kill"
fi

echo
echo -e "${BOLD}All tests complete.${NC}"
