#!/usr/bin/env bash
# ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11
# (with provision.sh's marked block and src/dev/sandbox-check-legacy.ts).
#
# Drain-then-flip of slack-presence-host, for provision.sh, which sources this
# and calls `legacy_drain_restart || systemctl restart slack-presence-host`.
# When the restart turns the host's SP_LAUNCH from systemd to podman, the
# running host is told to drain (SIGUSR2, src/host/legacy-migration/drain.ts):
# every runner exits after its turn, and the host exits once none is left;
# Restart= brings it back as a `podman` host.
#
#   legacy-drain.sh host-pid <pid>   the process running src/host/main.ts at or below <pid> (sandbox-check-legacy.ts)
#
# Invariants:
# - SIGUSR2 goes to the process running src/host/main.ts, never to MainPID as
#   such: the unit's ExecStart is tsx's CLI, which starts main.ts as a child
#   and forwards only SIGINT and SIGTERM, so SIGUSR2 on MainPID kills the
#   wrapper and the host is stopped, not drained (exit 140, #1084's review).
# - Returns 1, for a plain restart, only before anything was signalled: no
#   change systemd -> podman, a host it cannot find, or a release without the
#   drain. Once signalled it succeeds or exits the script non-zero.
# - Success is checked, not assumed: the old invocation logged
#   `legacy drain: exiting` and the new host process has SP_LAUNCH=podman.
# - Only the runner units there before the drain are stopped afterwards; the
#   `podman` host's runners are units of the same name pattern.
#
# Seams for tests (src/host/legacy-migration/legacy-drain-sh.test.ts): LEGACY_PROC (/proc), PATH
# (systemctl, journalctl, runuser), LEGACY_WAIT_S, LEGACY_STEP_S.

LEGACY_UNIT=slack-presence-host.service
LEGACY_PROC=${LEGACY_PROC:-/proc}
LEGACY_WAIT_S=${LEGACY_WAIT_S:-660}   # the drain's 10 min deadline, its grace, the host's stop and Restart=
LEGACY_STEP_S=${LEGACY_STEP_S:-5}

declare -F log >/dev/null || log() { printf '\n==> %s\n' "$*"; }
declare -F warn >/dev/null || warn() { printf 'WARNING: %s\n' "$*" >&2; }
declare -F die >/dev/null || die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

legacy_is_host() { # <pid>: its command line runs src/host/main.ts
  local c
  c=$(tr '\0' ' ' < "$LEGACY_PROC/$1/cmdline" 2>/dev/null) || return 1
  [[ $c == *src/host/main.ts* ]]
}

legacy_children() { # <pid>: its children's pids, from each process's stat (no CONFIG_PROC_CHILDREN needed)
  local f s ppid
  for f in "$LEGACY_PROC"/[0-9]*/stat; do
    s=$(cat "$f" 2>/dev/null) || continue
    s=${s##*) } # past the command name, which may hold spaces and parentheses
    read -r _ ppid _ <<< "$s"
    if [[ $ppid == "$1" ]]; then f=${f%/stat}; printf '%s\n' "${f##*/}"; fi
  done
}

legacy_host_pid() { # <pid>: the deepest process running src/host/main.ts from <pid> down; 1 when <pid> runs none
  local pid=$1 c next
  legacy_is_host "$pid" || return 1
  while :; do
    next=''
    for c in $(legacy_children "$pid"); do
      if legacy_is_host "$c"; then next=$c; break; fi
    done
    [[ -n $next ]] || break
    pid=$next
  done
  printf '%s\n' "$pid"
}

legacy_env_of() { # <pid> <name>: the variable in that process's environment (empty when unset)
  tr '\0' '\n' < "$LEGACY_PROC/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | tail -n1
}

legacy_launch_of_files() { # <env files...>: the last SP_LAUNCH= in them, unquoted
  local f v=''
  for f in "$@"; do
    [[ -r $f ]] || continue
    v=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?SP_LAUNCH=//p' "$f" | tail -n1 | sed "s/^[\"']//; s/[\"']\$//")
    [[ -n $v ]] && printf '%s\n' "$v"
  done | tail -n1
}

legacy_new_launch() { # what the restarted unit will have: its Environment=, then its EnvironmentFile=s in order (they win)
  local new files fromfiles
  new=$(systemctl show -p Environment --value "$LEGACY_UNIT" | tr ' ' '\n' | sed -n 's/^SP_LAUNCH=//p' | tail -n1)
  mapfile -t files < <(systemctl show -p EnvironmentFiles --value "$LEGACY_UNIT" | tr ' ' '\n' | grep '^/' || true)
  fromfiles=$(legacy_launch_of_files "${files[@]}")
  printf '%s\n' "${fromfiles:-$new}"
}

legacy_user_systemctl() { runuser -u "$AGENT_USER" -- env XDG_RUNTIME_DIR=/run/user/"$AGENT_UID" systemctl --user "$@"; }

legacy_runner_units() { # the runners' units running now, one a line
  legacy_user_systemctl list-units --plain --no-legend --state=active,activating,deactivating 'sp-runner-*' 2>/dev/null | awk '{print $1}' | grep '^sp-runner-' || true
}

legacy_stop_leftovers() { # <units before the drain, newline-separated>: stop those still running
  local before=$1 u left=()
  [[ -n $before ]] || return 0
  while read -r u; do
    [[ -n $u ]] && grep -qxF -- "$u" <<< "$before" && left+=("$u")
  done < <(legacy_runner_units)
  ((${#left[@]})) || { log "legacy drain: no runner of the systemd host is left"; return 0; }
  warn "legacy drain: stopping ${#left[@]} runner(s) of the systemd host still running: ${left[*]}"
  legacy_user_systemctl stop -- "${left[@]}" || warn "legacy drain: could not stop all of ${left[*]}"
}

legacy_drained() { # <old invocation id> <old MainPID>: the old host logged that the drain ended it (journald may lag: a few tries)
  local i out
  for ((i = 0; i < 5; i++)); do
    if [[ -n $1 ]]; then out=$(journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$1" 2>/dev/null | grep 'legacy drain: exiting' || true)
    else out=$(journalctl --no-pager -o cat "_SYSTEMD_UNIT=$LEGACY_UNIT" "_PID=$2" 2>/dev/null | grep 'legacy drain: exiting' || true)
    fi
    if [[ -n $out ]]; then printf '%s\n' "$out" | tail -n1; return 0; fi
    sleep 1
  done
  return 1
}

legacy_wait_main() { # <old MainPID>: the new MainPID, once there is one, or 1 at LEGACY_WAIT_S
  local i now
  for ((i = 0; i < LEGACY_WAIT_S; i += LEGACY_STEP_S)); do
    sleep "$LEGACY_STEP_S"
    now=$(systemctl show -p MainPID --value "$LEGACY_UNIT" 2>/dev/null || echo 0)
    if [[ -n $now && $now != 0 && $now != "$1" ]]; then printf '%s\n' "$now"; return 0; fi
  done
  return 1
}

legacy_new_host() { # <MainPID>: the process running main.ts under it, once tsx has started it (30 s at most)
  local i pid
  for ((i = 0; i < 30; i++)); do
    if pid=$(legacy_host_pid "$1") && [[ $pid != "$1" || $(tr '\0' ' ' < "$LEGACY_PROC/$1/cmdline" 2>/dev/null) != *tsx* ]]; then
      printf '%s\n' "$pid"; return 0
    fi
    sleep 1
  done
  return 1
}

legacy_drain_restart() {
  local main pid old new inv before now host launch line
  main=$(systemctl show -p MainPID --value "$LEGACY_UNIT" 2>/dev/null || echo 0)
  [[ -n $main && $main != 0 ]] || return 1
  pid=$(legacy_host_pid "$main") || return 1
  old=$(legacy_env_of "$pid" SP_LAUNCH)
  new=$(legacy_new_launch)
  [[ ${old:-systemd} == systemd && ${new:-systemd} == podman ]] || return 1
  if [[ ! -f $LEGACY_PROC/$main/cwd/src/host/legacy-migration/drain.ts ]]; then
    warn "SP_LAUNCH turns to podman but the running host has no drain: plain restart (deploy this release on systemd first)"
    return 1
  fi
  inv=$(systemctl show -p InvocationID --value "$LEGACY_UNIT" 2>/dev/null || true)
  before=$(legacy_runner_units)
  log "SP_LAUNCH systemd -> podman: draining host $pid (unit MainPID $main; runners finish their turns; at most ~10 min)"
  kill -USR2 "$pid" || die "legacy drain: could not signal host $pid; the host is unchanged. Retry provision, or restart it by hand"
  if ! now=$(legacy_wait_main "$main"); then
    warn "legacy drain: host $pid did not leave in ${LEGACY_WAIT_S} s: restarting it"
    systemctl restart "$LEGACY_UNIT"
    now=$(systemctl show -p MainPID --value "$LEGACY_UNIT" 2>/dev/null || echo 0)
  fi
  host=$(legacy_new_host "$now") || die "legacy drain: the host did not come back (MainPID $now runs no src/host/main.ts): journalctl -u $LEGACY_UNIT"
  launch=$(legacy_env_of "$host" SP_LAUNCH)
  [[ $launch == podman ]] || die "legacy drain: the host came back as pid $host with SP_LAUNCH=${launch:-unset}, not podman: journalctl -u $LEGACY_UNIT"
  legacy_stop_leftovers "$before"
  line=$(legacy_drained "$inv" "$main") || die "legacy drain: host $pid (invocation ${inv:-?}) never logged 'legacy drain: exiting': it was stopped, not drained, and turns may have been cut. The new host is podman (pid $host): journalctl _SYSTEMD_INVOCATION_ID=$inv"
  [[ $line == *'still connected'* ]] && warn "legacy drain: the deadline was reached: $line"
  log "host drained and back as podman (pid $host, MainPID $now)"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  case ${1:-} in
    host-pid) legacy_host_pid "${2:?usage: legacy-drain.sh host-pid <pid>}" ;;
    *) echo "usage: legacy-drain.sh host-pid <pid>" >&2; exit 2 ;;
  esac
fi
