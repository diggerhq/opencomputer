#!/usr/bin/env bash
#
# Python Template Test
#
# Tests:
#   1. Python template has python3
#   2. pip works
#   3. Python stdlib modules
#   4. File I/O from Python
#   5. Python version check
#   6. pip install

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
}

trap cleanup EXIT

echo -e "${BOLD}\n╔══════════════════════════════════════════════════╗"
echo "║       Python Template Test                       ║"
echo -e "╚══════════════════════════════════════════════════╝${RESET}\n"

# Helper to extract sandbox ID
extract_sandbox_id() {
    echo "$1" | grep -oE 'sb-[a-f0-9]+' | head -1
}

# ── Test 1: Create Python sandbox ──────────────────────────────
echo -e "${BOLD}━━━ Test 1: Create Python sandbox ━━━${RESET}\n"

OUTPUT=$($OSB sandbox create --template python --timeout 120 2>&1)
SANDBOX_ID=$(extract_sandbox_id "$OUTPUT")

check "Python sandbox created" '[[ -n "$SANDBOX_ID" ]]'
echo -e "${DIM}Sandbox ID: $SANDBOX_ID${RESET}\n"

# ── Test 2: Python availability ─────────────────────────────────
echo -e "${BOLD}━━━ Test 2: Python availability ━━━${RESET}\n"

PYTHON_VERSION=$($OSB exec "$SANDBOX_ID" python3 --version 2>&1)
check "python3 command exists" 'echo "$PYTHON_VERSION" | grep -q "Python 3"'

WHICH_PYTHON=$($OSB exec "$SANDBOX_ID" which python3 2>&1)
check "python3 in PATH" '[[ -n "$WHICH_PYTHON" ]]'
echo

# ── Test 3: pip availability ────────────────────────────────────
echo -e "${BOLD}━━━ Test 3: pip availability ━━━${RESET}\n"

PIP_VERSION=$($OSB exec "$SANDBOX_ID" pip3 --version 2>&1)
check "pip3 command exists" 'echo "$PIP_VERSION" | grep -q pip'

WHICH_PIP=$($OSB exec "$SANDBOX_ID" which pip3 2>&1)
check "pip3 in PATH" '[[ -n "$WHICH_PIP" ]]'
echo

# ── Test 4: Python stdlib ───────────────────────────────────────
echo -e "${BOLD}━━━ Test 4: Python stdlib modules ━━━${RESET}\n"

IMPORTS=$($OSB exec "$SANDBOX_ID" python3 -c "import json, os, sys, math; print('ok')" 2>&1)
check "Standard library imports work" 'echo "$IMPORTS" | grep -q ok'

JSON_OUT=$($OSB shell "$SANDBOX_ID" "python3 -c \"import json; print(json.dumps({'key': 'value'}))\"" 2>&1)
check "JSON module works" 'echo "$JSON_OUT" | grep -q key'

MATH_OUT=$($OSB shell "$SANDBOX_ID" "python3 -c \"import math; print(round(math.pi, 5))\"" 2>&1)
check "Math module works" 'echo "$MATH_OUT" | grep -q "3.14159"'
echo

# ── Test 5: Python file I/O ─────────────────────────────────────
echo -e "${BOLD}━━━ Test 5: Python file I/O ━━━${RESET}\n"

# Write Python script via file write
PYTHON_SCRIPT='import json, os
with open("/tmp/py-test.txt", "w") as f:
    f.write("python-written-data")
with open("/tmp/py-test.txt", "r") as f:
    content = f.read()
os.makedirs("/tmp/py-nested/deep", exist_ok=True)
with open("/tmp/py-nested/deep/file.txt", "w") as f:
    f.write("nested-content")
result = {"file_content": content, "nested_exists": os.path.exists("/tmp/py-nested/deep/file.txt")}
print(json.dumps(result))'

echo "$PYTHON_SCRIPT" | $OSB files write "$SANDBOX_ID" /tmp/test.py - 2>&1
PYTHON_OUT=$($OSB exec "$SANDBOX_ID" python3 /tmp/test.py 2>&1)

check "Python script executed" 'echo "$PYTHON_OUT" | grep -q python-written-data'
check "Nested file created" 'echo "$PYTHON_OUT" | grep -q nested_exists'

# Verify file via CLI
PY_FILE=$($OSB files cat "$SANDBOX_ID" /tmp/py-test.txt 2>&1)
check "CLI can read Python-written file" 'echo "$PY_FILE" | grep -q python-written-data'
echo

# ── Test 6: Python version ──────────────────────────────────────
echo -e "${BOLD}━━━ Test 6: Python version check ━━━${RESET}\n"

VERSION_CHECK=$($OSB shell "$SANDBOX_ID" "python3 -c \"import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')\"" 2>&1)
MAJOR=$(echo "$VERSION_CHECK" | cut -d. -f1)

check "Python version is 3.x" '[[ "$MAJOR" == "3" ]]'
echo -e "${DIM}Python version: $VERSION_CHECK${RESET}\n"

# ── Test 7: Simple pip install ─────────────────────────────────
echo -e "${BOLD}━━━ Test 7: pip install (quick test) ━━━${RESET}\n"

PIP_OUT=$($OSB shell "$SANDBOX_ID" "pip3 install --break-system-packages requests 2>&1 || pip3 install requests 2>&1" || echo "failed")
check "pip install works" 'echo "$PIP_OUT" | grep -qE "Successfully installed|already satisfied"'

# Verify import
IMPORT_CHECK=$($OSB exec "$SANDBOX_ID" python3 -c "import requests; print('ok')" 2>&1)
check "Installed package importable" 'echo "$IMPORT_CHECK" | grep -q ok'
echo

# --- Summary ---
echo -e "${BOLD}========================================"
echo " Results: $PASSED passed, $FAILED failed"
echo -e "========================================${RESET}\n"

[[ $FAILED -eq 0 ]]
