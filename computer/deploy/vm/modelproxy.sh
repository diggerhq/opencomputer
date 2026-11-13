#!/usr/bin/env bash
# oc-modelproxy on a computer (work 097 C9): every session's model client
# reaches its upstream through it, and holds only a placeholder, never the
# credential.
#
# provision.sh runs `modelproxy.sh install` on every provision and code-only
# update. From this release it installs the binary deploy/bundle.sh built
# (modelproxy/oc-modelproxy) as /usr/local/libexec/oc-modelproxy, and the
# shipped profiles (modelproxy/profiles/*.json) into
# /etc/oc-modelproxy/profiles.d/, then writes the socket and service units.
# Nothing is compiled on a computer.
#
#   /run/oc-modelproxy/api.sock      group agent: the sessions' model clients (SP_MODEL_SOCKET)
#   /run/oc-modelproxy/control.sock  group sp-host: the host agent only (SP_MODEL_PROXY, sp-host.sh)
#
# Invariants:
# - Checked before installed: the release's binary loads the profile set it
#   would serve (profiles.d as it is, with this release's files over it) in a
#   temporary directory first. When it does not, nothing installed changes and
#   the script fails; the installed proxy, if any, keeps serving.
# - A new binary or profile is a handoff (SIGUSR2, `systemctl reload`), never
#   a stop: no connection is refused and streams in flight finish. Only a
#   changed unit file restarts the service, since a handoff keeps the old
#   command line and limits.
# - Files in profiles.d that the release does not ship (an operator's own)
#   are left as they are, and checked with the rest.
# - Profiles are 0640 root:modelproxy: the proxy reads them, sessions do not.
# - The proxy runs as its own system user with no home and no write access
#   outside its runtime directory, so a runner (uid agent) can read neither its
#   memory nor its credentials.
set -euo pipefail

AGENT_USER="${AGENT_USER:-agent}"
SP_CURRENT="${SP_CURRENT:-/opt/slack-presence/current}"
BIN=/usr/local/libexec/oc-modelproxy
PROFILES=/etc/oc-modelproxy/profiles.d
USER_=modelproxy
RUN=/run/oc-modelproxy
UNITS=/etc/systemd/system

[[ ${1:-} == install ]] || { echo "usage: modelproxy.sh install" >&2; exit 2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

src="$SP_CURRENT/modelproxy/oc-modelproxy"
"$src" -version >/dev/null 2>&1 \
  || die "no working oc-modelproxy in this release ($src; deploy/bundle.sh builds it); nothing installed"
shopt -s nullglob
shipped=("$SP_CURRENT"/modelproxy/profiles/*.json)
installed=("$PROFILES"/*.json)
shopt -u nullglob
((${#shipped[@]})) || die "no profiles in this release ($SP_CURRENT/modelproxy/profiles); nothing installed"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/profiles.d"
((${#installed[@]} == 0)) || cp "${installed[@]}" "$tmp/profiles.d/"
cp "${shipped[@]}" "$tmp/profiles.d/"
"$src" -check -profiles "$tmp/profiles.d" \
  || die "this release's oc-modelproxy does not load the profiles it would serve; nothing installed"

getent group sp-host >/dev/null || groupadd --system sp-host
id "$USER_" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_"

changed=0       # binary or profiles: a handoff
unit_changed=0  # a unit file: a restart

if ! cmp -s "$src" "$BIN"; then
  install -D -m 0755 -o root -g root "$src" "$BIN"
  changed=1
fi
install -d -m 0755 -o root -g root "${PROFILES%/*}" "$PROFILES"
for f in "${shipped[@]}"; do
  dst="$PROFILES/${f##*/}"
  if ! cmp -s "$f" "$dst"; then
    install -m 0640 -o root -g "$USER_" "$f" "$dst"
    changed=1
  fi
done

# put <path>: stdin to path when it differs; a unit that changed restarts the service.
put() {
  cat > "$tmp/unit"
  cmp -s "$tmp/unit" "$1" && return
  install -m 0644 "$tmp/unit" "$1"
  unit_changed=1
}

# Not RuntimeDirectory=: it would go when the service stops, taking the sockets runners hold.
cat > /etc/tmpfiles.d/oc-modelproxy.conf <<EOF
d $RUN 0755 $USER_ $USER_ -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/oc-modelproxy.conf

put "$UNITS/oc-modelproxy-api.socket" <<EOF
# Written by deploy/vm/modelproxy.sh install.
[Unit]
Description=oc-modelproxy: the sessions' model clients

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

put "$UNITS/oc-modelproxy-control.socket" <<EOF
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

put "$UNITS/oc-modelproxy.service" <<EOF
# Written by deploy/vm/modelproxy.sh install.
[Unit]
Description=oc-modelproxy: the sessions' model credentials (work 097)
Requires=oc-modelproxy-api.socket oc-modelproxy-control.socket
After=oc-modelproxy-api.socket oc-modelproxy-control.socket network-online.target
Wants=network-online.target

[Service]
# The handoff's replacement reports itself as the main pid (MAINPID=).
Type=notify
NotifyAccess=all
User=$USER_
Group=$USER_
ExecStartPre=$BIN -check -profiles $PROFILES
ExecStart=$BIN -profiles $PROFILES
# The handoff: a replacement with the binary and profiles now on disk.
ExecReload=/bin/kill -USR2 \$MAINPID
Restart=always
RestartSec=1
# Streams in flight finish on a stop (-drain-timeout 630s; Claude Code's own request timeout is 600 s).
TimeoutStopSec=660
# A memory-pressured computer kills a runner, not every stream.
OOMScoreAdjust=-900
MemoryMax=512M
# A ceiling, not a raise (Go lifts its soft limit to the hard one): two
# descriptors a stream, the caller's and the upstream's.
LimitNOFILE=65536
# A core would hold credentials.
LimitCORE=0
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
# Not invisible: a caller is named by /proc/<pid>/cgroup of its process,
# which runs as $AGENT_USER (identity.go), and invisible hides other users' processes.
ProtectProc=default

[Install]
WantedBy=multi-user.target
EOF

((unit_changed == 0)) || systemctl daemon-reload
systemctl enable --now oc-modelproxy-api.socket oc-modelproxy-control.socket
systemctl enable oc-modelproxy.service
if ! systemctl is-active --quiet oc-modelproxy.service; then
  systemctl start --no-block oc-modelproxy.service
elif ((unit_changed)); then
  # The old process drains its streams (up to 10 min) while new connections
  # wait on the sockets; the host re-binds when it reconnects.
  systemctl restart --no-block oc-modelproxy.service
elif ((changed)); then
  systemctl reload oc-modelproxy.service
fi
echo "oc-modelproxy $("$BIN" -version)"
