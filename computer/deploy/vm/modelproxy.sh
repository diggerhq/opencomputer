#!/usr/bin/env bash
# oc-modelproxy on a computer (work 077): Claude Code in runners reaches the
# owner's Claude subscription through it, never holding the token.
#
# provision.sh runs `modelproxy.sh install` on every provision and code-only
# update: it installs the binary CI built, shipped in the release as
# modelproxy/oc-modelproxy (deploy/bundle.sh), as /usr/local/libexec/oc-modelproxy
# when it changed, and writes its socket and service units. Nothing is
# compiled on a computer.
#
#   /run/oc-modelproxy/api.sock      group agent: runners' Claude Code (ANTHROPIC_UNIX_SOCKET)
#   /run/oc-modelproxy/control.sock  group sp-host: the host agent only (SP_MODEL_PROXY)
#
# Invariants:
# - Inert until the host agent runs as sp-host (sp-host.sh migrate): before
#   that the host cannot open the control socket, sets no SP_MODEL_PROXY, and
#   the gateway routes every session managed.
# - Best effort: a release without a working binary leaves the previous one
#   (or none) and never fails the provision; the host then advertises no `model-proxy`.
# - The proxy runs as its own system user with no home and no write access
#   outside its runtime directory, so a runner (uid agent) can neither read its
#   memory nor its tokens.
# - The proxy's profiles (its upstreams, modelproxy/profiles/*.json in the
#   release) are installed with the binary that reads them or not at all:
#   $PROFILES holds exactly the release's files once that binary has loaded
#   them (`-check`). A set it refuses is a release without a working binary:
#   the installed binary and its profiles both stay.
set -euo pipefail

AGENT_USER="${AGENT_USER:-agent}"
SP_CURRENT="${SP_CURRENT:-/opt/slack-presence/current}"
BIN=/usr/local/libexec/oc-modelproxy
USER_=modelproxy
RUN=/run/oc-modelproxy
PROFILES=/etc/oc-modelproxy/profiles.d

[[ ${1:-} == install ]] || { echo "usage: modelproxy.sh install" >&2; exit 2; }

getent group sp-host >/dev/null || groupadd --system sp-host
id "$USER_" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_"

# The release's profiles, copied beside $PROFILES (root's, 0755 and 0644) and
# loaded there by the release's binary; false when it refuses them. A release
# without modelproxy/profiles/ has a proxy from before profiles: nothing to do.
stage_profiles() {
  local from="$SP_CURRENT/modelproxy/profiles" f why="" copied=1
  [[ -d $from ]] || return 0
  install -d -m 0755 -o root -g root "$(dirname "$PROFILES")" "$PROFILES.new" || copied=0
  for f in "$from"/*.json; do
    [[ ! -f $f || $copied == 0 ]] || install -m 0644 -o root -g root "$f" "$PROFILES.new/" || copied=0
  done
  if [[ $copied == 1 ]] && why="$("$src" -check -profiles "$PROFILES.new" 2>&1)"; then return 0; fi
  echo "WARNING: oc-modelproxy does not load this release's profiles: ${why:-they could not be copied to $PROFILES.new}" >&2
  rm -rf "$PROFILES.new"
  return 1
}

# Install only a binary that answers --version (a bundle made without one, or
# built for another platform, keeps whatever is installed) and loads its profiles.
src="$SP_CURRENT/modelproxy/oc-modelproxy"
rm -rf "$PROFILES.new" # of a run that died
if [[ -f $src ]] && "$src" --version >/dev/null 2>&1 && stage_profiles; then
  if ! cmp -s "$src" "$BIN"; then
    install -D -m 0755 "$src" "$BIN"
    changed=1
  fi
else
  echo "WARNING: no working oc-modelproxy in this release (deploy/bundle.sh ships CI's build); keeping $([[ -x $BIN ]] && echo the installed one || echo none)" >&2
fi
[[ -x $BIN ]] || exit 0

# Not RuntimeDirectory=: it would go when the service stops, taking the sockets runners hold.
cat > /etc/tmpfiles.d/oc-modelproxy.conf <<EOF
d $RUN 0755 $USER_ $USER_ -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/oc-modelproxy.conf

# The profiles staged above take the place of the installed ones: exactly the
# release's files, so one dropped from a release is gone here. The proxy reads
# them once at start, so a changed set restarts it like a changed binary.
if [[ -d $PROFILES.new ]]; then
  diff -rq "$PROFILES.new" "$PROFILES" >/dev/null 2>&1 || changed=1
  rm -rf "$PROFILES.old"
  [[ ! -e $PROFILES ]] || mv "$PROFILES" "$PROFILES.old"
  mv "$PROFILES.new" "$PROFILES"
  rm -rf "$PROFILES.old"
  "$BIN" -check -profiles "$PROFILES" >&2 || { echo "WARNING: oc-modelproxy does not load $PROFILES; its units are left as they are" >&2; exit 0; }
fi

cat > /etc/systemd/system/oc-modelproxy-api.socket <<EOF
# Written by deploy/vm/modelproxy.sh install.
[Unit]
Description=oc-modelproxy: Claude Code's socket (runners)

[Socket]
ListenStream=$RUN/api.sock
SocketUser=$USER_
SocketGroup=$AGENT_USER
SocketMode=0660
FileDescriptorName=api
Service=oc-modelproxy.service

[Install]
WantedBy=sockets.target
EOF

cat > /etc/systemd/system/oc-modelproxy-control.socket <<EOF
# Written by deploy/vm/modelproxy.sh install.
[Unit]
Description=oc-modelproxy: the host agent's control socket

[Socket]
ListenStream=$RUN/control.sock
SocketUser=$USER_
SocketGroup=sp-host
SocketMode=0660
FileDescriptorName=control
Service=oc-modelproxy.service

[Install]
WantedBy=sockets.target
EOF

cat > /etc/systemd/system/oc-modelproxy.service <<EOF
# Written by deploy/vm/modelproxy.sh install.
[Unit]
Description=oc-modelproxy: Claude subscriptions for runners (work 077)
Requires=oc-modelproxy-api.socket oc-modelproxy-control.socket
After=oc-modelproxy-api.socket oc-modelproxy-control.socket network-online.target
Wants=network-online.target

[Service]
Type=notify
User=$USER_
Group=$USER_
ExecStart=$BIN --bindings-file=$RUN/bindings.json
Restart=always
RestartSec=1
# Streams in flight may finish on a restart (Claude Code's own request timeout is 600 s).
TimeoutStopSec=660
# A memory-pressured computer kills a runner, not every stream.
OOMScoreAdjust=-900
MemoryMax=512M
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$RUN
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
# Reads callers' cgroups to tell runners apart (unit sp-runner-<id>.service).
ProtectProc=default

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now oc-modelproxy-api.socket oc-modelproxy-control.socket
systemctl enable oc-modelproxy.service
# A new binary takes over without blocking the provision: the old one drains its streams (up to 10 min)
# while new connections wait on the sockets; the host resyncs its binds when it reconnects.
if [[ ${changed:-0} == 1 ]]; then systemctl restart --no-block oc-modelproxy.service; else systemctl start --no-block oc-modelproxy.service; fi
echo "oc-modelproxy: $("$BIN" --version 2>/dev/null || echo installed)"
