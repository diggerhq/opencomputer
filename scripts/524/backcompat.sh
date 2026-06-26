#!/usr/bin/env bash
#
# backcompat.sh — prove BOTH the legacy (old-SDK) and async (new-SDK) HTTP
# contracts work against a deployed build of this change.
#
#   OSB_API_KEY=osb_xxx OSB_BASE=https://app2.opensandbox.ai ./scripts/524/backcompat.sh
#
# An old SDK is just its HTTP calls: the original endpoints, the original
# response shapes, and none of the new headers/params. This script issues those
# exact requests (LEGACY section) and asserts the responses are unchanged — i.e.
# a client that never upgrades keeps working. It then issues the new SDK's
# requests (ASYNC section) and asserts the non-blocking behavior. Both must pass.
set -uo pipefail
: "${OSB_API_KEY:?set OSB_API_KEY}"
: "${OSB_BASE:?set OSB_BASE (e.g. https://app2.opensandbox.ai)}"
API="$OSB_BASE/api"

# LEGACY headers — exactly what an old SDK sends (no X-OSB-Async-Wake).
OLD=(-H "X-API-Key: $OSB_API_KEY" -H "User-Agent: opensandbox-sdk/old" -H "Content-Type: application/json")
# NEW headers — the newer SDK opts into the background-wake flow for file ops.
NEW=(-H "X-API-Key: $OSB_API_KEY" -H "User-Agent: opensandbox-sdk/new" -H "Content-Type: application/json" -H "X-OSB-Async-Wake: 1")

PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
jq_(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }   # jq_ '<expr on d>'
newsb(){ curl -s "${OLD[@]}" -X POST -d '{}' "$API/sandboxes" | jq_ 'd["sandboxID"]'; }
hibernate(){ curl -s "${OLD[@]}" -X POST "$API/sandboxes/$1/hibernate" >/dev/null
  until [ "$(curl -s "${OLD[@]}" "$API/sandboxes/$1" | jq_ 'd.get("status")')" = hibernated ]; do sleep 2; done; }
# Delete a sandbox so the suite stays under the org's concurrent-sandbox quota.
del(){ [ -n "${1:-}" ] && curl -s "${OLD[@]}" -X DELETE "$API/sandboxes/$1" >/dev/null 2>&1; return 0; }
# Backstop: clean up whatever was created if we exit early.
trap 'del "${SID:-}"; del "${SID2:-}"; del "${SID3:-}"; del "${SID4:-}"' EXIT

echo "###########  LEGACY contract (un-upgraded SDK / raw HTTP)  ###########"

echo "=== exec/run: POST returns the full result inline (200, no execId) ==="
SID=$(newsb); echo "sandbox=$SID"
R=$(curl -s "${OLD[@]}" -X POST -d '{"cmd":"sh","args":["-c","echo hello"]}' "$API/sandboxes/$SID/exec/run")
EC=$(echo "$R"|jq_ 'd.get("exitCode")'); SO=$(echo "$R"|jq_ 'repr(d.get("stdout"))'); HASEID=$(echo "$R"|jq_ '"execId" in d')
echo "  resp: exitCode=$EC stdout=$SO hasExecId=$HASEID"
[ "$EC" = 0 ] && [ "$HASEID" = False ] && ok "sync exec/run shape unchanged (exitCode inline, no execId)" || no "got exitCode=$EC hasExecId=$HASEID"

echo "=== exec/run: long command (timeout>30) still returns parseable JSON ==="
# The keepalive-whitespace band-aid prefixes spaces; JSON.parse (and old SDKs) ignore them.
R=$(curl -s "${OLD[@]}" -X POST -d '{"cmd":"sh","args":["-c","sleep 2; echo done"],"timeout":35}' "$API/sandboxes/$SID/exec/run")
EC=$(echo "$R"|jq_ 'd.get("exitCode")')
[ "$EC" = 0 ] && ok "earlyFlush result parses (exit 0)" || no "earlyFlush exitCode=$EC raw=${R:0:60}"
del "$SID"  # free quota before the next sandbox

echo "=== snapshots: non-SSE POST blocks and returns a READY 201 ==="
TS=$(date +%s)
RB=$(curl -s -o /tmp/bc_snap -w '%{http_code}' "${OLD[@]}" -X POST \
  -d "{\"name\":\"backcompat-legacy-$TS\",\"image\":{\"base\":\"ubuntu\",\"steps\":[{\"type\":\"run\",\"args\":{\"commands\":[\"echo hi\"]}}]}}" "$API/snapshots")
ST=$(jq_ 'd.get("status")' </tmp/bc_snap)
echo "  HTTP $RB status=$ST"
[ "$RB" = 201 ] && [ "$ST" = ready ] && ok "blocking snapshot returns ready 201" || no "HTTP $RB status=$ST"

echo "=== files: cold box WITHOUT opt-in header → synchronous wake, serves bytes (no 503) ==="
SID2=$(newsb); curl -s "${OLD[@]}" -X PUT --data-binary "hello" "$API/sandboxes/$SID2/files?path=/tmp/t" >/dev/null
hibernate "$SID2"
RB=$(curl -s -o /tmp/bc_f -w '%{http_code}' "${OLD[@]}" "$API/sandboxes/$SID2/files?path=/tmp/t")
echo "  HTTP $RB body=$(cat /tmp/bc_f)"
{ [ "$RB" = 200 ] && [ "$(cat /tmp/bc_f)" = hello ]; } && ok "cold file op blocked through the wake and served bytes (old behavior)" || no "HTTP $RB body=$(cat /tmp/bc_f)"
del "$SID2"

echo
echo "###########  ASYNC contract (newer SDK)  ###########"

echo "=== exec/run-async: 202 {execId}, poll /result → exit 0 ==="
SID3=$(newsb); echo "sandbox=$SID3"
RJ=$(curl -s -w '\n%{http_code}' "${NEW[@]}" -X POST -d '{"cmd":"sh","args":["-c","sleep 3; echo go"]}' "$API/sandboxes/$SID3/exec/run-async")
HC=$(echo "$RJ"|tail -1); EID=$(echo "$RJ"|sed '$d'|jq_ 'd.get("execId")')
echo "  POST HTTP $HC execId=$EID"
[ "$HC" = 202 ] && [ -n "$EID" ] && ok "run-async returns 202 + execId" || no "HTTP $HC execId=$EID"
FEC=
for _ in $(seq 1 120); do RR=$(curl -s "${NEW[@]}" "$API/sandboxes/$SID3/exec/$EID/result")
  [ "$(echo "$RR"|jq_ 'd["running"]')" = False ] && { FEC=$(echo "$RR"|jq_ 'd.get("exitCode")'); break; }; sleep 1; done
[ "$FEC" = 0 ] && ok "poll resolved exit 0" || no "final exitCode=$FEC"
del "$SID3"

echo "=== snapshots?async=1: 202 building → poll → ready ==="
TS2=$(date +%s)
RB=$(curl -s -o /tmp/bc_snap2 -w '%{http_code}' "${NEW[@]}" -X POST \
  -d "{\"name\":\"backcompat-async-$TS2\",\"image\":{\"base\":\"ubuntu\",\"steps\":[{\"type\":\"run\",\"args\":{\"commands\":[\"echo hi\"]}}]}}" "$API/snapshots?async=1")
ST=$(jq_ 'd.get("status")' </tmp/bc_snap2)
echo "  POST HTTP $RB status=$ST"
{ [ "$RB" = 202 ] && [ "$ST" = building ]; } && ok "async snapshot returns 202 building" || no "HTTP $RB status=$ST"
FST=
for _ in $(seq 1 120); do FST=$(curl -s "${NEW[@]}" "$API/snapshots/backcompat-async-$TS2" | jq_ 'd.get("status")')
  { [ "$FST" = ready ] || [ "$FST" = failed ]; } && break; sleep 2; done
[ "$FST" = ready ] && ok "async snapshot reached ready" || no "ended $FST"

echo "=== files: cold box WITH opt-in header → 503 {waking} fast, served on retry ==="
SID4=$(newsb); curl -s "${NEW[@]}" -X PUT --data-binary "hello" "$API/sandboxes/$SID4/files?path=/tmp/t" >/dev/null
hibernate "$SID4"
T=$(curl -s -o /tmp/bc_f2 -w '%{time_total}' "${NEW[@]}" "$API/sandboxes/$SID4/files?path=/tmp/t")
WK=$(jq_ 'd.get("waking")' </tmp/bc_f2)
echo "  first GET=${T}s waking=$WK"
python3 -c "import sys;sys.exit(0 if float('$T')<5 and '$WK'=='True' else 1)" && ok "cold file returns 503 waking <5s" || no "${T}s waking=$WK"
for _ in $(seq 1 60); do B=$(curl -s -w '|%{http_code}' "${NEW[@]}" "$API/sandboxes/$SID4/files?path=/tmp/t")
  [ "${B##*|}" = 200 ] && break; sleep 2; done
[ "${B%|*}" = hello ] && ok "warm retry served the file" || no "retry body='${B%|*}'"
del "$SID4"

# Best-effort cleanup of the named snapshots.
curl -s "${OLD[@]}" -X DELETE "$API/snapshots/backcompat-legacy-$TS"  >/dev/null 2>&1
curl -s "${OLD[@]}" -X DELETE "$API/snapshots/backcompat-async-$TS2" >/dev/null 2>&1

echo; echo "==========  $PASS passed, $FAIL failed  =========="; exit $((FAIL>0))
