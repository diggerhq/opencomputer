#!/usr/bin/env bash
#
# confirm.sh — verify the 524s are gone against an environment on this change.
#
#   OSB_API_KEY=osb_xxx OSB_BASE=https://app2.opensandbox.ai ./scripts/524/confirm.sh
#
# Every request returns in well under Cloudflare's 100s; long work happens in the
# background and is polled, so there's no 524 on any path.
set -uo pipefail
: "${OSB_API_KEY:?set OSB_API_KEY}"
: "${OSB_BASE:?set OSB_BASE (e.g. https://app2.opensandbox.ai)}"
API="$OSB_BASE/api"
# X-OSB-Async-Wake opts into the 503-waking cold-start flow for file ops (the
# newer SDK sends this; older SDKs get the inline synchronous wake instead).
H=(-H "X-API-Key: $OSB_API_KEY" -H "User-Agent: curl/8.0" -H "Content-Type: application/json" -H "X-OSB-Async-Wake: 1")
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
newsb(){ curl -s "${H[@]}" -X POST -d '{}' "$API/sandboxes" | python3 -c 'import sys,json;print(json.load(sys.stdin)["sandboxID"])'; }
hibernate(){ curl -s "${H[@]}" -X POST "$API/sandboxes/$1/hibernate" >/dev/null
  until [ "$(curl -s "${H[@]}" "$API/sandboxes/$1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status"))')" = hibernated ]; do sleep 2; done; }

run_and_wait(){ # sid cmd -> "exit|stdout|post_secs"
  local rj; rj=$(curl -s -w '\n%{time_total}' "${H[@]}" -X POST \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"cmd":"sh","args":["-c",sys.argv[1]]}))' "$2")" \
    "$API/sandboxes/$1/exec/run-async")
  local ps eid; ps=$(echo "$rj"|tail -1); eid=$(echo "$rj"|head -1|python3 -c 'import sys,json;print(json.load(sys.stdin).get("execId",""))')
  local r; for _ in $(seq 1 300); do r=$(curl -s "${H[@]}" "$API/sandboxes/$1/exec/$eid/result")
    [ "$(echo "$r"|python3 -c 'import sys,json;print(json.load(sys.stdin)["running"])')" = False ] && break; sleep 0.5; done
  echo "$r"|python3 -c "import sys,json;r=json.load(sys.stdin);print(f\"{r.get('exitCode')}|{r.get('stdout','')!r}|$ps\")"
}

echo "=== exec/run: long command, async, no 524 ==="
SID=$(newsb); echo "sandbox=$SID"
IFS='|' read -r ec so ps <<<"$(run_and_wait "$SID" 'sleep 60; echo done')"
echo "  POST=${ps}s exit=$ec stdout=$so"
python3 -c "import sys;sys.exit(0 if float('$ps')<3 else 1)" && ok "POST <3s on a 60s command" || no "POST ${ps}s"
[ "$ec" = 0 ] && ok "exit 0" || no "exit=$ec"

echo "=== exec/run: fast commands keep their exit code ==="
IFS='|' read -r ec so ps <<<"$(run_and_wait "$SID" 'echo hi')";           [ "$ec" = 0 ] && ok "echo hi -> 0" || no "echo hi -> $ec"
IFS='|' read -r ec so ps <<<"$(run_and_wait "$SID" 'echo e>&2; exit 7')"; [ "$ec" = 7 ] && ok "exit 7 kept" || no "got $ec"

echo "=== exec/run: cold (hibernated) returns immediately ==="
hibernate "$SID"
T=$(curl -s -o /tmp/c_run -w '%{time_total}' "${H[@]}" -X POST -d '{"cmd":"sh","args":["-c","echo woke"]}' "$API/sandboxes/$SID/exec/run-async")
echo "  cold POST=${T}s"
python3 -c "import sys;sys.exit(0 if float('$T')<5 else 1)" && ok "cold exec POST <5s" || no "cold exec POST ${T}s"

echo "=== files: cold returns 503 waking immediately, served on retry ==="
SID2=$(newsb); curl -s "${H[@]}" -X PUT --data-binary "hello" "$API/sandboxes/$SID2/files?path=/tmp/t" >/dev/null
hibernate "$SID2"
T=$(curl -s -o /tmp/c_f -w '%{time_total}' "${H[@]}" "$API/sandboxes/$SID2/files?path=/tmp/t")
WK=$(python3 -c 'import json;print(json.load(open("/tmp/c_f")).get("waking"))' 2>/dev/null)
echo "  first GET=${T}s waking=$WK"
python3 -c "import sys;sys.exit(0 if float('$T')<5 and '$WK'=='True' else 1)" && ok "cold files 503 waking <5s" || no "cold files ${T}s waking=$WK"
for _ in $(seq 1 60); do B=$(curl -s -w '|%{http_code}' "${H[@]}" "$API/sandboxes/$SID2/files?path=/tmp/t")
  [ "${B##*|}" = 200 ] && break; sleep 2; done
[ "${B%|*}" = "hello" ] && ok "warm retry served the file" || no "retry body='${B%|*}'"

echo "=== snapshots: non-SSE build is async (building -> ready) ==="
TS=$(date +%s)
B=$(curl -s -o /tmp/c_s -w '%{time_total}' "${H[@]}" -X POST \
  -d "{\"name\":\"confirm-$TS\",\"image\":{\"base\":\"ubuntu\",\"steps\":[{\"type\":\"run\",\"args\":{\"commands\":[\"echo hi\"]}}]}}" "$API/snapshots?async=1")
echo "  POST=${B}s status=$(python3 -c 'import json;print(json.load(open("/tmp/c_s")).get("status"))')"
python3 -c "import sys;sys.exit(0 if float('$B')<5 else 1)" && ok "snapshot POST <5s" || no "snapshot POST ${B}s"
for _ in $(seq 1 120); do ST=$(curl -s "${H[@]}" "$API/snapshots/confirm-$TS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status"))' 2>/dev/null)
  { [ "$ST" = ready ] || [ "$ST" = failed ]; } && break; sleep 2; done
[ "$ST" = ready ] && ok "snapshot -> ready" || no "snapshot ended $ST"

echo; echo "==========  $PASS passed, $FAIL failed  =========="; exit $((FAIL>0))
