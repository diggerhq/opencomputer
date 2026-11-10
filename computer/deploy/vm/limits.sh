#!/usr/bin/env bash
# Size the host's cgroup limits from the machine it runs on (work 052: a
# computer per organization, 8 GiB and up; a resize changes the machine).
#
# provision.sh runs `limits.sh install`: it copies itself to
# /usr/local/sbin/slack-presence-limits, enables slack-presence-limits.service
# and applies the limits. That unit runs it again on every boot, before the
# agent's user manager and the host agent start, so a resized VM gets limits
# for its new size. One script, one set of formulas, for both paths.
#
# It writes (and reloads systemd only when one of them changed):
#   /etc/systemd/system/user-<uid>.slice.d/10-slack-presence.conf
#       caps everything the agent's user manager runs (all runners and what
#       they spawn), so sshd, journald, the guest agent and the host agent
#       (system.slice) stay responsive when a build runs away (risk R5)
#   /etc/systemd/user/slack-presence-runners.slice
#       all runners together, inside the above
#   /etc/systemd/system/slack-presence-host.service.d/10-limits.conf
#       the host agent's own MemoryMax
# Each runner's own MemoryHigh/MemoryMax is set by the host agent
# (src/host/runner-limits.ts: 60%/75% of RAM, capped at 12G/16G).
#
# Formulas (T = MemTotal in MiB, N = online CPUs; integer arithmetic):
#   reserve      = max(1024, T/10)      OS, journald, guest agent, host agent
#   user max     = T - reserve           user high = user max * 93%
#   runners max  = user high             runners high = runners max * 93%
#   user CPU     = max(1, N-1) * 100%    one CPU's worth left to the system
#   runners CPU  = max(1, N-2) * 100%
#   host max     = min(2048, max(768, T/8))
# 64 GiB / 16 vCPU (T ~ 64,300): user 52.6G/56.5G, runners 48.9G/52.6G,
#   CPU 1500%/1400%, host 2G (was 54G/58G, 50G/54G, 1500%/1400%, 2G).
# 8 GiB / 2 vCPU (T ~ 7,900): user 6.2G/6.7G, runners 5.8G/6.2G,
#   CPU 100%/100%, host 987M.
#
#   limits.sh install                install the script and its boot unit, then apply
#   slack-presence-limits            compute from /proc/meminfo and nproc, write, reload
#   slack-presence-limits --print    compute and print only (tests: SP_LIMITS_MEMTOTAL_KIB,
#                                    SP_LIMITS_NPROC fake the machine)
set -euo pipefail

AGENT_UID="${AGENT_UID:-1500}"

# sp_limits <MemTotal KiB> <nproc>: prints KEY=VALUE lines (memory in MiB,
# CPU in percent). Pure, so it can be tested with any machine.
sp_limits() {
  local t=$(( $1 / 1024 )) n=$2
  local reserve=$(( t / 10 > 1024 ? t / 10 : 1024 ))
  local user_max=$(( t - reserve ))
  (( user_max >= 256 )) || user_max=256   # degenerate tiny machines: still a usable cap
  local user_high=$(( user_max * 93 / 100 ))
  local run_max=$user_high
  local run_high=$(( run_max * 93 / 100 ))
  local user_cpu=$(( (n > 2 ? n - 1 : 1) * 100 ))
  local run_cpu=$(( (n > 3 ? n - 2 : 1) * 100 ))
  local host_max=$(( t / 8 > 768 ? t / 8 : 768 ))
  (( host_max <= 2048 )) || host_max=2048
  cat <<EOF
MEM_TOTAL_MIB=$t
NPROC=$n
USER_CPU=$user_cpu
USER_HIGH_MIB=$user_high
USER_MAX_MIB=$user_max
RUNNERS_CPU=$run_cpu
RUNNERS_HIGH_MIB=$run_high
RUNNERS_MAX_MIB=$run_max
HOST_MAX_MIB=$host_max
EOF
}

# write_if_changed <path> <mode>: content on stdin; returns 0 if it changed.
write_if_changed() {
  local path=$1 mode=$2 tmp
  # Called in `&&` lists, where set -e does not apply: fail explicitly.
  tmp="$(mktemp "$path.XXXXXX")" && cat > "$tmp" && chmod "$mode" "$tmp" || exit 1
  if cmp -s "$tmp" "$path"; then rm -f "$tmp"; chmod "$mode" "$path"; return 1; fi
  mv -f "$tmp" "$path" || exit 1
}

# The boot path: a oneshot ordered before the agent's user manager and the host.
install_unit() {
  install -m 0755 "${BASH_SOURCE[0]}" /usr/local/sbin/slack-presence-limits
  cat > /etc/systemd/system/slack-presence-limits.service <<EOF
# Written by deploy/vm/limits.sh install.
[Unit]
Description=Size slack-presence cgroup limits from this machine's memory and CPUs
DefaultDependencies=no
After=local-fs.target
Before=user@$AGENT_UID.service slack-presence-host.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=AGENT_UID=$AGENT_UID
ExecStart=/usr/local/sbin/slack-presence-limits

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable slack-presence-limits.service
}

main() {
  local kib n
  kib="${SP_LIMITS_MEMTOTAL_KIB:-$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)}"
  n="${SP_LIMITS_NPROC:-$(nproc)}"
  [[ $kib =~ ^[0-9]+$ && $n =~ ^[0-9]+$ ]] || { echo "cannot read MemTotal/nproc" >&2; exit 1; }
  if [[ ${1:-} == --print ]]; then sp_limits "$kib" "$n"; return; fi
  [[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
  if [[ ${1:-} == install ]]; then install_unit; fi   # not `||`: set -e must apply inside

  local USER_CPU USER_HIGH_MIB USER_MAX_MIB RUNNERS_CPU RUNNERS_HIGH_MIB RUNNERS_MAX_MIB HOST_MAX_MIB MEM_TOTAL_MIB NPROC
  eval "$(sp_limits "$kib" "$n")"
  echo "machine: ${MEM_TOTAL_MIB} MiB, $NPROC CPUs -> user-$AGENT_UID.slice ${USER_CPU}% ${USER_HIGH_MIB}M/${USER_MAX_MIB}M," \
    "runners ${RUNNERS_CPU}% ${RUNNERS_HIGH_MIB}M/${RUNNERS_MAX_MIB}M, host ${HOST_MAX_MIB}M"

  local sys_changed=0 user_changed=0
  install -d /etc/systemd/system/user-"$AGENT_UID".slice.d /etc/systemd/system/slack-presence-host.service.d /etc/systemd/user
  write_if_changed /etc/systemd/system/user-"$AGENT_UID".slice.d/10-slack-presence.conf 0644 <<EOF && sys_changed=1
# Written by slack-presence-limits (deploy/vm/limits.sh) for ${MEM_TOTAL_MIB} MiB, $NPROC CPUs.
[Slice]
CPUQuota=${USER_CPU}%
MemoryHigh=${USER_HIGH_MIB}M
MemoryMax=${USER_MAX_MIB}M
TasksMax=20000
EOF
  write_if_changed /etc/systemd/system/slack-presence-host.service.d/10-limits.conf 0644 <<EOF && sys_changed=1
# Written by slack-presence-limits (deploy/vm/limits.sh) for ${MEM_TOTAL_MIB} MiB.
[Service]
MemoryMax=${HOST_MAX_MIB}M
EOF
  # The runners slice, inside the agent's user manager. systemd-run --user
  # --slice=slack-presence-runners.slice puts runners here; per-person slices
  # (slack-presence-runners-<x>.slice) nest under it by name. Root-owned in
  # /etc/systemd/user, so the agent cannot raise its own limits. Mode 0644
  # explicitly: a 0600 file makes the user manager report the slice "not found".
  write_if_changed /etc/systemd/user/slack-presence-runners.slice 0644 <<EOF && user_changed=1
# Written by slack-presence-limits (deploy/vm/limits.sh) for ${MEM_TOTAL_MIB} MiB, $NPROC CPUs.
[Unit]
Description=slack-presence session runners

[Slice]
CPUQuota=${RUNNERS_CPU}%
MemoryHigh=${RUNNERS_HIGH_MIB}M
MemoryMax=${RUNNERS_MAX_MIB}M
TasksMax=16384
EOF

  # On boot this runs before user@<uid> starts, which then reads the files
  # fresh; a reload applies new limits to units that already run.
  if (( sys_changed )); then systemctl daemon-reload; fi
  if (( user_changed )) && [[ -S /run/user/$AGENT_UID/bus ]]; then
    runuser -u "$(id -nu "$AGENT_UID")" -- env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" systemctl --user daemon-reload || true
  fi
}

[[ ${BASH_SOURCE[0]} != "$0" ]] || main "$@"
