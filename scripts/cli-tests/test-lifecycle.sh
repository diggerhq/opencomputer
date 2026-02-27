#!/usr/bin/env bash
#
# Sandbox Lifecycle Test
#
# Tests:
#   1. Create sandbox with different templates
#   2. List sandboxes
#   3. Get sandbox details
#   4. Set timeout
#   5. Kill sandbox

set -uo pipefail

OSB="${OSB:-osb}"

# Colors
GREEN="\033[32m"
RED="\033[31m"
BOLD="\033[1m"
DIM="\033[2m"
RESET="\033[0m"

PASSED=0
FAILED=0

check() {
    local desc="$1"
    shift
    if eval "$@"; then
        echo -e "${GREEN}✓ $desc${RESET}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗ $desc${RESET}"
        FAILED=$((FAILED + 1))
    fi
}

cleanup() {
    if [[ -n "${SANDBOX_ID:-}" ]]; then
        $OSB sandbox kill "$SANDBOX_ID" 2>/dev/null || true
    fi
    if [[ -n "${CUSTOM_ID:-}" ]]; then
        $OSB sandbox kill "$CUSTOM_ID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

echo -e "${BOLD}\n╔══════════════════════════════════════════════════╗"
echo "║       Sandbox Lifecycle Test                     ║"
echo -e "╚══════════════════════════════════════════════════╝${RESET}\n"

# Helper to extract sandbox ID from create output
# Output format: "✓ Sandbox created: sb-xxxxxxxx"
extract_sandbox_id() {
    echo "$1" | grep -oE 'sb-[a-f0-9]+' | head -1
}

# ── Test 1: Create sandbox ──────────────────────────────────────
echo -e "${BOLD}━━━ Test 1: Create sandbox ━━━${RESET}\n"

OUTPUT=$($OSB sandbox create --template ubuntu --timeout 300 2>&1)
SANDBOX_ID=$(extract_sandbox_id "$OUTPUT")

check "Sandbox created" '[[ -n "$SANDBOX_ID" ]]'
check "Output contains status" 'echo "$OUTPUT" | grep -q running'
echo

# ── Test 2: List sandboxes ──────────────────────────────────────
echo -e "${BOLD}━━━ Test 2: List sandboxes ━━━${RESET}\n"

LIST_OUTPUT=$($OSB sandbox list 2>&1)
check "List contains our sandbox" 'echo "$LIST_OUTPUT" | grep -q "$SANDBOX_ID"'
check "List shows running status" 'echo "$LIST_OUTPUT" | grep -q running'
echo

# ── Test 3: Get sandbox details ─────────────────────────────────
echo -e "${BOLD}━━━ Test 3: Get sandbox details ━━━${RESET}\n"

GET_OUTPUT=$($OSB sandbox get "$SANDBOX_ID" 2>&1)
check "Get shows sandbox ID" 'echo "$GET_OUTPUT" | grep -q "$SANDBOX_ID"'
check "Get shows status" 'echo "$GET_OUTPUT" | grep -q running'

# Test JSON output
JSON_OUTPUT=$($OSB sandbox get "$SANDBOX_ID" --json 2>&1)
check "JSON output is valid" 'echo "$JSON_OUTPUT" | jq . >/dev/null 2>&1'
check "JSON contains sandboxID" 'echo "$JSON_OUTPUT" | grep -q sandboxID'
echo

# ── Test 4: Set timeout ─────────────────────────────────────────
echo -e "${BOLD}━━━ Test 4: Set timeout ━━━${RESET}\n"

TIMEOUT_OUTPUT=$($OSB sandbox timeout "$SANDBOX_ID" 600 2>&1)
check "Timeout set successfully" 'echo "$TIMEOUT_OUTPUT" | grep -qiE "timeout|600"'
echo

# ── Test 5: Create with custom config ───────────────────────────
echo -e "${BOLD}━━━ Test 5: Create with custom config ━━━${RESET}\n"

CUSTOM_OUTPUT=$($OSB sandbox create --template ubuntu --cpus 2 --memory 2048 --timeout 600 2>&1)
CUSTOM_ID=$(extract_sandbox_id "$CUSTOM_OUTPUT")

check "Custom sandbox created" '[[ -n "$CUSTOM_ID" ]]'

# Verify sandbox is running
CUSTOM_GET=$($OSB sandbox get "$CUSTOM_ID" 2>&1)
check "Custom sandbox is running" 'echo "$CUSTOM_GET" | grep -q running'

# Cleanup custom sandbox
$OSB sandbox kill "$CUSTOM_ID" >/dev/null 2>&1
CUSTOM_ID=""
echo

# ── Test 6: Kill sandbox ────────────────────────────────────────
echo -e "${BOLD}━━━ Test 6: Kill sandbox ━━━${RESET}\n"

KILL_OUTPUT=$($OSB sandbox kill "$SANDBOX_ID" 2>&1)
check "Kill command succeeded" 'echo "$KILL_OUTPUT" | grep -q killed'

# Verify sandbox is gone
sleep 2
LIST_AFTER=$($OSB sandbox list 2>&1 || true)
check "Sandbox not in list after kill" '! echo "$LIST_AFTER" | grep -q "$SANDBOX_ID"'

SANDBOX_ID=""  # Clear so cleanup doesnt try to kill again
echo

# --- Summary ---
echo -e "${BOLD}========================================"
echo " Results: $PASSED passed, $FAILED failed"
echo -e "========================================${RESET}\n"

[[ $FAILED -eq 0 ]]
