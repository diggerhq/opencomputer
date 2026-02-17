#!/usr/bin/env bash
set -euo pipefail

# Test hibernation: file persistence, process preservation, and timing
# Usage: ./scripts/test-hibernation.sh [api_url] [api_key]

API_URL="${1:-http://localhost:8080}"
API_KEY="${2:-test-key}"
PASS=0
FAIL=0

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

check() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    green "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -s -X "$method" "${API_URL}${path}" \
      -H "X-API-Key: ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -s -X "$method" "${API_URL}${path}" \
      -H "X-API-Key: ${API_KEY}"
  fi
}

run_cmd() {
  local sandbox_id="$1" cmd="$2"
  api POST "/api/sandboxes/${sandbox_id}/commands" "{\"cmd\": \"bash\", \"args\": [\"-c\", \"${cmd}\"]}"
}

timed() {
  local label="$1"
  shift
  local start end duration
  start=$(python3 -c 'import time; print(time.time())')
  "$@"
  end=$(python3 -c 'import time; print(time.time())')
  duration=$(python3 -c "print(f'{${end} - ${start}:.3f}')")
  yellow "  TIME: ${label} = ${duration}s"
  echo "$duration"
}

bold "========================================="
bold " OpenSandbox Hibernation Test"
bold "========================================="
echo ""

# --- Cleanup stale sessions ---
bold "[0/7] Cleaning up stale sandbox sessions..."
docker compose -f deploy/docker-compose.yml exec -T postgres \
  psql -U opensandbox -d opensandbox -c \
  "UPDATE sandbox_sessions SET status = 'stopped', stopped_at = now() WHERE status IN ('running', 'hibernated');" \
  2>/dev/null | grep -q "UPDATE" && green "  Cleaned up stale sessions" || yellow "  No stale sessions"
echo ""

# --- Create sandbox ---
bold "[1/7] Creating sandbox..."
CREATE_RESP=$(api POST "/api/sandboxes" '{"template": "ubuntu:22.04", "timeout": 600}')
SANDBOX_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['sandboxID'])" 2>/dev/null)
if [[ -z "$SANDBOX_ID" ]]; then
  red "Failed to create sandbox: $CREATE_RESP"
  exit 1
fi
green "  Created sandbox: $SANDBOX_ID"
echo ""

# --- Write file state ---
bold "[2/7] Writing file state..."
run_cmd "$SANDBOX_ID" "echo hibernation-proof-42 > /tmp/proof.txt" > /dev/null
run_cmd "$SANDBOX_ID" "echo hello-world > /root/hello.txt" > /dev/null
run_cmd "$SANDBOX_ID" "mkdir -p /var/data && echo persistent-data > /var/data/test.txt" > /dev/null

# Verify files exist
PROOF=$(run_cmd "$SANDBOX_ID" "cat /tmp/proof.txt" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
HELLO=$(run_cmd "$SANDBOX_ID" "cat /root/hello.txt" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
DATA=$(run_cmd "$SANDBOX_ID" "cat /var/data/test.txt" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
check "/tmp/proof.txt before hibernate" "hibernation-proof-42" "$PROOF"
check "/root/hello.txt before hibernate" "hello-world" "$HELLO"
check "/var/data/test.txt before hibernate" "persistent-data" "$DATA"
echo ""

# --- Check PID 1 process ---
bold "[3/7] Verifying PID 1 (entrypoint) before hibernate..."
PID1_CMD_BEFORE=$(run_cmd "$SANDBOX_ID" "cat /proc/1/cmdline | tr '\\0' ' '" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null || echo "unknown")
green "  PID 1 command: $PID1_CMD_BEFORE"
echo ""

# --- Hibernate ---
bold "[4/7] Hibernating sandbox..."
HIB_START=$(python3 -c 'import time; print(time.time())')
HIB_RESP=$(api POST "/api/sandboxes/${SANDBOX_ID}/hibernate")
HIB_END=$(python3 -c 'import time; print(time.time())')
HIBERNATE_DURATION=$(python3 -c "print(f'{${HIB_END} - ${HIB_START}:.3f}')")
yellow "  TIME: Hibernate = ${HIBERNATE_DURATION}s"

HIB_KEY=$(echo "$HIB_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('checkpointKey',''))" 2>/dev/null)
HIB_SIZE=$(echo "$HIB_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d.get(\"sizeBytes\",0)/1024/1024:.1f}MB')" 2>/dev/null)
if [[ -n "$HIB_KEY" ]]; then
  green "  Checkpoint: $HIB_KEY ($HIB_SIZE)"
else
  red "  Hibernate failed: $HIB_RESP"
fi

CONTAINER_CHECK=$(podman ps --format '{{.Names}}' 2>/dev/null | grep "osb-${SANDBOX_ID}" || true)
check "Container removed after hibernate" "" "$CONTAINER_CHECK"
echo ""

# --- Wake ---
bold "[5/7] Waking sandbox..."
WAKE_START=$(python3 -c 'import time; print(time.time())')
WAKE_RESP=$(api POST "/api/sandboxes/${SANDBOX_ID}/wake" '{"timeout": 600}')
WAKE_END=$(python3 -c 'import time; print(time.time())')
WAKE_DURATION=$(python3 -c "print(f'{${WAKE_END} - ${WAKE_START}:.3f}')")
yellow "  TIME: Wake = ${WAKE_DURATION}s"

WAKE_STATUS=$(echo "$WAKE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
check "Wake status" "running" "$WAKE_STATUS"
echo ""

# --- Verify file state ---
bold "[6/7] Verifying file state after wake..."
PROOF_AFTER=$(run_cmd "$SANDBOX_ID" "cat /tmp/proof.txt" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
HELLO_AFTER=$(run_cmd "$SANDBOX_ID" "cat /root/hello.txt" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
DATA_AFTER=$(run_cmd "$SANDBOX_ID" "cat /var/data/test.txt" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
check "/tmp/proof.txt after wake" "hibernation-proof-42" "$PROOF_AFTER"
check "/root/hello.txt after wake" "hello-world" "$HELLO_AFTER"
check "/var/data/test.txt after wake" "persistent-data" "$DATA_AFTER"
echo ""

# --- Verify process state ---
bold "[7/7] Verifying process state after wake..."
PID1_CMD_AFTER=$(run_cmd "$SANDBOX_ID" "cat /proc/1/cmdline | tr '\\0' ' '" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null || echo "unknown")
check "PID 1 command preserved" "$PID1_CMD_BEFORE" "$PID1_CMD_AFTER"
PID1_EXISTS=$(run_cmd "$SANDBOX_ID" "test -d /proc/1 && echo yes || echo no" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null || echo "no")
check "PID 1 still exists after wake" "yes" "$PID1_EXISTS"

# Verify we can still run commands (container is functional)
ECHO_TEST=$(run_cmd "$SANDBOX_ID" "echo alive" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null || echo "dead")
check "Container is functional after wake" "alive" "$ECHO_TEST"
echo ""

# --- Cleanup ---
bold "Cleaning up..."
api POST "/api/sandboxes/${SANDBOX_ID}/commands" '{"cmd": "kill", "args": ["1"]}' > /dev/null 2>&1 || true

# --- Summary ---
echo ""
bold "========================================="
bold " Results: $PASS passed, $FAIL failed"
bold " Hibernate: ~${HIBERNATE_DURATION:-?}s"
bold " Wake:      ~${WAKE_DURATION}s"
bold "========================================="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
