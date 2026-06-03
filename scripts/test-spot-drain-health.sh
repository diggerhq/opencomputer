#!/usr/bin/env bash
set -euo pipefail

# Live-migration drain health test for spot/preemption drills.
#
# Required env:
#   OPENSANDBOX_API_URL    e.g. https://spot-poc.opencomputer.app or http://127.0.0.1:8080
#   OPENSANDBOX_API_KEY
#   SOURCE_WORKER_ID       worker to evacuate
#   TARGET_WORKER_ID       spare worker expected to receive the sandboxes
#
# Optional env:
#   COUNT                  number of sandboxes to create (default: 40)
#   TEMPLATE               sandbox template (default: default)
#   MEMORY_MB              sandbox memory (default: 1024)
#   CPU_COUNT              sandbox vCPU count (default: 1)
#   DISK_MB                sandbox disk MB (default: 20480)
#   POLL_SECONDS           drain poll interval (default: 2)
#   DRAIN_TIMEOUT_SECONDS  drain timeout (default: 600)
#   KEEP_SANDBOXES         set to 1 to leave sandboxes running on exit (default: 0)
#   FORCE_SOURCE_PLACEMENT set to 0 to skip temporarily draining target during create (default: 1)

API_URL="${OPENSANDBOX_API_URL:?OPENSANDBOX_API_URL is required}"
API_KEY="${OPENSANDBOX_API_KEY:?OPENSANDBOX_API_KEY is required}"
SOURCE_WORKER_ID="${SOURCE_WORKER_ID:?SOURCE_WORKER_ID is required}"
TARGET_WORKER_ID="${TARGET_WORKER_ID:?TARGET_WORKER_ID is required}"

COUNT="${COUNT:-40}"
TEMPLATE="${TEMPLATE:-default}"
MEMORY_MB="${MEMORY_MB:-1024}"
CPU_COUNT="${CPU_COUNT:-1}"
DISK_MB="${DISK_MB:-20480}"
POLL_SECONDS="${POLL_SECONDS:-2}"
DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-600}"
KEEP_SANDBOXES="${KEEP_SANDBOXES:-0}"
FORCE_SOURCE_PLACEMENT="${FORCE_SOURCE_PLACEMENT:-1}"

AUTH_HEADER="X-API-Key: ${API_KEY}"
CONTENT_HEADER="Content-Type: application/json"
SANDBOX_FILE="$(mktemp -t spot-drain-sandboxes.XXXXXX)"
FAIL_FILE="$(mktemp -t spot-drain-failures.XXXXXX)"

cleanup() {
  api POST "/admin/workers/${SOURCE_WORKER_ID}/drain?drain=false" >/dev/null 2>&1 || true
  api POST "/admin/workers/${TARGET_WORKER_ID}/drain?drain=false" >/dev/null 2>&1 || true

  if [[ "$KEEP_SANDBOXES" == "1" ]]; then
    echo "Leaving sandboxes running. IDs: $SANDBOX_FILE"
    return
  fi

  if [[ -s "$SANDBOX_FILE" ]]; then
    echo "Cleaning up $(wc -l < "$SANDBOX_FILE" | tr -d ' ') sandboxes..."
    while read -r sandbox_id; do
      [[ -n "$sandbox_id" ]] || continue
      curl -fsS -X DELETE -H "$AUTH_HEADER" "${API_URL}/api/sandboxes/${sandbox_id}" >/dev/null || true
    done < "$SANDBOX_FILE"
  fi
}
trap cleanup EXIT

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -H "$AUTH_HEADER" -H "$CONTENT_HEADER" -d "$body" "${API_URL}${path}"
  else
    curl -fsS -X "$method" -H "$AUTH_HEADER" "${API_URL}${path}"
  fi
}

json_value() {
  local expr="$1"
  python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    value = ${expr}
    print('' if value is None else value)
except Exception:
    print('')
"
}

tracked_counts() {
  local source_count=0 target_count=0 other_count=0 non_running=0 total=0
  local sandbox_id meta status worker

  while read -r sandbox_id; do
    [[ -n "$sandbox_id" ]] || continue
    total=$((total + 1))
    meta=$(api GET "/api/sandboxes/${sandbox_id}" || echo '{}')
    status=$(printf "%s" "$meta" | json_value 'data.get("status")')
    worker=$(printf "%s" "$meta" | json_value 'data.get("workerID")')

    if [[ "$status" != "running" ]]; then
      non_running=$((non_running + 1))
    elif [[ "$worker" == "$SOURCE_WORKER_ID" ]]; then
      source_count=$((source_count + 1))
    elif [[ "$worker" == "$TARGET_WORKER_ID" ]]; then
      target_count=$((target_count + 1))
    else
      other_count=$((other_count + 1))
    fi
  done < "$SANDBOX_FILE"

  echo "source=$source_count target=$target_count other=$other_count non_running=$non_running total=$total"
}

create_sandbox() {
  local body response sandbox_id
  body=$(printf '{"template":"%s","memoryMB":%s,"cpuCount":%s,"diskMB":%s}' \
    "$TEMPLATE" "$MEMORY_MB" "$CPU_COUNT" "$DISK_MB")
  response=$(api POST /api/sandboxes "$body")
  sandbox_id=$(printf "%s" "$response" | json_value 'data.get("sandboxID") or data.get("id")')
  if [[ -z "$sandbox_id" ]]; then
    echo "create failed: $response" >&2
    return 1
  fi
  echo "$sandbox_id"
}

exec_ok() {
  local sandbox_id="$1"
  local response exit_code
  response=$(api POST "/api/sandboxes/${sandbox_id}/exec/run" \
    '{"cmd":"/bin/true","args":[],"timeout":5}' || true)
  exit_code=$(printf "%s" "$response" | json_value 'data.get("exitCode")')
  [[ "$exit_code" == "0" ]]
}

pty_ok() {
  local sandbox_id="$1"
  local response session_id
  response=$(api POST "/api/sandboxes/${sandbox_id}/pty" \
    '{"cols":80,"rows":24,"shell":"/bin/bash"}' || true)
  session_id=$(printf "%s" "$response" | json_value 'data.get("sessionID")')
  if [[ -z "$session_id" ]]; then
    return 1
  fi
  api DELETE "/api/sandboxes/${sandbox_id}/pty/${session_id}" >/dev/null || true
}

worker_of() {
  local sandbox_id="$1"
  api GET "/api/sandboxes/${sandbox_id}" | json_value 'data.get("workerID")'
}

health_pass() {
  local label="$1"
  local failures=0 total=0 worker exec_status pty_status
  : > "$FAIL_FILE"

  echo "Health pass: $label"
  while read -r sandbox_id; do
    [[ -n "$sandbox_id" ]] || continue
    total=$((total + 1))
    worker=$(worker_of "$sandbox_id")

    exec_status=ok
    if ! exec_ok "$sandbox_id"; then
      exec_status=fail
    fi

    pty_status=ok
    if ! pty_ok "$sandbox_id"; then
      pty_status=fail
    fi

    printf "%s worker=%s exec=%s pty=%s\n" "$sandbox_id" "$worker" "$exec_status" "$pty_status"
    if [[ "$exec_status" != "ok" || "$pty_status" != "ok" ]]; then
      failures=$((failures + 1))
      printf "%s worker=%s exec=%s pty=%s\n" "$sandbox_id" "$worker" "$exec_status" "$pty_status" >> "$FAIL_FILE"
    fi
  done < "$SANDBOX_FILE"

  echo "Health summary: label=$label total=$total failures=$failures"
  if [[ "$failures" -ne 0 ]]; then
    cat "$FAIL_FILE" >&2
    return 1
  fi
}

echo "Clearing drain markers on source and target workers..."
api POST "/admin/workers/${SOURCE_WORKER_ID}/drain?drain=false" >/dev/null || true
api POST "/admin/workers/${TARGET_WORKER_ID}/drain?drain=false" >/dev/null || true

if [[ "$FORCE_SOURCE_PLACEMENT" == "1" ]]; then
  echo "Temporarily draining target worker during create: $TARGET_WORKER_ID"
  api POST "/admin/workers/${TARGET_WORKER_ID}/drain" >/dev/null
fi

echo "Creating $COUNT sandboxes..."
for i in $(seq 1 "$COUNT"); do
  sandbox_id=$(create_sandbox)
  echo "$sandbox_id" | tee -a "$SANDBOX_FILE"
  sleep 0.3
done

if [[ "$FORCE_SOURCE_PLACEMENT" == "1" ]]; then
  echo "Clearing target worker drain marker before evacuation: $TARGET_WORKER_ID"
  api POST "/admin/workers/${TARGET_WORKER_ID}/drain?drain=false" >/dev/null
fi

echo "Initial tracked counts: $(tracked_counts)"
health_pass before-drain

echo "Evacuating source worker: $SOURCE_WORKER_ID"
api POST "/admin/workers/${SOURCE_WORKER_ID}/evacuate" >/dev/null

start_epoch=$(date +%s)
while true; do
  counts=$(tracked_counts)
  now=$(date -u "+%Y-%m-%d %H:%M:%S UTC")
  elapsed=$(( $(date +%s) - start_epoch ))
  echo "$now elapsed=${elapsed}s $counts"

  if [[ "$counts" == source=0* ]]; then
    break
  fi
  if [[ "$elapsed" -gt "$DRAIN_TIMEOUT_SECONDS" ]]; then
    echo "Drain timed out after ${elapsed}s" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done

echo "Final tracked counts: $(tracked_counts)"
health_pass after-drain
echo "PASS: all $COUNT sandboxes retained exec and PTY after drain"
