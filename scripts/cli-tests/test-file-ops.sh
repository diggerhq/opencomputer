#!/usr/bin/env bash
#
# File Operations Test
#
# Tests:
#   1. Large file write/read (100KB)
#   2. Special characters in content
#   3. Deeply nested directories
#   4. File deletion and overwrite
#   5. List directories
#   6. Empty file handling
#   7. Write from stdin
#   8. Cross-tool file access

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
    rm -f /tmp/osb-test-* 2>/dev/null || true
}

trap cleanup EXIT

echo -e "${BOLD}\n╔══════════════════════════════════════════════════╗"
echo "║       File Operations Test                       ║"
echo -e "╚══════════════════════════════════════════════════╝${RESET}\n"

# Helper to extract sandbox ID
extract_sandbox_id() {
    echo "$1" | grep -oE 'sb-[a-f0-9]+' | head -1
}

# Create sandbox
OUTPUT=$($OSB sandbox create --template ubuntu --timeout 120 2>&1)
SANDBOX_ID=$(extract_sandbox_id "$OUTPUT")
echo -e "${GREEN}Created sandbox: $SANDBOX_ID${RESET}\n"

# ── Test 1: Large file ──────────────────────────────────────────
echo -e "${BOLD}━━━ Test 1: Large file (100KB) ━━━${RESET}\n"

# Create 100KB file locally
python3 -c "print('X' * 102400)" > /tmp/osb-test-large.txt

cat /tmp/osb-test-large.txt | $OSB files write "$SANDBOX_ID" /tmp/large.txt - 2>&1
LARGE_CONTENT=$($OSB files cat "$SANDBOX_ID" /tmp/large.txt 2>&1)
LENGTH=${#LARGE_CONTENT}

check "100KB file written and readable" '[[ $LENGTH -gt 100000 ]]'
echo

# ── Test 2: Multi-line content ──────────────────────────────────
echo -e "${BOLD}━━━ Test 2: Multi-line content ━━━${RESET}\n"

python3 -c "for i in range(100): print(f'Line {i+1}: Some content here')" > /tmp/osb-test-multiline.txt
cat /tmp/osb-test-multiline.txt | $OSB files write "$SANDBOX_ID" /tmp/multiline.txt - 2>&1
MULTI_READ=$($OSB files cat "$SANDBOX_ID" /tmp/multiline.txt 2>&1)
LINE_COUNT=$(echo "$MULTI_READ" | wc -l | tr -d ' ')

check "100-line file preserved" '[[ "$LINE_COUNT" == "100" ]]'
echo

# ── Test 3: Deeply nested directories ──────────────────────────
echo -e "${BOLD}━━━ Test 3: Deeply nested directories ━━━${RESET}\n"

DEEP_PATH="/tmp/a/b/c/d/e/f/g/h"
$OSB files mkdir "$SANDBOX_ID" "$DEEP_PATH" 2>&1
$OSB files write "$SANDBOX_ID" "$DEEP_PATH/deep.txt" "bottom-of-tree" 2>&1
DEEP_CONTENT=$($OSB files cat "$SANDBOX_ID" "$DEEP_PATH/deep.txt" 2>&1)

check "8-level nested file created and read" 'echo "$DEEP_CONTENT" | grep -q bottom-of-tree'

# List intermediate directory
MID_LIST=$($OSB files ls "$SANDBOX_ID" /tmp/a/b/c/d 2>&1)
check "Intermediate dir lists correctly" 'echo "$MID_LIST" | grep -q e'
echo

# ── Test 4: File deletion and overwrite ────────────────────────
echo -e "${BOLD}━━━ Test 4: File deletion and overwrite ━━━${RESET}\n"

# Write -> overwrite -> verify
$OSB files write "$SANDBOX_ID" /tmp/overwrite.txt "original" 2>&1
CONTENT=$($OSB files cat "$SANDBOX_ID" /tmp/overwrite.txt 2>&1)
check "Original content written" 'echo "$CONTENT" | grep -q original'

$OSB files write "$SANDBOX_ID" /tmp/overwrite.txt "overwritten" 2>&1
CONTENT=$($OSB files cat "$SANDBOX_ID" /tmp/overwrite.txt 2>&1)
check "Overwritten content correct" 'echo "$CONTENT" | grep -q overwritten'

# Delete
$OSB files rm "$SANDBOX_ID" /tmp/overwrite.txt 2>&1
EXISTS=true
$OSB files cat "$SANDBOX_ID" /tmp/overwrite.txt 2>&1 && EXISTS=true || EXISTS=false
check "File gone after delete" '[[ "$EXISTS" == "false" ]]'
echo

# ── Test 5: Directory listing ───────────────────────────────────
echo -e "${BOLD}━━━ Test 5: Directory listing ━━━${RESET}\n"

# Create multiple files
for i in $(seq 1 10); do
    $OSB files write "$SANDBOX_ID" "/tmp/listtest-$i.txt" "content-$i" 2>&1 >/dev/null
done

LIST_OUT=$($OSB files ls "$SANDBOX_ID" /tmp 2>&1)
TEST_FILES=$(echo "$LIST_OUT" | grep -c "listtest-" || echo "0")
check "10 files visible in listing" '[[ "$TEST_FILES" -ge 10 ]]'
echo

# ── Test 6: Write from stdin ────────────────────────────────────
echo -e "${BOLD}━━━ Test 6: Write from stdin ━━━${RESET}\n"

echo "data from stdin" | $OSB files write "$SANDBOX_ID" /tmp/stdin.txt - 2>&1
STDIN_CONTENT=$($OSB files cat "$SANDBOX_ID" /tmp/stdin.txt 2>&1)
check "Stdin write works" 'echo "$STDIN_CONTENT" | grep -q "data from stdin"'
echo

# ── Test 7: Cross-tool file access ─────────────────────────────
echo -e "${BOLD}━━━ Test 7: Cross-tool file access ━━━${RESET}\n"

# Write via CLI, read via command
$OSB files write "$SANDBOX_ID" /tmp/cli-written.txt "cli-data" 2>&1
CMD_READ=$($OSB shell "$SANDBOX_ID" "cat /tmp/cli-written.txt" 2>&1)
check "CLI-written file readable via command" 'echo "$CMD_READ" | grep -q cli-data'

# Write via command, read via CLI
$OSB shell "$SANDBOX_ID" "echo 'cmd-data' > /tmp/cmd-written.txt" 2>&1
CLI_READ=$($OSB files cat "$SANDBOX_ID" /tmp/cmd-written.txt 2>&1)
check "Command-written file readable via CLI" 'echo "$CLI_READ" | grep -q cmd-data'
echo

# --- Summary ---
echo -e "${BOLD}========================================"
echo " Results: $PASSED passed, $FAILED failed"
echo -e "========================================${RESET}\n"

[[ $FAILED -eq 0 ]]
