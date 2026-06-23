#!/usr/bin/env bash
# Dev-only Autumn billing test helper. NOT part of any deploy — local use only.
#
# Autumn key + EVENT_SECRET are Infisical-injected (not in dev Key Vault), so
# export them first (values from Infisical / the Autumn dashboard):
#     export AUTUMN_SK=am_sk_...      # for customer / set-balance
#     export EVENT_SECRET=...         # for project
# Nothing sensitive is written to disk or echoed. Org state is read from D1.
#
#   ./autumn-test.sh state       <org-prefix|uuid>      # D1: provider/halt/concurrency/balance
#   ./autumn-test.sh customer    <org-uuid>             # Autumn: balance + subscriptions
#   ./autumn-test.sh set-balance <org-uuid> <usd>       # Autumn: overwrite credit balance
#   ./autumn-test.sh project     <org-uuid>             # force edge re-projection (signed)
#
# Typical halt test:  set-balance <org> 0  ->  project <org>  ->  state <org>  (is_halted=1)
set -euo pipefail

VAULT=opensandbox-dev-kv
EDGE=https://app2.opensandbox.ai
AUTUMN=https://api.useautumn.com/v1
D1DIR="$(cd "$(dirname "$0")/../../cloudflare-workers/api-edge" && pwd)"

kv() { az keyvault secret show --vault-name "$VAULT" --name "$1" --query value -o tsv 2>/dev/null; }

cmd="${1:-}"; org="${2:-}"
[ -z "$cmd" ] && { grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

case "$cmd" in
  state)
    [ -z "$org" ] && { echo "need <org>"; exit 1; }
    ( cd "$D1DIR" && node_modules/.bin/wrangler d1 execute opencomputer-dev --remote --json \
      --command "SELECT substr(id,1,8) org, plan, billing_provider, is_halted, max_concurrent_sandboxes, free_credits_remaining_cents, credit_balance_cents, max_disk_mb FROM orgs WHERE id LIKE '${org}%';" 2>/dev/null ) \
      | python3 -c "import sys,json;[print(r) for r in json.load(sys.stdin)[0]['results']] or print('no match')"
    ;;
  customer)
    [ -z "$org" ] && { echo "need <org-uuid>"; exit 1; }
    SK="${AUTUMN_SK:-$(kv server-autumn-secret-key)}"
    curl -s "$AUTUMN/customers/$org" -H "Authorization: Bearer $SK" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print('balance:',d.get('balances',{}).get('credits',{}).get('remaining'));print('subs:',[{ 'plan':s.get('plan_id'),'status':s.get('status')} for s in d.get('subscriptions',[])])"
    ;;
  set-balance)
    usd="${3:-}"; [ -z "$org" ] || [ -z "$usd" ] && { echo "need <org-uuid> <usd>"; exit 1; }
    SK="${AUTUMN_SK:-$(kv server-autumn-secret-key)}"
    curl -s -X POST "$AUTUMN/customers/$org/balances" -H "Authorization: Bearer $SK" \
      -H "content-type: application/json" \
      -d "{\"balances\":[{\"feature_id\":\"credits\",\"balance\":$usd}]}" -o /dev/null -w "set-balance -> HTTP %{http_code}\n"
    ;;
  project)
    [ -z "$org" ] && { echo "need <org-uuid>"; exit 1; }
    ES="${EVENT_SECRET:-$(kv server-cf-event-secret)}"
    ts=$(date +%s); path="/internal/autumn-project"; body="{\"org_id\":\"$org\"}"
    sig=$(printf '%s' "$ts.$path.$body" | openssl dgst -sha256 -hmac "$ES" -hex | sed 's/^.*= //')
    curl -s -X POST "$EDGE$path" -H "X-Timestamp: $ts" -H "X-Signature: $sig" \
      -H "content-type: application/json" -d "$body" -w "\nproject -> HTTP %{http_code}\n"
    ;;
  *) echo "unknown: $cmd"; grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1;;
esac
