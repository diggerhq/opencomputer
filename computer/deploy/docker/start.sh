#!/usr/bin/env bash
# Self-host container entrypoint (work 101): the gateway and the host agent in
# one container, runners started by the host as detached processes. On the
# first start it generates the instance's keys into $SP_HOME/instance.env and
# prints the /setup link; later starts reuse them, so the data volume is the
# whole instance (move it to move the instance).
#
#   SP_HOME     data volume (/data): instance.env, gateway.db, host/, workspaces/
#   SP_ORIGIN   public origin Slack and browsers use (https://$SP_DOMAIN, else
#               http://localhost:$PORT); Slack events need HTTPS, so set it to a
#               tunnel's URL or give the VM's domain as SP_DOMAIN
#   PORT        gateway port in the container (8080)
#
# Started as root only to hand the volume to `node`; it re-runs itself as
# `node` with setpriv, and nothing runs as root after that.
set -euo pipefail

SP_HOME="${SP_HOME:-/data}"
PORT="${PORT:-8080}"
SP_RUN="${SP_RUN:-/run/slack-presence}"
APP="${SP_APP:-$(cd "$(dirname "$0")/../.." && pwd)}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$SP_HOME" "$SP_RUN"
  chown node:node "$SP_HOME" "$SP_RUN"
  exec setpriv --reuid=node --regid=node --init-groups -- env HOME=/home/node "$0" "$@"
fi

umask 077
mkdir -p "$SP_HOME/host" "$SP_HOME/workspaces" "$SP_RUN"
ENV_FILE="$SP_HOME/instance.env"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "SETUP_TOKEN=$(openssl rand -hex 24)"
    echo "SP_STORE_KEY=$(openssl rand -hex 32)"
    echo "SP_HOST_TOKEN=sph_$(openssl rand -hex 32)"
  } >"$ENV_FILE"
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

ORIGIN="${SP_ORIGIN:-${SP_DOMAIN:+https://$SP_DOMAIN}}"
ORIGIN="${ORIGIN:-http://localhost:$PORT}"
ORIGIN="${ORIGIN%/}"

# Compose passes unset variables as empty strings; drop them (the gateway parses SP_PEOPLE as JSON).
for v in SP_PEOPLE GITHUB_ORG ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do [ -n "${!v:-}" ] || unset "$v"; done

cd "$APP"
TSX="$APP/node_modules/.bin/tsx"

PORT="$PORT" SP_DB="$SP_HOME/gateway.db" SP_ORIGIN="$ORIGIN" SP_HOST_TOKENS="$SP_HOST_TOKEN" \
  "$TSX" src/gateway/main.ts &
gateway=$!

for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$gateway" 2>/dev/null || { wait "$gateway"; exit 1; }
  sleep 0.2
done

SP_GATEWAY_URL="ws://127.0.0.1:$PORT/host" SP_HOST_ID="${SP_HOST_ID:-local}" SP_DATA="$SP_HOME/host" \
  SP_RUN="$SP_RUN" SP_LAUNCH=detached SETUP_TOKEN= SP_STORE_KEY= ANTHROPIC_API_KEY= CLAUDE_CODE_OAUTH_TOKEN= \
  "$TSX" src/host/main.ts &
host=$!

cat <<BANNER

  Computer is running. Finish setup in your browser:

    $ORIGIN/setup?token=$SETUP_TOKEN

  (the token is in $ENV_FILE; keep it private)

BANNER

# Either process ending ends the container; the restart policy brings both back.
set +e
wait -n "$gateway" "$host"
code=$?
kill "$gateway" "$host" 2>/dev/null
wait
exit "$code"
