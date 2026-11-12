#!/usr/bin/env bash
# The host agent as its own user, sp-host (work 077). Runs as root.
#
#   sp-host.sh migrate   move this computer's host agent to sp-host; runners stay `agent`
#   sp-host.sh revert    back to the host agent running as `agent`
#   sp-host.sh status    which user the host runs as, and the checks below
#   sp-host.sh apply     re-apply everything but the switch on a migrated computer (provision.sh, every run)
#   sp-host.sh run-dirs  write and create $SP_RUN's tmpfiles entries for whichever user the host is (provision.sh)
#
# Why: sessions run tools as `agent` with no permission prompts. While the host
# is `agent` too, a session can read the host's environment (the host token),
# signal it, and use what only the host should: the model proxy's control
# socket, which binds members' Claude subscriptions to runners. As sp-host, the
# host keeps all of that out of the sessions' reach.
#
# What changes (and what `revert` undoes):
#   - user sp-host (group sp-host, in group agent), HOME /var/lib/sp-host
#   - the host unit's drop-in 20-sp-host.conf: User=sp-host, SP_RUNNER_USER=agent
#     (runners start through `sudo -u agent systemd-run --user`), SP_MODEL_PROXY,
#     and a PATH of root-owned directories only (the agent's PATH has agent's own
#     ~/go/bin in it: a session could plant a `sudo` there); runners keep theirs
#   - sudoers: sp-host may run anything as agent (never the reverse); the host
#     also does its workspace git and file work as agent (workspaces/as-runner.ts),
#     so <SP_DATA>/people stays agent's and is not touched here
#   - $SP_RUN: sp-host's, group agent (setgid); runners/ and secrets/ group-writable
#     (the one tmpfiles entry, `run_dirs` below; provision.sh writes it through `run-dirs`)
#   - <SP_DATA>/state and $SP_RUN/traces: sp-host's (identity, telemetry spool, model routes, traces)
#   - sessions in containers (work 103): $SP_RUN/sandbox and $SP_RUN/helper, the host's and
#     read-only to the group; <SP_DATA>/state/sandboxes, the host's alone; <SP_DATA>/journals,
#     the host's with group agent and no group write, once every runner writes its journal into
#     the directory the host made for its session (`journals_dir` below)
#   - the metadata service blocked for sp-host and modelproxy too
#   - the client relay (work 084): sp-host joins group sp-wire (provision.sh makes
#     it), so the host's wire socket ($SP_RUN/wire/wire.sock) can be sp-wire's and
#     no session's; slack-presence-wire.service runs only while the marker is there,
#     and `revert` stops it (with the host as agent, sessions could reach the socket)
#
# Invariants:
# - Idempotent; provision.sh keeps a migrated computer migrated (the marker
#   $MARK) and re-runs `apply` on every provision. It sets the marker itself
#   on a new computer (no host.env yet), so those start migrated.
# - Running runners are kept: their sockets are opened to the group before the
#   host starts again, so the new host adopts them.
# - The host is stopped while $SP_RUN and <SP_DATA>/state change hands (migrate
#   and revert), so the state moves between hosts, never under a running one;
#   provision.sh's `apply` runs with the host already as sp-host, where the chowns change nothing.
# - A failed migrate leaves the host running: `apply` runs in its own process so a
#   step failing reverts the whole of it, the drop-in is written last, and a host
#   that does not come up as sp-host is reverted.
set -euo pipefail
# Run Command starts scripts in a root-only directory; commands run as other users must not inherit it.
cd /

AGENT_USER="${AGENT_USER:-agent}"
HOST_USER=sp-host
HOST_HOME=/var/lib/sp-host
DATA="${SP_DATA:-/data}"
SP_RUN="${SP_RUN:-/run/slack-presence}"
ETC=/etc/slack-presence
MARK="$ETC/host-user-sp-host"
UNIT=slack-presence-host.service
DROPIN="/etc/systemd/system/$UNIT.d/20-sp-host.conf"
SUDOERS=/etc/sudoers.d/50-sp-host
IMDS_UNIT=/etc/systemd/system/sp-host-imds-block.service
CONTROL=/run/oc-modelproxy/control.sock
WIRE_GROUP=sp-wire
WIRE_UNIT=slack-presence-wire.service
SP_CURRENT="${SP_CURRENT:-/opt/slack-presence/current}"
# The host's PATH: root-owned directories only. Runners get the agent's (provision.sh's AGENT_PATH, in the base unit).
HOST_PATH="$SP_CURRENT/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# No unit yet on a new computer (provision.sh writes it after `run-dirs`): empty, not a silent exit under pipefail.
AGENT_PATH="${AGENT_PATH:-$({ sed -n 's/^Environment=PATH=//p' "/etc/systemd/system/$UNIT" 2>/dev/null || true; } | tail -1)}"

log() { printf '\n== sp-host: %s\n' "$*"; }
die() { echo "sp-host: $*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || die "run as root"
id "$AGENT_USER" >/dev/null 2>&1 || die "no user $AGENT_USER"

# $SP_RUN as provision.sh writes it: <owner> is the host's user, group always agent.
run_dirs() {
  cat > /etc/tmpfiles.d/slack-presence.conf <<EOF
# Written by deploy/vm/provision.sh or sp-host.sh; the host is $1, runners $AGENT_USER.
d $SP_RUN 2750 $1 $AGENT_USER -
d $SP_RUN/runners 2770 $1 $AGENT_USER -
d $SP_RUN/secrets 2770 $1 $AGENT_USER -
d $SP_RUN/traces 0700 $1 $1 -
d $SP_RUN/sandbox 2750 $1 $AGENT_USER -
d $SP_RUN/helper 2750 $1 $AGENT_USER -
EOF
  systemd-tmpfiles --create /etc/tmpfiles.d/slack-presence.conf
}

# <SP_DATA>/journals. Sessions must not make names there (work 103, C8): the host makes
# journals/<session>/ and a runner writes only inside its own. That needs the host's code to
# make those directories (src/api/journal-dir.ts in the release) and no runner left from a
# release before it: such a runner still creates its checkpoint files in journals/ itself, as
# agent, and would lose them. Until both hold the directory stays as provision.sh made it
# (agent's, group-writable), and a later run tightens it.
journals_dir() {
  local dir="$DATA/journals" r releases
  [[ -d $dir ]] || return 0
  if [[ $1 == "$HOST_USER" && -e $SP_CURRENT/src/api/journal-dir.ts ]]; then
    releases="$(dirname "$(readlink -f "$SP_CURRENT")")"
    for r in "$releases"/*/; do
      [[ -e ${r}src/api/journal-dir.ts ]] && continue
      if grep -qsF "${r%/}" /proc/[0-9]*/cmdline; then
        echo "sp-host: $dir stays group-writable: a runner of ${r%/} still writes there"
        return 0
      fi
    done
    [[ $(stat -c '%U:%G %a' "$dir") == "$HOST_USER:$AGENT_USER 2750" ]] || { chown "$HOST_USER:$AGENT_USER" "$dir"; chmod 2750 "$dir"; }
  else
    [[ $(stat -c '%U:%G %a' "$dir") == "$AGENT_USER:$AGENT_USER 2770" ]] || { chown "$AGENT_USER:$AGENT_USER" "$dir"; chmod 2770 "$dir"; }
  fi
}

# Everything but the switch itself; safe to repeat, and run by provision.sh on a migrated computer.
# Metadata first (users, sudoers, units: harmless to a host still running as agent), then what
# takes $SP_RUN and the state from the old host (stopped by migrate; under provision.sh the
# host is sp-host already and nothing changes hands), then the drop-in.
apply() {
  [[ -n $AGENT_PATH ]] || die "no PATH in $UNIT; provision this computer first"
  getent group "$HOST_USER" >/dev/null || groupadd --system "$HOST_USER"
  if ! id "$HOST_USER" >/dev/null 2>&1; then
    useradd --system --gid "$HOST_USER" --groups "$AGENT_USER" --home-dir "$HOST_HOME" --create-home --shell /usr/sbin/nologin "$HOST_USER"
  fi
  usermod -a -G "$AGENT_USER" "$HOST_USER"
  # The relay's group (provision.sh makes it): the host gives its wire socket to it.
  local groups=$AGENT_USER
  if getent group "$WIRE_GROUP" >/dev/null; then
    usermod -a -G "$WIRE_GROUP" "$HOST_USER"
    groups="$AGENT_USER $WIRE_GROUP"
  fi
  install -d -m 0750 -o "$HOST_USER" -g "$HOST_USER" "$HOST_HOME"
  # Releases are root-owned worktrees; the host may read its version with git.
  runuser -u "$HOST_USER" -- env HOME="$HOST_HOME" git config --global --replace-all safe.directory '*'

  cat > "$SUDOERS.tmp" <<EOF
# Written by deploy/vm/sp-host.sh (work 077): the host agent ($HOST_USER) starts runners
# and does workspace work as $AGENT_USER. Not logged per call: housekeeping runs git often.
Defaults:$HOST_USER !syslog, !pam_session, env_keep += "XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS"
$HOST_USER ALL=($AGENT_USER) NOPASSWD: ALL
EOF
  chmod 0440 "$SUDOERS.tmp"
  visudo -cqf "$SUDOERS.tmp" || die "sudoers did not validate"
  mv "$SUDOERS.tmp" "$SUDOERS"

  # The metadata service (cloud credentials): blocked for agent by provision.sh, for these here.
  local rules=() u
  for u in "$HOST_USER" modelproxy; do
    id "$u" >/dev/null 2>&1 || continue
    rules+=("ExecStart=/bin/sh -c 'iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner $u -j REJECT 2>/dev/null || iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner $u -j REJECT'")
  done
  cat > "$IMDS_UNIT" <<EOF
# Written by deploy/vm/sp-host.sh.
[Unit]
Description=Block the cloud instance metadata service for $HOST_USER and the model proxy
After=network-pre.target
Before=$UNIT oc-modelproxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
$(printf '%s\n' "${rules[@]}")

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q sp-host-imds-block.service
  systemctl restart sp-host-imds-block.service

  install -d -m 0755 "$ETC"
  touch "$MARK"
  run_dirs "$HOST_USER"
  install -d -m 0755 -o "$HOST_USER" -g "$HOST_USER" "$DATA/state"
  # Symlinks a session planted there while the state was agent's would be followed by the host's writes.
  find "$DATA/state" -type l -delete
  chown -R "$HOST_USER:$HOST_USER" "$DATA/state" "$SP_RUN/traces"
  # The sandbox records (work 103): what the host knows about each session's container.
  install -d -m 0700 -o "$HOST_USER" -g "$HOST_USER" "$DATA/state/sandboxes"
  journals_dir "$HOST_USER"
  # Traces of hosts before: telemetry only, and in a directory sessions can write to now.
  rm -f "$SP_RUN"/runners/*.trace.json
  # The runners' sockets: the new host dials them.
  chmod 0660 "$SP_RUN"/runners/*.sock "$SP_RUN"/token.sock 2>/dev/null || true

  install -d "$(dirname "$DROPIN")"
  cat > "$DROPIN.tmp" <<EOF
# Written by deploy/vm/sp-host.sh (work 077). Remove with sp-host.sh revert.
[Service]
User=$HOST_USER
Group=$HOST_USER
SupplementaryGroups=$groups
Environment=HOME=$HOST_HOME
Environment=PATH=$HOST_PATH
Environment=SP_RUNNER_USER=$AGENT_USER
Environment=SP_RUNNER_PATH=$AGENT_PATH
Environment=SP_MODEL_PROXY=$CONTROL
# sudo needs it (runners start as $AGENT_USER); sudoers allows nothing but becoming $AGENT_USER.
NoNewPrivileges=no
EOF
  mv "$DROPIN.tmp" "$DROPIN"
  systemctl daemon-reload
}

# $SP_RUN for the user the host is now (the marker says): provision.sh on every run.
run_dirs_as_is() {
  if [[ -f $MARK ]]; then run_dirs "$HOST_USER"; else run_dirs "$AGENT_USER"; fi
}

host_user() { ps -o user= -p "$(systemctl show -p MainPID --value "$UNIT")" 2>/dev/null || true; }

# Up as `want` and not restarted in the 10 s after (a crash restarts it within 2 s).
came_up() {
  local want=$1 i n
  for i in $(seq 1 20); do
    sleep 1
    [[ $(systemctl is-active "$UNIT") == active && $(host_user) == "$want" ]] || continue
    n=$(systemctl show -p NRestarts --value "$UNIT")
    sleep 10
    [[ $(systemctl is-active "$UNIT") == active && $(host_user) == "$want" && $(systemctl show -p NRestarts --value "$UNIT") == "$n" ]]
    return
  done
  return 1
}

# The host is stopped while the state and $SP_RUN go back to agent (already stopped when migrate calls this).
revert() {
  # The relay first: its condition (the marker) goes below, and it must not outlive the switch.
  systemctl stop "$WIRE_UNIT" 2>/dev/null || true
  systemctl stop "$UNIT"
  rm -f "$DROPIN" "$MARK"
  run_dirs "$AGENT_USER"
  chown -R "$AGENT_USER:$AGENT_USER" "$DATA/state" "$SP_RUN/traces"
  journals_dir "$AGENT_USER"
  chown "$AGENT_USER" "$SP_RUN"/token.sock 2>/dev/null || true
  systemctl daemon-reload
  systemctl start "$UNIT"
}

status() {
  echo "host agent runs as: $(host_user) ($(systemctl is-active "$UNIT"))"
  echo "migrated: $([[ -f $MARK ]] && echo yes || echo no)"
  ls -ld "$SP_RUN" "$SP_RUN"/runners "$SP_RUN"/secrets "$DATA/state" 2>/dev/null || true
  ls -l "$SP_RUN"/token.sock "$SP_RUN"/runners/*.sock 2>/dev/null || true
  [[ -f $MARK ]] && sudo -n -u "$HOST_USER" sudo -n -u "$AGENT_USER" true && echo "sudo: $HOST_USER -> $AGENT_USER ok"
  iptables -S OUTPUT | grep -c 169.254.169.254 | sed 's/^/metadata rules: /'
}

case "${1:-}" in
  migrate)
    log "migrating the host agent to $HOST_USER"
    # The old host stops before the state and $SP_RUN become sp-host's; runners keep running in their own units.
    systemctl stop "$UNIT"
    # Its own process: `set -e` stops it at the first failing step, and the revert undoes the steps before.
    if ! bash "$0" _apply; then
      log "apply failed; reverting"
      revert
      exit 1
    fi
    systemctl start "$UNIT"
    if came_up "$HOST_USER"; then
      log "done: the host agent runs as $HOST_USER"
      # The relay's condition holds now; a no-op where the release has no dist/wire.js.
      systemctl restart "$WIRE_UNIT" 2>/dev/null || true
      status
    else
      journalctl -u "$UNIT" -n 30 --no-pager || true
      log "the host did not stay up as $HOST_USER; reverting"
      revert
      exit 1
    fi
    ;;
  apply) if [[ -f $MARK ]]; then apply; fi ;;
  _apply) apply ;;
  revert) log "reverting the host agent to $AGENT_USER"; revert; status ;;
  status) status ;;
  run-dirs) run_dirs_as_is ;;
  *) echo "usage: sp-host.sh migrate|revert|status|apply|run-dirs" >&2; exit 2 ;;
esac
