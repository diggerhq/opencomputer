#!/usr/bin/env bash
# The host side of a self-hosted computer: one VM that runs the gateway
# container (compose.yaml, not this script) and the host agent with its
# sessions in rootless Podman (this script). Carved from
# computer/deploy/vm/provision.sh, the fleet's provisioner, without anything
# that only the fleet needs: no cloud detection, no data disk discovery, no self-update timer, no Docker, no previews (cloudflared),
# no client relay, no operator CLIs (Claude Code, gh, codex, playwright).
# The contract with the gateway container is selfhost/CONTRACT.md.
#
#   sudo selfhost/host-install.sh [--build-image]   install, or update to this checkout
#   sudo selfhost/host-install.sh --dry-run         check this machine and print the plan; changes nothing
#   sudo selfhost/host-install.sh --link-gateway    point the host at the running gateway container (its
#                                                   URL, organization and /data/host-token) and (re)start it
#   sudo selfhost/host-install.sh --uninstall [--purge]
#                                                   stop and remove the services; --purge also
#                                                   the users, their data under /data and the images
#   sudo selfhost/host-install.sh --enable-offload --bucket <name> [--image-s <image>] [--image-m <image>] [--region <region>]
#                                                   build offload to AWS Lambda MicroVMs: only on an EC2 instance
#                                                   with a role (selfhost/lib/aws-detect.sh); anywhere else it
#                                                   refuses and changes nothing. With --dry-run: the plan
#   sudo selfhost/host-install.sh --disable-offload drain build offload's MicroVMs, then remove it (its ledger is kept)
#
# What it installs:
#   - Node.js 24 (the host agent), Go (only to build oc-modelproxy), git
#   - users agent (uid 1500: the sessions, rootless Podman with subuid/subgid
#     and lingering) and sp-host (the host agent, may become agent through sudo),
#     as on the fleet (deploy/vm/sp-host.sh)
#   - rootless Podman with crun, pasta and catatonit (deploy/vm/sandbox.sh, plus catatonit
#     for `podman run --init` and builds inside sessions); storage under /data/containers
#   - the release: this checkout's computer/ at /opt/slack-presence/releases/<commit>,
#     /opt/slack-presence/current pointing at it (containers mount /opt/slack-presence)
#   - the session image, pulled by digest (or built here with --build-image)
#   - systemd: slack-presence-host.service (EnvironmentFile=/etc/opencomputer/selfhost.env),
#     oc-modelproxy (socket-activated), the metadata block, cgroup limits;
#     opencomputer-imds-deny.service denies the cloud metadata service to every
#     user but root (DNS and NTP to it stay open), on every cloud
#   - build offload (opencomputer-offload*, user oc-offload, its metadata
#     exception), only with --enable-offload on EC2 with a role; never otherwise
#   - for the gateway's compose stack (selfhost/compose.yaml, not started here):
#     podman-compose in /opt/podman-compose (Ubuntu's 1.0.6 ignores compose
#     profiles) and user oc-gateway (home /var/lib/oc-gateway, rootless Podman,
#     lingering, podman-restart.service), so the stack runs apart from the
#     sessions and comes back after a reboot; this checkout's selfhost/ (and
#     services/managed-agents, the gateway's build context) copied to
#     /var/lib/oc-gateway/selfhost, refreshed on every install; .env is kept
#
# Inputs (environment):
#   SP_IMAGE        a session image to run instead of the one this checkout names,
#                   ghcr.io/diggerhq/computer-session@sha256:<digest> or :<tag>
#   ALLOW_UNVERIFIED_IMAGE  1: when the image's digest cannot be verified (no gh
#                   with a token here), run the tag CI pushed for this tree
#                   anyway. Anyone who can push a branch to the repository can
#                   move a tag; the digest check is what rules that out.
#   GO_SERIES       Go series for oc-modelproxy (default 1.27, as its go.mod)
#   GATEWAY_CONTAINER  --link-gateway: the gateway container's name, when
#                   $GATEWAY_USER runs more than one compose project
#   GATEWAY_USER    the dedicated user that runs the compose stack (default
#                   oc-gateway, made here); an existing login user works too.
#                   Never agent (uid 1500: only the sessions' user, inside their
#                   containers), sp-host or root: sessions run tools as agent with
#                   no prompts, and the gateway holds every secret
#   PODMAN_COMPOSE_VERSION  podman-compose from PyPI (default 1.6.0; >= 1.1.0)
#   NODE_MAJOR      Node.js major (default 24)
#
# /etc/opencomputer/selfhost.env (selfhost/selfhost.env.example) is the
# operator's: an install never writes it, --link-gateway rewrites only its
# SP_GATEWAY_URL, SP_HOST_ID and SP_HOST_TOKEN lines, --enable-offload adds
# SP_OFFLOAD* lines and --disable-offload removes them. Without a token in it the
# host is installed but not started.
#
# Invariants:
# - Idempotent: a second run with the same checkout changes nothing and restarts
#   only the host. A run with a newer checkout builds a new release beside the
#   old one and switches `current` only once its image is present and warm.
# - The fleet scripts it calls (computer/deploy/vm/{sandbox,sp-host,modelproxy,limits}.sh)
#   run unchanged, from the release, exactly as provision.sh runs them.
# - Never formats a disk, never deletes /data (only --purge removes the
#   directories this script made there), never touches Docker, never starts
#   or stops the compose stack.
#
# TODO(selfhost): the agent user, its directories, the agent environment and
# the release build below duplicate provision.sh's. They stay copies until
# provision.sh is split into functions both can source; that refactor is a
# fleet change and is left for its own PR.
set -euo pipefail
umask 022

DL=(--connect-timeout 15 --speed-limit 100000 --speed-time 20 --retry 5 --retry-delay 2 --retry-all-errors)

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '/^#   sudo/,/^#$/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

MODE=install DRY_RUN=0 BUILD_IMAGE=0 PURGE=0
OFFLOAD_BUCKET="" OFFLOAD_IMAGE_S="" OFFLOAD_IMAGE_M="" OFFLOAD_REGION="" OFFLOAD_FLAGS=0
ARGS=("$@")
while (($#)); do
  arg="$1"; shift
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --build-image) BUILD_IMAGE=1 ;;
    --uninstall) MODE=uninstall ;;
    --link-gateway) MODE=link ;;
    --purge) PURGE=1 ;;
    --enable-offload) MODE=enable-offload ;;
    --disable-offload) MODE=disable-offload ;;
    --bucket|--image-s|--image-m|--region)
      (($#)) || die "$arg needs a value"
      set -- "$arg=$1" "${@:2}" ;;
    --bucket=*) OFFLOAD_BUCKET="${arg#*=}" OFFLOAD_FLAGS=1 ;;
    --image-s=*) OFFLOAD_IMAGE_S="${arg#*=}" OFFLOAD_FLAGS=1 ;;
    --image-m=*) OFFLOAD_IMAGE_M="${arg#*=}" OFFLOAD_FLAGS=1 ;;
    --region=*) OFFLOAD_REGION="${arg#*=}" OFFLOAD_FLAGS=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $arg" >&2; usage 2 ;;
  esac
done
[[ $PURGE == 0 || $MODE == uninstall ]] || die "--purge goes with --uninstall"
[[ $OFFLOAD_FLAGS == 0 || $MODE == enable-offload ]] || die "--bucket, --image-s, --image-m and --region go with --enable-offload"
[[ -z $OFFLOAD_BUCKET || $OFFLOAD_BUCKET =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "--bucket: not an S3 bucket name: $OFFLOAD_BUCKET"
[[ -z $OFFLOAD_REGION || $OFFLOAD_REGION =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "--region: not an AWS region: $OFFLOAD_REGION"
for arg in "$OFFLOAD_IMAGE_S" "$OFFLOAD_IMAGE_M"; do
  [[ -z $arg || $arg =~ ^[A-Za-z0-9:/._-]+$ ]] || die "--image-s/--image-m: not an image name or ARN: $arg"
done

AGENT_USER=agent
AGENT_UID=1500            # fixed: the session image and podman-args.ts assume 1500
HOST_USER=sp-host
DATA=/data
AGENT_HOME="$DATA/home/$AGENT_USER"
# OC_ROOT: tests only (selfhost/test/), a directory standing in for / under
# the paths the offload modes touch. Unset on a real host.
R="${OC_ROOT:-}"
SP_ROOT="$R/opt/slack-presence"
SP_RELEASES="$SP_ROOT/releases"
SP_CURRENT="$SP_ROOT/current"
SP_RUN=/run/slack-presence
ETC=/etc/slack-presence
SELFHOST_ETC="$R/etc/opencomputer"
SELFHOST_ENV="$SELFHOST_ETC/selfhost.env"
REPOSITORY=ghcr.io/diggerhq/computer-session
GO_SERIES="${GO_SERIES:-1.27}"
NODE_MAJOR="${NODE_MAJOR:-24}"
GATEWAY_USER="${GATEWAY_USER:-oc-gateway}"
GATEWAY_HOME_DEFAULT=/var/lib/oc-gateway
# The stack's copy, from this checkout into $GATEWAY_HOME: compose.yaml builds from its parent (context: ..).
GATEWAY_STACK_PATHS=(selfhost/compose.yaml selfhost/.env.example selfhost/gateway selfhost/systemd services/managed-agents)
GATEWAY_NETWORKS="/srv/$GATEWAY_USER/networks"   # its Podman networks: not under /var/lib (gateway_user)
PODMAN_COMPOSE_VERSION="${PODMAN_COMPOSE_VERSION:-1.6.0}"
PODMAN_COMPOSE_MIN=1.1.0
COMPOSE_VENV=/opt/podman-compose
UNIT=slack-presence-host.service
SYSTEMD="$R/etc/systemd/system"
LOCK="$R/run/opencomputer-host-install.lock"
# Build offload (work/136): present only where --enable-offload passed detection and wrote the marker.
OFFLOAD_USER=oc-offload
OFFLOAD_MARKER="$SELFHOST_ETC/offload.enabled"
OFFLOAD_DRAINING="$SELFHOST_ETC/offload.draining"
OFFLOAD_STATE="$R/var/lib/opencomputer-offload"
OFFLOAD_KEEP="$R/var/lib/opencomputer"
OFFLOAD_UNITS=(opencomputer-offload-reap.timer opencomputer-offload-reap.service opencomputer-offload.service opencomputer-offload-imds.service)
OFFLOAD_KEYS='^[[:space:]]*SP_OFFLOAD[A-Z0-9_]*='
AGENT_PATH="$SP_CURRENT/bin:/usr/local/go/bin:$AGENT_HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEBIAN_FRONTEND=noninteractive
# go build needs a module cache under HOME; run-command and some cloud-init shells give root none.
export HOME="${HOME:-/root}"

[[ $EUID -eq 0 || $DRY_RUN == 1 || -n $R ]] || die "run as root (sudo $0 ${ARGS[*]})"

# ------------------------------------------------------------------ helpers

# git on the checkout, which is usually not root's: without safe.directory git refuses it under sudo.
rgit() { git -c safe.directory='*' -C "$REPO_ROOT" "$@"; }

# The checkout this script is in: the code it deploys.
checkout() {
  REPO_ROOT="$(git -c safe.directory='*' -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" \
    || die "$HERE is not in a git checkout of diggerhq/opencomputer; clone it and run the script from there"
  [[ -d $REPO_ROOT/computer/src/host ]] || die "$REPO_ROOT has no computer/src/host; not an opencomputer checkout"
  SHA="$(rgit rev-parse --short=12 HEAD)"
  TREE="$(rgit rev-parse HEAD:computer/deploy/image)"
  RELEASE="$SP_RELEASES/$SHA"
}

# fill <template>: the template with its @NAMES@ replaced, on stdout.
fill() {
  sed -e "s|@AGENT_USER@|$AGENT_USER|g" -e "s|@AGENT_UID@|$AGENT_UID|g" \
      -e "s|@AGENT_HOME@|$AGENT_HOME|g" -e "s|@AGENT_PATH@|$AGENT_PATH|g" \
      -e "s|@DATA@|$DATA|g" -e "s|@SP_RUN@|$SP_RUN|g" -e "s|@SP_CURRENT@|$SP_CURRENT|g" \
      -e "s|@SELFHOST_ENV@|$SELFHOST_ENV|g" -e "s|@SELFHOST_ETC@|$SELFHOST_ETC|g" \
      -e "s|@HOST_USER@|$HOST_USER|g" "$1"
}

# run <command...>: print it and run it; with --dry-run, only print it.
run() { if [[ $DRY_RUN == 1 ]]; then echo "would: $*"; else echo "$*"; "$@"; fi; }

# Podman as the agent, in its user manager (what sandbox.sh and the host do).
as_agent() {
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" "$@"
}

# The value of KEY in the operator's selfhost.env, read as data (never sourced, never printed).
env_value() { sed -n "s/^[[:space:]]*$1=//p" "$SELFHOST_ENV" 2>/dev/null | tail -1 | tr -d "\"'[:space:]"; }

# version_ge <a> <b>: a >= b, both dotted numbers.
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

# Podman as the gateway user, in its user manager.
as_gateway() {
  local uid; uid="$(id -u "$GATEWAY_USER")"
  runuser -u "$GATEWAY_USER" -- env HOME="$GATEWAY_HOME" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}

# free_subids <file>: the start of a 65536-id range above every range in <file>.
free_subids() {
  awk -F: 'BEGIN { end = 100000 } NF == 3 && $2 + $3 > end { end = $2 + $3 } END { print end }' "$1"
}

# >= 4.7: sessions need 4.4 (--userns=keep-id:uid=,gid= and pasta); the
# `podman compose` command the stack is run with arrived in 4.7. Ubuntu 24.04
# ships 4.9.3, the tested version.
podman_version_ok() {   # <version>
  local maj min
  IFS=. read -r maj min _ <<<"${1%%[-+~]*}"
  [[ $maj =~ ^[0-9]+$ && $min =~ ^[0-9]+$ ]] && (( maj > 4 || (maj == 4 && min >= 7) ))
}

# ------------------------------------------------------------------ preflight
preflight() {
  log "preflight"
  [[ -r /etc/os-release ]] || die "no /etc/os-release"
  # shellcheck disable=SC1091
  read -r OS_ID OS_VERSION <<<"$(. /etc/os-release && echo "$ID $VERSION_ID")"
  [[ $OS_ID == ubuntu ]] || die "Ubuntu only, not $OS_ID"
  ARCH="$(dpkg --print-architecture)"
  [[ $ARCH == amd64 ]] || die "amd64 only: the session image is built for linux/amd64 (this is $ARCH)"
  echo "Ubuntu $OS_VERSION $ARCH"

  case $OS_VERSION in
    24.04) ;;
    22.04)
      # Ubuntu 22.04's own Podman is 3.4 (no keep-id:uid=, no pasta) and its AppArmor
      # cannot load sandbox.sh's pasta profile (abi 4.0). Go on only if apt offers a newer
      # Podman and passt, from a repository the operator added.
      local cand
      apt-get update -q >/dev/null 2>&1 || true
      cand="$(apt-cache policy podman 2>/dev/null | sed -n 's/^ *Candidate: //p')"
      if ! podman_version_ok "${cand#*:}" || ! apt-cache policy passt 2>/dev/null | sed -n 's/^ *Candidate: //p' | grep -qv none; then
        die "Ubuntu 22.04: apt offers podman '${cand:-none}' and no passt; this needs Podman >= 4.7 with pasta. Use Ubuntu 24.04"
      fi
      warn "Ubuntu 22.04 with podman $cand from an added repository: untested" ;;
    *) die "Ubuntu 24.04 (or 22.04 with a newer Podman) only, not $OS_VERSION" ;;
  esac

  if [[ $DRY_RUN == 0 ]]; then
    [[ -d /run/systemd/system ]] || die "systemd is not running (PID 1 is $(ps -o comm= -p 1)); this needs a VM, not a container"
  fi
  if command -v docker >/dev/null && id -nG "$AGENT_USER" 2>/dev/null | grep -qw docker; then
    die "$AGENT_USER is in the docker group (root-equivalent for every session); remove it first"
  fi

  case $GATEWAY_USER in
    "$AGENT_USER"|"$HOST_USER"|modelproxy|root|'') die "GATEWAY_USER=$GATEWAY_USER: the compose stack needs a user of its own (default oc-gateway)" ;;
  esac
  if id "$GATEWAY_USER" >/dev/null 2>&1; then
    GATEWAY_HOME="$(getent passwd "$GATEWAY_USER" | cut -d: -f6)"
    id -nG "$GATEWAY_USER" | grep -qwE "$AGENT_USER|$HOST_USER" \
      && die "$GATEWAY_USER is in group $AGENT_USER or $HOST_USER; the gateway's user must not share the sessions' files"
    echo "compose stack user: $GATEWAY_USER (exists, home $GATEWAY_HOME)"
  else
    GATEWAY_HOME="$GATEWAY_HOME_DEFAULT"
    echo "compose stack user: $GATEWAY_USER (to be created, home $GATEWAY_HOME)"
  fi
  version_ge "$PODMAN_COMPOSE_VERSION" "$PODMAN_COMPOSE_MIN" \
    || die "PODMAN_COMPOSE_VERSION=$PODMAN_COMPOSE_VERSION: compose profiles need podman-compose >= $PODMAN_COMPOSE_MIN"

  checkout
  echo "checkout $REPO_ROOT at $SHA"
  if [[ -n "$(rgit status --porcelain -- computer)" ]]; then
    warn "computer/ has uncommitted changes; the release is the commit $SHA without them"
  fi

  if mountpoint -q "$DATA" 2>/dev/null; then echo "$DATA: mounted from $(findmnt -no SOURCE "$DATA")"
  else echo "$DATA: a directory on the root disk (mount a data disk there before installing to keep sessions apart from the OS)"; fi
  local free; free=$(( $(df -B1 --output=avail "$(test -d "$DATA" && echo "$DATA" || echo /)" | tail -1) / 1073741824 ))
  (( free >= 20 )) || warn "$DATA has $free GiB free; the session image needs about 10 and every session's workspace more"
}

# Which session image: SP_IMAGE, the checkout's deploy/image.pin, a digest
# verified by deploy/image-pin.sh, a local build, or (opted in) the tag.
resolve_image() {
  IMAGE_HOW=""
  if [[ -n ${SP_IMAGE:-} ]]; then
    IMAGE="$SP_IMAGE" IMAGE_HOW="SP_IMAGE"
  elif [[ $BUILD_IMAGE == 1 ]]; then
    IMAGE="$REPOSITORY:local-$TREE" IMAGE_HOW="built here from computer/deploy/image"
  elif [[ -f $REPO_ROOT/computer/deploy/image.pin ]]; then
    IMAGE="$(tr -d '[:space:]' < "$REPO_ROOT/computer/deploy/image.pin")" IMAGE_HOW="deploy/image.pin"
  elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1 \
       && IMAGE="$(bash "$REPO_ROOT/computer/deploy/image-pin.sh" "$TREE" 2>/dev/null)"; then
    IMAGE_HOW="digest main's CI attested for tree $TREE (deploy/image-pin.sh)"
  elif [[ ${ALLOW_UNVERIFIED_IMAGE:-0} == 1 ]]; then
    IMAGE="$REPOSITORY:$TREE" IMAGE_HOW="UNVERIFIED tag (ALLOW_UNVERIFIED_IMAGE=1)"
    warn "running $IMAGE without checking who built it"
  else
    die "cannot verify the session image for tree $TREE: no deploy/image.pin, and deploy/image-pin.sh needs gh with a token (GH_TOKEN). Give SP_IMAGE=$REPOSITORY@sha256:<digest>, build it here with --build-image, or accept the tag with ALLOW_UNVERIFIED_IMAGE=1"
  fi
  [[ $IMAGE == "$REPOSITORY":* || $IMAGE == "$REPOSITORY"@sha256:* ]] \
    || die "SP_IMAGE must be an image of $REPOSITORY (deploy/vm/sandbox.sh accepts no other), not $IMAGE"
  ABI="$(tr -d '[:space:]' < "$REPO_ROOT/computer/deploy/image/ABI")"
  [[ $ABI =~ ^[0-9]+$ ]] || die "computer/deploy/image/ABI is not an integer"
}

plan() {
  cat <<EOF

Plan (nothing below has run):
  1. apt: git curl jq xz-utils sudo dbus-user-session iptables uidmap acl catatonit sqlite3 apparmor python3-venv
  2. Node.js $NODE_MAJOR (nodejs.org, checksum-verified) -> /usr/local; Go $GO_SERIES (go.dev) -> /usr/local/go;
     podman-compose $PODMAN_COMPOSE_VERSION (PyPI) -> $COMPOSE_VENV, /usr/local/bin/podman-compose
  3. $DATA directory; user $AGENT_USER (uid $AGENT_UID, home $AGENT_HOME, no sudo);
     user $GATEWAY_USER for the compose stack (home $GATEWAY_HOME, stack in $GATEWAY_HOME/selfhost, copied from this checkout, .env kept; subuid/subgid, no sudo)
  4. release $RELEASE from $REPO_ROOT (git archive HEAD:computer, npm ci, runner bundle, oc-modelproxy build)
  5. rootless Podman for $AGENT_USER (computer/deploy/vm/sandbox.sh install): podman crun passt uidmap slirp4netns,
     /etc/subuid and /etc/subgid, lingering, storage $DATA/containers/storage
  6. session image $IMAGE
     ($IMAGE_HOW), ABI $ABI: $( [[ $BUILD_IMAGE == 1 ]] && echo "podman build as $AGENT_USER, then warmed" || echo "pulled and warmed" )
  7. $SP_CURRENT -> $RELEASE; old releases and images pruned
  8. systemd: run dirs, /tmp ageing, user@$AGENT_UID drop-in, cgroup limits (limits.sh), oc-modelproxy (modelproxy.sh),
     slack-presence-imds-block.service, opencomputer-imds-deny.service (deny IMDS to non-root; ports 53, udp 123 open),
     $UNIT (EnvironmentFile=$SELFHOST_ENV)
  9. user $HOST_USER, sudoers, SP_LAUNCH=podman (computer/deploy/vm/sp-host.sh new + apply)
     $GATEWAY_USER: lingering, podman-restart.service enabled (starts restart: always containers at boot)
 10. $( [[ -n "$(env_value SP_HOST_TOKEN)" ]] && echo "start $UNIT ($SELFHOST_ENV has a token)" || echo "$UNIT installed, NOT started: $SELFHOST_ENV has no SP_HOST_TOKEN yet" )
 11. build offload: $(offload_plan_line)
Not installed: Docker, cloudflared, Claude Code CLI, gh, codex, playwright, a self-update timer.
Not started: the compose stack (selfhost/compose.yaml, as $GATEWAY_USER).
EOF
}

# ------------------------------------------------------------------ install steps

# The stack's files, from this checkout's HEAD (git archive: no node_modules or
# local edits) into $GATEWAY_HOME, owned by $GATEWAY_USER. Each run replaces
# them; selfhost/.env is not in the archive and stays.
gateway_stack() {
  log "compose stack -> $GATEWAY_HOME/selfhost"
  local p paths=() group; group="$(id -gn "$GATEWAY_USER")"
  for p in "${GATEWAY_STACK_PATHS[@]}"; do
    if rgit cat-file -e "HEAD:$p" 2>/dev/null; then paths+=("$p"); else echo "warning: $p is not in this checkout; skipped"; fi
  done
  [[ ${#paths[@]} -gt 0 ]] || { echo "warning: no compose stack in this checkout"; return 0; }
  for p in "${paths[@]}"; do [[ $p == */.env.example || $p == */compose.yaml ]] || rm -rf "${GATEWAY_HOME:?}/$p"; done
  rgit archive --format=tar HEAD "${paths[@]}" | tar -x -C "$GATEWAY_HOME" --no-same-owner
  for p in selfhost services; do [[ ! -d $GATEWAY_HOME/$p ]] || chown -R "$GATEWAY_USER:$group" "$GATEWAY_HOME/$p"; done
  chmod 0750 "$GATEWAY_HOME/selfhost"
  [[ ! -f $GATEWAY_HOME/selfhost/.env ]] || chmod 0600 "$GATEWAY_HOME/selfhost/.env"
}
packages() {
  log "apt packages"
  apt-get update -q
  # dbus-user-session: the agent's user manager bus (Podman, systemd-run --user).
  # iptables: the metadata block. catatonit: `podman run --init`.
  apt-get install -y -q --no-install-recommends \
    ca-certificates curl git jq xz-utils sudo dbus-user-session iptables uidmap acl catatonit sqlite3 apparmor \
    procps util-linux python3-venv
}

node_js() {
  log "Node.js $NODE_MAJOR"
  if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
    local dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp tarball
    tmp="$(mktemp -d)"
    curl "${DL[@]}" -fsSL "$dist/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    tarball="$(awk '/linux-x64\.tar\.xz$/ {print $2}' "$tmp/SHASUMS256.txt")"
    [[ -n $tarball ]] || die "no linux-x64 tarball in $dist/SHASUMS256.txt"
    curl "${DL[@]}" -fsSL "$dist/$tarball" -o "$tmp/$tarball"
    (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
    rm -rf "$tmp"
    hash -r
  fi
  node --version
}

go_toolchain() {
  log "Go $GO_SERIES (to build oc-modelproxy)"
  local have want tgz sha tmp json
  have="$(/usr/local/go/bin/go env GOVERSION 2>/dev/null || true)"
  if [[ $have == "go$GO_SERIES" || $have == go$GO_SERIES.* ]]; then echo "$have"; return; fi
  json="$(curl "${DL[@]}" -fsSL 'https://go.dev/dl/?mode=json&include=all')"
  want="$(jq -r --arg s "go$GO_SERIES" '[.[] | select(.stable and (.version == $s or (.version | startswith($s + "."))))][0].version' <<<"$json")"
  [[ -n $want && $want != null ]] || die "could not resolve the latest Go $GO_SERIES release"
  tgz="$want.linux-amd64.tar.gz"
  sha="$(jq -r --arg f "$tgz" '.[].files[] | select(.filename == $f) | .sha256' <<<"$json" | head -1)"
  [[ -n $sha ]] || die "no checksum for $tgz"
  tmp="$(mktemp -d)"
  curl "${DL[@]}" -fsSL "https://go.dev/dl/$tgz" -o "$tmp/$tgz"
  echo "$sha  $tmp/$tgz" | sha256sum -c -
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tmp/$tgz"
  rm -rf "$tmp"
  /usr/local/go/bin/go version
}

# podman-compose for the gateway's stack. Ubuntu 24.04's package is 1.0.6,
# which ignores compose profiles (the tunnel services); PyPI's is current.
# `podman compose` finds it on PATH.
compose_tool() {
  log "podman-compose $PODMAN_COMPOSE_VERSION"
  local have=""
  have="$("$COMPOSE_VENV/bin/python" -c 'import importlib.metadata as m; print(m.version("podman-compose"))' 2>/dev/null || true)"
  if [[ $have != "$PODMAN_COMPOSE_VERSION" ]]; then
    rm -rf "$COMPOSE_VENV"
    python3 -m venv "$COMPOSE_VENV"
    "$COMPOSE_VENV/bin/pip" install -q --disable-pip-version-check "podman-compose==$PODMAN_COMPOSE_VERSION"
    have="$("$COMPOSE_VENV/bin/python" -c 'import importlib.metadata as m; print(m.version("podman-compose"))')"
  fi
  version_ge "$have" "$PODMAN_COMPOSE_MIN" || die "podman-compose $have in $COMPOSE_VENV is older than $PODMAN_COMPOSE_MIN"
  ln -sfn "$COMPOSE_VENV/bin/podman-compose" /usr/local/bin/podman-compose
  [[ "$(command -v podman-compose)" == /usr/local/bin/podman-compose ]] \
    || die "podman-compose on PATH is $(command -v podman-compose), not $COMPOSE_VENV's"
  if dpkg -s podman-compose >/dev/null 2>&1; then
    warn "apt's podman-compose is installed too; /usr/local/bin/podman-compose ($have) comes first on PATH"
  fi
  echo "podman-compose $have"
}

# The compose stack's user: rootless Podman of its own, apart from the
# sessions (agent) and the host (sp-host). Its systemd side (lingering,
# podman-restart) is in gateway_units, once systemd has the user.
gateway_user() {
  log "user $GATEWAY_USER (the compose stack)"
  if ! id "$GATEWAY_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$GATEWAY_HOME" --shell /bin/bash \
      --comment "opencomputer gateway (compose)" "$GATEWAY_USER"
    install -d -m 0755 "$SELFHOST_ETC"
    echo "$GATEWAY_USER" > "$SELFHOST_ETC/gateway-user-created"
  fi
  GATEWAY_HOME="$(getent passwd "$GATEWAY_USER" | cut -d: -f6)"
  chmod 0750 "$GATEWAY_HOME"
  local g f
  for g in sudo admin adm lxd docker "$AGENT_USER" "$HOST_USER"; do gpasswd -d "$GATEWAY_USER" "$g" >/dev/null 2>&1 || true; done
  # A range of its own, above every other: sandbox.sh refuses an agent range that overlaps another user's.
  for f in /etc/subuid /etc/subgid; do
    touch "$f"
    if ! grep -qs "^$GATEWAY_USER:" "$f"; then
      local start; start="$(free_subids "$f")"
      echo "$GATEWAY_USER:$start:65536 in $f"
      printf '%s:%s:65536\n' "$GATEWAY_USER" "$start" >> "$f"
    fi
  done
  # Storage of its own. sandbox.sh's /etc/containers/storage.conf sets
  # rootless_storage_path to the agent's /data/containers/storage for every
  # rootless user; without this file the gateway user's Podman tries to use it
  # and fails (permission denied on .../libpod). A user's storage.conf replaces
  # the system one, so it names the driver too.
  local conf="$GATEWAY_HOME/.config/containers/storage.conf" group
  group="$(id -gn "$GATEWAY_USER")"
  if [[ ! -e $conf ]] || grep -qs '^# host-install.sh' "$conf"; then
    install -d -m 0700 -o "$GATEWAY_USER" -g "$group" "$GATEWAY_HOME/.config" "$GATEWAY_HOME/.config/containers"
    install -m 0644 -o "$GATEWAY_USER" -g "$group" /dev/stdin "$conf" <<EOF
# host-install.sh: rootless storage of $GATEWAY_USER, apart from the agent's.
[storage]
driver = "overlay"
graphroot = "$GATEWAY_HOME/.local/share/containers/storage"
EOF
  fi
  # Networks outside /var/lib. Podman 4.9's rootless network namespace mounts
  # an empty tmpfs over /var/lib (and re-binds only the overlay store), so with
  # the home there a compose network is created but "not found" when the
  # container starts. GATEWAY_NETWORKS is outside it.
  # Logs to files: with journald (the default) a system user's container logs
  # land in the system journal, which it cannot read, so `podman logs` is empty.
  conf="$GATEWAY_HOME/.config/containers/containers.conf"
  install -d -m 0700 -o "$GATEWAY_USER" -g "$group" "$GATEWAY_NETWORKS"
  if [[ ! -e $conf ]] || grep -qs '^# host-install.sh' "$conf"; then
    install -m 0644 -o "$GATEWAY_USER" -g "$group" /dev/stdin "$conf" <<EOF
# host-install.sh: networks of $GATEWAY_USER outside /var/lib (Podman 4.9 hides it from rootless networking); logs it can read.
[containers]
log_driver = "k8s-file"
log_size_max = 52428800

[network]
network_config_dir = "$GATEWAY_NETWORKS"
EOF
  fi
}

gateway_units() {
  log "lingering and podman-restart for $GATEWAY_USER"
  local uid
  uid="$(id -u "$GATEWAY_USER")"
  loginctl enable-linger "$GATEWAY_USER"
  systemctl start "user@$uid.service"
  # Ubuntu 24.04's podman-restart (Podman 4.9) starts only restart-policy=always
  # containers at boot, which is what compose.yaml uses.
  as_gateway systemctl --user enable -q podman-restart.service
  as_gateway systemctl --user is-enabled -q podman-restart.service || die "podman-restart.service is not enabled for $GATEWAY_USER"
}

# provision.sh "agent user", minus the data disk, the relay user and Docker.
agent_user() {
  log "$DATA and user $AGENT_USER (uid $AGENT_UID, no sudo)"
  mountpoint -q "$DATA" || install -d -m 0755 "$DATA"
  if getent group "$AGENT_USER" >/dev/null; then
    [[ "$(getent group "$AGENT_USER" | cut -d: -f3)" == "$AGENT_UID" ]] || die "group $AGENT_USER exists with a gid other than $AGENT_UID"
  else
    getent group "$AGENT_UID" >/dev/null && die "gid $AGENT_UID is taken by group $(getent group "$AGENT_UID" | cut -d: -f1)"
    groupadd --gid "$AGENT_UID" "$AGENT_USER"
  fi
  if id "$AGENT_USER" >/dev/null 2>&1; then
    [[ "$(id -u "$AGENT_USER")" == "$AGENT_UID" ]] || die "user $AGENT_USER exists with a uid other than $AGENT_UID"
    [[ "$(getent passwd "$AGENT_USER" | cut -d: -f6)" == "$AGENT_HOME" ]] || usermod --home "$AGENT_HOME" "$AGENT_USER"
  else
    getent passwd "$AGENT_UID" >/dev/null && die "uid $AGENT_UID is taken by user $(getent passwd "$AGENT_UID" | cut -d: -f1)"
    useradd --uid "$AGENT_UID" --gid "$AGENT_UID" --home-dir "$AGENT_HOME" --no-create-home \
      --shell /bin/bash --comment "slack-presence runners" "$AGENT_USER"
  fi
  local g
  for g in sudo admin adm lxd docker; do gpasswd -d "$AGENT_USER" "$g" >/dev/null 2>&1 || true; done
  install -d -m 0755 "$DATA/home"
  install -d -m 0750 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME" "$DATA/people"
  [[ -d $DATA/journals ]] || install -d -m 2770 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA/journals"
  [[ -d $DATA/state ]] || install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA/state"
  install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/.config" "$AGENT_HOME/.config/environment.d"
  install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/.calvin" "$AGENT_HOME/.calvin/codex"
}

# The release: provision.sh builds it from a clone of the repository; here it is
# the checkout's own commit, so a self-hosted computer runs exactly the code it
# was installed from. Built in a temporary directory and renamed, so a failed
# build never leaves a release that looks ready.
release() {
  log "release $SHA"
  install -d -m 0755 "$SP_ROOT" "$SP_RELEASES" "$ETC"
  echo computer > "$ETC/definition-name"
  if [[ ! -f $RELEASE/.sp-ready ]]; then
    local tmp="$RELEASE.tmp"
    rm -rf "$tmp" "$RELEASE"
    install -d -m 0755 "$tmp"
    rgit archive HEAD:computer | tar -x -C "$tmp"
    (cd "$tmp" && npm ci --no-audit --no-fund)
    (cd "$tmp" && node scripts/bundle-runner.mjs) || warn "runner bundle failed; runners start under tsx"
    (cd "$tmp/modelproxy" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 /usr/local/go/bin/go build \
       -trimpath -buildvcs=false -ldflags "-X main.version=$SHA" -o oc-modelproxy .)
    [[ -d $tmp/bin ]] && chmod 0755 "$tmp"/bin/*
    mv -T "$tmp" "$RELEASE"
    touch "$RELEASE/.sp-ready"
  fi
  # Rewritten on every run: the image is chosen per run (SP_IMAGE, --build-image), the code is not.
  printf 'SP_VERSION=%s\nSP_IMAGE=%s\nSP_IMAGE_ABI=%s\n' "$SHA" "$IMAGE" "$ABI" > "$RELEASE/.sp-version.env.tmp"
  mv -f "$RELEASE/.sp-version.env.tmp" "$RELEASE/.sp-version.env"
}

sandbox() {
  log "rootless Podman for $AGENT_USER"
  AGENT_USER="$AGENT_USER" AGENT_UID="$AGENT_UID" SP_DATA="$DATA" bash "$RELEASE/deploy/vm/sandbox.sh" install
  # As agent: sandbox.sh's /etc/containers/storage.conf sets no runroot, so root's podman fails ("runroot must be set").
  local pv; pv="$(as_agent podman --version 2>/dev/null | awk '{print $NF}')"
  podman_version_ok "$pv" || die "podman ${pv:-not found}: this needs Podman >= 4.7"
  if [[ $BUILD_IMAGE == 1 ]] && ! as_agent podman image exists "$IMAGE"; then
    log "building $IMAGE as $AGENT_USER (computer/deploy/image; 20 minutes or more)"
    local args=() line ctx
    ctx="$(mktemp -d)"; chmod 0755 "$ctx"
    rgit archive HEAD:computer/deploy/image | tar -x -C "$ctx"
    while IFS= read -r line; do
      case $line in ''|'#'*) continue ;; esac
      args+=(--build-arg "$line")
    done < "$ctx/versions.env"
    as_agent podman build --platform linux/amd64 "${args[@]}" -f "$ctx/Containerfile" -t "$IMAGE" "$ctx"
    rm -rf "$ctx"
  fi
  # Pulls unless present, then warms (the first keep-id container copies the image).
  AGENT_USER="$AGENT_USER" AGENT_UID="$AGENT_UID" bash "$RELEASE/deploy/vm/sandbox.sh" image "$IMAGE"
}

switch_current() {
  local previous r
  previous="$(readlink -f "$SP_CURRENT" 2>/dev/null || true)"
  if [[ -n $previous && $previous != "$RELEASE" && -d $previous ]]; then touch "$previous/.sp-superseded"; fi
  rm -f "$RELEASE/.sp-superseded"
  ln -sfn "$RELEASE" "$SP_CURRENT.tmp" && mv -T "$SP_CURRENT.tmp" "$SP_CURRENT"
  echo "current -> $RELEASE"
  # As provision.sh: releases superseded over 2 days ago that no process names.
  for r in "$SP_RELEASES"/*/; do
    r="${r%/}"
    [[ $r == "$RELEASE" ]] && continue
    [[ -f $r/.sp-superseded && -n "$(find "$r/.sp-superseded" -mtime +2)" ]] || continue
    if grep -qsF "$r" /proc/[0-9]*/cmdline /proc/[0-9]*/environ; then continue; fi
    echo "pruning release $r"; rm -rf "$r"
  done
  local keep=("$IMAGE") last prev_image
  last="$(find "$SP_RELEASES" -mindepth 2 -maxdepth 2 -name .sp-superseded -printf '%T@ %h\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  if [[ -n $last ]]; then
    prev_image="$(sed -n 's/^SP_IMAGE=//p' "$last/.sp-version.env" 2>/dev/null || true)"
    [[ -z $prev_image ]] || keep+=("$prev_image")
  fi
  AGENT_USER="$AGENT_USER" AGENT_UID="$AGENT_UID" bash "$SP_CURRENT/deploy/vm/sandbox.sh" prune-images "${keep[@]}"
}

# provision.sh "agent environment", without preview hosts and playwright.
agent_env() {
  log "environment for $AGENT_USER"
  cat > "$AGENT_HOME/.config/environment.d/10-slack-presence.conf" <<EOF
# Written by selfhost/host-install.sh; rewritten on every run.
PATH=$AGENT_PATH
SP_DATA=$DATA
SP_RUN=$SP_RUN
DISABLE_AUTOUPDATER=1
EOF
  chown "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.config/environment.d/10-slack-presence.conf"
  agent_git() { runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" git config --global "$@"; }
  agent_git --replace-all credential.https://github.com.helper ''
  agent_git --add credential.https://github.com.helper "$SP_CURRENT/bin/git-credential-slack-presence"
  agent_git credential.https://github.com.useHttpPath true
  agent_git init.defaultBranch main
  agent_git fetch.prune true
  agent_git push.autoSetupRemote true
}

units() {
  log "systemd units"
  AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" bash "$SP_CURRENT/deploy/vm/sp-host.sh" run-dirs
  install -m 0644 "$SP_CURRENT/deploy/vm/tmp.conf" /etc/tmpfiles.d/tmp.conf
  loginctl enable-linger "$AGENT_USER"
  install -d "$SYSTEMD/user@$AGENT_UID.service.d"
  cat > "$SYSTEMD/user@$AGENT_UID.service.d/10-slack-presence.conf" <<EOF
# Written by selfhost/host-install.sh.
[Unit]
RequiresMountsFor=$DATA

[Service]
Delegate=pids memory cpu io
EOF
  AGENT_UID="$AGENT_UID" bash "$SP_CURRENT/deploy/vm/limits.sh" install
  # shellcheck disable=SC2097,SC2098  # the same path either way: passed on, as provision.sh does
  AGENT_USER="$AGENT_USER" SP_CURRENT="$SP_CURRENT" bash "$SP_CURRENT/deploy/vm/modelproxy.sh" install \
    || die "oc-modelproxy did not install; no session can start without it"
  fill "$HERE/systemd/$UNIT" > "$SYSTEMD/$UNIT"
  fill "$HERE/systemd/slack-presence-imds-block.service" > "$SYSTEMD/slack-presence-imds-block.service"
  install -m 0644 "$HERE/systemd/opencomputer-imds-deny.service" "$SYSTEMD/opencomputer-imds-deny.service"
  systemctl daemon-reload
  systemctl enable -q slack-presence-imds-block.service opencomputer-imds-deny.service
  systemctl restart slack-presence-imds-block.service
  systemctl restart opencomputer-imds-deny.service || die "opencomputer-imds-deny.service failed: the metadata service would be open to every user"
  systemctl start "user@$AGENT_UID.service"
  as_agent systemctl --user daemon-reload || true
}

# The host as sp-host, its runners in containers: what a new fleet computer gets
# (sp-host.sh `new`), but required here: sp-host.sh falls back to the host as
# agent under systemd when `apply` fails, which a self-hosted computer must not run.
host_user() {
  log "host agent as $HOST_USER, sessions in Podman"
  local dropin="$SYSTEMD/$UNIT.d/20-sp-host.conf"
  install -d -m 0755 "$ETC"
  echo podman > "$ETC/sp-launch"
  if [[ ! -f $ETC/host-user-sp-host ]]; then
    AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" SP_DATA="$DATA" bash "$SP_CURRENT/deploy/vm/sp-host.sh" new
  fi
  AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" SP_DATA="$DATA" bash "$SP_CURRENT/deploy/vm/sp-host.sh" apply
  if ! grep -qx "User=$HOST_USER" "$dropin" 2>/dev/null || ! grep -qx 'Environment=SP_LAUNCH=podman' "$dropin"; then
    die "sp-host.sh did not set the host up as $HOST_USER with SP_LAUNCH=podman ($dropin)"
  fi
}

start_host() {
  install -d -m 0755 "$SELFHOST_ETC"
  install -m 0644 "$HERE/selfhost.env.example" "$SELFHOST_ETC/selfhost.env.example"
  systemctl enable -q "$UNIT"
  if [[ ! -f $SELFHOST_ENV ]]; then
    log "no $SELFHOST_ENV: host installed, not started"
    echo "Create it: sudo install -m 0600 $SELFHOST_ETC/selfhost.env.example $SELFHOST_ENV, fill it in, run this script again"
    return
  fi
  chown root:root "$SELFHOST_ENV"; chmod 0600 "$SELFHOST_ENV"
  if [[ -z "$(env_value SP_HOST_TOKEN)" ]]; then
    log "SP_HOST_TOKEN is empty in $SELFHOST_ENV: host installed, not started"
    return
  fi
  [[ "$(env_value SP_GATEWAY_URL)" =~ ^wss?://[^/]+/v1/computer/host\?organizationId=[A-Za-z0-9_-]+$ ]] \
    || die "SP_GATEWAY_URL in $SELFHOST_ENV must be ws://127.0.0.1:<GATEWAY_PORT>/v1/computer/host?organizationId=<GATEWAY_ORG> (sudo $0 --link-gateway writes it)"
  log "starting $UNIT"
  systemctl restart "$UNIT"
  sleep 3
  systemctl --no-pager --lines=15 status "$UNIT" || true
}

install_all() {
  preflight
  resolve_image
  if [[ $DRY_RUN == 1 ]]; then plan; exit 0; fi
  install_lock
  cd /
  packages
  node_js
  go_toolchain
  compose_tool
  agent_user
  gateway_user
  gateway_stack
  release
  sandbox
  switch_current
  agent_env
  units
  host_user
  gateway_units
  start_host
  offload_upgrade
  log "done: release $SHA, image $IMAGE, $(node --version), podman $(dpkg-query -W -f='${Version}' podman), podman-compose $PODMAN_COMPOSE_VERSION"
  echo "The compose stack is $GATEWAY_USER's, in $GATEWAY_HOME/selfhost: as $GATEWAY_USER, cp .env.example .env, fill it in, start it (docs/self-hosting/single-vm.mdx); then sudo $0 --link-gateway"
}

# --link-gateway: points the host at the gateway container that $GATEWAY_USER runs. As
# $GATEWAY_USER it reads the gateway's GATEWAY_ORG, GATEWAY_PORT and /data/host-token (the
# gateway writes it at every start), then writes SP_GATEWAY_URL, SP_HOST_ID and SP_HOST_TOKEN
# into selfhost.env (root 0600; its other lines are kept) and (re)starts the host. The token
# goes from `podman exec` into a variable and from there into the file: never printed, never
# on a command line. sp-host cannot read the file; systemd hands it the token (EnvironmentFile=).
link_gateway() {
  id "$GATEWAY_USER" >/dev/null 2>&1 || die "no user $GATEWAY_USER: run $0 first"
  systemctl cat "$UNIT" >/dev/null 2>&1 || die "$UNIT is not installed: run $0 first"
  GATEWAY_HOME="$(getent passwd "$GATEWAY_USER" | cut -d: -f6)"
  cd /   # runuser fails in a directory $GATEWAY_USER cannot enter, such as a checkout under /root
  local container="${GATEWAY_CONTAINER:-}" org port token tmp keep='^[[:space:]]*(SP_GATEWAY_URL|SP_HOST_ID|SP_HOST_TOKEN)='
  if [[ -z $container ]]; then
    container="$(as_gateway podman ps --filter label=com.docker.compose.service=gateway --format '{{.Names}}')" \
      || die "podman ps as $GATEWAY_USER failed"
    [[ -n $container ]] || die "$GATEWAY_USER runs no gateway container: start the compose stack first (podman compose up -d)"
    [[ $container != *$'\n'* ]] || die "$GATEWAY_USER runs more than one gateway container ($(echo $container)): name one with GATEWAY_CONTAINER="
  fi
  as_gateway podman container exists "$container" || die "$GATEWAY_USER has no container $container"
  org="$(as_gateway podman exec "$container" printenv GATEWAY_ORG)" || die "$container has no GATEWAY_ORG (a gateway older than selfhost/gateway?)"
  port="$(as_gateway podman exec "$container" printenv GATEWAY_PORT)" || port=8080
  [[ $org =~ ^[A-Za-z0-9_-]+$ ]] || die "$container's GATEWAY_ORG is not a plain id: $org"
  [[ $port =~ ^[0-9]+$ ]] || die "$container's GATEWAY_PORT is not a port: $port"
  token="$(as_gateway podman exec "$container" cat /data/host-token)" || die "cannot read /data/host-token in $container"
  [[ $token =~ ^sph_[A-Za-z0-9_-]+$ ]] || die "/data/host-token in $container is not an sph_ token (not printed)"
  install -d -m 0755 "$SELFHOST_ETC"
  tmp="$(mktemp "$SELFHOST_ETC/.selfhost.env.XXXXXX")"   # 0600
  grep -Ev "$keep" "$( [[ -f $SELFHOST_ENV ]] && echo "$SELFHOST_ENV" || echo "$HERE/selfhost.env.example" )" >"$tmp" || true
  printf 'SP_GATEWAY_URL=ws://127.0.0.1:%s/v1/computer/host?organizationId=%s\nSP_HOST_ID=%s\nSP_HOST_TOKEN=%s\n' \
    "$port" "$org" "$org" "$token" >>"$tmp"
  unset token
  chown root:root "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$SELFHOST_ENV"
  log "$SELFHOST_ENV: SP_GATEWAY_URL=ws://127.0.0.1:$port/v1/computer/host?organizationId=$org, SP_HOST_ID=$org, SP_HOST_TOKEN from $container:/data/host-token (not printed)"
  start_host
}

# ------------------------------------------------------------------ build offload (AWS only)
# work/136 section 3. Everything below exists only on a host where
# --enable-offload passed detection (an EC2 instance with a role) and wrote
# $OFFLOAD_MARKER. A plain install or upgrade never adds it: with the marker it
# re-checks detection, without it SP_OFFLOAD* lines only get a warning. The
# service itself is computer/src/offload/main.ts (serve, check-aws, reap,
# drain, health), run from the release as $OFFLOAD_USER.

install_lock() {
  install -d -m 0755 "$(dirname "$LOCK")"
  exec 9>"$LOCK"
  flock -w 3600 9 || die "another host-install.sh held the lock for an hour"
}

# offload_detect: selfhost/lib/aws-detect.sh; sets OFFLOAD_LINE, returns its code (0 aws, 1 not, 2 no role).
offload_detect() {
  # shellcheck source=selfhost/lib/aws-detect.sh
  source "$HERE/lib/aws-detect.sh"
  local rc=0
  OFFLOAD_LINE="$(aws_detect)" || rc=$?
  return "$rc"
}

# offload_refusal <code>: why --enable-offload will not go on, for the operator.
offload_refusal() {
  case $1 in
    2) echo "this EC2 instance has no role: attach an instance profile (the offload stack's InstanceProfileArn output), then re-run" ;;
    *) echo "build offload is AWS-only, and this host is not an EC2 instance with a role (${OFFLOAD_LINE#not-aws: })" ;;
  esac
}

# offload_env_changes: the KEY=VALUE lines --enable-offload writes, into OFFLOAD_SET.
# A flag replaces the key's value; without a flag a key is written only if missing.
offload_env_changes() {   # <detected region>
  OFFLOAD_SET=()
  local key want
  [[ "$(env_value SP_OFFLOAD_BACKEND)" == aws-microvm ]] || OFFLOAD_SET+=("SP_OFFLOAD_BACKEND=aws-microvm")
  for key in BUCKET REGION IMAGE_S IMAGE_M; do
    case $key in
      BUCKET) want="$OFFLOAD_BUCKET" ;;
      REGION) want="${OFFLOAD_REGION:-$( [[ -n "$(env_value SP_OFFLOAD_REGION)" ]] || echo "$1")}" ;;
      IMAGE_S) want="$OFFLOAD_IMAGE_S" ;;
      IMAGE_M) want="$OFFLOAD_IMAGE_M" ;;
    esac
    [[ -z $want || "$(env_value "SP_OFFLOAD_$key")" == "$want" ]] || OFFLOAD_SET+=("SP_OFFLOAD_$key=$want")
  done
  [[ -n "$(env_value SP_OFFLOAD_CONTROL)" ]] || OFFLOAD_SET+=("SP_OFFLOAD_CONTROL=/run/opencomputer-offload/control.sock")
  [[ -n $OFFLOAD_BUCKET || -n "$(env_value SP_OFFLOAD_BUCKET)" ]] \
    || die "--bucket is required: the offload stack's bucket (CloudFormation output BucketName)"
  for key in IMAGE_S IMAGE_M; do
    local flag="--${key,,}"; flag="${flag/_/-}"
    if [[ -z "$(env_value "SP_OFFLOAD_$key")" && ! " ${OFFLOAD_SET[*]} " == *" SP_OFFLOAD_$key="* ]]; then
      warn "no SP_OFFLOAD_$key: give $flag (selfhost/aws/build-offload-image.sh prints it); the service is not ready without it"
    fi
  done
}

# env_rewrite <grep -E pattern to drop> [KEY=VALUE...]: selfhost.env without the
# matching lines, plus the given ones; root 0600, replaced in one rename.
env_rewrite() {
  local drop="$1" tmp; shift
  install -d -m 0755 "$SELFHOST_ETC"
  tmp="$(mktemp "$SELFHOST_ETC/.selfhost.env.XXXXXX")"
  grep -Ev "$drop" "$SELFHOST_ENV" >"$tmp" 2>/dev/null || true
  [[ $# == 0 ]] || printf '%s\n' "$@" >>"$tmp"
  chown root:root "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$SELFHOST_ENV"
}

offload_units_install() {
  local u
  for u in "${OFFLOAD_UNITS[@]}"; do fill "$HERE/systemd/$u" > "$SYSTEMD/$u"; done
  systemctl daemon-reload
}

# offload_start: (re)start the exception, the service and the timer. The
# exception must hold (it is the only way oc-offload gets credentials); the
# service may fail its check-aws and stay down, which is fail-closed.
offload_start() {
  systemctl enable -q opencomputer-offload-imds.service opencomputer-offload.service opencomputer-offload-reap.timer
  systemctl restart opencomputer-offload-imds.service \
    || die "opencomputer-offload-imds.service failed (is opencomputer-imds-deny.service active?)"
  systemctl restart opencomputer-offload-reap.timer || warn "opencomputer-offload-reap.timer did not start"
  if ! systemctl restart opencomputer-offload.service; then
    warn "opencomputer-offload.service did not start: sudo journalctl -u opencomputer-offload"
  fi
}

# One line for plan(): what an install would do about offload. Detects only
# where offload is enabled; an ordinary host makes no request.
offload_plan_line() {
  if [[ -f $OFFLOAD_MARKER ]]; then
    local rc=0; offload_detect || rc=$?
    case $rc in
      0) echo "enabled; $OFFLOAD_LINE; units re-templated and restarted" ;;
      2) echo "enabled, but $OFFLOAD_LINE: units kept, the service stays down until a role is attached" ;;
      *) echo "enabled, but $OFFLOAD_LINE: the units would be stopped (run --disable-offload)" ;;
    esac
  elif grep -Eq "$OFFLOAD_KEYS" "$SELFHOST_ENV" 2>/dev/null; then
    echo "off. WARNING: $SELFHOST_ENV has SP_OFFLOAD* lines; they are ignored without --enable-offload"
  else
    echo "off (sudo $0 --enable-offload on an EC2 instance with a role)"
  fi
}

# After a normal install or upgrade.
offload_upgrade() {
  if [[ ! -f $OFFLOAD_MARKER ]]; then
    if grep -Eq "$OFFLOAD_KEYS" "$SELFHOST_ENV" 2>/dev/null; then
      warn "$SELFHOST_ENV has SP_OFFLOAD* lines, but build offload is not enabled here: they are ignored. Remove them, or run sudo $0 --enable-offload on EC2"
    fi
    return 0
  fi
  log "build offload (enabled here)"
  local rc=0; offload_detect || rc=$?
  echo "detection: $OFFLOAD_LINE"
  [[ -f $SP_CURRENT/src/offload/main.ts ]] || warn "this release has no src/offload/main.ts; opencomputer-offload will not start"
  case $rc in
    0) offload_units_install; offload_start ;;
    2) warn "build offload is enabled but this instance has no role; the service stays down until one is attached (the reaper keeps trying)"
       offload_units_install; offload_start ;;
    *) warn "build offload was enabled but this host is no longer an EC2 instance with a role (${OFFLOAD_LINE#not-aws: }); stopping it. Run sudo $0 --disable-offload"
       systemctl stop opencomputer-offload-reap.timer opencomputer-offload.service opencomputer-offload-imds.service 2>/dev/null || true ;;
  esac
}

# --enable-offload: on an EC2 instance with a role, after a normal install.
enable_offload() {
  log "build offload: enable$( [[ $DRY_RUN == 1 ]] && echo ' (dry run: nothing changes)' )"
  if [[ ! -f $SELFHOST_ENV ]]; then
    [[ $DRY_RUN == 1 ]] || die "no $SELFHOST_ENV: install the host first ($0), then enable offload"
    warn "no $SELFHOST_ENV yet: install the host first"
  fi
  if [[ $DRY_RUN == 0 ]]; then
    systemctl cat "$UNIT" >/dev/null 2>&1 || die "$UNIT is not installed: run $0 first"
    id "$HOST_USER" >/dev/null 2>&1 || die "no user $HOST_USER: run $0 first"
  fi
  if [[ ! -f $SP_CURRENT/src/offload/main.ts ]]; then
    [[ $DRY_RUN == 1 ]] || die "the installed release has no src/offload/main.ts: update with $0 from a checkout that has build offload, then re-run"
    warn "the installed release has no src/offload/main.ts: enabling would refuse until it does"
  fi

  local rc=0 region
  offload_detect || rc=$?
  echo "detection: $OFFLOAD_LINE"
  (( rc == 0 )) || die "$(offload_refusal "$rc"). Nothing was changed."
  read -r _ region _ <<<"$OFFLOAD_LINE"
  offload_env_changes "$region"

  if [[ $DRY_RUN == 1 ]]; then
    cat <<EOF

Plan (nothing below has run):
  1. user $OFFLOAD_USER (system, no home, nologin, in no group but its own)
  2. $SELFHOST_ENV: $( ((${#OFFLOAD_SET[@]})) && echo "${OFFLOAD_SET[*]}" || echo "SP_OFFLOAD* lines already set" )
  3. units: ${OFFLOAD_UNITS[*]} (from selfhost/systemd)
  4. marker $OFFLOAD_MARKER
  5. start: opencomputer-offload-imds.service (oc-offload may reach the metadata service), opencomputer-offload.service, opencomputer-offload-reap.timer
  6. restart $UNIT (if running), so sessions get offload through SP_OFFLOAD_CONTROL
EOF
    exit 0
  fi

  install_lock
  if ! id "$OFFLOAD_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$OFFLOAD_USER"
  fi
  id -nG "$OFFLOAD_USER" | grep -qwE "$AGENT_USER|$HOST_USER" \
    && die "$OFFLOAD_USER is in group $AGENT_USER or $HOST_USER; it must hold the role's credentials alone"
  if ((${#OFFLOAD_SET[@]})); then
    local kv drop='^$'
    for kv in "${OFFLOAD_SET[@]}"; do drop+="|^[[:space:]]*${kv%%=*}="; done
    env_rewrite "$drop" "${OFFLOAD_SET[@]}"
    echo "$SELFHOST_ENV: ${OFFLOAD_SET[*]}"
  fi
  offload_units_install
  rm -f "$OFFLOAD_DRAINING"
  printf 'enabled %s by host-install.sh: %s\n' "$(date -u +%FT%TZ)" "$OFFLOAD_LINE" >"$OFFLOAD_MARKER"
  chmod 0644 "$OFFLOAD_MARKER"
  offload_start
  # The host relays builds to the service only while SP_OFFLOAD_CONTROL is in its environment.
  systemctl try-restart "$UNIT" || warn "$UNIT did not restart; sessions get offload after: sudo systemctl restart $UNIT"
  sleep 3
  systemctl --no-pager --lines=10 status opencomputer-offload.service || true
  log "build offload enabled ($OFFLOAD_LINE)"
  echo "The service builds its MicroVM images on first start; it advertises offload to the gateway once ready."
  echo "Follow it with: sudo journalctl -fu opencomputer-offload"
}

# --disable-offload, and the first step of --uninstall: drain while the role
# still works, then remove everything offload installed. Removal never depends
# on AWS answering. The ledger is kept: on a host that lost its role, it is the
# only record of what may still run.
disable_offload() {
  local u present=0 drained=1 kept=""
  [[ -f $OFFLOAD_MARKER ]] && present=1
  for u in "${OFFLOAD_UNITS[@]}"; do [[ ! -f $SYSTEMD/$u ]] || present=1; done
  id "$OFFLOAD_USER" >/dev/null 2>&1 && present=1
  grep -Eq "$OFFLOAD_KEYS" "$SELFHOST_ENV" 2>/dev/null && present=1
  if [[ $present == 0 ]]; then
    [[ $MODE != disable-offload ]] || echo "build offload is not enabled here; nothing to do"
    return 0
  fi
  log "build offload: disable$( [[ $DRY_RUN == 1 ]] && echo ' (dry run: nothing changes)' )"

  # 1. Drain: new submits refused, then `main.ts drain` as oc-offload, with the
  # service's environment (systemd reads selfhost.env; nothing on a command line).
  if [[ -f $SYSTEMD/opencomputer-offload.service ]] && id "$OFFLOAD_USER" >/dev/null 2>&1 \
     && [[ -f $SP_CURRENT/src/offload/main.ts ]]; then
    run install -m 0644 /dev/null "$OFFLOAD_DRAINING"
    if ! run timeout 180 systemd-run --quiet --wait --pipe --collect --unit=opencomputer-offload-drain \
         -p User="$OFFLOAD_USER" -p Group="$OFFLOAD_USER" -p EnvironmentFile="$SELFHOST_ENV" \
         -p Environment=AWS_EC2_METADATA_V1_DISABLED=true -p Environment=PATH=/usr/local/bin:/usr/bin:/bin \
         -p WorkingDirectory="$SP_CURRENT" -p StateDirectory=opencomputer-offload \
         "$SP_CURRENT/node_modules/.bin/tsx" src/offload/main.ts drain --timeout 120; then
      drained=0
      warn "drain failed (no role, no network, or the service's code is missing); removing offload anyway"
    fi
  else
    echo "no offload service to drain"
  fi

  # 2. Units, then the exception by user and by uid (in case the unit is already gone).
  for u in "${OFFLOAD_UNITS[@]}"; do
    [[ ! -f $SYSTEMD/$u ]] || run systemctl disable --now "$u" 2>/dev/null || true
  done
  local uid; uid="$(id -u "$OFFLOAD_USER" 2>/dev/null || true)"
  if command -v iptables >/dev/null && iptables -S OC-IMDS >/dev/null 2>&1; then
    local who
    for who in "$OFFLOAD_USER" $uid; do
      while iptables -C OC-IMDS -m owner --uid-owner "$who" -j RETURN 2>/dev/null; do
        run iptables -D OC-IMDS -m owner --uid-owner "$who" -j RETURN || break
        [[ $DRY_RUN == 0 ]] || break
      done
    done
  fi
  for u in "${OFFLOAD_UNITS[@]}"; do run rm -f "$SYSTEMD/$u"; done
  [[ $DRY_RUN == 1 ]] || systemctl daemon-reload || warn "systemctl daemon-reload failed; continuing"

  # 3. The ledger, root-only, until --purge.
  if [[ -d $OFFLOAD_STATE ]] && [[ -n "$(ls -A "$OFFLOAD_STATE" 2>/dev/null)" ]]; then
    kept="$OFFLOAD_KEEP/offload-ledger-$(date -u +%Y%m%dT%H%M%SZ)"
    run install -d -m 0700 "$OFFLOAD_KEEP" "$kept"
    run cp -a "$OFFLOAD_STATE/." "$kept/"
    run chown -R root:root "$kept"
  fi
  run rm -rf "$OFFLOAD_STATE"

  # 4. Settings, markers, user.
  if grep -Eq "$OFFLOAD_KEYS" "$SELFHOST_ENV" 2>/dev/null; then
    if [[ $DRY_RUN == 1 ]]; then echo "would: remove the SP_OFFLOAD* lines from $SELFHOST_ENV"
    else env_rewrite "$OFFLOAD_KEYS"; echo "removed the SP_OFFLOAD* lines from $SELFHOST_ENV"; fi
  fi
  run rm -f "$OFFLOAD_MARKER" "$OFFLOAD_DRAINING"
  # The host drops its offload relay once SP_OFFLOAD_CONTROL is gone from its environment.
  if [[ $MODE == disable-offload ]]; then run systemctl try-restart "$UNIT" || warn "$UNIT did not restart: sudo systemctl restart $UNIT"; fi
  if id "$OFFLOAD_USER" >/dev/null 2>&1; then run userdel "$OFFLOAD_USER" || warn "userdel $OFFLOAD_USER failed; remove it by hand"; fi
  if getent group "$OFFLOAD_USER" >/dev/null 2>&1; then run groupdel "$OFFLOAD_USER" || true; fi

  if [[ $drained == 0 ]]; then
    warn "MicroVMs this host started may still run until their maximum duration (at most about 8 h). Stop them from the AWS console or CLI on another machine${kept:+; the ledger ($kept) lists them}"
  fi
  [[ -z $kept ]] || echo "kept: the offload ledger in $kept (root only); --uninstall --purge removes it"
  echo "In AWS: the offload CloudFormation stack and its bucket are still there. Empty the bucket (it is retained), then delete the stack."
}

# ------------------------------------------------------------------ uninstall
# Stops and removes what install wrote. Keeps packages, Node and Go (shared
# with whatever else the machine runs), and the operator's selfhost.env and
# /data unless --purge.
uninstall() {
  log "uninstall$( [[ $PURGE == 1 ]] && echo ' --purge' )"
  [[ $DRY_RUN == 0 ]] || echo "(dry run: nothing changes)"
  disable_offload

  local units=("$UNIT" slack-presence-imds-block.service opencomputer-imds-deny.service sp-host-imds-block.service
               oc-modelproxy.service oc-modelproxy-api.socket oc-modelproxy-control.socket slack-presence-limits.service)
  local u
  for u in "${units[@]}"; do
    systemctl list-unit-files "$u" >/dev/null 2>&1 && run systemctl disable --now "$u" 2>/dev/null || true
  done
  # Session containers: stopped, so nothing runs without its host. Removed with --purge.
  if id "$AGENT_USER" >/dev/null 2>&1 && [[ -S /run/user/$AGENT_UID/bus ]]; then
    run as_agent podman stop --all --time 10 >/dev/null 2>&1 || true
    [[ $PURGE == 0 ]] || run as_agent podman system reset --force || true
  fi
  # The metadata rules, by uid.
  local uid table rule
  for uid in "$AGENT_UID" "$(id -u "$HOST_USER" 2>/dev/null)" "$(id -u modelproxy 2>/dev/null)"; do
    [[ -n $uid ]] || continue
    for table in iptables ip6tables; do
      command -v "$table" >/dev/null || continue
      while read -r rule; do
        [[ -n $rule ]] || continue
        # shellcheck disable=SC2086  # a rule is a list of words
        run "$table" ${rule/-A OUTPUT/-D OUTPUT} || break
      done < <("$table" -S OUTPUT 2>/dev/null | grep -- "--uid-owner $uid " || true)
    done
  done
  imds_deny_remove
  run rm -rf "$SYSTEMD/$UNIT" "$SYSTEMD/$UNIT.d" "$SYSTEMD/slack-presence-imds-block.service" \
    "$SYSTEMD/opencomputer-imds-deny.service" \
    "$SYSTEMD/sp-host-imds-block.service" "$SYSTEMD"/oc-modelproxy.service "$SYSTEMD"/oc-modelproxy-api.socket \
    "$SYSTEMD"/oc-modelproxy-control.socket "$SYSTEMD/slack-presence-limits.service" \
    "$SYSTEMD/user@$AGENT_UID.service.d/10-slack-presence.conf" "$SYSTEMD/user-$AGENT_UID.slice.d/10-slack-presence.conf" \
    /etc/systemd/user/slack-presence-runners.slice /usr/local/sbin/slack-presence-limits \
    /etc/sudoers.d/50-sp-host /etc/tmpfiles.d/slack-presence.conf /etc/tmpfiles.d/oc-modelproxy.conf \
    /etc/tmpfiles.d/tmp.conf /usr/local/libexec/oc-modelproxy /etc/oc-modelproxy "$ETC" \
    "$SP_ROOT" "$SP_RUN" /run/oc-modelproxy /usr/local/etc/slack-presence-sandbox \
    "$SELFHOST_ETC/selfhost.env.example"
  [[ $DRY_RUN == 1 ]] || systemctl daemon-reload || warn "systemctl daemon-reload failed; continuing"
  if [[ $PURGE == 1 ]]; then
    id "$AGENT_USER" >/dev/null 2>&1 && run loginctl disable-linger "$AGENT_USER" || true
    systemctl is-active -q "user@$AGENT_UID.service" 2>/dev/null && run systemctl stop "user@$AGENT_UID.service" || true
    local d
    for d in people home/"$AGENT_USER" containers state journals; do run rm -rf "${DATA:?}/$d"; done
    run rm -rf "$SELFHOST_ENV" /var/lib/sp-host "$OFFLOAD_KEEP"/offload-ledger-*
    for u in "$HOST_USER" modelproxy "$AGENT_USER"; do
      id "$u" >/dev/null 2>&1 && run userdel "$u"
      getent group "$u" >/dev/null && run groupdel "$u"
    done
    run sed -i "/^$AGENT_USER:/d" /etc/subuid /etc/subgid
    purge_gateway
    run rm -rf "$COMPOSE_VENV" /usr/local/bin/podman-compose
    echo "kept: apt packages (podman, ...), Node.js in /usr/local, Go in /usr/local/go, $DATA itself"
  else
    echo "kept: users $AGENT_USER, $HOST_USER, modelproxy; $DATA (sessions, workspaces, images); $SELFHOST_ENV;"
    echo "      user $GATEWAY_USER with the compose stack, still running, and podman-compose. --purge removes them"
  fi
}

# opencomputer-imds-deny.service's rules: every jump from OUTPUT to OC-IMDS, then the chain.
imds_deny_remove() {
  local table addr
  for table in iptables ip6tables; do
    command -v "$table" >/dev/null || continue
    "$table" -S OC-IMDS >/dev/null 2>&1 || continue
    for addr in 169.254.169.254 fd00:ec2::254 fd20:ce::254; do
      case $table:$addr in iptables:*:*|ip6tables:*.*) continue ;; esac
      while "$table" -C OUTPUT -d "$addr" -j OC-IMDS 2>/dev/null; do
        run "$table" -D OUTPUT -d "$addr" -j OC-IMDS || break
        [[ $DRY_RUN == 0 ]] || break
      done
    done
    run "$table" -F OC-IMDS
    run "$table" -X OC-IMDS || warn "$table: chain OC-IMDS is still referenced; remove it by hand"
  done
}

# --purge: the compose stack's user, with the stack's containers and volumes
# (the gateway's database), only if this script made the user; an operator's
# own account keeps everything.
purge_gateway() {
  id "$GATEWAY_USER" >/dev/null 2>&1 || return 0
  if [[ "$(cat "$SELFHOST_ETC/gateway-user-created" 2>/dev/null)" != "$GATEWAY_USER" ]]; then
    echo "kept: user $GATEWAY_USER (not made by this script) and its containers"
    return 0
  fi
  local uid; uid="$(id -u "$GATEWAY_USER")"
  if [[ -S /run/user/$uid/bus ]]; then run as_gateway podman system reset --force || true; fi
  run loginctl disable-linger "$GATEWAY_USER" || true
  if systemctl is-active -q "user@$uid.service" 2>/dev/null; then run systemctl stop "user@$uid.service" || true; fi
  run userdel --remove "$GATEWAY_USER" || warn "userdel $GATEWAY_USER failed; remove it by hand"
  getent group "$GATEWAY_USER" >/dev/null && run groupdel "$GATEWAY_USER"
  run sed -i "/^$GATEWAY_USER:/d" /etc/subuid /etc/subgid
  run rm -f "$SELFHOST_ETC/gateway-user-created"
  run rm -rf "$GATEWAY_NETWORKS"
}

case $MODE in
  install) install_all ;;
  uninstall) uninstall ;;
  link) link_gateway ;;
  enable-offload) enable_offload ;;
  disable-offload) disable_offload ;;
esac
