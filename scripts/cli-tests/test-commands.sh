#!/usr/bin/env bash
#
# Command Execution Test
#
# Tests:
#   1. Basic commands (echo, multi-line)
#   2. stderr handling
#   3. Non-zero exit codes
#   4. Large stdout output
#   5. Shell features (pipes, redirects, wildcards)
#   6. Command vs shell modes

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
echo "║       Command Execution Test                     ║"
echo -e "╚══════════════════════════════════════════════════╝${RESET}\n"

# Helper to extract sandbox ID
extract_sandbox_id() {
    echo "$1" | grep -oE 'sb-[a-f0-9]+' | head -1
}

# Create sandbox
OUTPUT=$($OSB sandbox create --template ubuntu --timeout 120 2>&1)
SANDBOX_ID=$(extract_sandbox_id "$OUTPUT")
echo -e "${GREEN}Created sandbox: $SANDBOX_ID${RESET}\n"

# ── Test 1: Basic commands ──────────────────────────────────────
echo -e "${BOLD}━━━ Test 1: Basic commands ━━━${RESET}\n"

ECHO_OUT=$($OSB exec "$SANDBOX_ID" echo hello-world 2>&1)
check "Echo returns correct output" 'echo "$ECHO_OUT" | grep -q hello-world'

MULTI_OUT=$($OSB shell "$SANDBOX_ID" "echo line1 && echo line2 && echo line3" 2>&1)
LINE_COUNT=$(echo "$MULTI_OUT" | wc -l | tr -d ' ')
check "Multi-command outputs 3 lines" '[[ "$LINE_COUNT" == "3" ]]'
check "First line correct" 'echo "$MULTI_OUT" | grep -q line1'
check "Last line correct" 'echo "$MULTI_OUT" | grep -q line3'
echo

# ── Test 2: stderr handling ─────────────────────────────────────
echo -e "${BOLD}━━━ Test 2: stderr handling ━━━${RESET}\n"

STDERR_OUT=$($OSB shell "$SANDBOX_ID" "echo error-msg >&2" 2>&1 || true)
check "stderr captured" 'echo "$STDERR_OUT" | grep -q error-msg'

MIXED_OUT=$($OSB shell "$SANDBOX_ID" "echo stdout-data && echo stderr-data >&2" 2>&1 || true)
check "Mixed: stdout captured" 'echo "$MIXED_OUT" | grep -q stdout-data'
check "Mixed: stderr captured" 'echo "$MIXED_OUT" | grep -q stderr-data'
echo

# ── Test 3: Non-zero exit codes ─────────────────────────────────
echo -e "${BOLD}━━━ Test 3: Non-zero exit codes ━━━${RESET}\n"

EXIT_FALSE=0
$OSB exec "$SANDBOX_ID" false 2>&1 >/dev/null || EXIT_FALSE=$?
check "'false' returns non-zero exit code" '[[ $EXIT_FALSE -ne 0 ]]'

EXIT_42=0
$OSB shell "$SANDBOX_ID" "exit 42" 2>&1 >/dev/null || EXIT_42=$?
check "Exit code 42 causes failure" '[[ $EXIT_42 -ne 0 ]]'
echo

# ── Test 4: Large stdout ────────────────────────────────────────
echo -e "${BOLD}━━━ Test 4: Large stdout output ━━━${RESET}\n"

LARGE_OUT=$($OSB shell "$SANDBOX_ID" "seq 1 1000" 2>&1)
LINE_COUNT=$(echo "$LARGE_OUT" | wc -l | tr -d ' ')
check "1000 lines captured" '[[ "$LINE_COUNT" == "1000" ]]'

FIRST_LINE=$(echo "$LARGE_OUT" | head -1)
LAST_LINE=$(echo "$LARGE_OUT" | tail -1)
check "First line is 1" '[[ "$FIRST_LINE" == "1" ]]'
check "Last line is 1000" '[[ "$LAST_LINE" == "1000" ]]'
echo

# ── Test 5: Shell features ──────────────────────────────────────
echo -e "${BOLD}━━━ Test 5: Shell features (pipes, redirects, wildcards) ━━━${RESET}\n"

# Pipes
PIPE_OUT=$($OSB shell "$SANDBOX_ID" "echo 'hello world' | tr ' ' '-'" 2>&1)
check "Pipe works" 'echo "$PIPE_OUT" | grep -q hello-world'

# Redirect
$OSB shell "$SANDBOX_ID" "echo redirect-test > /tmp/redirect.txt" 2>&1
REDIRECT_CONTENT=$($OSB files cat "$SANDBOX_ID" /tmp/redirect.txt 2>&1)
check "Redirect to file works" 'echo "$REDIRECT_CONTENT" | grep -q redirect-test'

# Wildcards
$OSB shell "$SANDBOX_ID" "touch /tmp/wc-a.txt /tmp/wc-b.txt /tmp/wc-c.txt" 2>&1
WC_OUT=$($OSB shell "$SANDBOX_ID" "ls /tmp/wc-*.txt | wc -l" 2>&1)
check "Wildcard expansion works" 'echo "$WC_OUT" | grep -q 3'

# Arithmetic
ARITH_OUT=$($OSB shell "$SANDBOX_ID" 'echo $((42 * 7))' 2>&1)
check "Arithmetic expansion works" 'echo "$ARITH_OUT" | grep -q 294'
echo

# ── Test 6: Files created via commands ──────────────────────────
echo -e "${BOLD}━━━ Test 6: Files created via commands ━━━${RESET}\n"

$OSB shell "$SANDBOX_ID" "echo 'command-written' > /tmp/cmd-file.txt" 2>&1
CMD_FILE=$($OSB files cat "$SANDBOX_ID" /tmp/cmd-file.txt 2>&1)
check "Command-written file readable via CLI" 'echo "$CMD_FILE" | grep -q command-written'
echo

# ── Test 7: Very long single line ───────────────────────────────
echo -e "${BOLD}━━━ Test 7: Very long single line ━━━${RESET}\n"

LONG_LINE=$($OSB shell "$SANDBOX_ID" "head -c 10000 /dev/zero | tr '\0' 'X'" 2>&1)
LENGTH=${#LONG_LINE}
check "10000 character line captured" '[[ $LENGTH -ge 10000 ]]'
echo

# --- Summary ---
echo -e "${BOLD}========================================"
echo " Results: $PASSED passed, $FAILED failed"
echo -e "========================================${RESET}\n"

[[ $FAILED -eq 0 ]]
