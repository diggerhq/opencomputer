#!/usr/bin/env bash
# Prove a freshly published guest image actually serves a real create.
#
# Publishing only proves the image BUILT. This proves it boots and answers the
# control plane — which is the gap that let a guest missing /oc/secrets sit in
# production for three weeks: it built fine, and nothing ever asked it to serve
# the route the control plane was calling.
#
# The create deliberately carries an egressAllowlist. That trips HasSecrets(),
# which is what sends the control plane to /oc/secrets — the exact path whose
# absence returned 415 with an empty body and failed every create carrying a
# secret. A plain create would pass against a broken image.
#
#   ./deploy/microvm/smoke.sh https://app2.opensandbox.ai "$API_KEY"
set -euo pipefail

BASE="${1:-}"
KEY="${2:-}"
if [[ -z "$BASE" || -z "$KEY" ]]; then
  echo "usage: $0 <base-url> <api-key>" >&2
  exit 2
fi

echo "smoke: creating a sandbox with an egress allowlist on $BASE"
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
CODE="$(curl -sS -o "$BODY" -w '%{http_code}' -X POST "$BASE/api/sandboxes" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -H 'x-oc-sdk-version: 1.0.0' \
  -d '{"egressAllowlist":["api.github.com"]}')"

if [[ "$CODE" != "201" ]]; then
  echo "smoke FAILED: create returned $CODE" >&2
  head -c 600 "$BODY" >&2; echo >&2
  echo >&2
  echo "A 415 on /oc/secrets here means the published guest does not serve it —" >&2
  echo "the image is older than the control plane calling it." >&2
  exit 1
fi

SB="$(python3 -c "import json;print(json.load(open('$BODY'))['sandboxID'])")"
WORKER="$(python3 -c "import json;print(json.load(open('$BODY')).get('workerID',''))")"
echo "smoke: created $SB on $WORKER"

# It must be a MicroVM box, or we proved nothing about the image we just built.
case "$WORKER" in
  vmhost:*|microvm:*) ;;
  *) echo "smoke FAILED: $SB landed on $WORKER, not a MicroVM worker" >&2; exit 1 ;;
esac

# Best effort: a leaked smoke box costs money until the service cap.
curl -sS -X DELETE "$BASE/api/sandboxes/$SB" -H "X-API-Key: $KEY" -o /dev/null || true
echo "smoke: OK (deleted $SB)"
