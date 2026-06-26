#!/usr/bin/env bash
#
# repro.sh — reproduce the Cloudflare 524s this change eliminates.
#
# Each case is a SINGLE synchronous request that holds the connection open past
# Cloudflare's ~100s proxy_read_timeout while the backend works, so the edge
# 524s the client even though the operation is fine. Run against an environment
# on the pre-change code:
#
#   OSB_API_KEY=osb_xxx OSB_BASE=https://app.opencomputer.dev ./scripts/524/repro.sh
#
# Expect HTTP 524 (or a 5xx near the ~100s mark) on each path.
set -uo pipefail
: "${OSB_API_KEY:?set OSB_API_KEY}"
: "${OSB_BASE:?set OSB_BASE (e.g. https://app.opencomputer.dev)}"
API="$OSB_BASE/api"
H=(-H "X-API-Key: $OSB_API_KEY" -H "User-Agent: curl/8.0" -H "Content-Type: application/json")

new_sandbox() { curl -s "${H[@]}" -X POST -d '{}' "$API/sandboxes" | python3 -c 'import sys,json;print(json.load(sys.stdin)["sandboxID"])'; }
hibernate() {
  curl -s "${H[@]}" -X POST "$API/sandboxes/$1/hibernate" >/dev/null
  until [ "$(curl -s "${H[@]}" "$API/sandboxes/$1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status"))')" = hibernated ]; do sleep 2; done
}
timed() { curl -s -o /dev/null -w "HTTP %{http_code} in %{time_total}s" "${H[@]}" "$@"; }

echo "### exec/run — the synchronous command holds the connection until it finishes"
SID=$(new_sandbox); echo "sandbox=$SID"
echo "  $(timed -X POST -d '{"cmd":"sh","args":["-c","sleep 130; echo done"],"timeout":200}' "$API/sandboxes/$SID/exec/run")"
echo

echo "### snapshots — the synchronous (non-SSE) build holds the connection silent"
TS=$(date +%s)
# A 200s build step keeps the origin silent well past Cloudflare's ~100s
# proxy_read_timeout, so the edge 524s the client while the build runs.
BODY="{\"name\":\"repro-$TS\",\"image\":{\"base\":\"ubuntu\",\"steps\":[{\"type\":\"run\",\"args\":{\"commands\":[\"sleep 200\"]}}]}}"
echo "  $(timed -X POST -d "$BODY" "$API/snapshots")"
