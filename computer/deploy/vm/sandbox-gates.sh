#!/usr/bin/env bash
# The prototype gates of the session sandbox (work 103, build step 0): every
# assumption the build rests on, tried on a real computer before any host code
# is written. Run by a person, as root, on a scratch Ubuntu 24.04 computer
# provisioned like ours (user `agent` with uid 1500, `user@1500` running,
# `slack-presence-runners.slice`). Never on a computer that serves threads: it
# installs packages, loads and unloads an AppArmor profile, adds firewall
# rules and starts containers. It refuses to start where the host's unit is
# active, or a runner unit or container exists (enabled alone says nothing:
# provisioning enables the unit on every computer, with or without a host.env).
#
#   sudo deploy/vm/sandbox-gates.sh [-i <image>] [-r <release>] [-k] [G1 ... G9]
#
#   -i <image>    the session image. Default: a small one built here from
#                 ubuntu:24.04 with what the gates need and the entrypoint of
#                 work 103, so the gates can run before the real image exists.
#   -r <release>  a built release under /opt/slack-presence (it has
#                 dist/runner-boot.mjs). G4 needs it, and an image whose Node
#                 runs it; without it G4 prints `skip`.
#   -k            keep the containers, volumes and scratch directories.
#   G1 ... G9     only these gates; all of them when none is named.
#
# Prints a few `#` lines about the machine, then one line per gate:
#   G<n> pass|fail|skip <measured numbers, or the reason>
# and exits 1 when a gate failed, 2 when the setup did. Everything the commands
# print goes to the log named in the first line. The dated output belongs in
# work 103's "Evidence".
#
# What it holds to: a gate builds its commands from the functions below, which
# are "Podman commands" of work 103 word for word (create, start, pid, exec,
# stop, remove, mount, helper). A gate that had to change one has found the
# thing work 103 must change; each such place is marked `103 must change`.
# The script stands in for the host: it owns the run directories as root where
# the host would as `sp-host`, and keeps its files under $SP_RUN and $SP_DATA
# of its own, away from a real host's. It makes those two directories itself,
# puts a marker file in each, and removes only a directory with its marker.
#
# Before the gates it brings the computer to what the `sandbox` tier of
# provision.sh will install (work 103 "Provisioning", steps 1 to 5), leaving
# alone what is already there.
set -uo pipefail

AGENT=agent
AGENT_UID=1500
SLICE=slack-presence-runners.slice
SP_RUN=${SP_GATES_RUN:-/run/sp-gates}
SP_DATA=${SP_GATES_DATA:-/data/sp-gates}
GATES=$SP_RUN/gates           # this script's own files, readable by agent
PEOPLE=$SP_DATA/people
QUICK_IMAGE=localhost/sp-gates-session:3
PASTA_PROFILE=/etc/apparmor.d/pasta
WIRESERVER=168.63.129.16      # Azure's: the platform's agent endpoint, and the only DNS server a VM is given
MARKER=.sp-sandbox-gates
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG=/var/log/sp-sandbox-gates-$(date -u +%Y%m%dT%H%M%SZ).log

IMAGE='' RELEASE='' KEEP=0 FAILED=0 RESULT='' PID=0 FIRST_CREATE_MS='' IDS=()
NETWORK=pasta CREATE_MORE=() PROFILE_OFF=0 BG=() STANDIN_FIRST='' KILL_MS='' WRONG=''

# --------------------------------------------------------------------------- small things
note() { echo "# $*"; }
die() { echo "setup failed: $* (log: $LOG)" >&2; exit 2; }
q() { "$@" >>"$LOG" 2>&1; }                      # run, output to the log
now_ms() { date +%s%3N; }
new_id() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
sq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }       # boot.env quoting: ' as '\''
pass() { RESULT="pass $*"; }
fail() { RESULT="fail $*"; }
skip() { RESULT="skip $*"; }
# The middle of a sorted list of numbers, one per line (the upper one of two).
median() { sort -n | awk '{ a[NR] = $1 } END { print a[int(NR / 2) + 1] }'; }

# The prefix runnerUser builds (src/host/runner-user.ts) and the `--` work 103
# puts after it, with more variables when given first.
as_agent() {
  local vars=()
  while [[ ${1:-} == *=* ]]; do vars+=("$1"); shift; done
  sudo -n -u "$AGENT" "XDG_RUNTIME_DIR=/run/user/$AGENT_UID" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$AGENT_UID/bus" "${vars[@]}" -- "$@"
}
pm() { as_agent /usr/bin/podman "$@"; }
# The unit's cgroup as the host sees it. systemd nests a slice by the dashes of
# its name (.../slack.slice/slack-presence.slice/slack-presence-runners.slice/),
# so the path is asked for, never built.
unit_cgroup() {
  local cg
  cg=$(as_agent systemctl --user show -p ControlGroup --value "sp-runner-$1" 2>>"$LOG")
  [[ -n $cg ]] && echo "/sys/fs/cgroup$cg"
}
# The pids of the container's own processes (not conmon, pasta or podman).
payload_pids() { find "$(unit_cgroup "$1")"/libpod-payload-* -name cgroup.procs -exec cat {} + 2>/dev/null; }
state() { pm inspect --format '{{.State.Status}}' "sp-runner-$1" 2>>"$LOG"; }
unit_active() { as_agent systemctl --user is-active --quiet "sp-runner-$1"; }
wait_unit_gone() { local i; for ((i = 0; i < 100; i++)); do unit_active "$1" || return 0; sleep 0.2; done; return 1; }

# systemdRunPrefix(os.totalmem()) of src/host/runner-limits.ts: 60% and 75% of
# the machine in whole MiB, capped at 12G and 16G. SP_SYSTEMD_RUN replaces it,
# as it does for the host.
default_prefix() {
  if [[ -n ${SP_SYSTEMD_RUN:-} ]]; then echo "$SP_SYSTEMD_RUN"; return; fi
  local kib high max
  kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  high=$((kib * 3 / 5120)); ((high > 12288)) && high=12288
  max=$((kib * 3 / 4096)); ((max > 16384)) && max=16384
  size() { if (($1 % 1024 == 0)); then echo "$(($1 / 1024))G"; else echo "$1M"; fi; }
  echo "systemd-run --user --slice=$SLICE -p MemoryHigh=$(size "$high") -p MemoryMax=$(size "$max")"
}

# --------------------------------------------------------------------------- work 103, "Podman commands"
run_dir() { echo "$SP_RUN/sandbox/$1"; }

# Create: the same for a spare, a new thread and a recreation.
# 103 must change: `--device /dev/net/tun` is not in its argv. Without it a
# network of `docker compose` inside cannot be made (G9). $NETWORK and
# $CREATE_MORE are for the gates that compare (G2) or watch (G4).
create() {
  local id=$1 run
  run=$(run_dir "$id")
  IDS+=("$id")
  install -d -m 2750 -o root -g "$AGENT" "$run"   # a -v source must exist
  q pm create --name "sp-runner-$id" --hostname session \
    --label "sp.runner=$id" --label sp.abi=1 \
    --cgroups=split --userns=keep-id:uid=1500,gid=1500 --user 1500:1500 \
    "--network=$NETWORK" --pids-limit=4096 \
    --sysctl net.ipv4.ip_unprivileged_port_start=0 \
    --sysctl "net.ipv4.ping_group_range=0 65536" \
    --security-opt 'unmask=/proc/*' \
    --device /dev/fuse \
    --device /dev/net/tun \
    --log-driver=k8s-file --log-opt max-size=10m \
    --stop-timeout=10 \
    --env "SP_RUN=$run" --env "SP_DATA=$SP_DATA" \
    --env "SP_DEFINITION=$run/definition.json" \
    --env "SP_TOKEN_SOCKET=$run/tokens/$id.sock" \
    --env "SP_PREVIEW_SOCKET=$run/runners/$id.preview.sock" \
    -v "sp-home-$id:/home/agent" \
    -v "$run:$run" \
    -v /run/oc-modelproxy/api:/run/oc-modelproxy/api \
    -v /opt/slack-presence:/opt/slack-presence:ro \
    "${CREATE_MORE[@]}" \
    "$IMAGE"
}

# Step 1 of `up`: the run directory and boot.env. Without a release the runner
# is a stand-in under the run directory that only stays alive, so the image's
# entrypoint runs as written. $2: SP_ROOT, $3: RUNNER_SPEC, both optional.
prepare_run() {
  local id=$1 run root spec
  run=$(run_dir "$id")
  root=${2:-$run/gate-root}
  spec=${3:-$(printf '{"id":"%s","socket":"%s/runners/%s.sock","version":"gates"}' "$id" "$run" "$id")}
  pm unshare find "$run/runners" "$run/secrets" -mindepth 1 -delete >/dev/null 2>&1
  install -d -m 2750 -o root -g "$AGENT" "$run" "$run/tokens"
  install -d -m 2770 -o root -g "$AGENT" "$run/runners" "$run/secrets"
  if [[ -z ${2:-} ]]; then
    install -d -m 0755 "$root/dist"
    # Stands in for the runner: says that Node runs (G2 times it), then stays.
    # $STANDIN_FIRST: what a gate has it do before that (G1: ignore SIGTERM).
    echo "$STANDIN_FIRST"'import { writeFileSync } from "node:fs"; writeFileSync(`${process.env.SP_RUN}/runners/up`, ""); setInterval(() => {}, 1 << 30);' > "$root/dist/runner-boot.mjs"
  fi
  { echo "SP_ROOT=$(sq "$root")"; echo "RUNNER_SPEC=$(sq "$spec")"; echo "SP_VERSION='gates'"; } > "$run/boot.env.tmp"
  chmod 0640 "$run/boot.env.tmp"
  chgrp "$AGENT" "$run/boot.env.tmp"
  mv "$run/boot.env.tmp" "$run/boot.env"
}

# Start: the podman branch of launchCommand, with the "already" retry. $2...: another prefix.
start() {
  local id=$1 i out prefix
  shift
  if (($#)); then prefix=("$@"); else read -ra prefix <<<"$(default_prefix)"; fi
  for ((i = 0; i < 10; i++)); do
    out=$(as_agent "${prefix[@]}" -p Delegate=yes -p KillMode=mixed -p TimeoutStopSec=20 \
      -p StandardOutput=null -p StandardError=journal \
      "--unit=sp-runner-$id" --collect --quiet \
      -- /usr/bin/podman start --attach "sp-runner-$id" 2>&1) && return 0
    echo "start $id: $out" >>"$LOG"
    [[ $out == *already* ]] || return 1
    sleep 0.3
  done
  return 1
}

# Pid: polled every 20 ms until above 0, for 5 s. Sets PID.
pid() {
  local id=$1 deadline=$(($(now_ms) + 5000))
  PID=0
  while (($(now_ms) < deadline)); do
    PID=$(pm inspect --format '{{.State.Pid}}' "sp-runner-$id" 2>>"$LOG") || PID=0
    ((${PID:-0} > 0)) && return 0
    sleep 0.02
  done
  {
    as_agent systemctl --user status "sp-runner-$id" --no-pager
    as_agent journalctl --user -u "sp-runner-$id" -n 30 --no-pager
    pm logs --tail 50 "sp-runner-$id"
  } >>"$LOG" 2>&1
  return 1
}

# `up` without mounts: run directory, Start, Pid.
up() {
  local id=$1
  prepare_run "$id" "${2:-}" "${3:-}" && start "$id" && pid "$id"
}

exec_in() { local id=$1 dir=$2; shift 2; pm exec --user 1500:1500 --workdir "$dir" "sp-runner-$id" "$@"; }
stop() { q pm stop --time "${2:-10}" "sp-runner-$1"; wait_unit_gone "$1"; }
remove() {
  q pm rm --force --volumes "sp-runner-$1"
  q pm volume rm --force "sp-home-$1"
}

# Mount: `podman unshare python3 -I <ROOT>/bin/sandbox-mount.py <pid> <id> <p> <src>:<dst>...`, 10 s.
# SP_DATA reaches the helper as one more variable of the sudo prefix.
mount_in() {
  local pid=$1 id=$2 person=$3
  shift 3
  as_agent "SP_DATA=$SP_DATA" /usr/bin/timeout 10 /usr/bin/podman unshare python3 -I "$GATES/sandbox-mount.py" "$pid" "$id" "$person" "$@" 2>>"$LOG"
}

# Helper container: one script on one person's clones. $1 person, $2 pasta|none, then script and arguments.
helper() {
  local person=$1 network=$2
  shift 2
  as_agent systemd-run --user --scope --quiet "--slice=$SLICE" -p Delegate=yes -- \
    /usr/bin/podman run --rm --label "sp.helper=$person" --cgroups=split \
    --userns=keep-id:uid=1500,gid=1500 --user 1500:1500 "--network=$network" --pids-limit=1024 \
    --env "SP_RUN=$SP_RUN/helper" --env "SP_TOKEN_SOCKET=$SP_RUN/helper/token.sock" --env HOME=/tmp \
    -v "$PEOPLE/$person/ws:/clones" \
    -v "$SP_RUN/helper:$SP_RUN/helper" \
    -v /opt/slack-presence:/opt/slack-presence:ro \
    --entrypoint /bin/sh "$IMAGE" "$@"
}

# A created, started container. Sets ID and PID; 1 with a failed RESULT.
new_container() {
  ID=$(new_id)
  create "$ID" || { fail "podman create failed (log: $LOG)"; return 1; }
  up "$ID" || { fail "start: no pid within 5 s (log: $LOG)"; return 1; }
}

# A person's directories, as the host makes them (as agent).
person() { as_agent mkdir -p "$PEOPLE/$1/sessions" "$PEOPLE/$1/ws" "$PEOPLE/$1/wt"; }

# --------------------------------------------------------------------------- setup
quick_image() {
  local dir=$GATES/image
  install -d -m 0755 "$dir"
  cat > "$dir/sp-session-init" <<'EOF'
#!/bin/sh
# Start the runner the host described in boot.env (work 103). Exit 71: no boot file.
set -eu
[ -r "$SP_RUN/boot.env" ] || exit 71
set -a; . "$SP_RUN/boot.env"; set +a
exec node "$SP_ROOT/dist/runner-boot.mjs"
EOF
  cat > "$dir/containers.conf" <<'EOF'
[containers]
netns = "host"
userns = "host"
ipcns = "host"
utsns = "host"
cgroupns = "host"
cgroups = "disabled"
log_driver = "k8s-file"
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
runtime = "crun"
EOF
  # Work 103 "Image", cut to what a gate uses: no toolchains, Chromium or CLIs,
  # and Ubuntu's own Node (it runs the stand-in, not a release).
  # 103 must change, for G9: newuidmap and newgidmap with file capabilities in
  # place of setuid (a container has no CAP_SYS_ADMIN, which the setuid ones
  # need); subordinate ids 1-1499 and 1501-65536 in place of 10000:50000 (an
  # image with files of uid 65534 does not unpack in 50000); the `iptables`
  # package (netavark calls it for a compose network); a search registry.
  cat > "$dir/Containerfile" <<'EOF'
FROM docker.io/library/ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git iproute2 nodejs python3 sudo tini util-linux \
      podman podman-docker podman-compose buildah uidmap fuse-overlayfs slirp4netns netavark aardvark-dns iptables libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap \
    && setcap cap_setuid=ep /usr/bin/newuidmap && setcap cap_setgid=ep /usr/bin/newgidmap
RUN groupadd -g 1500 agent && useradd -u 1500 -g 1500 -m -d /home/agent -s /bin/bash agent \
    && echo 'agent ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent \
    && printf 'agent:1:1499\nagent:1501:64036\n' > /etc/subuid && cp /etc/subuid /etc/subgid \
    && mkdir -p /etc/containers && touch /etc/containers/nodocker \
    && echo 'unqualified-search-registries = ["docker.io"]' > /etc/containers/registries.conf \
    && mkdir -p /workspace /clones /home/agent/.local/share/containers /home/agent/.local/bin /home/agent/.cache /home/agent/go \
    && chown -R 1500:1500 /workspace /clones /home/agent \
    && printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig
COPY containers.conf /etc/containers/containers.conf
COPY --chmod=0755 sp-session-init /usr/local/bin/sp-session-init
ENV PATH=/opt/slack-presence/current/bin:/usr/local/go/bin:/home/agent/go/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash LANG=C.UTF-8 TMPDIR=/tmp
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sp-session-init"]
EOF
  q pm build -t "$QUICK_IMAGE" "$dir" || die "building $QUICK_IMAGE"
}

setup() {
  ((EUID == 0)) || die "run as root"
  cd / || die "cd /"
  : >"$LOG" || die "cannot write $LOG"
  [[ $(id -u "$AGENT" 2>/dev/null) == "$AGENT_UID" ]] || die "no user $AGENT with uid $AGENT_UID"
  systemctl is-active --quiet "user@$AGENT_UID.service" || die "user@$AGENT_UID.service is not running"
  as_agent systemctl --user cat "$SLICE" >/dev/null 2>&1 || die "$SLICE is not defined in $AGENT's user manager"
  # Never beside a host or its runners.
  local host=slack-presence-host.service
  if systemctl is-active --quiet "$host"; then die "$host is active: this computer serves threads"; fi
  [[ -z $(as_agent systemctl --user list-units --all --plain --no-legend 'sp-runner-*' 2>/dev/null) ]] || die "runner units exist in $AGENT's user manager (systemctl --user list-units 'sp-runner-*')"
  [[ -z $(pm ps --all --quiet --filter 'name=^sp-runner-' 2>/dev/null) ]] || die "containers named sp-runner-* exist (a run with -k? remove them: podman rm --force --volumes)"
  local d
  for d in "$SP_RUN" "$SP_DATA"; do
    [[ $d == /*/* ]] || die "$d: not a directory this script may own"
    [[ ! -e $d || -f $d/$MARKER ]] || die "$d exists and is not this script's (no $MARKER in it)"
  done
  mountpoint -q /data || note "warning: /data is not a mount point; the graph root goes on the root disk"
  grep -q '^VERSION_ID="24.04"' /etc/os-release || note "warning: not Ubuntu 24.04; the gates are about its Podman 4.9.3"

  # Provisioning 1: packages (and what this script itself calls).
  local missing=() p
  for p in podman crun passt uidmap slirp4netns curl python3 iptables apparmor; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || missing+=("$p")
  done
  if ((${#missing[@]})); then
    q apt-get update && q env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" || die "apt-get install ${missing[*]}"
  fi

  # Provisioning 2: pasta's AppArmor profile. G6 says whether it is needed.
  if [[ ! -f $PASTA_PROFILE ]]; then
    cat > "$PASTA_PROFILE" <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile pasta /usr/bin/pasta{,.avx2} flags=(unconfined) {
  userns,
  signal (receive) set=(term) peer=podman,
  include if exists <local/pasta>
}
EOF
  fi
  q apparmor_parser -r "$PASTA_PROFILE" || die "apparmor_parser -r $PASTA_PROFILE"

  # Provisioning 3: subordinate ids.
  grep -q "^$AGENT:" /etc/subuid || echo "$AGENT:165536:65536" >> /etc/subuid
  grep -q "^$AGENT:" /etc/subgid || echo "$AGENT:165536:65536" >> /etc/subgid

  # Provisioning 4: the graph root on /data.
  install -d -o "$AGENT" -g "$AGENT" /data/containers
  if [[ ! -f /etc/containers/storage.conf ]]; then
    install -d /etc/containers
    printf '[storage]\ndriver = "overlay"\nrootless_storage_path = "/data/containers/storage"\n' > /etc/containers/storage.conf
  fi
  local graph
  graph=$(pm info --format '{{.Store.GraphRoot}}' 2>>"$LOG")
  [[ $graph == /data/containers/storage ]] || die "podman's graph root is '$graph', not /data/containers/storage (see /etc/containers/storage.conf; Podman remembers the first path it ran with)"

  # Provisioning 5: the metadata service and the Azure wireserver, refused for agent.
  # 103 must change: the wireserver's address is also the DNS server of every
  # Azure VM, and Podman writes it into a container's resolv.conf (the host's
  # own is systemd-resolved's stub, which a container cannot reach). pasta's
  # sockets are agent's, so a plain REJECT refuses every lookup. The rule is:
  # refuse all of it except port 53, UDP and TCP, the two ACCEPTs first.
  local ip proto
  for ip in 169.254.169.254 "$WIRESERVER"; do
    iptables -C OUTPUT -d "$ip" -m owner --uid-owner "$AGENT_UID" -j REJECT 2>/dev/null \
      || iptables -I OUTPUT -d "$ip" -m owner --uid-owner "$AGENT_UID" -j REJECT || die "iptables rule for $ip"
  done
  for proto in udp tcp; do
    iptables -D OUTPUT -d "$WIRESERVER" -p "$proto" --dport 53 -m owner --uid-owner "$AGENT_UID" -j ACCEPT 2>/dev/null
    iptables -I OUTPUT -d "$WIRESERVER" -p "$proto" --dport 53 -m owner --uid-owner "$AGENT_UID" -j ACCEPT || die "iptables DNS rule ($proto)"
  done

  # Provisioning 6 and 7, under this script's own $SP_RUN and $SP_DATA; root stands for sp-host.
  install -d -m 0755 "$SP_RUN" "$SP_DATA"
  touch "$SP_RUN/$MARKER" "$SP_DATA/$MARKER"
  install -d -m 0755 "$GATES"
  install -d -m 2750 -o root -g "$AGENT" "$SP_RUN/sandbox" "$SP_RUN/helper" "$SP_DATA/journals"
  install -d -m 0700 "$SP_DATA/state" "$SP_DATA/state/sandboxes"
  install -d -o "$AGENT" -g "$AGENT" "$PEOPLE"
  install -m 0644 "$HERE/../../bin/sandbox-mount.py" "$GATES/sandbox-mount.py" || die "bin/sandbox-mount.py is not beside this script's repository"
  # Create's fixed -v sources: there on a provisioned computer, made here when not.
  [[ -d /opt/slack-presence ]] || install -d /opt/slack-presence
  [[ -d /run/oc-modelproxy/api ]] || install -d -m 0750 -g "$AGENT" /run/oc-modelproxy/api

  local had=1 t
  if [[ -z $IMAGE ]]; then
    IMAGE=$QUICK_IMAGE
    pm image exists "$IMAGE" || { had=0; note "building $IMAGE"; quick_image; }
  elif ! pm image exists "$IMAGE"; then
    had=0
    q pm pull "$IMAGE" || die "podman pull $IMAGE"
  fi
  # The warm-up of the release switch: the first container with this mapping copies and chowns the image.
  q pm rm --force sp-warm
  t=$(now_ms)
  q pm create --name sp-warm --userns=keep-id:uid=1500,gid=1500 "$IMAGE" || die "the warm-up create"
  FIRST_CREATE_MS=$(($(now_ms) - t))
  ((had)) && FIRST_CREATE_MS="$FIRST_CREATE_MS(image was here before this run)"
  q pm rm sp-warm

  note "$(date -u +%Y-%m-%dT%H:%M:%SZ) $(. /etc/os-release && echo "$PRETTY_NAME") kernel $(uname -r) $(nproc) vCPU $(awk '/^MemTotal:/ { printf "%d MiB", $2 / 1024 }' /proc/meminfo)"
  note "$(pm --version 2>/dev/null), crun $(crun --version 2>/dev/null | awk 'NR == 1 { print $3 }'), passt $(dpkg-query -W -f='${Version}' passt 2>/dev/null)"
  note "image $IMAGE $(pm image inspect --format '{{.Id}} {{.Size}} bytes' "$IMAGE" 2>/dev/null); release ${RELEASE:-none}; log $LOG"
}

# Runs on every way out (EXIT, and INT or TERM through it). What a gate left
# half done goes first: the profile it unloaded, the listeners it started.
cleanup() {
  trap - EXIT INT TERM
  local id d p
  ((PROFILE_OFF)) && q apparmor_parser -r "$PASTA_PROFILE" && PROFILE_OFF=0
  for p in "${BG[@]:-}"; do [[ -n $p ]] && kill "$p" 2>/dev/null; done
  ((KEEP)) && { note "kept: containers ${IDS[*]:-none}, $SP_RUN, $SP_DATA"; return; }
  for id in "${IDS[@]:-}"; do
    [[ -n $id ]] || continue
    q as_agent systemctl --user stop "sp-runner-$id"
    remove "$id"
  done
  # Files a session made as root are a subordinate uid's: emptied inside
  # Podman's user namespace, where that is root. The directory itself is
  # root's parent's to unlink, so root removes it after.
  [[ -f $SP_DATA/$MARKER && -d $PEOPLE ]] && q pm unshare find "$PEOPLE" -mindepth 1 -delete
  for d in "$SP_RUN" "$SP_DATA"; do
    [[ -f $d/$MARKER ]] && rm -rf -- "$d"
  done
}

# --------------------------------------------------------------------------- the gates

# One `systemctl --user kill` of a running container's unit: what "Timeouts"
# had for a Stop that failed, and what it now forbids. Measured, not judged.
# Prints `clean` when Podman then says the container is neither running nor
# stopping, `stale` when 5 s after the unit went it still does.
unit_kill() {
  local id=$1 i
  shift
  q as_agent systemctl --user kill "$@" "sp-runner-$id"
  wait_unit_gone "$id" || { echo "unit-stays"; return; }
  for ((i = 0; i < 50; i++)); do
    [[ $(state "$id") != @(running|stopping) ]] && { echo clean; return; }
    sleep 0.1
  done
  echo stale
}

# Stop's fallback in "Timeouts": as agent, `1` to cgroup.kill of each
# libpod-payload-* below the unit's cgroup. conmon is not in those, so it
# lives, sees the exit and records it. Then what must hold: within 5 s the
# container is `exited` and the unit gone (KILL_MS), and it starts again.
# Sets WRONG to what did not hold, and returns 1 then.
cgroup_kill() {
  local id=$1 cg t i
  KILL_MS='' WRONG=''
  cg=$(unit_cgroup "$id") || { WRONG="the unit has no ControlGroup"; return 1; }
  t=$(now_ms)
  as_agent sh -c 'n=0; for d in "$1"/libpod-payload-*; do echo 1 > "$d/cgroup.kill" || exit 1; n=$((n + 1)); done; [ "$n" -gt 0 ]' sh "$cg" 2>>"$LOG" \
    || { WRONG="agent could not write cgroup.kill of the libpod-payload-* below $cg"; return 1; }
  for ((i = 0; i < 100; i++)); do
    [[ $(state "$id") == exited ]] && ! unit_active "$id" && { KILL_MS=$(($(now_ms) - t)); break; }
    sleep 0.05
  done
  [[ -n $KILL_MS ]] || { WRONG="5 s after it Podman says $(state "$id") and the unit is $(as_agent systemctl --user is-active "sp-runner-$id")"; return 1; }
  up "$id" && unit_active "$id" && [[ $(state "$id") == running ]] || { WRONG="the container does not start after it (log: $LOG)"; return 1; }
}

# G1: Create and Start as written; the unit's memory limit is the container's;
# Stop's fallback leaves no container marked running; a stale one is recovered.
gate_G1() {
  local id cg want got t events before after rc oom_ms r ok from='' stale=0 rounds=0 stale9='' how='' was recreate_ms kill_ms term_ms kept run
  new_container || return
  id=$ID
  cg=$(unit_cgroup "$id") || { fail "the unit sp-runner-$id has no ControlGroup"; return; }
  want=$(as_agent systemctl --user show -p MemoryMax --value "sp-runner-$id")
  got=$(cat "$cg/memory.max" 2>>"$LOG") || { fail "no $cg/memory.max"; return; }
  [[ $got == "$want" && $got != max ]] || { fail "memory.max=$got, the unit's MemoryMax=$want"; return; }
  [[ /sys/fs/cgroup$(cut -d: -f3 "/proc/$PID/cgroup") == "$cg"/* ]] \
    || { fail "pid $PID is in $(cut -d: -f3 "/proc/$PID/cgroup"), not below the unit ($cg)"; return; }
  stop "$id" || { fail "the unit did not go after podman stop"; return; }

  # Past the limit: a small one, given the way SP_SYSTEMD_RUN gives the host
  # another prefix. MemoryMax alone: with a MemoryHigh below it the kernel
  # throttles the allocation instead (measured: 9 minutes to the kill with
  # MemoryHigh=192M), which is another thing than the limit this gate is about.
  prepare_run "$id" && start "$id" systemd-run --user "--slice=$SLICE" -p MemoryMax=256M && pid "$id" \
    || { fail "start under MemoryMax=256M (log: $LOG)"; return; }
  cg=$(unit_cgroup "$id")
  before=$(awk '$1 == "oom_kill" { print $2 }' "$cg/memory.events")
  t=$(now_ms)
  as_agent /usr/bin/timeout 60 /usr/bin/podman exec --user 1500:1500 "sp-runner-$id" python3 -c 'b = b"x" * (768 << 20)' >>"$LOG" 2>&1
  rc=$?
  oom_ms=$(($(now_ms) - t))
  # The kernel may kill the stand-in runner after the allocation (seen: two
  # kills, python3 then node), and then the unit and its memory.events are
  # gone before they can be read: the kernel's log has the same count.
  if after=$(awk '$1 == "oom_kill" { print $2 }' "$cg/memory.events" 2>/dev/null) && [[ -n $after ]]; then
    events=$((after - ${before:-0}))
  else
    sleep 1
    events=$(journalctl -k --since "@$((t / 1000))" --no-pager 2>>"$LOG" | grep -cF "oom_memcg=${cg#/sys/fs/cgroup},")
    from="(from the kernel's log: the unit went with its runner)"
  fi
  ((events > 0)) || { fail "768 MiB allocated under MemoryMax=256M and nothing was OOM-killed in ${oom_ms} ms (exit $rc, swap $(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo) kB)"; return; }

  # Stop's fallback, on a payload that would have gone on SIGTERM and on one
  # that ignores it (the case a Stop times out on).
  [[ $(state "$id") == running ]] && unit_active "$id" || up "$id" || { fail "no running container for cgroup.kill (log: $LOG)"; return; }
  cgroup_kill "$id" || { fail "cgroup.kill of the payload: $WRONG"; return; }
  kill_ms=$KILL_MS
  stop "$id" || { fail "the unit did not go after podman stop"; return; }
  run=$(run_dir "$id")
  STANDIN_FIRST='process.on("SIGTERM", () => {}); '
  up "$id"; ok=$?
  STANDIN_FIRST=''
  ((ok == 0)) || { fail "no running container with a payload that ignores SIGTERM (log: $LOG)"; return; }
  t=$(($(now_ms) + 10000))
  while [[ ! -e $run/runners/up ]] && (($(now_ms) < t)); do sleep 0.05; done
  q pm kill --signal TERM "sp-runner-$id"
  sleep 2
  [[ -e $run/runners/up && $(state "$id") == running ]] && unit_active "$id" \
    || { fail "the payload meant to ignore SIGTERM did not: Podman says $(state "$id") 2 s after it"; return; }
  cgroup_kill "$id" || { fail "cgroup.kill of a payload that ignores SIGTERM: $WRONG"; return; }
  term_ms=$KILL_MS

  # Informational, why "Timeouts" forbids it: `systemctl --user kill`, three
  # times as it was written and once with SIGKILL (what the unit itself does
  # when TimeoutStopSec runs out). conmon dies with the rest and records no exit.
  for how in '' '' '' --signal=SIGKILL; do
    [[ $(state "$id") == running ]] && unit_active "$id" || up "$id" || { fail "no running container for systemctl --user kill (log: $LOG)"; return; }
    if [[ -n $how ]]; then
      q exec_in "$id" /home/agent sh -c 'echo kept > /home/agent/.g1-kept' || { fail "could not write to the home volume (log: $LOG)"; return; }
    fi
    r=$(unit_kill "$id" $how)
    was=$(state "$id")
    echo "unit_kill ${how:-SIGTERM}: $r, podman says $was" >>"$LOG"
    if [[ -n $how ]]; then stale9=$r; else rounds=$((rounds + 1)); [[ $r == clean ]] || stale=$((stale + 1)); fi
    [[ $r == clean && -z $how ]] && continue
    # The stale recovery of "Timeouts": `podman rm --force`, then Create. Done
    # after the SIGKILL round whatever it left, and it must hold there.
    q as_agent journalctl --user -u "sp-runner-$id" -n 12 --no-pager
    t=$(now_ms)
    q pm rm --force "sp-runner-$id" || { fail "podman rm --force of a container left '$was' by systemctl --user kill ${how:-} (log: $LOG)"; return; }
    create "$id" || { fail "Create after rm --force of a container left '$was' (log: $LOG)"; return; }
    recreate_ms=$(($(now_ms) - t))
  done
  up "$id" && unit_active "$id" || { fail "the container created again after rm --force does not start (log: $LOG)"; return; }
  kept=$(exec_in "$id" /home/agent cat /home/agent/.g1-kept 2>>"$LOG")
  [[ $kept == kept ]] || { fail "the home volume did not survive rm --force and Create (the file written before reads '${kept:-nothing}')"; return; }
  [[ $stale9 == stale ]] && was="stale($was, unit inactive)" || was="not stale($was): rm --force and Create tried all the same"
  pass "memory.max=$got (the unit's) oom_kill=$events$from exec_exit=$rc oom_ms=$oom_ms; cgroup.kill: exited, unit gone and started again, in ${kill_ms} ms, ${term_ms} ms for a payload ignoring SIGTERM; stale recovery: after systemctl --user kill --signal=SIGKILL $was, rm --force + Create ${recreate_ms} ms, starts, home volume kept; informational, systemctl --user kill left Podman saying running: $stale of $rounds with SIGTERM, with SIGKILL: $stale9"
}

# n starts of a stopped container. Sets P50 and PMAX (Start to Pid) and U50
# (Start to the first line of the runner's JavaScript), in ms.
SERIES_ERR=''
series() {
  local id=$1 n=$2 i t run pids='' ups=''
  run=$(run_dir "$id")
  for ((i = 0; i < n; i++)); do
    prepare_run "$id"
    t=$(now_ms)
    start "$id" && pid "$id" || { SERIES_ERR="start $((i + 1)) of $n: no pid (log: $LOG)"; return 1; }
    pids+="$(($(now_ms) - t))"$'\n'
    while [[ ! -e $run/runners/up ]] && (($(now_ms) - t < 10000)); do sleep 0.005; done
    [[ -e $run/runners/up ]] || { SERIES_ERR="start $((i + 1)) of $n: Node did not run in 10 s"; return 1; }
    ups+="$(($(now_ms) - t))"$'\n'
    stop "$id" || { SERIES_ERR="stop $((i + 1)) of $n: the unit did not go"; return 1; }
  done
  P50=$(printf '%s' "$pids" | median)
  PMAX=$(printf '%s' "$pids" | sort -n | tail -1)
  U50=$(printf '%s' "$ups" | median)
}

# G2: a stopped, warm container reaches Pid in 600 ms p50; the first create after a pull, apart.
gate_G2() {
  local id n=10 p50 max up50 slirp
  new_container || return
  id=$ID
  stop "$id" || { fail "the unit did not go after podman stop"; return; }
  series "$id" "$n" || { fail "$SERIES_ERR"; return; }
  p50=$P50 max=$PMAX up50=$U50
  # The same with slirp4netns, to know what pasta costs or saves. Not judged.
  NETWORK=slirp4netns
  if new_container && stop "$ID" && series "$ID" 5; then slirp="start_to_pid_p50_ms=$P50 start_to_node_p50_ms=$U50 n=5"; else slirp="did not run: ${SERIES_ERR:-create or start failed}"; fi
  NETWORK=pasta
  RESULT=''
  if ((p50 <= 600)); then pass "start_to_pid_p50_ms=$p50 max_ms=$max start_to_node_p50_ms=$up50 n=$n vcpu=$(nproc) first_create_ms=$FIRST_CREATE_MS; slirp4netns: $slirp"
  else fail "start_to_pid_p50_ms=$p50 (over 600) max_ms=$max start_to_node_p50_ms=$up50 n=$n vcpu=$(nproc) first_create_ms=$FIRST_CREATE_MS; slirp4netns: $slirp"; fi
}

# G3: the mount helper against real containers, and the private worktree registry.
gate_G3() {
  local a b pa pb p1=$PEOPLE/p1 rc t ms binds_a binds_b out flags
  person p1; person p2
  as_agent mkdir -p "$p1/sessions/k1" "$p1/sessions/k2" "$p1/wt/k1/repo" "$p1/wt/k2/repo" "$PEOPLE/p2/sessions/k9"
  as_agent sh -c "echo here > '$p1/sessions/k1/marker'; echo theirs > '$PEOPLE/p2/sessions/k9/secret'; ln -sfn ../../p2/sessions/k9 '$p1/sessions/link'"
  # The person's clone, made before any session can write it.
  if [[ ! -d $p1/ws/repo/.git ]]; then
    q as_agent git init -q -b main "$p1/ws/repo" \
      && q as_agent git -C "$p1/ws/repo" -c user.name=gate -c user.email=gate@example.invalid commit -q --allow-empty -m init \
      && as_agent mkdir -p "$p1/ws/repo/.git/worktrees" || { fail "could not make the fixture clone (log: $LOG)"; return; }
  fi
  binds_a=("$p1/sessions/k1:/workspace" "$p1/ws/repo:/clones/repo" "$p1/wt/k1/repo:/clones/repo/.git/worktrees")
  binds_b=("$p1/sessions/k2:/workspace" "$p1/ws/repo:/clones/repo" "$p1/wt/k2/repo:/clones/repo/.git/worktrees")

  new_container || return
  a=$ID pa=$PID
  new_container || return
  b=$ID pb=$PID

  t=$(now_ms)
  mount_in "$pa" "$a" p1 "${binds_a[@]}" || { fail "mount exited $? (log: $LOG)"; return; }
  ms=$(($(now_ms) - t))
  [[ $(exec_in "$a" / cat /workspace/marker 2>>"$LOG") == here ]] || { fail "the workspace is not at /workspace after the mount"; return; }
  exec_in "$a" /workspace sh -c 'echo made > /workspace/made' 2>>"$LOG"
  [[ $(stat -c %u "$p1/sessions/k1/made" 2>/dev/null) == "$AGENT_UID" ]] || { fail "a file written inside is not $AGENT_UID's on the host"; return; }
  mount_in "$pa" "$a" p1 "${binds_a[@]}" || { fail "the second run exited $?"; return; }
  [[ $(grep -c ' /workspace ' "/proc/$pa/mountinfo") == 1 ]] || { fail "the second run mounted again"; return; }
  # As a -v of Podman's: nosuid, nodev, and no propagation from the host (field 7 is the separator).
  flags=$(awk '$5 == "/workspace" || $5 == "/clones/repo" || $5 == "/clones/repo/.git/worktrees" { n++; if ($6 !~ /nosuid/ || $6 !~ /nodev/ || $7 != "-") bad = bad " " $5 ":" $6 ":" $7 } END { if (n != 3) print "found " n " of 3 mounts"; else print bad }' "/proc/$pa/mountinfo")
  [[ -z $flags ]] || { fail "a helper mount is not nosuid,nodev and private:$flags"; return; }

  mount_in "$pa" "$a" p1 "$p1/sessions/link:/mnt/link"; rc=$?
  ((rc == 2)) || { fail "a symlinked source exited $rc, not 2"; return; }
  mount_in "$pa" "$a" p1 "$PEOPLE/p2/sessions/k9:/mnt/other"; rc=$?
  ((rc == 2)) || { fail "another person's directory exited $rc, not 2"; return; }
  mount_in "$pb" "$a" p1 "${binds_a[@]}"; rc=$?
  ((rc == 3)) || { fail "another container's pid exited $rc, not 3"; return; }
  out=$(exec_in "$a" / sh -c 'cat /mnt/link/secret /mnt/other/secret 2>/dev/null'; exec_in "$b" / sh -c 'cat /workspace/marker 2>/dev/null')
  [[ -z $out ]] || { fail "a refused mount is visible inside"; return; }

  # The private registry, as measured with raw namespaces on 2026-11-12 (work 078 "Evidence").
  mount_in "$pb" "$b" p1 "${binds_b[@]}" || { fail "mount into the second container exited $?"; return; }
  q exec_in "$a" /workspace git -C /clones/repo worktree add --quiet -b sp/k1 /workspace/repo || { fail "git worktree add in thread k1 (log: $LOG)"; return; }
  q exec_in "$b" /workspace git -C /clones/repo worktree add --quiet -b sp/k2 /workspace/repo || { fail "git worktree add at the same path in thread k2 (log: $LOG)"; return; }
  out=$(exec_in "$a" /workspace git -C /clones/repo worktree prune -v 2>&1)
  [[ -z $out ]] || { fail "git worktree prune in k1 removed something: $out"; return; }
  [[ -d $p1/wt/k1/repo/repo && -d $p1/wt/k2/repo/repo ]] || { fail "the registrations are not in wt/<key>/repo on the host"; return; }
  [[ -z $(ls -A "$p1/ws/repo/.git/worktrees") ]] || { fail "the clone's own .git/worktrees is not empty on the host"; return; }
  [[ -f $p1/ws/repo/.git/refs/heads/sp/k1 && -f $p1/ws/repo/.git/refs/heads/sp/k2 ]] || { fail "the clone lacks sp/k1 or sp/k2"; return; }
  q exec_in "$b" /workspace/repo git status --porcelain || { fail "k2's worktree is broken after k1's prune"; return; }

  # Mounts do not outlive a stop, and go back on.
  stop "$a" || { fail "the unit did not go after podman stop"; return; }
  up "$a" || { fail "restart: no pid (log: $LOG)"; return; }
  exec_in "$a" / test -e /workspace/marker 2>>"$LOG" && { fail "the mounts survived a stop"; return; }
  mount_in "$PID" "$a" p1 "${binds_a[@]}" || { fail "mounting again after a restart exited $?"; return; }
  q exec_in "$a" /workspace/repo git status --porcelain || { fail "k1's worktree is broken after a restart"; return; }
  pass "mount_ms=$ms (3 binds, podman unshare included) flags=nosuid,nodev,private second_run=no-op symlink=2 other_person=2 other_container=3 gone_after_stop=yes remount=ok registry=private"
}

# G4: a real runner with a session spec and nothing mounted leaves /workspace alone.
gate_G4() {
  local id run spec events cwds p watch rc
  [[ -n $RELEASE ]] || { skip "needs a built release (-r) and an image whose Node runs it"; return; }
  [[ $RELEASE == /opt/slack-presence/* && -f $RELEASE/dist/runner-boot.mjs ]] || { skip "$RELEASE is not a built release under /opt/slack-presence (no dist/runner-boot.mjs)"; return; }
  command -v inotifywait >/dev/null || q env DEBIAN_FRONTEND=noninteractive apt-get install -y inotify-tools || { skip "inotifywait is not installed and apt could not install inotify-tools"; return; }
  id=$(new_id)
  run=$(run_dir "$id")
  spec=$(printf '{"id":"%s","socket":"%s/runners/%s.sock","version":"gates","session":{"key":"CGATE:1.000001","kind":"thread","channel":"CGATE","threadTs":"1.000001","owner":{"slackUserId":"UGATE","dir":"p1","gitName":"gate","gitEmail":"gate@example.invalid"},"title":"gate","mode":"default","forkPath":"/workspace"}}' "$id" "$run" "$id")
  # The watch is there before the container starts: /workspace is an empty
  # directory of the host's for this one container, which the runner cannot
  # tell from the image's own.
  watch=$GATES/g4-events
  install -d -o "$AGENT" -g "$AGENT" "$GATES/g4-workspace"
  : >"$watch"
  inotifywait -m -q -r -e access -e open -e modify -e create -e delete -e attrib --format '%e %w%f' "$GATES/g4-workspace" >"$watch" 2>>"$LOG" &
  p=$!
  BG+=("$p")
  sleep 0.5
  CREATE_MORE=(-v "$GATES/g4-workspace:/workspace")
  create "$id"; rc=$?
  CREATE_MORE=()
  ((rc == 0)) || { kill "$p" 2>/dev/null; fail "podman create failed (log: $LOG)"; return; }
  up "$id" "$RELEASE" "$spec" || { kill "$p" 2>/dev/null; fail "start: no pid within 5 s (log: $LOG)"; return; }
  local deadline=$(($(now_ms) + 30000))
  while [[ ! -S $run/runners/$id.sock ]] && (($(now_ms) < deadline)); do sleep 0.1; done
  [[ -S $run/runners/$id.sock ]] || { kill "$p" 2>/dev/null; pm logs --tail 50 "sp-runner-$id" >>"$LOG" 2>&1; fail "the runner's socket did not appear in 30 s (log: $LOG)"; return; }
  sleep 5 # no credentials are ever sent: all of this is "before it has credentials"
  kill "$p" 2>/dev/null
  events=$(wc -l <"$watch")
  cwds=$(for p in $(payload_pids "$id"); do readlink "/proc/$p/cwd"; ls -l "/proc/$p/fd" 2>/dev/null | awk '{ print $NF }'; done | grep -c '^/workspace')
  if ((events == 0 && cwds == 0)); then pass "workspace_events=0 over socket-ready+5s, no cwd or fd under /workspace"
  else fail "workspace_events=$events cwd_or_fd_under_workspace=$cwds ($(head -3 "$watch" | tr '\n' ';'))"; fi
}

# G5: who a caller is, decided on the host from the peer's pid and cgroup.
# A listener stands in for the model proxy and the token relay: it applies the
# rule work 103 gives them (uid 1500 only; the first component below the
# runners slice names the runner) and answers `ok <id> leaf=<the last
# component of the caller's cgroup>` or `refused uid=<n>`.
gate_G5() {
  local id run sock other lp as_agent_says moved root_says codex client plain i
  new_container || return
  id=$ID
  run=$(run_dir "$id")
  sock=$run/tokens/$id.sock
  other=$(new_id)
  cat > "$GATES/peer-listen.py" <<'EOF'
import os, re, socket, struct, sys
path, slice_name, uid_ok = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.umask(0o007)
s = socket.socket(socket.AF_UNIX)
s.bind(path)
s.listen(8)
while True:
    c, _ = s.accept()
    pid, uid, _gid = struct.unpack('3i', c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    parts = open(f'/proc/{pid}/cgroup').read().strip().split(':', 2)[2].split('/')
    at = parts.index(slice_name) + 1 if slice_name in parts else len(parts)
    m = re.fullmatch(r'sp-runner-([0-9a-f]{16})\.service', parts[at]) if at < len(parts) else None
    c.sendall((f'ok {m.group(1)} leaf={parts[-1]}' if m and uid == uid_ok else f'refused uid={uid}').encode())
    c.close()
EOF
  python3 "$GATES/peer-listen.py" "$sock" "$SLICE" "$AGENT_UID" 2>>"$LOG" &
  lp=$!
  BG+=("$lp")
  for ((i = 0; i < 50; i++)); do [[ -S $sock ]] && break; sleep 0.1; done
  client='import socket, sys; s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print(s.recv(128).decode())'

  as_agent_says=$(exec_in "$id" / python3 -c "$client" "$sock" 2>>"$LOG")
  # The plain ways to a cgroup of one's own choosing, which must all be shut:
  # /sys/fs/cgroup is read-only and the container has no CAP_SYS_ADMIN.
  plain=$(exec_in "$id" / sudo sh -c "mkdir /sys/fs/cgroup/sp-runner-$other.service || mount -o remount,rw /sys/fs/cgroup || { mkdir -p /tmp/g5a && mount -t cgroup2 none /tmp/g5a; }" >>"$LOG" 2>&1 && echo open || echo shut)
  # The way that is open: the container's cgroup belongs to its root, and in
  # a user and cgroup namespace of its own root may mount cgroup2 writable.
  # There it makes a cgroup named like another runner's unit and moves this
  # shell (agent's) into it; the shell then becomes the client.
  moved=$(exec_in "$id" / sh -c '
    sudo unshare -UrmC sh -c "mkdir -p /tmp/g5b && mount -t cgroup2 none /tmp/g5b && mkdir -p /tmp/g5b/\$1 && echo \$2 > /tmp/g5b/\$1/cgroup.procs" sh "$1" "$$" || { echo "not-moved"; exit 0; }
    exec python3 -c "$2" "$3"' sh "sp-runner-$other.service" "$client" "$sock" 2>>"$LOG")
  root_says=$(exec_in "$id" / sudo python3 -c "$client" "$sock" 2>&1 | tail -1)
  # What Codex's loopback peer check reads (src/runner/harness/codex/peer.ts): its own cgroup's members, and the TCP table.
  codex=$(exec_in "$id" / sh -c 'p=$(cut -d: -f3 /proc/self/cgroup); grep -qx "$$" "/sys/fs/cgroup$p/cgroup.procs" && [ -r /proc/net/tcp ] && echo readable || echo "unreadable (cgroup $p)"' 2>>"$LOG")
  kill "$lp" 2>/dev/null

  [[ $as_agent_says == "ok $id leaf=libpod-payload-"* ]] || { fail "as agent the listener said '${as_agent_says:-nothing}', not 'ok $id'"; return; }
  [[ $plain == shut ]] || { fail "in-container root could write, remount or mount the cgroup tree directly"; return; }
  [[ $moved == "ok $id leaf=sp-runner-$other.service" ]] \
    || { fail "a caller moved into a cgroup named sp-runner-$other.service was answered '${moved:-nothing}', not 'ok $id leaf=sp-runner-$other.service' (not-moved: the move itself did not happen, so the rule was not tried)"; return; }
  [[ $root_says == "refused uid="* || $root_says == *"Permission denied"* ]] || { fail "in-container root was not refused: '$root_says'"; return; }
  [[ $codex == readable ]] || { fail "Codex's peer check cannot read its inputs: $codex"; return; }
  pass "agent=identified moved_into_cgroup_named_like_another_unit=still_itself(host saw leaf sp-runner-$other.service) direct_cgroup_write_as_root=shut root='${root_says##*: }' codex_inputs=readable; not run here (they need a host: step 6's check): the real model proxy, Codex's check itself, the token socket, gh pr create"
}

# One pass of G6's network checks in a running container. Prints the first thing wrong, or nothing.
# $2: a port open on the host's loopback only, $3: one open on every address of the host.
network_checks() {
  local id=$1 lo=$2 any=$3 gw addr port
  exec_in "$id" / curl -s -m 3 -o /dev/null -H Metadata:true 'http://169.254.169.254/metadata/instance?api-version=2021-02-01' 2>>"$LOG" && { echo "IMDS answered"; return; }
  for port in 80 32526; do
    exec_in "$id" / curl -s -m 3 -o /dev/null "http://$WIRESERVER:$port/?comp=versions" 2>>"$LOG" && { echo "the wireserver answered on port $port"; return; }
  done
  gw=$(exec_in "$id" / sh -c "ip -4 route show default | awk '{ print \$3; exit }'" 2>>"$LOG")
  for addr in 127.0.0.1 '[::1]' ${gw:+"$gw"} ${HOST_ADDR:+"$HOST_ADDR"}; do
    for port in "$lo" "$any" 7070; do
      exec_in "$id" / curl -s -m 2 -o /dev/null "http://$addr:$port/" 2>>"$LOG" && { echo "the host's port $port answered at $addr"; return; }
    done
  done
  exec_in "$id" / getent hosts github.com >/dev/null 2>>"$LOG" || { echo "DNS does not resolve github.com (resolv.conf: $(exec_in "$id" / awk '/^nameserver/ { printf "%s ", $2 }' /etc/resolv.conf 2>/dev/null))"; return; }
  exec_in "$id" / curl -s -m 10 -o /dev/null https://github.com/ 2>>"$LOG" || { echo "https://github.com/ does not answer"; return; }
}

# G6: the network from inside, apt as root inside, with and without pasta's AppArmor profile.
gate_G6() {
  local id lo=47071 any=47072 wrong without host_imds host_wire ns
  new_container || return
  id=$ID
  # On the host, what must not answer from inside: one port on its loopback, one on all its addresses.
  python3 -m http.server --bind 127.0.0.1 "$lo" >/dev/null 2>&1 &
  BG+=("$!")
  python3 -m http.server --bind 0.0.0.0 "$any" >/dev/null 2>&1 &
  BG+=("$!")
  sleep 0.5
  HOST_ADDR=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$lo/" && curl -s -m 2 -o /dev/null "http://${HOST_ADDR:-127.0.0.1}:$any/" || { fail "the host's own test listeners do not answer on the host"; return; }
  # Whether there is anything to refuse on this machine (root is not blocked).
  curl -s -m 3 -o /dev/null -H Metadata:true 'http://169.254.169.254/metadata/instance?api-version=2021-02-01' && host_imds=there || host_imds=absent
  curl -s -m 3 -o /dev/null "http://$WIRESERVER/?comp=versions" && host_wire=there || host_wire=absent
  ns=$(exec_in "$id" / awk '/^nameserver/ { printf "%s%s", sep, $2; sep = "," }' /etc/resolv.conf 2>>"$LOG")

  wrong=$(network_checks "$id" "$lo" "$any")
  [[ -z $wrong ]] || { fail "with the pasta profile: $wrong"; return; }
  q exec_in "$id" / sudo sh -c 'apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends hello' \
    || { fail "sudo apt-get install inside (log: $LOG)"; return; }
  stop "$id" && up "$id" || { fail "restart: no pid (log: $LOG)"; return; }
  q exec_in "$id" / hello || { fail "the package installed inside is gone after stop and start"; return; }

  # The same start without the profile: is provisioning step 2 needed? The
  # profile is this script's or provisioning's own file: Ubuntu's passt
  # package has one for `passt` only (usr.bin.passt), so unloading `pasta`
  # leaves the distribution's state. A file some package owns is left alone.
  stop "$id"
  if dpkg -S "$PASTA_PROFILE" >/dev/null 2>&1; then
    without="not tried: $PASTA_PROFILE belongs to a package"
  else
    PROFILE_OFF=1
    q apparmor_parser -R "$PASTA_PROFILE"
    if up "$id"; then
      wrong=$(network_checks "$id" "$lo" "$any")
      without=${wrong:+"starts, but: $wrong"}
      without=${without:-works the same}
      stop "$id"
    else
      without="does not start"
    fi
    q apparmor_parser -r "$PASTA_PROFILE" && PROFILE_OFF=0
  fi
  kill "${BG[@]}" 2>/dev/null
  pass "imds=refused(host:$host_imds) wireserver_80_32526=refused(host:$host_wire) host_loopback=unreachable host_any_address_port=unreachable(at 127.0.0.1, ::1, the gateway, $HOST_ADDR) dns=ok(nameserver $ns, port 53 let through) https=ok apt_survives_restart=yes without_pasta_profile='$without'"
}

# G7: what an exec and a helper container cost, and where a helper runs.
gate_G7() {
  local id i t exec_ms helper_ms times='' cid hp where held
  new_container || return
  id=$ID
  for ((i = 0; i < 10; i++)); do
    t=$(now_ms)
    exec_in "$id" /workspace true 2>>"$LOG" || { fail "podman exec true failed (log: $LOG)"; return; }
    times+="$(($(now_ms) - t))"$'\n'
  done
  exec_ms=$(printf '%s' "$times" | median)

  # ws-sync.sh is not written yet (step 3): a script that does nothing measures what a helper run adds to it.
  person p1
  printf '#!/bin/sh\n[ "${1:-}" = hold ] && sleep 8\nexit 0\n' > "$SP_RUN/helper/ws-gate.sh"
  chmod 0755 "$SP_RUN/helper/ws-gate.sh"
  times=''
  for ((i = 0; i < 5; i++)); do
    t=$(now_ms)
    helper p1 none "$SP_RUN/helper/ws-gate.sh" >>"$LOG" 2>&1 || { fail "the helper container exited $? (log: $LOG)"; return; }
    times+="$(($(now_ms) - t))"$'\n'
  done
  helper_ms=$(printf '%s' "$times" | median)

  helper p1 pasta "$SP_RUN/helper/ws-gate.sh" hold >>"$LOG" 2>&1 &
  held=$!
  where=''
  for ((i = 0; i < 60 && ${#where} == 0; i++)); do
    sleep 0.1
    cid=$(pm ps --filter label=sp.helper=p1 --format '{{.ID}}' 2>/dev/null | head -1)
    [[ -n $cid ]] || continue
    hp=$(pm inspect --format '{{.State.Pid}}' "$cid" 2>/dev/null)
    ((${hp:-0} > 0)) && where=$(cut -d: -f3 "/proc/$hp/cgroup" 2>/dev/null)
  done
  wait "$held"
  [[ $where == */$SLICE/* ]] || { fail "a helper's process is in '${where:-nowhere found}', not below $SLICE"; return; }
  if ((exec_ms <= 300 && helper_ms <= 1000)); then pass "exec_true_p50_ms=$exec_ms helper_run_p50_ms=$helper_ms (a script that does nothing, --network=none) helper_cgroup=$where"
  else fail "exec_true_p50_ms=$exec_ms (limit 300) helper_run_p50_ms=$helper_ms (limit 1000)"; fi
}

# G8: files a session made as root go with `podman unshare rm -rf`; the release-pruning scan sees a containerised runner.
gate_G8() {
  local id owner plain root seen p made=$PEOPLE/p1/sessions/k8/rootmade
  person p1
  as_agent mkdir -p "$PEOPLE/p1/sessions/k8"
  new_container || return
  id=$ID
  mount_in "$PID" "$id" p1 "$PEOPLE/p1/sessions/k8:/workspace" || { fail "mount exited $? (log: $LOG)"; return; }
  q exec_in "$id" /workspace sudo sh -c 'mkdir -p /workspace/rootmade/sub && echo x > /workspace/rootmade/sub/f && chmod 000 /workspace/rootmade/sub /workspace/rootmade' \
    || { fail "could not make files as root inside (log: $LOG)"; return; }
  owner=$(stat -c %u "$made")
  [[ $owner != "$AGENT_UID" && $owner != 0 ]] || { fail "a file made as root inside belongs to uid $owner on the host"; return; }
  as_agent rm -rf -- "$made" 2>/dev/null
  [[ -e $made ]] && plain=refused || plain=worked
  q pm unshare rm -rf -- "$made"
  [[ ! -e $made ]] || { fail "podman unshare rm -rf left $made (owner uid $owner)"; return; }

  # provision.sh's scan, word for word, for the root this runner started from.
  root=$(run_dir "$id")/gate-root
  # Only the container's own processes are counted: a scan of every /proc/*/cmdline
  # finds the scanning grep itself, which has the root as an argument.
  seen=0
  for p in $(payload_pids "$id"); do grep -qsF "$root" "/proc/$p/cmdline" && seen=$((seen + 1)); done
  ((seen > 0)) || { fail "grep -F <ROOT> /proc/<pid>/cmdline matches none of the container's processes ($(payload_pids "$id" | tr '\n' ' '))"; return; }
  pass "root_made_owner_uid=$owner plain_rm_as_agent=$plain podman_unshare_rm=removed cmdline_scan_hits=$seen(the container's processes only)"
}

# G9: Docker's commands inside a session, as agent (C11).
gate_G9() {
  local id owners short=resolves out t run_ms build_ms up_ms
  new_container || return
  id=$ID
  in9() { local dir=$1; shift; as_agent /usr/bin/timeout 300 /usr/bin/podman exec --user 1500:1500 --workdir "$dir" "sp-runner-$id" "$@"; }
  owners=$(exec_in "$id" /home/agent sh -c 'stat -c %u ~/.local ~/.local/share ~/.local/share/containers' 2>>"$LOG" | tr '\n' ' ')
  [[ $owners == "1500 1500 1500 " ]] || { fail "owners of ~/.local, ~/.local/share, ~/.local/share/containers: ${owners:-unreadable}"; return; }
  t=$(now_ms)
  if ! q in9 /home/agent docker run --rm hello-world; then
    short=unresolved
    t=$(now_ms)
    q in9 /home/agent docker run --rm docker.io/library/hello-world \
      || { fail "docker run hello-world, by short and by full name (log: $LOG)"; return; }
  fi
  run_ms=$(($(now_ms) - t))
  t=$(now_ms)
  q in9 /home/agent sh -c '
    mkdir -p g9 && cd g9 &&
    printf "FROM docker.io/library/busybox\nRUN echo built > /built\nCMD cat /built\n" > Dockerfile &&
    docker build -t g9-built . && [ "$(docker run --rm g9-built)" = built ]' \
    || { fail "docker build of a three-line Dockerfile, or running what it built (log: $LOG)"; return; }
  build_ms=$(($(now_ms) - t))
  # Two services on the network compose makes for them; the second reaches the
  # first by its name. What they print is in capitals, which the commands
  # compose echoes are not.
  t=$(now_ms)
  out=$(in9 /home/agent/g9 sh -c '
    printf "services:\n  one:\n    image: docker.io/library/busybox\n    command: sh -c \"echo one-up | tr a-z A-Z; nc -l -p 8080 -e echo hi-from-one\"\n  two:\n    image: docker.io/library/busybox\n    command: sh -c \"sleep 1; echo two-up | tr a-z A-Z; nc one 8080 | tr a-z A-Z\"\n" > compose.yaml &&
    timeout 120 docker compose up 2>&1; docker compose down >/dev/null 2>&1' 2>&1)
  up_ms=$(($(now_ms) - t))
  echo "$out" >>"$LOG"
  [[ $out == *ONE-UP* && $out == *TWO-UP* ]] || { fail "docker compose up of two services (log: $LOG): $(echo "$out" | grep -iE 'error|no such' | head -2 | tr '\n' ' ' | cut -c1-200)"; return; }
  [[ $out == *HI-FROM-ONE* ]] || { fail "compose started both services, but the second did not reach the first by its name (log: $LOG)"; return; }
  pass "docker_run=ok(short name $short, ${run_ms} ms with the pull) docker_build=ok(${build_ms} ms, and a run of it) compose_two_services=ok(by service name, up+down ${up_ms} ms) owners=1500,1500,1500"
}

# --------------------------------------------------------------------------- main
while getopts 'i:r:kh' opt; do
  case $opt in
    i) IMAGE=$OPTARG ;;
    r) RELEASE=${OPTARG%/} ;;
    k) KEEP=1 ;;
    *) sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
(($#)) || set -- G1 G2 G3 G4 G5 G6 G7 G8 G9
for g in "$@"; do [[ $g =~ ^G[1-9]$ ]] || { echo "no gate $g" >&2; exit 2; }; done

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
setup
for g in "$@"; do
  RESULT=''
  echo "== $g" >>"$LOG"
  "gate_$g"
  [[ -n $RESULT ]] || RESULT="fail the gate ended without a result (log: $LOG)"
  echo "$g $RESULT"
  [[ $RESULT == fail* ]] && FAILED=1
done
exit "$FAILED"
