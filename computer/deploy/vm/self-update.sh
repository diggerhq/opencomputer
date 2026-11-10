#!/usr/bin/env bash
# Keep an organization's computer on Calvin's latest release (work 052): pull,
# not push. deploy/update.sh publishes calvin-latest.bundle and then
# calvin-latest.version (the release's short commit) next to it; this checks
# the version every 5 minutes (and 2 minutes after boot, so a computer waking
# from parking catches up) and, when it differs from the running release,
# re-runs the boot script code-only: fetch the bundle, build the release,
# switch `current`, restart the host agent. Running runners keep their release
# and pick up the new one when they next start, like every deploy.
#
# provision.sh runs `self-update.sh install`: it copies itself to
# /usr/local/sbin/slack-presence-self-update, run by
# slack-presence-self-update.timer.
#
# Invariants:
# - Only computers made by the backend (they have /root/calvin-computer.env) pull;
#   the hand-made host is updated by deploy/update.sh's push, as before.
# - The version URL is the bootstrap URL with calvin-latest.bundle replaced by
#   calvin-latest.version: a signed (SAS) URL must therefore be a container SAS.
# - Never logs a token or a URL's query string.
set -euo pipefail

ENV_FILE="${CALVIN_COMPUTER_ENV:-/root/calvin-computer.env}"
BOOT_SCRIPT=/opt/bootstrap/calvin-src/deploy/vm/azure-computer-boot.sh
CURRENT=/opt/slack-presence/current

if [[ ${1:-} == install ]]; then
  install -m 0755 "${BASH_SOURCE[0]}" /usr/local/sbin/slack-presence-self-update
  cat > /etc/systemd/system/slack-presence-self-update.service <<UNIT
# Written by deploy/vm/self-update.sh install.
[Unit]
Description=Update Calvin to its latest published release
After=network-online.target
Wants=network-online.target
ConditionPathExists=$ENV_FILE

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/slack-presence-self-update
UNIT
  cat > /etc/systemd/system/slack-presence-self-update.timer <<UNIT
# Written by deploy/vm/self-update.sh install.
[Unit]
Description=Check for a new Calvin release

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now slack-presence-self-update.timer
  exit 0
fi

[[ -r $ENV_FILE ]] || { echo "no $ENV_FILE: not a computer made by the backend; nothing to do"; exit 0; }
BOOTSTRAP_URL="" CLIENT_ID=""
while IFS='=' read -r k v; do
  case $k in BOOTSTRAP_URL) BOOTSTRAP_URL=$v ;; CLIENT_ID) CLIENT_ID=$v ;; esac
done < "$ENV_FILE"
[[ $BOOTSTRAP_URL == *calvin-latest.bundle* ]] || { echo "bootstrap URL does not name calvin-latest.bundle; not updating"; exit 0; }
version_url="${BOOTSTRAP_URL/calvin-latest.bundle/calvin-latest.version}"

fetch() {
  if [[ $1 == *sig=* ]]; then
    curl -fsS -m 30 --retry 3 "$1"
  else
    local q="api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F${CLIENT_ID:+&client_id=$CLIENT_ID}" tok
    tok="$(curl -fsS -m 10 -H Metadata:true "http://169.254.169.254/metadata/identity/oauth2/token?$q" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" || return 1
    curl -fsS -m 30 --retry 3 -H @<(printf 'Authorization: Bearer %s\nx-ms-version: 2023-11-03\n' "$tok") "$1"
  fi
}

want="$(fetch "$version_url" 2>/dev/null | tr -d '[:space:]')" || { echo "could not read ${version_url%%\?*}"; exit 0; }
[[ $want =~ ^[0-9a-f]{7,40}$ ]] || { echo "published version '${want:0:40}' is not a commit; not updating"; exit 0; }
have="$(basename "$(readlink "$CURRENT" 2>/dev/null || echo none)")"
if [[ $have == "$want"* || $want == "$have"* ]]; then exit 0; fi
[[ -f $BOOT_SCRIPT ]] || { echo "no $BOOT_SCRIPT yet (first boot still running?)"; exit 0; }
echo "updating Calvin: $have -> $want"
CODE_ONLY=1 BOOTSTRAP_FETCH=1 bash "$BOOT_SCRIPT"
echo "now on $(basename "$(readlink "$CURRENT")")"
