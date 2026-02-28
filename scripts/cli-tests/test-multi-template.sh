#!/usr/bin/env bash
#
# Multi-Template Test
#
# Tests:
#   1. Ubuntu template (base)
#   2. Python template
#   3. Node template
#   4. Verify each has appropriate tools
#   5. Template isolation

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
declare -a SANDBOX_IDS=()

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
    for sid in "${SANDBOX_IDS[@]}"; do
        $OSB sandbox kill "$sid" 2>/dev/null || true
    done
}

trap cleanup EXIT

echo -e "${BOLD}\n╔══════════════════════════════════════════════════╗"
echo "║       Multi-Template Test                        ║"
echo -e "╚══════════════════════════════════════════════════╝${RESET}\n"

# Helper to extract sandbox ID
extract_sandbox_id() {
    echo "$1" | grep -oE 'sb-[a-f0-9]+' | head -1
}

# ── Test 1: Ubuntu template ─────────────────────────────────────
echo -e "${BOLD}━━━ Test 1: Ubuntu template ━━━${RESET}\n"

UBUNTU_OUT=$($OSB sandbox create --template ubuntu --timeout 120 2>&1)
UBUNTU_ID=$(extract_sandbox_id "$UBUNTU_OUT")
SANDBOX_IDS+=("$UBUNTU_ID")

check "Ubuntu sandbox created" '[[ -n "$UBUNTU_ID" ]]'
echo -e "${DIM}Ubuntu ID: $UBUNTU_ID${RESET}"

# Verify Ubuntu tools
BASH_CHECK=$($OSB exec "$UBUNTU_ID" bash --version 2>&1)
check "bash available" 'echo "$BASH_CHECK" | grep -q bash'

CURL_CHECK=$($OSB exec "$UBUNTU_ID" curl --version 2>&1)
check "curl available" 'echo "$CURL_CHECK" | grep -q curl'

GIT_CHECK=$($OSB exec "$UBUNTU_ID" git --version 2>&1)
check "git available" 'echo "$GIT_CHECK" | grep -q git'
echo

# ── Test 2: Python template ─────────────────────────────────────
echo -e "${BOLD}━━━ Test 2: Python template ━━━${RESET}\n"

PYTHON_OUT=$($OSB sandbox create --template python --timeout 120 2>&1)
PYTHON_ID=$(extract_sandbox_id "$PYTHON_OUT")
SANDBOX_IDS+=("$PYTHON_ID")

check "Python sandbox created" '[[ -n "$PYTHON_ID" ]]'
echo -e "${DIM}Python ID: $PYTHON_ID${RESET}"

# Verify Python
PYTHON_CHECK=$($OSB exec "$PYTHON_ID" python3 --version 2>&1)
check "python3 available" 'echo "$PYTHON_CHECK" | grep -q "Python 3"'

PIP_CHECK=$($OSB exec "$PYTHON_ID" pip3 --version 2>&1)
check "pip3 available" 'echo "$PIP_CHECK" | grep -q pip'

# Test Python import
IMPORT_CHECK=$($OSB exec "$PYTHON_ID" python3 -c "import sys, json, os; print('ok')" 2>&1)
check "Python stdlib imports work" 'echo "$IMPORT_CHECK" | grep -q ok'
echo

# ── Test 3: Node template ───────────────────────────────────────
echo -e "${BOLD}━━━ Test 3: Node template ━━━${RESET}\n"

NODE_OUT=$($OSB sandbox create --template node --timeout 120 2>&1)
NODE_ID=$(extract_sandbox_id "$NODE_OUT")
SANDBOX_IDS+=("$NODE_ID")

check "Node sandbox created" '[[ -n "$NODE_ID" ]]'
echo -e "${DIM}Node ID: $NODE_ID${RESET}"

# Verify Node
NODE_CHECK=$($OSB exec "$NODE_ID" node --version 2>&1)
check "node available" 'echo "$NODE_CHECK" | grep -q v'

NPM_CHECK=$($OSB exec "$NODE_ID" npm --version 2>&1)
check "npm available" '[[ -n "$NPM_CHECK" ]]'

# Test Node execution
NODE_EXEC=$($OSB shell "$NODE_ID" "node -e \"console.log('hello-node')\"" 2>&1)
check "Node execution works" 'echo "$NODE_EXEC" | grep -q hello-node'

# Test Node fs module
NODE_FS=$($OSB shell "$NODE_ID" "node -e \"const fs = require('fs'); fs.writeFileSync('/tmp/node-test.txt', 'node-data'); console.log('ok');\"" 2>&1)
check "Node fs module works" 'echo "$NODE_FS" | grep -q ok'

NODE_FILE=$($OSB files cat "$NODE_ID" /tmp/node-test.txt 2>&1)
check "Node-written file readable" 'echo "$NODE_FILE" | grep -q node-data'
echo

# ── Test 4: All templates running concurrently ──────────────────
echo -e "${BOLD}━━━ Test 4: All templates running concurrently ━━━${RESET}\n"

LIST_OUT=$($OSB sandbox list 2>&1)
check "Ubuntu sandbox in list" 'echo "$LIST_OUT" | grep -q "$UBUNTU_ID"'
check "Python sandbox in list" 'echo "$LIST_OUT" | grep -q "$PYTHON_ID"'
check "Node sandbox in list" 'echo "$LIST_OUT" | grep -q "$NODE_ID"'

RUNNING_COUNT=$(echo "$LIST_OUT" | grep -c "running" || echo "0")
check "All show running status" '[[ $RUNNING_COUNT -ge 3 ]]'
echo

# ── Test 5: Template isolation ──────────────────────────────────
echo -e "${BOLD}━━━ Test 5: Template isolation ━━━${RESET}\n"

# Write different data to each
$OSB files write "$UBUNTU_ID" /tmp/template.txt "ubuntu" 2>&1
$OSB files write "$PYTHON_ID" /tmp/template.txt "python" 2>&1
$OSB files write "$NODE_ID" /tmp/template.txt "node" 2>&1

# Verify isolation
UBUNTU_CONTENT=$($OSB files cat "$UBUNTU_ID" /tmp/template.txt 2>&1)
PYTHON_CONTENT=$($OSB files cat "$PYTHON_ID" /tmp/template.txt 2>&1)
NODE_CONTENT=$($OSB files cat "$NODE_ID" /tmp/template.txt 2>&1)

check "Ubuntu sandbox isolated" 'echo "$UBUNTU_CONTENT" | grep -q ubuntu'
check "Python sandbox isolated" 'echo "$PYTHON_CONTENT" | grep -q python'
check "Node sandbox isolated" 'echo "$NODE_CONTENT" | grep -q node'
echo

# --- Summary ---
echo -e "${BOLD}========================================"
echo " Results: $PASSED passed, $FAILED failed"
echo -e "========================================${RESET}\n"

[[ $FAILED -eq 0 ]]
