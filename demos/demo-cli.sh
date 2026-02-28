#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# OpenSandbox CLI Demo
#
# Shows the `osb` CLI tool in action: create sandboxes, run
# commands, manage files, hibernate/wake, and clean up.
#
# Usage:
#   OPENCOMPUTER_API_URL=https://... OPENCOMPUTER_API_KEY=osb_... bash demos/demo-cli.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

GREEN='\033[32m'; RED='\033[31m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
step()  { echo -e "\n${BOLD}━━━ $1 ━━━${RESET}\n"; }
ok()    { echo -e "${GREEN}✓ $1${RESET}"; }
fail()  { echo -e "${RED}✗ $1${RESET}"; }
dim()   { echo -e "${DIM}  $1${RESET}"; }

# Pre-flight
if [ -z "${OPENCOMPUTER_API_KEY:-}" ]; then
  fail "OPENCOMPUTER_API_KEY is not set"
  exit 1
fi

OSB=${OSB:-osb}   # path to osb binary; default assumes it's on PATH

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════╗"
echo "║       OpenSandbox CLI Demo                       ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${RESET}"

SANDBOX_ID=""
cleanup() {
  if [ -n "$SANDBOX_ID" ]; then
    echo
    dim "Cleaning up sandbox $SANDBOX_ID..."
    $OSB sandbox kill "$SANDBOX_ID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── 1. Create a sandbox ─────────────────────────────────────
step "1. Create a sandbox"

CREATE_OUTPUT=$($OSB sandbox create --template base --timeout 300)
echo "$CREATE_OUTPUT"
SANDBOX_ID=$(echo "$CREATE_OUTPUT" | grep 'Sandbox created:' | awk '{print $NF}')
ok "Sandbox created: $SANDBOX_ID"

# ── 2. List sandboxes ───────────────────────────────────────
step "2. List sandboxes"

$OSB sandbox ls
ok "Sandbox appears in list"

# ── 3. Execute commands ─────────────────────────────────────
step "3. Execute commands"

dim "Running: python3 --version"
$OSB exec "$SANDBOX_ID" python3 --version
ok "Python available"

dim "Running: node --version"
$OSB exec "$SANDBOX_ID" node --version
ok "Node.js available"

dim "Running shell command with pipes"
$OSB shell "$SANDBOX_ID" "echo 'Hello from OpenSandbox!' | tr 'a-z' 'A-Z'"
ok "Shell pipes work"

# ── 4. File operations ──────────────────────────────────────
step "4. File operations"

dim "Writing a file..."
$OSB files write "$SANDBOX_ID" /workspace/hello.py 'print("Hello from a sandbox file!")'
ok "File written"

dim "Reading it back..."
$OSB files cat "$SANDBOX_ID" /workspace/hello.py
ok "File read"

dim "Listing workspace..."
$OSB files ls "$SANDBOX_ID" /workspace/ -l
ok "Directory listed"

dim "Executing the script..."
$OSB exec "$SANDBOX_ID" python3 /workspace/hello.py
ok "Script executed"

# ── 5. Inspect sandbox ─────────────────────────────────────
step "5. Inspect sandbox"

$OSB sandbox get "$SANDBOX_ID"
ok "Sandbox details retrieved"

# ── 6. Hibernate and wake ──────────────────────────────────
step "6. Hibernate and wake"

dim "Writing state before hibernation..."
$OSB files write "$SANDBOX_ID" /workspace/state.txt "I survived hibernation!"

dim "Hibernating..."
$OSB sandbox hibernate "$SANDBOX_ID"
ok "Sandbox hibernated"

dim "Waking..."
$OSB sandbox wake "$SANDBOX_ID"
ok "Sandbox woken"

dim "Checking state persisted..."
CONTENT=$($OSB files cat "$SANDBOX_ID" /workspace/state.txt)
if [ "$CONTENT" = "I survived hibernation!" ]; then
  ok "State persisted across hibernate/wake!"
else
  fail "State did not persist: got '$CONTENT'"
fi

# ── 7. Kill sandbox ────────────────────────────────────────
step "7. Kill sandbox"

$OSB sandbox kill "$SANDBOX_ID"
ok "Sandbox killed"
SANDBOX_ID=""  # prevent double-kill in cleanup

echo
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  ${GREEN}CLI Demo Complete!${RESET}${BOLD}                              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
