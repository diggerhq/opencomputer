#!/usr/bin/env bash
#
# OpenSandbox CLI Test Suite Runner
#
# Runs all CLI tests in sequence with a summary at the end.
#
# Usage:
#   ./run-all-tests.sh              # Run all tests
#   ./run-all-tests.sh --skip-slow  # Skip slow tests (multi-template)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
DIM="\033[2m"
RESET="\033[0m"

SKIP_SLOW=false
if [[ "${1:-}" == "--skip-slow" ]]; then
    SKIP_SLOW=true
fi

# Test suites (name:file:description)
declare -a TEST_SUITES=(
    "Lifecycle:test-lifecycle.sh:Sandbox create, list, get, kill"
    "Commands:test-commands.sh:Shell commands, stderr, exit codes, pipes"
    "File Ops:test-file-ops.sh:Large files, nested dirs, deletion"
    "Python Template:test-python-template.sh:Python template validation"
)

if [[ "$SKIP_SLOW" == "false" ]]; then
    TEST_SUITES+=("Multi-Template:test-multi-template.sh:ubuntu, python, node templates")
fi

echo -e "${BOLD}\n╔════════════════════════════════════════════════════════╗"
echo "║       OpenSandbox CLI Test Suite                       ║"
echo -e "╚════════════════════════════════════════════════════════╝${RESET}\n"

TOTAL_SUITES=${#TEST_SUITES[@]}
echo -e "${DIM}Running $TOTAL_SUITES test suites${SKIP_SLOW:+ (slow tests skipped)}${RESET}"
echo -e "${DIM}$(printf '─%.0s' {1..60})${RESET}\n"

# Track results
declare -a RESULTS=()
TOTAL_START=$(date +%s)

for i in "${!TEST_SUITES[@]}"; do
    IFS=: read -r NAME FILE DESC <<< "${TEST_SUITES[$i]}"
    FILE_PATH="$SCRIPT_DIR/$FILE"

    echo -e "${BOLD}[$((i+1))/$TOTAL_SUITES] $NAME${RESET}"
    echo -e "${DIM}    $DESC${RESET}"
    echo -e "${DIM}    Running: ./$FILE${RESET}\n"

    START=$(date +%s)
    if bash "$FILE_PATH"; then
        END=$(date +%s)
        DURATION=$((END - START))
        RESULTS+=("PASS:$NAME:$DURATION")
        echo -e "${GREEN}── $NAME: PASSED (${DURATION}s) ──${RESET}\n"
    else
        END=$(date +%s)
        DURATION=$((END - START))
        RESULTS+=("FAIL:$NAME:$DURATION")
        echo -e "${RED}── $NAME: FAILED (${DURATION}s) ──${RESET}\n"
    fi
done

TOTAL_END=$(date +%s)
TOTAL_SECS=$((TOTAL_END - TOTAL_START))

# Summary
echo -e "\n${BOLD}╔════════════════════════════════════════════════════════╗"
echo "║                    Test Results                        ║"
echo -e "╠════════════════════════════════════════════════════════╣${RESET}"

PASSED=0
FAILED=0

for result in "${RESULTS[@]}"; do
    IFS=: read -r STATUS NAME DURATION <<< "$result"
    if [[ "$STATUS" == "PASS" ]]; then
        echo -e "  ${GREEN}✓${RESET} $NAME  (${DURATION}s)"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${RESET} $NAME  (${DURATION}s)"
        ((FAILED++))
    fi
done

echo -e "${BOLD}\n╠════════════════════════════════════════════════════════╣"
echo "║  $PASSED passed, $FAILED failed | Total: ${TOTAL_SECS}s"
echo -e "╚════════════════════════════════════════════════════════╝${RESET}\n"

if [[ $FAILED -gt 0 ]]; then
    echo -e "${RED}Failed suites:${RESET}"
    for result in "${RESULTS[@]}"; do
        IFS=: read -r STATUS NAME DURATION <<< "$result"
        if [[ "$STATUS" == "FAIL" ]]; then
            echo -e "  ${RED}✗ $NAME${RESET}"
        fi
    done
    echo
    exit 1
fi
