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
#   sandbox.sh prune-images <ref>...   remove every other image of the same repository
#
# Which image: the release says, in deploy/image.pin, one line
# ghcr.io/diggerhq/computer-session@sha256:<digest>. The release pipeline
# writes it with deploy/image-pin.sh, which names the image main's CI built
# from the release's deploy/image and nothing else, so a release exists only
# once its image does, and a computer pulls by digest: whatever a tag in the
# registry is moved to, it gets those bytes or nothing. A release without the
# file is refused. Only a test computer (SP_IMAGE_BRANCH=1, never set by the
# backend's boot or self-update) builds one, and runs :branch-<git tree of
# deploy/image>, the tag CI pushes for any branch: enough to test a branch,
# and anyone who can push a branch can replace it.
#
# Invariants:
# - Idempotent. Files are written only when their content differs; the packages
#   are installed once per $VERSION (the stamp $STAMP), like provision.sh's visuals.
# - A file is replaced by renaming a dot file beside it: a run killed halfway
#   leaves nothing a program reads (AppArmor loads every other name in its directory).
# - Every podman call is the agent's, through `pm`: the prefix the host's
#   runnerUser builds (sudo -n -u agent with the user manager's runtime directory
#   and bus). Root never has a Podman store here.
# - Podman remembers the first storage path it ran with. `install` reads the path
#   back and fails if it is not $DATA/containers/storage, so a computer never
#   fills its root disk with images.
# - `image` succeeds only with the image present and warm. provision.sh switches
#   `current` after it, so a computer never runs a release whose image it lacks.
#   It pulls only with room for the image and its warm copy, and says so otherwise.
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
# The agent's subordinate ids where it has none: the first free range of this
# size from useradd's own minimum. Nothing may assume where it starts: whoever
# needs it reads /etc/subuid.
SUBID_MIN=100000
SUBID_COUNT=65536
# Free space a pull needs, in GiB. The store: the image and its copy for the
# user namespace (7.3 GB for the 3.77 GB image of 2026-11-12), with room to
# spare. $BLOBS is where Podman keeps the compressed layers while it pulls
# (1.5 GB then). Raise them when the image grows.
STORE_GB=10
BLOBS=/var/tmp
BLOBS_GB=2

log() { printf '\n== sandbox: %s\n' "$*"; }
die() { echo "sandbox: $*" >&2; exit 1; }

pm() {
  sudo -n -u "$AGENT_USER" XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" /usr/bin/podman "$@"
}

# write_if_changed <path> <mode>: content on stdin; returns 0 if it changed.
# The temporary file is beside the target, so the rename is atomic, and has a
# dot name, which AppArmor (and whoever else reads a whole directory) skips: a
# `pasta.XXXXXX` left in /etc/apparmor.d would be loaded at boot as a profile.
TMP=""
trap '[[ -z $TMP ]] || rm -f "$TMP"' EXIT
write_if_changed() {
  local path=$1 mode=$2
  # Called in `&&` lists and conditions, where set -e does not apply: fail explicitly.
  TMP="$(mktemp "$(dirname "$path")/.$(basename "$path").XXXXXX")" && cat > "$TMP" && chmod "$mode" "$TMP" || exit 1
  if cmp -s "$TMP" "$path"; then rm -f "$TMP"; TMP=""; return 1; fi
  mv -f "$TMP" "$path" || exit 1
  TMP=""
}

version_env() {
  local release="${1:?usage: sandbox.sh version-env <release>}" image ref tag abi
  image="$release/deploy/image"
  [[ -f $image/ABI ]] || die "no deploy/image/ABI in $release"
  abi="$(tr -d '[:space:]' < "$image/ABI")"
  [[ $abi =~ ^[0-9]+$ ]] || die "deploy/image/ABI of $release is not an integer"
  if [[ -f $release/deploy/image.pin ]]; then
    ref="$(tr -d '[:space:]' < "$release/deploy/image.pin")"
    [[ $ref == "$REPOSITORY"@sha256:* && ${ref#*@sha256:} =~ ^[0-9a-f]{64}$ ]] \
      || die "deploy/image.pin of $release is not $REPOSITORY@sha256:<digest>"
  elif [[ ${SP_IMAGE_BRANCH:-} == 1 ]]; then
    # The tree, not the commit: the same files give the same tag in any repository layout.
    tag="$(git -C "$image" rev-parse HEAD:./)"
    [[ $tag =~ ^[0-9a-f]{40}$ ]] || die "deploy/image of $release has no git tree"
    [[ -z "$(git -C "$image" status --porcelain -- .)" ]] || die "deploy/image of $release differs from its commit"
    ref="$REPOSITORY:branch-$tag"
  else
    die "$release has no deploy/image.pin, so nothing says which image main built for it (the release pipeline writes it with deploy/image-pin.sh; a test computer runs a branch's image with SP_IMAGE_BRANCH=1)"
  fi
  printf 'SP_IMAGE=%s\nSP_IMAGE_ABI=%s\n' "$ref" "$abi"
}

# free_subids <file>: the start of the first range of $SUBID_COUNT ids, from
# $SUBID_MIN up, that no line of <file> overlaps.
free_subids() {
  awk -F: -v start="$SUBID_MIN" -v n="$SUBID_COUNT" '
    $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { from[NR] = $2 + 0; to[NR] = $2 + $3 }
    END {
      do { moved = 0; for (i in from) if (start < to[i] && from[i] < start + n) { start = to[i]; moved = 1 } } while (moved)
      print start
    }' "$1"
}

# shared_subids <file>: the first other user whose range overlaps one of the agent's.
shared_subids() {
  awk -F: -v me="$AGENT_USER" '
    $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ { next }
    $1 == me { mf[++m] = $2 + 0; mt[m] = $2 + $3; next }
    { of[++o] = $2 + 0; ot[o] = $2 + $3; on[o] = $1 }
    END { for (i = 1; i <= m; i++) for (j = 1; j <= o; j++) if (mf[i] < ot[j] && of[j] < mt[i]) { print on[j]; exit } }' "$1"
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

  # A range shared with another user would give that user's containers the
  # ids of the sessions' files, and the reverse: take a free one, and read the
  # file back (a line of the agent's from before, or another writer meanwhile).
  local f start other
  for f in /etc/subuid /etc/subgid; do
    touch "$f"
    if ! grep -qs "^$AGENT_USER:" "$f"; then
      start="$(free_subids "$f")"
      log "$AGENT_USER:$start:$SUBID_COUNT in $f"
      printf '%s:%s:%s\n' "$AGENT_USER" "$start" "$SUBID_COUNT" >> "$f"
    fi
    grep -qs "^$AGENT_USER:[0-9][0-9]*:[0-9][0-9]*$" "$f" || die "$f has no subordinate ids for $AGENT_USER"
    other="$(shared_subids "$f")"
    [[ -z $other ]] || die "the subordinate ids of $AGENT_USER in $f overlap those of $other; give $AGENT_USER a range of its own there"
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

# free_gb <path>: whole GiB free on its filesystem, for a user who is not root.
free_gb() { echo $(( $(df -B1 --output=avail "$1" | tail -1) / 1073741824 )); }

# Room for the pull and the warm-up, checked before either: a disk that fills
# halfway fails every Podman call on the computer, the running sessions' too.
# Only when the image is not here, so a full disk does not stop a run that
# needs no space.
room() {
  local store="$DATA/containers" need=$STORE_GB have
  if [[ "$(df --output=target "$BLOBS" | tail -1)" == "$(df --output=target "$store" | tail -1)" ]]; then
    need=$(( STORE_GB + BLOBS_GB ))
  else
    have="$(free_gb "$BLOBS")"
    (( have >= BLOBS_GB )) || die "$BLOBS has $have GiB free; pulling $1 needs $BLOBS_GB there for its compressed layers. This release is not switched to until it has"
  fi
  have="$(free_gb "$store")"
  (( have >= need )) || die "$store has $have GiB free; $1 needs $need to be pulled and warmed (the image and its copy for the user namespace). Free space on the data volume or grow it; this release is not switched to until then"
}

# Pull, then warm. Rootless overlay has no ID-mapped layers, so the first
# container made with a user-namespace mapping copies and chowns the whole
# image (113 s for 3.77 GB on a 2 vCPU computer, against 0.2 s afterwards), and
# the storage lock holds every other Podman call meanwhile. Paying that here,
# before the release runs, keeps it out of a person's first message.
image() {
  local ref="${1:?usage: sandbox.sh image <ref>}" try t0=$SECONDS
  # Whichever the release's .sp-version.env names: a digest, or a tag (a test computer's, or a release from before the pin).
  [[ $ref == "$REPOSITORY":* || $ref == "$REPOSITORY"@sha256:* ]] || die "$ref is not an image of $REPOSITORY"
  if ! pm image exists "$ref"; then
    room "$ref"
    log "pulling $ref"
    for try in 1 2 3; do
      pm pull -q "$ref" >/dev/null && break
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
# By image id: an image pulled by digest has no tag to list or to name it by.
prune_images() {
  [[ $# -gt 0 ]] || die "usage: sandbox.sh prune-images <ref to keep>..."
  local ref id repository keep=" "
  for ref in "$@"; do
    # One that is not here (the image of a release pruned since) is nothing to keep.
    id="$(pm image inspect --format '{{.Id}}' "$ref" 2>/dev/null)" && keep+="${id#sha256:} "
  done
  # Never on an empty list: the image of the running release is always here.
  [[ $keep != " " ]] || die "none of the images to keep is in the store: $*"
  while read -r id repository; do
    [[ $repository == "$REPOSITORY" ]] || continue
    id="${id#sha256:}"
    [[ $keep == *" $id "* ]] && continue
    if pm rmi "$id" >/dev/null 2>&1; then echo "removed image $id"; else echo "kept image $id (a container uses it, or it has a second name)"; fi
  done < <(pm images --no-trunc --format '{{.ID}} {{.Repository}}' | sort -u)
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
