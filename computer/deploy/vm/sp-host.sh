#!/usr/bin/env bash
# The host agent as its own user, sp-host (work 077). Runs as root.
#
#   sp-host.sh migrate   move this computer's host agent to sp-host; runners stay `agent`
#   sp-host.sh revert    back to the host agent running as `agent`
#   sp-host.sh status    which user the host runs as, and the checks below
#   sp-host.sh apply     re-apply everything but the switch on a migrated computer (provision.sh, every run)
#   sp-host.sh run-dirs  write and create $SP_RUN's tmpfiles entries for whichever user the host is (provision.sh)
#   sp-host.sh launch podman|systemd|status
#                        this computer's runners as containers or as systemd units (work 103 rollout, ONE-TIME:
#                        delete in step 11); see `launch` below
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
ETC="${SP_ETC:-/etc/slack-presence}"
MARK="$ETC/host-user-sp-host"
# podman|systemd: the host's SP_LAUNCH on this computer, written by `launch` and kept by `apply` (ONE-TIME, work 103).
LAUNCH_MARK="$ETC/sp-launch"
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
# ONE-TIME systemd->podman migration (work 103): the drain-then-flip `launch` restarts with, as provision.sh does. Delete in step 11.
# shellcheck source=legacy-drain.sh
source "$(dirname "${BASH_SOURCE[0]}")/legacy-drain.sh"

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
#
# Which runners are left is read from the agent's user manager: the host starts every runner
# as its unit sp-runner-<id>, whose ExecStart names the release's entry file, and a process
# cannot change its unit's record. (Not /proc/*/cmdline: a session writes its own, so one
# could hide a runner or name an old release for ever. Not /proc/<pid>/exe or cwd either:
# those are node and the session's fork under every release.) A session runs as agent and
# can still start a unit of that name that names an old release, so the wait has an end: a
# release counts for 2 days after it was superseded (.sp-superseded, root's, in a directory
# sessions cannot write), the time provision.sh keeps it at all. Runners exit after 2 h idle.
old_runners() {
  local uid records
  uid="$(id -u "$AGENT_USER")"
  [[ -S /run/user/$uid/bus ]] || return 1   # no user manager, so no runner
  # A manager that does not answer says nothing about its runners: assume one.
  records="$(runuser -u "$AGENT_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" \
    systemctl --user show -p ExecStart --value 'sp-runner-*')" || return 0
  grep -qF "$1/" <<<"$records"
}

journals_dir() {
  local dir="$DATA/journals" r releases
  [[ -d $dir ]] || return 0
  if [[ $1 == "$HOST_USER" && -e $SP_CURRENT/src/api/journal-dir.ts ]]; then
    releases="$(dirname "$(readlink -f "$SP_CURRENT")")"
    for r in "$releases"/*/; do
      r="${r%/}"
      [[ -e $r/src/api/journal-dir.ts ]] && continue
      # Never superseded: it never ran. Superseded long ago: the deadline above.
      [[ -f $r/.sp-superseded && -z "$(find "$r/.sp-superseded" -mtime +2)" ]] || continue
      if old_runners "$r"; then
        echo "sp-host: $dir stays group-writable: a runner of $r may still write there (until 2 days after $r was superseded)"
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
$(launch_env)
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

# ---- ONE-TIME systemd->podman migration (work 103). Delete in step 11 (with the `launch` verb in opencomputer-deploy).
# The marker says what the host's SP_LAUNCH is on this computer; `apply` writes it into the drop-in, so
# provision.sh (which re-runs `apply`) keeps it. No marker: no SP_LAUNCH, the code's default (systemd).
launch_marker() {
  local v
  [[ -f $LAUNCH_MARK ]] || return 0
  v=$(tr -d '[:space:]' < "$LAUNCH_MARK")
  case $v in podman|systemd) echo "$v" ;; *) echo "sp-host: ignoring $LAUNCH_MARK: '$v' is not podman or systemd" >&2 ;; esac
}
launch_env() { local v; v=$(launch_marker); [[ -z $v ]] || echo "Environment=SP_LAUNCH=$v"; }

# The process running src/host/main.ts in the unit, or nothing.
launch_host_pid() {
  local main
  main=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
  [[ -n $main && $main != 0 ]] || return 0
  legacy_host_pid "$main" || true
}
# The running host's SP_LAUNCH, and only that variable of its environment (the rest holds the host token).
launch_running() { local pid; pid=$(launch_host_pid); [[ -z $pid ]] || legacy_env_of "$pid" SP_LAUNCH || true; }
launch_apply() { bash "$0" apply; }
launch_podman() { runuser -u "$AGENT_USER" -- env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" timeout 60 podman "$@"; }

# Containers: thread (a record that is not `unclaimed`) or spare. Unmigrated threads: forks with no record (legacy-migration/migrate.ts migrates them on their next message).
launch_status() {
  local pid running ids id rec spares=0 threads=0 forks=0 unmigrated=0 migrated f p
  pid=$(launch_host_pid)
  running=$(launch_running)
  if [[ -z $pid ]]; then echo "launch running: none (the host is not running)"
  else echo "launch running: ${running:-systemd (unset)}"; fi
  echo "launch configured: $(legacy_new_launch | grep . || echo 'systemd (unset)')"
  echo "launch marker: $(launch_marker | grep . || echo none)"
  echo "host user migrated: $([[ -f $MARK ]] && echo yes || echo no)"
  if ids=$(launch_podman ps --all --filter label=sp.runner --format '{{index .Labels "sp.runner"}}' 2>/dev/null); then
    while read -r id; do
      [[ -n $id ]] || continue
      rec="$DATA/state/sandboxes/$id.json"
      if [[ -f $rec ]] && ! grep -q '"unclaimed": *true' "$rec"; then threads=$((threads + 1)); else spares=$((spares + 1)); fi
    done <<< "$ids"
    echo "containers: $((threads + spares)) ($threads threads, $spares spares)"
  else
    echo "containers: unknown (podman ps failed)"
  fi
  # A fork is <people>/<p>/sessions/<safeKey(key)> (mounts.ts); records name person and key.
  migrated=$(find "$DATA/state/sandboxes" -maxdepth 1 -name '*.json' -exec jq -r \
    '"\(.person)/\(.key | gsub("[^a-zA-Z0-9]+"; "-") | ltrimstr("-") | rtrimstr("-"))"' {} + 2>/dev/null | sort -u || true)
  for f in "$DATA"/people/*/sessions/*/; do
    [[ -d $f ]] || continue
    forks=$((forks + 1))
    p=${f%/}; p="${p%/sessions/*}"; p=${p##*/}
    grep -qxF -- "$p/$(basename "$f")" <<< "$migrated" || unmigrated=$((unmigrated + 1))
  done
  echo "unmigrated threads: $unmigrated of $forks"
}

# launch podman|systemd: write the marker, `apply` it to the drop-in, and restart the host the way provision.sh does:
# drained when SP_LAUNCH turns from systemd to podman (legacy-drain.sh), a plain restart otherwise. Under provision.sh's
# lock, so no self-update or deploy runs in between. podman needs the host as sp-host (SP_RUNNER_USER, sandbox/host.ts)
# and a running release with the drain: a plain restart into podman would leave the systemd runners running beside it.
# Back to systemd is a plain restart: the podman containers keep running, unseen by the host (stop them by hand).
launch() {
  local want=$1 old running main
  AGENT_UID=${AGENT_UID:-$(id -u "$AGENT_USER")}
  exec 8>"${SP_PROVISION_LOCK:-/run/slack-presence-provision.lock}"
  flock -w 1800 8 || die "launch: provision.sh held its lock for 30 min; try again"
  running=$(launch_running)
  if [[ $want == podman ]]; then
    [[ -f $MARK ]] || die "launch: this host agent is not migrated to $HOST_USER (sp-host.sh migrate first); podman needs it"
    main=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
    if [[ ${running:-systemd} == systemd && -n $main && $main != 0 && ! -f $LEGACY_PROC/$main/cwd/src/host/legacy-migration/drain.ts ]]; then
      die "launch: the running host has no drain (src/host/legacy-migration/drain.ts): deploy a current release first"
    fi
  fi
  old=$(cat "$LAUNCH_MARK" 2>/dev/null || true)
  install -d -m 0755 "$ETC"
  echo "$want" > "$LAUNCH_MARK.tmp" && mv "$LAUNCH_MARK.tmp" "$LAUNCH_MARK"
  if ! launch_apply; then
    if [[ -n $old ]]; then echo "$old" > "$LAUNCH_MARK"; else rm -f "$LAUNCH_MARK"; fi
    die "launch: apply failed; the marker is back to '${old:-none}' and the host was not restarted"
  fi
  [[ $(legacy_new_launch | grep . || echo systemd) == "$want" ]] \
    || die "launch: the unit's SP_LAUNCH is '$(legacy_new_launch)', not $want: another drop-in or environment file sets it (systemctl cat $UNIT); not restarted"
  if [[ -n $(launch_host_pid) && ${running:-systemd} == "$want" ]]; then
    log "launch: already $want; nothing to restart"
    launch_status
    return 0
  fi
  log "launch: restarting the host agent as $want"
  if [[ $want == systemd ]]; then
    echo "sp-host: launch: the podman containers keep running and the systemd host does not see them; stop them with" \
      "runuser -u $AGENT_USER -- env XDG_RUNTIME_DIR=/run/user/$AGENT_UID podman stop -a" >&2
  fi
  legacy_drain_restart || systemctl restart "$UNIT"
  main=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
  local host now
  host=$(legacy_new_host "$main") || die "launch: the host did not come back (MainPID $main runs no src/host/main.ts): journalctl -u $UNIT"
  now=$(legacy_env_of "$host" SP_LAUNCH)
  [[ ${now:-systemd} == "$want" ]] || die "launch: the host came back with SP_LAUNCH=${now:-unset}, not $want: journalctl -u $UNIT"
  log "launch: done, the host agent runs as $want (pid $host)"
  launch_status
}
# ---- end ONE-TIME systemd->podman migration

# Sourced (tests): the functions only.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

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
  launch) # ONE-TIME systemd->podman migration (work 103): delete in step 11
    case "${2:-}" in
      podman|systemd) launch "$2" ;;
      status) launch_status ;;
      *) echo "usage: sp-host.sh launch podman|systemd|status" >&2; exit 2 ;;
    esac ;;
  *) echo "usage: sp-host.sh migrate|revert|status|apply|run-dirs|launch" >&2; exit 2 ;;
esac
