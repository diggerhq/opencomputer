#!/usr/bin/env bash
# What a computer needs to run sessions in containers (work 103): rootless
# Podman for the `agent` user, its storage on the data volume, and the session
# image of the release about to run, pulled and warm. Runs as root, from
# provision.sh, on every run (CODE_ONLY=1 too: computers made before this get
# it from their next self-update). Nothing here starts a container for a
# session: the host does that, and only where SP_LAUNCH=podman.
#
#   sandbox.sh version-env <release>   print the SP_IMAGE= and SP_IMAGE_ABI= lines of a release
#                                      (provision.sh appends them to its .sp-version.env)
#   sandbox.sh install                 the tier: packages, pasta's AppArmor profile, the
#                                      subordinate ids, the storage path
#   sandbox.sh image <ref>             pull <ref> if it is not here, then warm it
#   sandbox.sh prune-images <ref>...   remove every other tag of the same repository
#
# The image's tag is the git tree of deploy/image in the release (the same
# number .github/workflows/computer-image.yml pushes under), so a release names
# exactly the image built from its own files, and a tag never changes content.
#
# Invariants:
# - Idempotent. Files are written only when their content differs; the packages
#   are installed once per $VERSION (the stamp $STAMP), like provision.sh's visuals.
# - Every podman call is the agent's, through `pm`: the prefix the host's
#   runnerUser builds (sudo -n -u agent with the user manager's runtime directory
#   and bus). Root never has a Podman store here.
# - Podman remembers the first storage path it ran with. `install` reads the path
#   back and fails if it is not $DATA/containers/storage, so a computer never
#   fills its root disk with images.
# - `image` succeeds only with the image present and warm. provision.sh switches
#   `current` after it, so a computer never runs a release whose image it lacks.
# - `prune-images` never forces: an image a container still uses is refused by
#   Podman and stays.
set -euo pipefail
# Commands run as the agent must not inherit a root-only working directory.
cd /

AGENT_USER="${AGENT_USER:-agent}"
AGENT_UID="${AGENT_UID:-1500}"
DATA="${SP_DATA:-/data}"
REPOSITORY=ghcr.io/diggerhq/computer-session
# Bump when the package list below changes: the tier then installs again on every computer.
VERSION=1
STAMP=/usr/local/etc/slack-presence-sandbox
STORAGE="$DATA/containers/storage"
# The agent's first subordinate ids where it has none. Nothing may assume this
# range: whoever needs it reads /etc/subuid.
SUBIDS=165536:65536

log() { printf '\n== sandbox: %s\n' "$*"; }
die() { echo "sandbox: $*" >&2; exit 1; }

pm() {
  sudo -n -u "$AGENT_USER" XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" /usr/bin/podman "$@"
}

# write_if_changed <path> <mode>: content on stdin; returns 0 if it changed.
write_if_changed() {
  local path=$1 mode=$2 tmp
  # Called in `&&` lists and conditions, where set -e does not apply: fail explicitly.
  tmp="$(mktemp "$path.XXXXXX")" && cat > "$tmp" && chmod "$mode" "$tmp" || exit 1
  if cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  mv -f "$tmp" "$path" || exit 1
}

version_env() {
  local image="${1:?usage: sandbox.sh version-env <release>}/deploy/image" tag abi
  [[ -f $image/ABI ]] || die "no deploy/image/ABI in $1"
  # The tree, not the commit: the same files give the same tag in any repository layout.
  tag="$(git -C "$image" rev-parse HEAD:./)"
  [[ $tag =~ ^[0-9a-f]{40}$ ]] || die "deploy/image of $1 has no git tree"
  [[ -z "$(git -C "$image" status --porcelain -- .)" ]] || die "deploy/image of $1 differs from its commit"
  abi="$(tr -d '[:space:]' < "$image/ABI")"
  [[ $abi =~ ^[0-9]+$ ]] || die "deploy/image/ABI of $1 is not an integer"
  printf 'SP_IMAGE=%s:%s\nSP_IMAGE_ABI=%s\n' "$REPOSITORY" "$tag" "$abi"
}

# The agent's user manager: Podman needs its runtime directory and bus. provision.sh
# enables lingering further down; this runs before the release is switched to.
user_manager() {
  loginctl enable-linger "$AGENT_USER"
  systemctl start "user@$AGENT_UID.service"
  local i
  for i in $(seq 1 50); do
    [[ -S /run/user/$AGENT_UID/bus ]] && return
    sleep 0.2
  done
  die "user@$AGENT_UID.service is up without /run/user/$AGENT_UID/bus (is dbus-user-session installed?)"
}

install_tier() {
  id "$AGENT_USER" >/dev/null 2>&1 || die "no user $AGENT_USER"
  [[ -d $DATA ]] || die "no $DATA"

  if [[ "$(cat "$STAMP" 2>/dev/null)" != "$VERSION" ]]; then
    log "packages (tier version $VERSION)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    # The Ubuntu archive's: Podman 4.9.3 on 24.04, the version every measurement of work 103 was made on.
    apt-get install -y -q podman crun passt uidmap slirp4netns
    install -d -m 0755 "$(dirname "$STAMP")"
    printf '%s\n' "$VERSION" > "$STAMP"
  fi

  # pasta is the sessions' network. Ubuntu 24.04 restricts unprivileged user
  # namespaces to programs with a profile that allows them. Gate G6 measured the
  # same result with and without this profile; it stays until that is measured
  # after a reboot as well.
  local profile=/etc/apparmor.d/pasta
  if write_if_changed "$profile" 0644 <<'EOF' || ! grep -qs '^pasta ' /sys/kernel/security/apparmor/profiles
abi <abi/4.0>,
include <tunables/global>
profile pasta /usr/bin/pasta{,.avx2} flags=(unconfined) {
  userns,
  signal (receive) set=(term) peer=podman,
  include if exists <local/pasta>
}
EOF
  then
    log "AppArmor profile for pasta"
    apparmor_parser -r "$profile"
  fi

  local f
  for f in /etc/subuid /etc/subgid; do
    grep -qs "^$AGENT_USER:" "$f" && continue
    log "$AGENT_USER:$SUBIDS in $f"
    printf '%s:%s\n' "$AGENT_USER" "$SUBIDS" >> "$f"
  done

  # Images and containers on the data volume: the root disk is small, and a
  # computer's sessions (their containers' writable layers) live with its data.
  install -d -o "$AGENT_USER" -g "$AGENT_USER" "$DATA/containers"
  install -d -m 0755 /etc/containers
  if write_if_changed /etc/containers/storage.conf 0644 <<EOF
# Written by deploy/vm/sandbox.sh (work 103).
[storage]
driver = "overlay"
rootless_storage_path = "$STORAGE"
EOF
  then log "storage path $STORAGE"; fi

  user_manager
  local root
  root="$(pm info --format '{{.Store.GraphRoot}}')" || die "podman info failed as $AGENT_USER"
  [[ $root == "$STORAGE" ]] \
    || die "Podman's storage for $AGENT_USER is $root, not $STORAGE (it keeps the first path it ran with; \`podman system reset\` as $AGENT_USER forgets it, with every image and container)"
  echo "podman $(pm version --format '{{.Client.Version}}'), storage $root"
}

# Pull, then warm. Rootless overlay has no ID-mapped layers, so the first
# container made with a user-namespace mapping copies and chowns the whole
# image (113 s for 3.77 GB on a 2 vCPU computer, against 0.2 s afterwards), and
# the storage lock holds every other Podman call meanwhile. Paying that here,
# before the release runs, keeps it out of a person's first message.
image() {
  local ref="${1:?usage: sandbox.sh image <ref>}" try t0=$SECONDS
  [[ $ref == "$REPOSITORY":* ]] || die "$ref is not a tag of $REPOSITORY"
  if ! pm image exists "$ref"; then
    log "pulling $ref"
    for try in 1 2 3; do
      pm pull -q "$ref" && break
      [[ $try != 3 ]] || die "could not pull $ref"
      sleep $(( try * 5 ))
    done
  fi
  # A run that died between create and rm left the name taken.
  pm rm --ignore sp-warm >/dev/null
  pm create --name sp-warm "--userns=keep-id:uid=$AGENT_UID,gid=$AGENT_UID" "$ref" >/dev/null
  pm rm sp-warm >/dev/null
  echo "image $ref present and warm ($(( SECONDS - t0 )) s)"
}

# Not `podman image prune --filter until`: that filters on build time and can delete the current image.
prune_images() {
  [[ $# -gt 0 ]] || die "usage: sandbox.sh prune-images <ref to keep>..."
  local ref keep
  while read -r ref; do
    [[ $ref == "$REPOSITORY":* ]] || continue
    for keep in "$@"; do [[ $ref == "$keep" ]] && continue 2; done
    if pm rmi "$ref" >/dev/null 2>&1; then echo "removed image $ref"; else echo "kept image $ref (a container uses it)"; fi
  done < <(pm images --format '{{.Repository}}:{{.Tag}}')
}

case "${1:-}" in
  version-env) version_env "${2:-}" ;;
  install|image|prune-images)
    [[ $EUID -eq 0 ]] || die "run as root"
    case $1 in
      install) install_tier ;;
      image) image "${2:-}" ;;
      prune-images) shift; prune_images "$@" ;;
    esac
    ;;
  *) echo "usage: sandbox.sh version-env <release> | install | image <ref> | prune-images <ref>..." >&2; exit 2 ;;
esac
