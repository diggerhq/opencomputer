#!/usr/bin/env bash
# First boot of an organization's computer (work 052: a computer per
# organization). The backend creates the Azure VM with the cloud-init below; it
# fetches Calvin's latest release and runs this script as root, which does a
# full provision.sh (toolchains, data disk, units, host.env) and starts the
# host agent, which dials the gateway with the organization's host token.
#
# Idempotent: re-running it (by hand, or after a failed first boot) fetches the
# latest release again and re-runs provision.sh, which never formats a disk
# that is not blank and keeps /data. Later code updates come from
# deploy/update.sh like on every other host. Log: /var/log/calvin-boot.log.
#
# Inputs, from the environment or, for any that is unset, from
# /root/calvin-computer.env (CALVIN_COMPUTER_ENV; unquoted KEY=value lines):
#   SP_GATEWAY_URL   the gateway's host WebSocket, wss://<gateway>/api/machine/host?organizationId=<urlencoded id>
#   SP_HOST_TOKEN    the organization's host token (secret; never logged)
#   SP_HOST_ID       the organization id, e.g. slack:T0TEST00001
#   DATA_DEVICE      the data disk: /dev/disk/azure/data/by-lun/0 (NVMe-only sizes
#                    such as v6/v7) or /dev/disk/azure/scsi1/lun0 (SCSI sizes).
#                    Optional: provision.sh finds LUN 0 by itself on Azure.
#   BOOTSTRAP_URL    https URL of the release bundle, e.g.
#                    https://<storage account>.blob.core.windows.net/<container>/calvin-latest.bundle
#   SP_TELEMETRY_URL, SP_TELEMETRY_CREDENTIAL, SP_REGION, SP_SUBSTRATE
#                    optional: telemetry collector, the host's signed credential
#                    (secret; never logged) and dimensions (work 054); passed to
#                    provision.sh for host.env.
#   CLIENT_ID        optional: client id of the VM's user-assigned identity
#                    (the one allowed to read BOOTSTRAP_URL). Needed only if the VM has more than one.
#   BOOTSTRAP_FETCH  1 (default): download BOOTSTRAP_URL and check it out first.
#   CODE_ONLY        0 (default): full provision; 1: code and units only
#                    (deploy/vm/self-update.sh, for a new release).
#                    0: use /opt/bootstrap/calvin-src as it is (the cloud-init
#                    below just did that).
#
# The cloud-init the backend emits as the VM's customData. customData cannot fetch
# this script before Calvin's code is on the VM, so it inlines the fetch (the
# same steps as fetch_release below) and then execs this script from the
# clone. customData is root-only on the VM, and provision.sh blocks the
# metadata service for the agent user; the env file is root 0600.
#
#   #cloud-config
#   write_files:
#     - path: /root/calvin-computer.env
#       owner: root:root
#       permissions: "0600"
#       content: |
#         SP_GATEWAY_URL=wss://<gateway>/api/machine/host?organizationId=slack%3AT0TEST00001
#         SP_HOST_TOKEN=<the organization's host token>
#         SP_HOST_ID=<organization id>
#         DATA_DEVICE=/dev/disk/azure/data/by-lun/0
#         BOOTSTRAP_URL=https://<storage account>.blob.core.windows.net/<container>/calvin-latest.bundle
#         CLIENT_ID=<client id of the VM's bootstrap identity>
#   runcmd:
#     - - bash
#       - -c
#       - |
#         set -euo pipefail
#         exec >>/var/log/calvin-boot.log 2>&1
#         set -a; . /root/calvin-computer.env; set +a
#         q="api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F${CLIENT_ID:+&client_id=$CLIENT_ID}"
#         tok=""
#         for i in $(seq 60); do
#           tok="$(curl -fsS -m 10 -H Metadata:true "http://169.254.169.254/metadata/identity/oauth2/token?$q" \
#             | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" && break
#           sleep 5
#         done
#         [ -n "$tok" ] || { echo "no managed identity token"; exit 1; }
#         install -d -m 0755 /opt/bootstrap
#         curl -fsS --retry 10 --retry-delay 5 --retry-all-errors -H "Authorization: Bearer $tok" \
#           -H 'x-ms-version: 2023-11-03' "$BOOTSTRAP_URL" -o /opt/bootstrap/calvin.bundle
#         unset tok
#         rm -rf /opt/bootstrap/calvin-src
#         git clone -q --branch main /opt/bootstrap/calvin.bundle /opt/bootstrap/calvin-src
#         BOOTSTRAP_FETCH=0 exec bash /opt/bootstrap/calvin-src/deploy/vm/azure-computer-boot.sh
#
# By hand on a computer (Run Command, as root): bash /opt/bootstrap/calvin-src/deploy/vm/azure-computer-boot.sh

set -euo pipefail
umask 022

LOG=/var/log/calvin-boot.log
ENV_FILE="${CALVIN_COMPUTER_ENV:-/root/calvin-computer.env}"
BOOT=/opt/bootstrap
SRC="$BOOT/calvin-src"
BUNDLE="$BOOT/calvin.bundle"
KEYS=(SP_GATEWAY_URL SP_HOST_TOKEN SP_HOST_ID DATA_DEVICE BOOTSTRAP_URL CLIENT_ID
  SP_TELEMETRY_URL SP_TELEMETRY_CREDENTIAL SP_REGION SP_SUBSTRATE)

log() { printf '%s calvin-boot: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# Values from the environment win; the env file fills in the rest.
load_env_file() {
  [[ -r $ENV_FILE ]] || return 0
  local k v key
  while IFS='=' read -r k v; do
    for key in "${KEYS[@]}"; do
      if [[ $k == "$key" && -z ${!key:-} ]]; then export "$key=$v"; fi
    done
  done < "$ENV_FILE"
}

# A storage token from the instance metadata service with the VM's managed
# identity. The identity can lag the VM's start by a little: retry ~5 minutes.
storage_token() {
  local q="api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F${CLIENT_ID:+&client_id=$CLIENT_ID}" tok i
  for i in $(seq 60); do
    tok="$(curl -fsS -m 10 -H Metadata:true "http://169.254.169.254/metadata/identity/oauth2/token?$q" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' 2>/dev/null)" && [[ -n $tok ]] \
      && { printf '%s' "$tok"; return 0; }
    (( i % 12 == 1 )) && log "waiting for a managed identity token from IMDS"
    sleep 5
  done
  return 1
}

# Download BOOTSTRAP_URL and check it out in $SRC, like deploy/update.sh does.
fetch_release() {
  local tok
  install -d -m 0755 "$BOOT"
  log "downloading ${BOOTSTRAP_URL%%\?*}"
  if [[ $BOOTSTRAP_URL == *sig=* ]]; then
    # A read-only signed URL (preview computers): no managed identity needed.
    curl -fsS --retry 10 --retry-delay 5 --retry-all-errors "$BOOTSTRAP_URL" -o "$BUNDLE.new" \
      || die "download of ${BOOTSTRAP_URL%%\?*} failed"
  else
    tok="$(storage_token)" || die "no managed identity token from IMDS (is computer-bootstrap assigned?)"
    # The token goes to curl as a header file on a pipe, not on its command line.
    curl -fsS --retry 10 --retry-delay 5 --retry-all-errors \
      -H @<(printf 'Authorization: Bearer %s\nx-ms-version: 2023-11-03\n' "$tok") \
      "$BOOTSTRAP_URL" -o "$BUNDLE.new" || die "download of $BOOTSTRAP_URL failed"
  fi
  mv -f "$BUNDLE.new" "$BUNDLE"
  [[ -d $SRC/.git ]] || { rm -rf "$SRC"; git init -q "$SRC"; }
  git -C "$SRC" fetch -q "$BUNDLE" main
  git -C "$SRC" checkout -q -f --detach FETCH_HEAD
}

main() {
  load_env_file
  local k
  for k in SP_GATEWAY_URL SP_HOST_TOKEN SP_HOST_ID; do [[ -n ${!k:-} ]] || die "$k is not set (environment or $ENV_FILE)"; done
  if [[ ${BOOTSTRAP_FETCH:-1} == 1 ]]; then
    [[ -n ${BOOTSTRAP_URL:-} ]] || die "BOOTSTRAP_URL is not set"
    fetch_release
  fi
  [[ -f $SRC/deploy/vm/provision.sh ]] || die "no $SRC/deploy/vm/provision.sh; run with BOOTSTRAP_FETCH=1"
  log "release $(git -C "$SRC" rev-parse --short=12 HEAD), host id $SP_HOST_ID, data ${DATA_DEVICE:-Azure LUN 0}"

  # A full provision: toolchains on first boot, then the data disk, code, units
  # and host.env. Transient failures (apt mirrors, downloads) are retried; every
  # step is idempotent.
  local attempt
  for attempt in 1 2 3; do
    if env CLOUD=none REPO_URL="$BUNDLE" REPO_REF=main CODE_ONLY="${CODE_ONLY:-0}" \
        SP_GATEWAY_URL="$SP_GATEWAY_URL" SP_HOST_TOKEN="$SP_HOST_TOKEN" SP_HOST_ID="$SP_HOST_ID" \
        SP_TELEMETRY_URL="${SP_TELEMETRY_URL:-}" SP_TELEMETRY_CREDENTIAL="${SP_TELEMETRY_CREDENTIAL:-}" \
        SP_REGION="${SP_REGION:-}" SP_SUBSTRATE="${SP_SUBSTRATE:-}" \
        DATA_DEVICE="${DATA_DEVICE:-}" SP_DEFINITION_NAME=computer bash "$SRC/deploy/vm/provision.sh"; then
      log "done: $(readlink /opt/slack-presence/current), host agent $(systemctl is-active slack-presence-host || true)"
      return 0
    fi
    log "provision.sh failed (attempt $attempt)"
    (( attempt < 3 )) && sleep 30
  done
  die "provision.sh failed 3 times; see above"
}

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# Everything goes to the log (cloud-init's own log keeps only what precedes this).
exec >>"$LOG" 2>&1
chmod 0640 "$LOG" 2>/dev/null || true
main "$@"
