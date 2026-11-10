#!/usr/bin/env bash
# Reconciles exits.json into Fly apps (oc-exit-<region>-<n>) and writes the
# registry (src/egress-registry.json, which the control plane imports).
# Re-runnable: existing apps, IPs and REALITY keys are kept.
#
#   EGRESS_ROOT_KEYS=<hex,...> [EGRESS_POLICY='{"deployments":{...}}'] \
#   [EGRESS_EDGE=https://managedagents.opencomputer.dev EGRESS_FETCH_TOKEN=<token>] ./apply.sh [region]
#
# With EGRESS_EDGE and EGRESS_FETCH_TOKEN, each exit polls its region's policy
# from the edge (/internal/egress/policy); EGRESS_POLICY stays enforced on top.
#
# Needs flyctl (logged in, or FLY_API_TOKEN), sing-box (key generation) and jq.
# A REALITY private key exists only as a Fly secret; the registry keeps the
# public half. Losing an app's secrets means a new keypair (delete its registry
# entry and re-run).
set -euo pipefail
cd "$(dirname "$0")"
# Under src/ so tsc's output keeps its root (dist/microvm/supervisor.js).
REGISTRY=../../src/egress-registry.json
: "${EGRESS_ROOT_KEYS:?set EGRESS_ROOT_KEYS}"
# The smoke deployments (test/policy.json) are always added, so test/smoke.py
# can run against any exit. Their credentials need a root key like any other.
POLICY=$(printf '%s' "${EGRESS_POLICY:-{\"deployments\":{\}\}}" | jq -c --slurpfile t test/policy.json '.deployments += $t[0].deployments')
ONLY="${1:-}"
EDGE="${EGRESS_EDGE:-}"
if [ -n "$EDGE" ]; then : "${EGRESS_FETCH_TOKEN:?set EGRESS_FETCH_TOKEN with EGRESS_EDGE}"; fi
for bin in fly sing-box jq; do command -v $bin >/dev/null || { echo "missing $bin" >&2; exit 1; }; done

ORG=$(jq -r .org exits.json); DECOY=$(jq -r .decoy exits.json)
[ -f "$REGISTRY" ] || echo '{"exits": []}' > "$REGISTRY"

ips() { fly ips list -a "$1" --json; }  # Type: v4 (dedicated inbound), egress_v4, ...
entry() { jq -c --arg app "$1" '.exits[] | select(.app == $app)' "$REGISTRY"; }

for region in $(jq -r '.regions | keys[]' exits.json); do
  [ -z "$ONLY" ] || [ "$ONLY" = "$region" ] || continue
  FLY_REGION=$(jq -r --arg r "$region" '.regions[$r].fly_region' exits.json)
  COUNT=$(jq -r --arg r "$region" '.regions[$r].exits' exits.json)
  for n in $(seq 1 "$COUNT"); do
    APP="oc-exit-$region-$n"
    echo "==> $APP ($FLY_REGION)"
    fly status -a "$APP" >/dev/null 2>&1 || fly apps create "$APP" -o "$ORG"

    PUB=$(entry "$APP" | jq -r '.reality.public_key // empty')
    SID=$(entry "$APP" | jq -r '.reality.short_id // empty')
    SECRETS="EGRESS_ROOT_KEYS=$EGRESS_ROOT_KEYS
EGRESS_POLICY=$POLICY"
    [ -z "$EDGE" ] || SECRETS="$SECRETS
EGRESS_FETCH_TOKEN=$EGRESS_FETCH_TOKEN"
    if [ -z "$PUB" ]; then
      KP=$(sing-box generate reality-keypair)
      PUB=$(awk '/PublicKey/{print $2}' <<<"$KP")
      SID=$(sing-box generate rand --hex 8)
      SECRETS="$SECRETS
REALITY_PRIVATE_KEY=$(awk '/PrivateKey/{print $2}' <<<"$KP")
REALITY_SHORT_ID=$SID"
    fi
    printf '%s\n' "$SECRETS" | fly secrets import -a "$APP" --stage >/dev/null

    ips "$APP" | jq -e 'any(.[]; .Type == "v4")' >/dev/null || fly ips allocate-v4 -a "$APP" --yes
    ips "$APP" | jq -e 'any(.[]; .Type == "egress_v4")' >/dev/null \
      || fly ips allocate-egress -a "$APP" -r "$FLY_REGION" --yes

    sed -e "s|__APP__|$APP|" -e "s|__FLY_REGION__|$FLY_REGION|" -e "s|__DECOY__|$DECOY|" \
        -e "s|__POLICY_URL__|${EDGE:+$EDGE/internal/egress/policy?region=$region}|" \
        server/fly.tmpl.toml > "server/fly.$APP.toml"
    fly deploy ./server -c "$PWD/server/fly.$APP.toml" -a "$APP" --ha=false --remote-only
    rm -f "server/fly.$APP.toml"

    SERVER=$(ips "$APP" | jq -r 'first(.[] | select(.Type == "v4")) | .Address')
    EGRESS=$(ips "$APP" | jq -r 'first(.[] | select(.Type == "egress_v4")) | .Address')
    [ -n "$SERVER" ] && [ -n "$EGRESS" ] || { echo "$APP: missing inbound or egress IPv4" >&2; exit 1; }
    jq --arg app "$APP" --arg region "$region" --arg fr "$FLY_REGION" --arg server "$SERVER" \
       --arg egress "$EGRESS" --arg pub "$PUB" --arg sid "$SID" --arg decoy "$DECOY" '
      .exits = ([.exits[] | select(.app != $app)] + [{
        region: $region, fly_region: $fr, app: $app, server: $server, ports: [443, 8443],
        egress_ipv4: $egress,
        reality: { public_key: $pub, short_id: $sid, server_name: $decoy }
      }] | sort_by(.region, .app))' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
    echo "    inbound $SERVER, egress $EGRESS"
  done
done
