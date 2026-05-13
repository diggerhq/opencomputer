#!/bin/bash
# populate-vector-env.sh — Fetch the Axiom platform-logs ingest token from
# Azure Key Vault via the VM's managed identity, write it to
# /etc/opensandbox/vector.env so Vector picks it up at start.
#
# Runs as a one-shot systemd unit (populate-vector-env.service) before
# vector.service. Idempotent on every boot.
#
# Required env (sourced from /etc/opensandbox/worker.env or server.env by
# the systemd unit's EnvironmentFile=):
#   SECRETS_VAULT_NAME       Key Vault name (e.g. opencomputer-prod-kv)
#
# Optional env (used to enrich Vector's host envelope for non-JSON lines):
#   OPENSANDBOX_CELL_ID      e.g. eastus2-default
#   OPENSANDBOX_REGION       e.g. eastus2
#   AXIOM_PLATFORM_DATASET   override (default: oc-platform-logs)
#
# Secret name in KV: `shared-axiom-platform-ingest-token`. Stored under
# `shared-` so the same secret can be read by both worker and server hosts.
# If absent, the script exits 0 — Vector will fail its healthcheck and
# events will buffer to disk until the secret appears; this is intentional
# (don't break the worker boot path over a missing logging credential).
set -euo pipefail

VAULT_NAME="${SECRETS_VAULT_NAME:-}"
ENV_FILE=/etc/opensandbox/vector.env
SECRET_NAME=shared-axiom-platform-ingest-token

log() { logger -t populate-vector-env "$*"; echo "$*"; }

if [ -z "$VAULT_NAME" ]; then
    log "SECRETS_VAULT_NAME not set — skipping (Vector will start without a token)"
    exit 0
fi

# IMDS → AAD token for Key Vault
IMDS_RESP=$(curl -sf -H 'Metadata: true' \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net" \
    || true)
AAD_TOKEN=$(echo "$IMDS_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
if [ -z "$AAD_TOKEN" ]; then
    log "failed to acquire IMDS token (managed identity not attached?); skipping"
    exit 0
fi

# Fetch the platform-logs ingest token from the vault.
SECRET_RESP=$(curl -sf -H "Authorization: Bearer $AAD_TOKEN" \
    "https://${VAULT_NAME}.vault.azure.net/secrets/${SECRET_NAME}?api-version=7.4" \
    || true)
SECRET_VALUE=$(echo "$SECRET_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("value",""))' 2>/dev/null)
if [ -z "$SECRET_VALUE" ]; then
    log "secret $SECRET_NAME not found in $VAULT_NAME (or no access); skipping"
    exit 0
fi

# Auto-detect HOST_IP via the kernel's source-address selection (skips link-local).
HOST_IP=$(ip route get 8.8.8.8 2>/dev/null | awk '/src/ {for(i=1;i<NF;i++) if($i=="src") print $(i+1); exit}' || true)

install -d -m 0755 /etc/opensandbox
umask 077
cat > "${ENV_FILE}.tmp" <<EOF
AXIOM_PLATFORM_TOKEN=${SECRET_VALUE}
AXIOM_PLATFORM_DATASET=${AXIOM_PLATFORM_DATASET:-oc-platform-logs}
OPENSANDBOX_CELL_ID=${OPENSANDBOX_CELL_ID:-unknown}
OPENSANDBOX_REGION=${OPENSANDBOX_REGION:-unknown}
OPENSANDBOX_HOST_IP=${HOST_IP:-unknown}
EOF
chown root:root "${ENV_FILE}.tmp"
chmod 0600 "${ENV_FILE}.tmp"
mv -f "${ENV_FILE}.tmp" "$ENV_FILE"

log "populated $ENV_FILE (token from $VAULT_NAME/$SECRET_NAME, host_ip=${HOST_IP:-unknown})"
