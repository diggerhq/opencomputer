#!/usr/bin/env bash
# The host side of a self-hosted computer: one VM that runs the gateway
# container (compose.yaml, not this script) and the host agent with its
# sessions in rootless Podman (this script). Carved from
# computer/deploy/vm/provision.sh, the fleet's provisioner, without anything
# that only the fleet needs: no cloud detection or metadata service, no data
# disk discovery, no self-update timer, no Docker, no previews (cloudflared),
# no client relay, no operator CLIs (Claude Code, gh, codex, playwright).
# The contract with the gateway container is selfhost/CONTRACT.md.
#
#   sudo selfhost/host-install.sh [--build-image]   install, or update to this checkout
#   sudo selfhost/host-install.sh --dry-run         check this machine and print the plan; changes nothing
#   sudo selfhost/host-install.sh --uninstall [--purge]
#                                                   stop and remove the services; --purge also
#                                                   the users, their data under /data and the images
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
#     oc-modelproxy (socket-activated), the metadata block, cgroup limits
#   - for the gateway's compose stack (selfhost/compose.yaml, not started here):
#     podman-compose in /opt/podman-compose (Ubuntu's 1.0.6 ignores compose
#     profiles) and user oc-gateway (rootless Podman, lingering,
#     podman-restart.service), so the stack runs apart from the sessions and
#     comes back after a reboot
#
# Inputs (environment):
#   SP_IMAGE        a session image to run instead of the one this checkout names,
#                   ghcr.io/diggerhq/computer-session@sha256:<digest> or :<tag>
#   ALLOW_UNVERIFIED_IMAGE  1: when the image's digest cannot be verified (no gh
#                   with a token here), run the tag CI pushed for this tree
#                   anyway. Anyone who can push a branch to the repository can
#                   move a tag; the digest check is what rules that out.
#   GO_SERIES       Go series for oc-modelproxy (default 1.27, as its go.mod)
#   GATEWAY_USER    the user that runs the compose stack (default oc-gateway, made
#                   here); an existing login user works too. Never agent, sp-host
#                   or root: sessions run tools as agent with no prompts, and the
#                   gateway holds every secret
#   PODMAN_COMPOSE_VERSION  podman-compose from PyPI (default 1.6.0; >= 1.1.0)
#   NODE_MAJOR      Node.js major (default 24)
#
# /etc/opencomputer/selfhost.env (selfhost/selfhost.env.example) is the
# operator's: this script never writes it. Without a token in it the host is
# installed but not started.
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
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --build-image) BUILD_IMAGE=1 ;;
    --uninstall) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $arg" >&2; usage 2 ;;
  esac
done
[[ $PURGE == 0 || $MODE == uninstall ]] || die "--purge goes with --uninstall"

AGENT_USER=agent
AGENT_UID=1500            # fixed: the session image and podman-args.ts assume 1500
HOST_USER=sp-host
DATA=/data
AGENT_HOME="$DATA/home/$AGENT_USER"
SP_ROOT=/opt/slack-presence
SP_RELEASES="$SP_ROOT/releases"
SP_CURRENT="$SP_ROOT/current"
SP_RUN=/run/slack-presence
ETC=/etc/slack-presence
SELFHOST_ETC=/etc/opencomputer
SELFHOST_ENV="$SELFHOST_ETC/selfhost.env"
REPOSITORY=ghcr.io/diggerhq/computer-session
GO_SERIES="${GO_SERIES:-1.27}"
NODE_MAJOR="${NODE_MAJOR:-24}"
GATEWAY_USER="${GATEWAY_USER:-oc-gateway}"
GATEWAY_HOME_DEFAULT=/var/lib/oc-gateway
PODMAN_COMPOSE_VERSION="${PODMAN_COMPOSE_VERSION:-1.6.0}"
PODMAN_COMPOSE_MIN=1.1.0
COMPOSE_VENV=/opt/podman-compose
UNIT=slack-presence-host.service
SYSTEMD=/etc/systemd/system
AGENT_PATH="$SP_CURRENT/bin:/usr/local/go/bin:$AGENT_HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

[[ $EUID -eq 0 || $DRY_RUN == 1 ]] || die "run as root (sudo $0 $*)"

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
      -e "s|@SELFHOST_ENV@|$SELFHOST_ENV|g" "$1"
}

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

podman_version_ok() {   # <version>: >= 4.4 (--userns=keep-id:uid=,gid= and pasta)
  local maj min
  IFS=. read -r maj min _ <<<"${1%%[-+~]*}"
  [[ $maj =~ ^[0-9]+$ && $min =~ ^[0-9]+$ ]] && (( maj > 4 || (maj == 4 && min >= 4) ))
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
        die "Ubuntu 22.04: apt offers podman '${cand:-none}' and no passt; sessions need Podman >= 4.4 with pasta. Use Ubuntu 24.04"
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
     user $GATEWAY_USER for the compose stack (home $GATEWAY_HOME, subuid/subgid, no sudo)
  4. release $RELEASE from $REPO_ROOT (git archive HEAD:computer, npm ci, runner bundle, oc-modelproxy build)
  5. rootless Podman for $AGENT_USER (computer/deploy/vm/sandbox.sh install): podman crun passt uidmap slirp4netns,
     /etc/subuid and /etc/subgid, lingering, storage $DATA/containers/storage
  6. session image $IMAGE
     ($IMAGE_HOW), ABI $ABI: $( [[ $BUILD_IMAGE == 1 ]] && echo "podman build as $AGENT_USER, then warmed" || echo "pulled and warmed" )
  7. $SP_CURRENT -> $RELEASE; old releases and images pruned
  8. systemd: run dirs, /tmp ageing, user@$AGENT_UID drop-in, cgroup limits (limits.sh), oc-modelproxy (modelproxy.sh),
     slack-presence-imds-block.service, $UNIT (EnvironmentFile=$SELFHOST_ENV)
  9. user $HOST_USER, sudoers, SP_LAUNCH=podman (computer/deploy/vm/sp-host.sh new + apply)
     $GATEWAY_USER: lingering, podman-restart.service (restart policies always and unless-stopped) enabled
 10. $( [[ -n "$(env_value SP_HOST_TOKEN)" ]] && echo "start $UNIT ($SELFHOST_ENV has a token)" || echo "$UNIT installed, NOT started: $SELFHOST_ENV has no SP_HOST_TOKEN yet" )
Not installed: Docker, cloudflared, Claude Code CLI, gh, codex, playwright, a self-update timer.
Not started: the compose stack (selfhost/compose.yaml, as $GATEWAY_USER).
EOF
}

# ------------------------------------------------------------------ install steps
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
}

gateway_units() {
  log "lingering and podman-restart for $GATEWAY_USER"
  local uid podman dir
  uid="$(id -u "$GATEWAY_USER")"
  podman="$(command -v podman)"
  loginctl enable-linger "$GATEWAY_USER"
  systemctl start "user@$uid.service"
  # Ubuntu 24.04's podman-restart (Podman 4.9) starts only restart-policy=always;
  # compose's `unless-stopped` needs the second filter (same-key filters are ORed).
  dir="$GATEWAY_HOME/.config/systemd/user/podman-restart.service.d"
  install -d -m 0755 -o "$GATEWAY_USER" -g "$(id -gn "$GATEWAY_USER")" \
    "$GATEWAY_HOME/.config" "$GATEWAY_HOME/.config/systemd" "$GATEWAY_HOME/.config/systemd/user" "$dir"
  cat > "$dir/10-unless-stopped.conf" <<EOF
# Written by selfhost/host-install.sh: start containers with restart policy
# unless-stopped at boot too, not only always.
[Service]
ExecStart=
ExecStart=$podman \$LOGGING start --all --filter restart-policy=always --filter restart-policy=unless-stopped
ExecStop=
ExecStop=/bin/sh -c '$podman \$LOGGING stop \$($podman container ls --filter restart-policy=always --filter restart-policy=unless-stopped -q)'
EOF
  chown "$GATEWAY_USER:$(id -gn "$GATEWAY_USER")" "$dir/10-unless-stopped.conf"
  as_gateway systemctl --user daemon-reload
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
  systemctl daemon-reload
  systemctl enable -q slack-presence-imds-block.service
  systemctl restart slack-presence-imds-block.service
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
  [[ "$(env_value SP_GATEWAY_URL)" == ws://* || "$(env_value SP_GATEWAY_URL)" == wss://* ]] \
    || die "SP_GATEWAY_URL in $SELFHOST_ENV must be ws://.../host or wss://.../host"
  log "starting $UNIT"
  systemctl restart "$UNIT"
  sleep 3
  systemctl --no-pager --lines=15 status "$UNIT" || true
}

install_all() {
  preflight
  resolve_image
  if [[ $DRY_RUN == 1 ]]; then plan; exit 0; fi
  exec 9>/run/opencomputer-host-install.lock
  flock -w 3600 9 || die "another host-install.sh held the lock for an hour"
  cd /
  packages
  node_js
  go_toolchain
  compose_tool
  agent_user
  gateway_user
  release
  sandbox
  switch_current
  agent_env
  units
  host_user
  gateway_units
  start_host
  log "done: release $SHA, image $IMAGE, $(node --version), podman $(podman --version | awk '{print $3}'), podman-compose $PODMAN_COMPOSE_VERSION"
  echo "The compose stack is $GATEWAY_USER's: copy selfhost/ where $GATEWAY_USER can read it, then as $GATEWAY_USER: podman compose up -d (selfhost/CONTRACT.md)"
}

# ------------------------------------------------------------------ uninstall
# Stops and removes what install wrote. Keeps packages, Node and Go (shared
# with whatever else the machine runs), and the operator's selfhost.env and
# /data unless --purge.
uninstall() {
  log "uninstall$( [[ $PURGE == 1 ]] && echo ' --purge' )"
  local say=echo
  [[ $DRY_RUN == 1 ]] && { say="echo would:"; echo "(dry run: nothing changes)"; }
  run() { $say "$*"; [[ $DRY_RUN == 1 ]] || "$@"; }

  local units=("$UNIT" slack-presence-imds-block.service sp-host-imds-block.service
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
  run rm -rf "$SYSTEMD/$UNIT" "$SYSTEMD/$UNIT.d" "$SYSTEMD/slack-presence-imds-block.service" \
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
    run rm -rf "$SELFHOST_ENV" /var/lib/sp-host
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

# --purge: the compose stack's user, with the stack's containers and volumes
# (the gateway's database), only if this script made the user; an operator's
# own account keeps everything but the podman-restart drop-in.
purge_gateway() {
  id "$GATEWAY_USER" >/dev/null 2>&1 || return 0
  GATEWAY_HOME="$(getent passwd "$GATEWAY_USER" | cut -d: -f6)"
  run rm -rf "$GATEWAY_HOME/.config/systemd/user/podman-restart.service.d/10-unless-stopped.conf"
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
}

case $MODE in
  install) install_all ;;
  uninstall) uninstall ;;
esac
