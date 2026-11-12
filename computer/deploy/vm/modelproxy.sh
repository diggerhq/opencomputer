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
#   /run/oc-modelproxy/api/api.sock  group agent: runners' Claude Code (ANTHROPIC_UNIX_SOCKET)
#   /run/oc-modelproxy/control.sock  group sp-host: the host agent only (SP_MODEL_PROXY)
#   /run/oc-modelproxy/api.sock      a link to api/api.sock, for runners started by an older release
#
# The API socket has a directory of its own (work 103) because a session's
# container mounts that directory and nothing else of the proxy's: the control
# socket and the bindings file stay outside every container.
#
# Invariants:
# - Inert until the host agent runs as sp-host (sp-host.sh migrate): before
#   that the host cannot open the control socket, sets no SP_MODEL_PROXY, and
#   the gateway routes every session managed.
# - /run/oc-modelproxy/api exists after every install, proxy or not: a
#   container names it as a bind source, and podman refuses a missing one.
# - Best effort: a release without a working binary leaves the previous one
#   (or none) and never fails the provision; the host then advertises no `model-proxy`.
# - The proxy runs as its own system user with no home and no write access
#   outside its runtime directory, so a runner (uid agent) can neither read its
#   memory nor its tokens.
set -euo pipefail

AGENT_USER="${AGENT_USER:-agent}"
SP_CURRENT="${SP_CURRENT:-/opt/slack-presence/current}"
BIN=/usr/local/libexec/oc-modelproxy
USER_=modelproxy
RUN=/run/oc-modelproxy

[[ ${1:-} == install ]] || { echo "usage: modelproxy.sh install" >&2; exit 2; }

getent group sp-host >/dev/null || groupadd --system sp-host
id "$USER_" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_"

# Install only a binary that answers --version (a bundle made without one, or
# built for another platform, keeps whatever is installed).
src="$SP_CURRENT/modelproxy/oc-modelproxy"
if [[ -f $src ]] && "$src" --version >/dev/null 2>&1; then
  if ! cmp -s "$src" "$BIN"; then
    install -D -m 0755 "$src" "$BIN"
    changed=1
  fi
else
  echo "WARNING: no working oc-modelproxy in this release (deploy/bundle.sh ships CI's build); keeping $([[ -x $BIN ]] && echo the installed one || echo none)" >&2
fi

# Not RuntimeDirectory=: it would go when the service stops, taking the sockets runners hold.
# Before the binary is looked at: the api directory is there on a computer without a proxy too.
cat > /etc/tmpfiles.d/oc-modelproxy.conf <<EOF
d $RUN 0755 $USER_ $USER_ -
d $RUN/api 0750 $USER_ $AGENT_USER -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/oc-modelproxy.conf
[[ -x $BIN ]] || exit 0

# Where the API socket listens, as the unit on disk has it: when that changes,
# the socket unit must be restarted, which systemd refuses while its service runs.
api_unit=/etc/systemd/system/oc-modelproxy-api.socket
listen_was="$(sed -n 's/^ListenStream=//p' "$api_unit" 2>/dev/null || true)"
# Only callers of the runners' uid are sessions (in a container, every other
# uid is one of its subordinate ids). A binary from before the option runs without it.
caller_uid=""
help="$("$BIN" --help 2>&1 || true)" # not a pipe: under pipefail, grep -q closing early would fail it
if grep -q -- '-caller-uid' <<<"$help"; then caller_uid=" --caller-uid=$(id -u "$AGENT_USER")"; fi

cat > /etc/systemd/system/oc-modelproxy-api.socket <<EOF
# Written by deploy/vm/modelproxy.sh install.
[Unit]
Description=oc-modelproxy: Claude Code's socket (runners)

[Socket]
ListenStream=$RUN/api/api.sock
Symlinks=$RUN/api.sock
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
ExecStart=$BIN --bindings-file=$RUN/bindings.json$caller_uid
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
if [[ -n $listen_was && $listen_was != "$RUN/api/api.sock" ]]; then
  # The socket moved (once, on the update that brings work 103). systemd will
  # not rebind a socket under its running service, so the service stops first
  # and its streams are cut; the host resyncs its binds when it reconnects.
  echo "oc-modelproxy: API socket moves from $listen_was to $RUN/api/api.sock; restarting the proxy"
  systemctl kill --signal=SIGKILL oc-modelproxy.service 2>/dev/null || true
  systemctl stop oc-modelproxy.service oc-modelproxy-api.socket
  rm -f "$listen_was"
  changed=1
fi
systemctl enable --now oc-modelproxy-api.socket oc-modelproxy-control.socket
systemctl enable oc-modelproxy.service
# A new binary takes over without blocking the provision: the old one drains its streams (up to 10 min)
# while new connections wait on the sockets; the host resyncs its binds when it reconnects.
if [[ ${changed:-0} == 1 ]]; then systemctl restart --no-block oc-modelproxy.service; else systemctl start --no-block oc-modelproxy.service; fi
echo "oc-modelproxy: $("$BIN" --version 2>/dev/null || echo installed)"
