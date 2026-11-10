#!/usr/bin/env bash
# Provision (or re-provision) the shared slack-presence VM (work 045, stage D3).
#
# Target: Ubuntu 24.04 on the hosts (CLOUD=none; deploy/update.sh)
# or EC2 (m7i.4xlarge; deploy/vm/cloud-init.yaml), run as root. Idempotent: run
# it on first boot (EC2 user-data, or by hand) and again to update code,
# toolchains or units (CODE_ONLY=1: code and units only). Re-running never formats an existing volume, never deletes data,
# and only restarts the host agent (runners live in their own systemd units
# and keep running; see "Runners" below).
#
# Everything the VM needs comes from here; the only state is the /data volume:
#   /data/people/<person>/{ws,sessions}   workspaces and session forks (S4)
#   /data/home/agent                      the agent user's home: ~/.claude
#                                         transcripts, ~/.gitconfig
#
# Inputs (environment variables):
#   REPO_URL          required. HTTPS clone URL of slack-presence (Calvin),
#                     e.g. https://github.com/<owner>/<repo>.git
#   REPO_REF          branch or tag to deploy (default: main)
#   REPO_TOKEN        optional GitHub token for a private REPO_URL. Used for
#                     this run only via GIT_CONFIG_* env (not argv, not disk).
#   CLOUD             aws | none. Default: detected (DMI, then the metadata
#                     server). Selects data disk discovery below.
#   DATA_VOLUME_ID    EC2: EBS volume id (vol-0123...) of the data volume. Needed
#                     on first use; later runs find it by its filesystem label.
#   DATA_DEVICE       any cloud, overrides the above: a block device path.
#                     Without either, an existing sp-data label is used, and on
#                     Azure (CLOUD=none with /dev/disk/azure) the data disk at
#                     LUN 0: /dev/disk/azure/data/by-lun/0 (NVMe-only sizes such
#                     as v6/v7), else /dev/disk/azure/scsi1/lun0 (SCSI sizes).
#   DATA_WAIT_SECS    how long to wait for the volume to be attached (default 900)
#   FORMAT_IF_BLANK   1 (default): format the data device with ext4 ONLY if it
#                     has no partitions and no filesystem signature at all.
#                     0: never format; fail instead.
#   ALLOW_NO_DATA_VOLUME  1: use a plain /data directory on the root disk
#                     (throwaway test VMs only; not replaceable)
#   AGENT_UID         fixed uid/gid of `agent` (default 1500). Must be the same
#                     on every VM that mounts the volume.
#   GO_SERIES         Go minor series to install (default 1.27, the latest
#                     stable); latest patch is used
#   GO_VERSION        exact Go version instead (e.g. 1.27.3)
#   NODE_MAJOR        Node.js major (default 24)
#   INSTALL_DOCKER    0 (default) | 1. See "Docker" below.
#   CODE_ONLY         1: skip apt packages and toolchains (Node, gh, Claude Code
#                     CLI, Go, uv) on a host provisioned before; deploy/update.sh
#                     sets it on every merge. Run without it to refresh toolchains.
#   SP_DEFINITION_NAME  which shipped definitions/<name>.json the host uses
#                     when the gateway sends none. Default: computer (an
#                     organization's computer, work 052: no repositories until
#                     the gateway's definition arrives). Remembered in /etc/slack-presence, so
#                     later runs (deploy/update.sh) keep it.
#   SP_GATEWAY_URL, SP_HOST_TOKEN, SP_HOST_ID
#                     if SP_HOST_TOKEN is set, (re)write /etc/slack-presence/host.env
#                     from these and start the host agent. Otherwise an existing
#                     host.env is kept, and without one the agent is installed
#                     but not started.
#   SP_TELEMETRY_URL, SP_TELEMETRY_CREDENTIAL, SP_REGION, SP_SUBSTRATE
#                     optional, written to host.env with the above when set:
#                     the telemetry collector and this host's signed credential
#                     (work 054), and the region/substrate telemetry dimensions.
#
# Usage:
#   Azure, existing hosts: deploy/update.sh (CLOUD=none, code from a git bundle)
#   Azure, a new computer (work 052): deploy/vm/azure-computer-boot.sh, from cloud-init
#   EC2: sudo REPO_URL=... REPO_TOKEN=... DATA_VOLUME_ID=vol-... bash provision.sh
#
# Assumptions about other work items (045 S2/S4), stated here so they can be
# checked against the code:
#   - The host agent is `tsx src/host/main.ts`, run from the release directory.
#   - On Linux it starts runners with `systemd-run --user` (the agent user's own
#     systemd manager, kept alive by lingering) in `slack-presence-runners.slice`.
#     The host unit sets XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS for that.
#   - Runner sockets and the token socket live in SP_RUN=/run/slack-presence.
#   - bin/git-credential-slack-presence and bin/gh (shim) exist in the repo; the
#     gh shim must call /usr/bin/gh by absolute path (it is first on PATH).
#   - definitions/computer.json exists in the repo (SP_DEFINITION).

set -euo pipefail
# A caller's umask 077 (GCE's startup runner had one) leaves releases unreadable
# to the agent user (host agent fails with 200/CHDIR). Code and toolchains are public.
umask 022

# Every download gives up on a stalled transfer and retries. On production
# (work 052) a first boot hung for minutes on a Node tarball stuck at 90%,
# while a fresh download of the same file took 0.2 s: without these, curl
# waits forever and the computer never comes online.
DL=(--connect-timeout 15 --speed-limit 100000 --speed-time 20 --retry 5 --retry-delay 2 --retry-all-errors)

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
cd /   # runuser/git below must not inherit an unreadable cwd
# One run at a time: a first boot, deploy/update.sh and a hand run can overlap.
exec 9>/run/slack-presence-provision.lock
flock -w 3600 9 || die "another provision.sh held the lock for an hour"

REPO_URL="${REPO_URL:-}"
REPO_REF="${REPO_REF:-main}"
REPO_TOKEN="${REPO_TOKEN:-}"
CLOUD="${CLOUD:-}"
DATA_VOLUME_ID="${DATA_VOLUME_ID:-}"
DATA_DEVICE="${DATA_DEVICE:-}"
DATA_WAIT_SECS="${DATA_WAIT_SECS:-900}"
FORMAT_IF_BLANK="${FORMAT_IF_BLANK:-1}"
ALLOW_NO_DATA_VOLUME="${ALLOW_NO_DATA_VOLUME:-0}"
AGENT_USER=agent
AGENT_UID="${AGENT_UID:-1500}"
# The client relay's user and loopback port (work 084; slack-presence-wire.service).
WIRE_USER=sp-wire
WIRE_PORT="${WIRE_PORT:-7071}"
GO_SERIES="${GO_SERIES:-1.27}"
GO_VERSION="${GO_VERSION:-}"
NODE_MAJOR="${NODE_MAJOR:-24}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.64.1}"
# Pinned: the Codex harness speaks this version's app-server protocol (work 082; src/runner/harness/codex/).
CODEX_VERSION="${CODEX_VERSION:-0.163.0}"
INSTALL_DOCKER="${INSTALL_DOCKER:-0}"
CODE_ONLY="${CODE_ONLY:-0}"

DATA=/data
DATA_LABEL=sp-data
AGENT_HOME="$DATA/home/$AGENT_USER"
SP_ROOT=/opt/slack-presence
SP_REPO="$SP_ROOT/repo"          # bare-ish clone used as the object store
SP_RELEASES="$SP_ROOT/releases"  # one git worktree + node_modules per deployed commit
SP_CURRENT="$SP_ROOT/current"    # symlink to the release the host agent runs
SP_RUN=/run/slack-presence
ETC=/etc/slack-presence
HOST_ENV="$ETC/host.env"
# The shipped definition used until the gateway sends one; kept across runs.
DEFINITION_NAME_FILE="$ETC/definition-name"
DEFINITION_NAME="${SP_DEFINITION_NAME:-$(cat "$DEFINITION_NAME_FILE" 2>/dev/null || echo computer)}"
[[ $DEFINITION_NAME =~ ^[a-z0-9-]+$ ]] || die "SP_DEFINITION_NAME must be a plain name, not '$DEFINITION_NAME'"

[[ -n $REPO_URL ]] || die "REPO_URL is required (the slack-presence clone URL)"

export DEBIAN_FRONTEND=noninteractive
ARCH="$(dpkg --print-architecture)"   # amd64 on n2/m7i; arm64 also works

# --------------------------------------------------------------------------- cloud
# Only data disk discovery and messages depend on the cloud; the metadata
# block below covers both. DMI first (no network), then the metadata servers.
detect_cloud() {
  local dmi
  dmi="$(cat /sys/class/dmi/id/product_name /sys/class/dmi/id/sys_vendor 2>/dev/null || true)"
  if [[ $dmi == *"Amazon EC2"* ]]; then echo aws; return; fi
  if curl -fsS -m 2 -o /dev/null -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
       http://169.254.169.254/latest/api/token 2>/dev/null; then echo aws; return; fi
  echo none
}
[[ -n $CLOUD ]] || CLOUD="$(detect_cloud)"
case $CLOUD in
  aws)  attach_hint="aws ec2 attach-volume ..." ;;
  none) attach_hint="attach the data disk" ;;
  *)    die "CLOUD must be aws or none, not '$CLOUD'" ;;
esac
echo "cloud: $CLOUD"

if ! grep -q 'VERSION_ID="24.04"' /etc/os-release; then
  warn "written for Ubuntu 24.04; continuing on $(. /etc/os-release && echo "$PRETTY_NAME")"
fi

# --------------------------------------------------------------------------- packages
have_tools() { local t; for t in node gh uv claude opencomputer /usr/local/go/bin/go; do command -v "$t" >/dev/null || return 1; done; }
if [[ $CODE_ONLY == 1 ]] && have_tools; then
  log "CODE_ONLY=1: keeping apt packages and toolchains"
  GO_VERSION="$(/usr/local/go/bin/go env GOVERSION | sed 's/^go//')"
else
[[ $CODE_ONLY == 1 ]] && warn "CODE_ONLY=1 but toolchains are missing; installing them"
log "apt packages"
apt-get update -q
# build-essential/pkg-config: opencomputer builds with CGO_ENABLED=1 (Makefile).
# python3-venv/pip + uv (below): opencomputer/sdks/python (requires-python >=3.10, CI uses uv).
# dbus-user-session: the bus `systemd-run --user` talks to.
# iptables: the IMDS block for the agent user (below).
apt-get install -y -q --no-install-recommends \
  ca-certificates curl gnupg git git-lfs openssh-client \
  build-essential pkg-config make \
  jq ripgrep fd-find tree unzip zip xz-utils rsync less file lsof \
  python3 python3-venv python3-pip sqlite3 \
  tmux htop \
  dbus-user-session iptables e2fsprogs util-linux acl cloud-guest-utils

install -d -m 0755 /etc/apt/keyrings

# Node.js from the official nodejs.org tarball, checksum-verified (Ubuntu's own
# is too old; NodeSource's apt key rotation once broke a first boot). Repos need
# >=22 (managed-agents, opencomputer engines; flue >=22.19); slack-presence uses
# node:sqlite -> 24.
log "Node.js $NODE_MAJOR"
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  rm -f /etc/apt/sources.list.d/nodesource.list
  dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
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

# GitHub CLI from GitHub's apt repository. The bin/gh shim in slack-presence
# wraps it with installation tokens.
log "GitHub CLI"
if ! command -v gh >/dev/null; then
  curl "${DL[@]}" -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q
  apt-get install -y -q gh
fi
gh --version | head -1

# Claude Code CLI, for operators debugging in an SSM shell. Runners do not need
# it: the Agent SDK ships its own Claude Code binary in node_modules.
log "Claude Code CLI"
npm install -g --no-audit --no-fund @anthropic-ai/claude-code@latest >/dev/null
claude --version || warn "claude --version failed"

# OpenComputer CLI, so sessions can create and deploy serverless agent projects
# (automations; work 067). @latest on every provision, which
# deploy/update.sh reruns on each rollout.
log "OpenComputer CLI"
npm install -g --no-audit --no-fund @opencomputer/cli@latest >/dev/null
opencomputer --version || warn "opencomputer --version failed"

# Go: the latest stable series, for sessions and for the VM's own Go services.
# Newer Go builds older modules (opencomputer/go.mod says `go 1.25.0`).
# Install the latest patch of that series from go.dev, checksum-verified.
log "Go"
if [[ -z $GO_VERSION ]]; then
  GO_VERSION="$(curl "${DL[@]}" -fsSL 'https://go.dev/dl/?mode=json&include=all' \
    | jq -r --arg s "go${GO_SERIES}" '[.[] | select(.stable and (.version == $s or (.version | startswith($s + "."))))][0].version' \
    | sed 's/^go//')"
  [[ -n $GO_VERSION && $GO_VERSION != null ]] || die "could not resolve the latest Go $GO_SERIES release"
fi
if [[ "$(/usr/local/go/bin/go env GOVERSION 2>/dev/null || true)" != "go$GO_VERSION" ]]; then
  go_tgz="go${GO_VERSION}.linux-${ARCH}.tar.gz"
  go_sha="$(curl "${DL[@]}" -fsSL 'https://go.dev/dl/?mode=json&include=all' \
    | jq -r --arg f "$go_tgz" '.[].files[] | select(.filename == $f) | .sha256' | head -1)"
  [[ -n $go_sha ]] || die "no checksum for $go_tgz"
  tmp="$(mktemp -d)"
  curl "${DL[@]}" -fsSL "https://go.dev/dl/$go_tgz" -o "$tmp/$go_tgz"
  echo "$go_sha  $tmp/$go_tgz" | sha256sum -c -
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tmp/$go_tgz"
  rm -rf "$tmp"
fi
/usr/local/go/bin/go version

# uv (Python packaging; opencomputer's Python SDK workflow uses it).
log "uv"
if ! command -v uv >/dev/null; then
  curl "${DL[@]}" -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi
uv --version

# Docker: off by default. No test suite in the seed repositories needs it
# (opencomputer's Go tests use no testcontainers/dockertest; managed-agents tests use
# vitest/workerd). Its Dockerfiles are for release images built in CI.
# Membership in the `docker` group is root-equivalent, which would undo
# "agent has no sudo"; turn it on only as a conscious decision.
if [[ $INSTALL_DOCKER == 1 ]]; then
  log "Docker (INSTALL_DOCKER=1; agent gets root-equivalent docker access)"
  apt-get install -y -q docker.io docker-buildx
  systemctl enable --now docker
fi
fi   # CODE_ONLY

# --------------------------------------------------------------------------- visuals
# Screenshots, diagrams, charts and videos (work 063). Without these a browser
# cannot start on the agent user (no sudo), and every session that rendered one
# spent minutes unpacking .debs by hand. Its own section, outside CODE_ONLY: a
# code deploy installs it once (the version file is the marker) without
# re-running the toolchain refresh above. Chromium's libraries come from
# Playwright's own list (install-deps), at the version whose browsers the agent
# user gets below; fonts cover Latin, CJK and emoji; ffmpeg for video.
VISUALS_MARK=/usr/local/etc/slack-presence-visuals
if [[ "$(cat "$VISUALS_MARK" 2>/dev/null)" != "playwright@$PLAYWRIGHT_VERSION" ]]; then
  log "visuals: browser, fonts, ffmpeg (playwright $PLAYWRIGHT_VERSION)"
  apt-get update -q
  apt-get install -y -q --no-install-recommends \
    ffmpeg fontconfig fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
  npm install -g --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION" >/dev/null
  playwright install-deps chromium
  install -d -m 0755 "$(dirname "$VISUALS_MARK")"
  printf 'playwright@%s\n' "$PLAYWRIGHT_VERSION" > "$VISUALS_MARK"
fi
playwright --version

# --------------------------------------------------------------------------- previews
# cloudflared, the tunnel that carries this computer's preview URLs (work 074).
# The host agent runs it with the token from the gateway's welcome, in memory
# only; nothing is configured here. Outside CODE_ONLY, like visuals: a code
# deploy installs it once on a host provisioned before.
if ! command -v cloudflared >/dev/null; then
  log "cloudflared"
  install -d -m 0755 /etc/apt/keyrings
  curl "${DL[@]}" -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
  chmod 0644 /etc/apt/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q
  apt-get install -y -q cloudflared
fi
cloudflared --version || warn "cloudflared --version failed"

# --------------------------------------------------------------------------- codex
# Codex CLI, which a `harness: 'codex'` session runs as `codex app-server`
# (work 082). Outside CODE_ONLY, like visuals: a code
# deploy is how a computer gets a new pin, and computers provisioned before
# 082 get it at all only this way. Pinned, never @latest: Calvin speaks its
# JSON-RPC protocol, which changes between releases. Its own prefix, off PATH
# (runners find it through SP_CODEX_BIN's default), so a session's `codex`
# is whatever the person installs, never Calvin's.
CODEX_BIN=/usr/local/lib/codex/bin/codex
# Into a new prefix, swapped in only once complete: a failed install (npm
# down) keeps the working one, and only Codex sessions miss it, not the provision.
if [[ "$("$CODEX_BIN" --version 2>/dev/null)" != *" $CODEX_VERSION" ]]; then
  log "Codex CLI $CODEX_VERSION"
  rm -rf /usr/local/lib/codex.new
  if npm install -g --prefix /usr/local/lib/codex.new --no-audit --no-fund "@openai/codex@$CODEX_VERSION" >/dev/null; then
    rm -rf /usr/local/lib/codex.old
    [[ -e /usr/local/lib/codex ]] && mv /usr/local/lib/codex /usr/local/lib/codex.old
    mv /usr/local/lib/codex.new /usr/local/lib/codex
    rm -rf /usr/local/lib/codex.old
  else
    rm -rf /usr/local/lib/codex.new
    warn "Codex CLI $CODEX_VERSION not installed"
  fi
fi
"$CODEX_BIN" --version || warn "codex --version failed"

# --------------------------------------------------------------------------- data volume
log "data volume at $DATA"

data_dev=""
# Azure's udev rules link the data disk at LUN 0 here (NVMe-only sizes, then SCSI).
AZURE_LUN0=(/dev/disk/azure/data/by-lun/0 /dev/disk/azure/scsi1/lun0)
on_azure() { [[ $CLOUD == none && -d /dev/disk/azure ]]; }
find_data_device() {
  if [[ -n $DATA_DEVICE ]]; then
    [[ -b $DATA_DEVICE ]] && data_dev="$(readlink -f "$DATA_DEVICE")"
  elif [[ -n $DATA_VOLUME_ID ]]; then
    # Nitro instances expose EBS volumes as NVMe devices whose serial is the
    # volume id without the dash; udev links them by id.
    local link="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID/-/}"
    [[ -e $link ]] && data_dev="$(readlink -f "$link")"
  elif [[ -e /dev/disk/by-label/$DATA_LABEL ]]; then
    data_dev="$(readlink -f "/dev/disk/by-label/$DATA_LABEL")"
  elif on_azure; then
    local l
    for l in "${AZURE_LUN0[@]}"; do
      [[ -b $l ]] && { data_dev="$(readlink -f "$l")"; break; }
    done
  fi
  [[ -n $data_dev ]]
}

if mountpoint -q "$DATA"; then
  echo "$DATA already mounted from $(findmnt -no SOURCE "$DATA")"
elif [[ $ALLOW_NO_DATA_VOLUME == 1 && -z $DATA_VOLUME_ID && -z $DATA_DEVICE ]]; then
  warn "ALLOW_NO_DATA_VOLUME=1: $DATA is a directory on the root disk; this VM is NOT replaceable"
  install -d -m 0755 "$DATA"
else
  if [[ -z $DATA_VOLUME_ID && -z $DATA_DEVICE && ! -e /dev/disk/by-label/$DATA_LABEL ]] && ! on_azure; then
    die "no data volume: set DATA_VOLUME_ID=vol-... (EC2) or DATA_DEVICE, or ALLOW_NO_DATA_VOLUME=1 for a throwaway VM"
  fi
  data_want="${DATA_DEVICE:-${DATA_VOLUME_ID:-label $DATA_LABEL}}"
  [[ -z $DATA_DEVICE && -z $DATA_VOLUME_ID && ! -e /dev/disk/by-label/$DATA_LABEL ]] && data_want="the Azure data disk at LUN 0"
  waited=0
  until find_data_device; do
    (( waited >= DATA_WAIT_SECS )) && die "data volume $data_want not attached after ${DATA_WAIT_SECS}s"
    (( waited % 60 == 0 )) && echo "waiting for data volume $data_want to be attached ($attach_hint)"
    sleep 5; waited=$((waited + 5))
  done
  echo "data device: $data_dev"

  root_dev="$(findmnt -no SOURCE / | xargs -r lsblk -no PKNAME 2>/dev/null | head -1 || true)"
  [[ -n $root_dev && $data_dev == "/dev/$root_dev" ]] && die "$data_dev is the root disk; refusing"
  findmnt -rno SOURCE | grep -qx "$data_dev" && die "$data_dev is mounted somewhere else; refusing"

  fstype="$(blkid -p -o value -s TYPE "$data_dev" 2>/dev/null || true)"
  label="$(blkid -p -o value -s LABEL "$data_dev" 2>/dev/null || true)"
  if [[ -z $fstype ]]; then
    # Format ONLY a device that is provably blank: no partitions, no signature
    # of any kind (filesystem, RAID, LVM, partition table) per wipefs.
    nparts="$(lsblk -nro NAME "$data_dev" | tail -n +2 | wc -l)"
    sigs="$(wipefs --no-act --noheadings "$data_dev" 2>/dev/null | wc -l)"
    if [[ $nparts -ne 0 || $sigs -ne 0 ]]; then
      die "$data_dev has partitions or signatures but no filesystem we recognize; inspect by hand, not formatting"
    fi
    [[ $FORMAT_IF_BLANK == 1 ]] || die "$data_dev is blank and FORMAT_IF_BLANK=0; not formatting"
    log "formatting BLANK device $data_dev as ext4 label=$DATA_LABEL"
    mkfs.ext4 -q -L "$DATA_LABEL" -m 1 "$data_dev"
  elif [[ $fstype != ext4 || $label != "$DATA_LABEL" ]]; then
    die "$data_dev holds $fstype label '$label', expected ext4 label '$DATA_LABEL'; not touching it"
  else
    echo "existing $fstype filesystem label=$label: keeping it"
  fi

  uuid="$(blkid -p -o value -s UUID "$data_dev")"
  [[ -n $uuid ]] || die "no UUID on $data_dev"
  # nofail: a missing volume must not block boot (SSM/IAP SSH must still come up to fix
  # it); units that need /data declare RequiresMountsFor=/data and wait/fail.
  fstab_line="UUID=$uuid $DATA ext4 defaults,noatime,nofail,x-systemd.device-timeout=60s 0 2"
  if grep -qE "^[^#]*[[:space:]]$DATA[[:space:]]" /etc/fstab; then
    sed -i -E "\|^[^#]*[[:space:]]$DATA[[:space:]]|c\\$fstab_line" /etc/fstab
  else
    echo "$fstab_line" >> /etc/fstab
  fi
  install -d -m 0755 "$DATA"
  systemctl daemon-reload
  mount "$DATA"
fi

# --------------------------------------------------------------------------- agent user
log "user $AGENT_USER (uid $AGENT_UID, no sudo)"
if getent group "$AGENT_USER" >/dev/null; then
  [[ "$(getent group "$AGENT_USER" | cut -d: -f3)" == "$AGENT_UID" ]] || die "group $AGENT_USER exists with a gid other than $AGENT_UID"
else
  groupadd --gid "$AGENT_UID" "$AGENT_USER"
fi
if id "$AGENT_USER" >/dev/null 2>&1; then
  [[ "$(id -u "$AGENT_USER")" == "$AGENT_UID" ]] || die "user $AGENT_USER exists with a uid other than $AGENT_UID"
  [[ "$(getent passwd "$AGENT_USER" | cut -d: -f6)" == "$AGENT_HOME" ]] || usermod --home "$AGENT_HOME" "$AGENT_USER"
else
  # Home on the volume: transcripts (~/.claude/projects) are session state.
  useradd --uid "$AGENT_UID" --gid "$AGENT_UID" --home-dir "$AGENT_HOME" --no-create-home \
    --shell /bin/bash --comment "slack-presence runners" "$AGENT_USER"
fi
# No sudo: not in sudo/admin/docker groups (docker only with INSTALL_DOCKER=1).
for g in sudo admin adm lxd; do gpasswd -d "$AGENT_USER" "$g" >/dev/null 2>&1 || true; done
[[ $INSTALL_DOCKER == 1 ]] && usermod -aG docker "$AGENT_USER"

install -d -m 0755 "$DATA/home"
install -d -m 0750 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME" "$DATA/people"
# Session journals (work 084, src/api/journal.ts): runners write them as agent, the host
# (sp-host, in group agent) adopts them. $DATA is root's, so neither could create this itself.
install -d -m 2770 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA/journals"
# Host state the agent user writes: the gateway's workspace definition (052).
install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA/state"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/.config" "$AGENT_HOME/.config/environment.d"
# Codex sessions' homes (work 082): the runner's, under the user it runs as (runner/main.ts); never /data or $DATA/state.
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/.calvin" "$AGENT_HOME/.calvin/codex"

# --------------------------------------------------------------------------- relay user (work 084)
# The client relay (src/wire, slack-presence-wire.service) runs as its own
# system user: no shell, no home, no sudo. Group sp-wire is how it reaches the
# host's wire socket ($SP_RUN/wire/wire.sock, 0660 :sp-wire; the host joins the
# group in sp-host.sh); group agent is how it traverses $SP_RUN and dials the
# session writers' sockets in $SP_RUN/runners. Never in sudo or docker.
log "user $WIRE_USER (the client relay: no shell, no sudo)"
getent group "$WIRE_USER" >/dev/null || groupadd --system "$WIRE_USER"
if ! id "$WIRE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$WIRE_USER" --groups "$AGENT_USER" --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin --comment "slack-presence client relay" "$WIRE_USER"
fi
usermod -a -G "$AGENT_USER" "$WIRE_USER"
for g in sudo admin adm lxd docker; do gpasswd -d "$WIRE_USER" "$g" >/dev/null 2>&1 || true; done
# No process may ptrace one that is not its descendant: a session cannot read
# the relay's memory (its connections' credentials), nor the relay a runner's.
printf '# Written by deploy/vm/provision.sh (work 084).\nkernel.yama.ptrace_scope = 1\n' > /etc/sysctl.d/60-slack-presence-wire.conf
sysctl -q -p /etc/sysctl.d/60-slack-presence-wire.conf || warn "could not set kernel.yama.ptrace_scope=1"

# --------------------------------------------------------------------------- slack-presence code
# Releases: each deployed commit is its own git worktree with its own
# node_modules, and `current` points at the newest. Runners keep running from the
# release they started in ("a runner keeps the code version it started with"),
# so an update never replaces files under a running runner.
log "slack-presence $REPO_REF from $REPO_URL"
git_auth=()
if [[ -n $REPO_TOKEN ]]; then
  # Header via GIT_CONFIG_* env: not on the command line (ps), not on disk.
  basic="$(printf 'x-access-token:%s' "$REPO_TOKEN" | base64 -w0)"
  git_auth=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
            "GIT_CONFIG_VALUE_0=Authorization: Basic $basic")
fi
install -d -m 0755 "$SP_ROOT" "$SP_RELEASES"
install -d -m 0755 "$ETC"
printf '%s\n' "$DEFINITION_NAME" > "$DEFINITION_NAME_FILE"
if [[ ! -d $SP_REPO/.git ]]; then
  "${git_auth[@]}" git clone --no-checkout "$REPO_URL" "$SP_REPO"
else
  git -C "$SP_REPO" remote set-url origin "$REPO_URL"
  "${git_auth[@]}" git -C "$SP_REPO" fetch --prune --tags origin
fi
"${git_auth[@]}" git -C "$SP_REPO" fetch origin "$REPO_REF"
sha="$(git -C "$SP_REPO" rev-parse --short=12 FETCH_HEAD)"
release="$SP_RELEASES/$sha"
if [[ ! -f $release/.sp-ready ]]; then
  rm -rf "$release"; git -C "$SP_REPO" worktree prune
  git -C "$SP_REPO" worktree add --detach "$release" "$sha"
  # Same lockfile as the running release: hard-link its node_modules instead of
  # installing them again. Releases are root-owned and never modified, so the
  # shared files are safe; pruning one release leaves the other's links intact.
  running="$(readlink -f "$SP_CURRENT" 2>/dev/null || true)"
  if [[ -n $running && -f $running/.sp-ready ]] \
     && cmp -s "$running/package-lock.json" "$release/package-lock.json"; then
    cp -al "$running/node_modules" "$release/node_modules"
  else
    (cd "$release" && npm ci --no-audit --no-fund)
  fi
  # The runner as one file (scripts/bundle-runner.mjs, work 082): about 100 ms
  # off every runner start. Without it, host/launch.ts starts runners under tsx.
  # It also builds dist/wire.js, the client relay: slack-presence-wire.service runs only that.
  (cd "$release" && node scripts/bundle-runner.mjs) || warn "runner bundle failed; runners start under tsx"
  [[ -f $release/dist/wire.js ]] || warn "no dist/wire.js: the client relay (slack-presence-wire) will not start on this release"
  [[ -d $release/bin ]] && chmod 0755 "$release"/bin/* 2>/dev/null || true
  printf 'SP_VERSION=%s\n' "$sha" > "$release/.sp-version.env"
  touch "$release/.sp-ready"
fi
previous="$(readlink -f "$SP_CURRENT" 2>/dev/null || true)"
if [[ -n $previous && $previous != "$release" && -d $previous ]]; then
  touch "$previous/.sp-superseded"   # pruning clock starts now, not at creation
fi
rm -f "$release/.sp-superseded"
ln -sfn "$release" "$SP_CURRENT.tmp" && mv -T "$SP_CURRENT.tmp" "$SP_CURRENT"
echo "current -> $release"
for f in bin/git-credential-slack-presence bin/gh bin/opencomputer definitions/computer.json; do
  [[ -e $SP_CURRENT/$f ]] || warn "$f missing in this release (045 S4 not merged yet?)"
done

# Prune old releases: superseded more than 2 days ago (runners idle-exit after
# 2 h, so none should still run from it) and not named in any process's command
# line or environment (a runner still started from it).
for r in "$SP_RELEASES"/*/; do
  r="${r%/}"
  [[ $r == "$(readlink -f "$SP_CURRENT")" ]] && continue
  [[ -f $r/.sp-superseded && -n "$(find "$r/.sp-superseded" -mtime +2)" ]] || continue
  if grep -qsF "$r" /proc/[0-9]*/cmdline /proc/[0-9]*/environ; then continue; fi
  echo "pruning release $r"
  git -C "$SP_REPO" worktree remove --force "$r" || rm -rf "$r"
done
git -C "$SP_REPO" worktree prune

# --------------------------------------------------------------------------- agent environment
log "environment for $AGENT_USER"
# gh shim and credential helper first on PATH; Go and uv next.
AGENT_PATH="$SP_CURRENT/bin:/usr/local/go/bin:$AGENT_HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Vite (>= 6.0.9) refuses requests for hosts it does not know; preview URLs
# (work 074) are on opencomputer.app, so every dev server a session starts
# accepts them without a config change.
PREVIEW_HOSTS=.opencomputer.app

# For the agent's systemd user manager, so runners (systemd-run --user) get it.
cat > "$AGENT_HOME/.config/environment.d/10-slack-presence.conf" <<EOF
# Written by slack-presence deploy/vm/provision.sh; rewritten on every run.
PATH=$AGENT_PATH
SP_DATA=$DATA
SP_RUN=$SP_RUN
DISABLE_AUTOUPDATER=1
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=$PREVIEW_HOSTS
EOF
chown "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.config/environment.d/10-slack-presence.conf"

# For interactive shells (`sudo -iu agent` from an SSM session).
cat > /etc/profile.d/slack-presence.sh <<EOF
# Written by slack-presence deploy/vm/provision.sh
export PATH="/usr/local/go/bin:\$PATH"
if [ "\$(id -un)" = "$AGENT_USER" ]; then
  export PATH="$AGENT_PATH" SP_DATA="$DATA" SP_RUN="$SP_RUN" DISABLE_AUTOUPDATER=1 __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=$PREVIEW_HOSTS
fi
EOF

# Git for the agent user: GitHub credentials only through the helper, which asks
# the host agent's token socket for an installation token. useHttpPath so the
# helper sees the repository (tokens may be narrowed per repository). Any other
# helper is cleared first (the empty value resets the helper list).
agent_git() { runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" git config --global "$@"; }
agent_git --replace-all credential.https://github.com.helper ''
agent_git --add credential.https://github.com.helper "$SP_CURRENT/bin/git-credential-slack-presence"
agent_git credential.https://github.com.useHttpPath true
# Automation repositories (work 067): push credentials per project, also from
# the helper; useHttpPath so it sees which project's repository.
agent_git --replace-all 'credential.https://*.code.storage.helper' ''
agent_git --add 'credential.https://*.code.storage.helper' "$SP_CURRENT/bin/git-credential-slack-presence"
agent_git 'credential.https://*.code.storage.useHttpPath' true
agent_git init.defaultBranch main
agent_git fetch.prune true
agent_git push.autoSetupRemote true
# Releases are root-owned worktrees; let the agent read their git metadata
# (the host may take its version from `git rev-parse`).
agent_git --replace-all safe.directory "$SP_CURRENT"
agent_git --add safe.directory "$(readlink -f "$SP_CURRENT")"

# Playwright's browsers in the agent user's cache (~/.cache/ms-playwright), where
# scripts find them with no setup; `npm link playwright` gets the matching library.
runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" playwright install chromium chromium-headless-shell \
  || warn "playwright browsers not installed; sessions will download them on first use"

# --------------------------------------------------------------------------- systemd
log "systemd units"

# /run/slack-presence for runner sockets and the token socket. tmpfiles.d, not
# RuntimeDirectory=: RuntimeDirectory is deleted when the host service stops,
# which would remove the sockets of runners that outlive a host restart.
# Owned by the host's user (sp-host once deploy/vm/sp-host.sh migrated this computer, work 077),
# group agent (setgid): runners create their sockets in runners/ and their secrets in secrets/.
# The entries live in sp-host.sh (`run_dirs`), which also writes them on migrate and revert.
AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" bash "$SP_CURRENT/deploy/vm/sp-host.sh" run-dirs

# Lingering keeps the agent's systemd user manager (user@$AGENT_UID) running
# without a login, so the host agent can start runners as transient user units
# (`systemd-run --user`). Chosen over system-level systemd-run: letting a
# non-root user create system units (polkit manage-units) is root-equivalent,
# since a transient unit can set User=root; the user manager can only start
# processes as the agent itself.
loginctl enable-linger "$AGENT_USER"

# The user manager's home is on /data; start it only once /data is mounted, and
# delegate the cpu/memory/io controllers so the runners slice limits apply.
install -d /etc/systemd/system/user@"$AGENT_UID".service.d
cat > /etc/systemd/system/user@"$AGENT_UID".service.d/10-slack-presence.conf <<EOF
[Unit]
RequiresMountsFor=$DATA

[Service]
Delegate=pids memory cpu io
EOF

# Machine sizing (work 052: computers from 2 vCPU / 8 GiB up, resized by a
# reboot). Everything the agent's user manager runs (all runners and what they
# spawn: builds, tests, dev servers) is capped below the machine so sshd,
# journald, the guest agent and the host agent (system.slice, outside this cap)
# stay responsive when a build runs away (risk R5). deploy/vm/limits.sh computes
# the caps from MemTotal and nproc (formulas there), now and on every boot
# (slack-presence-limits.service), and writes the user-$AGENT_UID.slice drop-in,
# the runners slice and the host agent's MemoryMax.
AGENT_UID="$AGENT_UID" bash "$SP_CURRENT/deploy/vm/limits.sh" install

# /data grows online when its disk is made bigger (Premium SSD v2 grows without
# a reboot): a timer extends the ext4 to the disk; never formats, a no-op when
# sizes match (deploy/vm/grow-data.sh).
bash "$SP_CURRENT/deploy/vm/grow-data.sh" install

# Computers made by the backend pull Calvin's latest release (work 052): a timer
# compares the published version with `current` and updates code-only
# (deploy/vm/self-update.sh). A no-op on hosts without /root/calvin-computer.env.
bash "$SP_CURRENT/deploy/vm/self-update.sh" install

# oc-modelproxy (work 077): runners reach their owner's Claude subscription
# through it. Installed from this release (CI built it; deploy/bundle.sh ships it); inert until the host runs as sp-host
# (deploy/vm/sp-host.sh migrate). Never fails the provision.
AGENT_USER="$AGENT_USER" SP_CURRENT="$SP_CURRENT" bash "$SP_CURRENT/deploy/vm/modelproxy.sh" install \
  || warn "oc-modelproxy not installed; sessions stay on the organization's credentials"

# The host agent: a system service running as the agent user. KillMode is the
# default (control-group) on purpose: runners are NOT in this unit's cgroup
# (each is its own transient unit under the user manager), so stopping or
# restarting the host never touches them, while stray children of the host
# itself (housekeeping `git fetch`) are cleaned up. KillMode=process would only
# matter if the host spawned runners as plain children, which it must not do on
# Linux; it would then also leak those children on every restart.
cat > /etc/systemd/system/slack-presence-host.service <<EOF
[Unit]
Description=slack-presence host agent (dials the gateway; starts runners)
Wants=network-online.target
After=network-online.target user@$AGENT_UID.service
Requires=user@$AGENT_UID.service
RequiresMountsFor=$DATA
ConditionPathExists=$HOST_ENV

[Service]
Type=simple
User=$AGENT_USER
Group=$AGENT_USER
WorkingDirectory=$SP_CURRENT
Environment=HOME=$AGENT_HOME
Environment=PATH=$AGENT_PATH
Environment=SP_DATA=$DATA
Environment=SP_RUN=$SP_RUN
Environment=SP_DEFINITION=$SP_CURRENT/definitions/$DEFINITION_NAME.json
Environment=DISABLE_AUTOUPDATER=1
Environment=XDG_RUNTIME_DIR=/run/user/$AGENT_UID
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$AGENT_UID/bus
EnvironmentFile=$SP_CURRENT/.sp-version.env
EnvironmentFile=$HOST_ENV
ExecStart=$SP_CURRENT/node_modules/.bin/tsx src/host/main.ts
Restart=always
RestartSec=2
TimeoutStopSec=15
# MemoryMax: slack-presence-host.service.d/10-limits.conf, from the machine (limits.sh).
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF

# Sessions run tools with bypassPermissions as `agent`. Block the instance
# metadata service for that uid so they cannot read the instance role's or
# service account's credentials, user-data or startup-script metadata. Root
# (SSM agent, Azure guest agent, cloud-init) is unaffected. EC2 and Azure serve
# it on 169.254.169.254; IPv6: fd00:ec2::254 (EC2), fd20:ce::254 (GCE). All
# rules on every cloud.
cat > /etc/systemd/system/slack-presence-imds-block.service <<EOF
[Unit]
Description=Block the cloud instance metadata service (EC2 and Azure IMDS) for the $AGENT_USER user
After=network-pre.target
Before=slack-presence-host.service user@$AGENT_UID.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner $AGENT_UID -j REJECT 2>/dev/null || iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner $AGENT_UID -j REJECT'
ExecStart=-/bin/sh -c 'ip6tables -C OUTPUT -d fd00:ec2::254 -m owner --uid-owner $AGENT_UID -j REJECT 2>/dev/null || ip6tables -I OUTPUT -d fd00:ec2::254 -m owner --uid-owner $AGENT_UID -j REJECT'
ExecStart=-/bin/sh -c 'ip6tables -C OUTPUT -d fd20:ce::254 -m owner --uid-owner $AGENT_UID -j REJECT 2>/dev/null || ip6tables -I OUTPUT -d fd20:ce::254 -m owner --uid-owner $AGENT_UID -j REJECT'

[Install]
WantedBy=multi-user.target
EOF

# The client relay (work 084, src/wire/main.ts): clients reach it through the
# computer's tunnel (`<tunnelId>.w.opencomputer.dev` -> 127.0.0.1:$WIRE_PORT); it
# reaches the host on $SP_RUN/wire/wire.sock and the writers' sockets. Its own
# unit and user, so a client flood or a relay crash never touches the host or a
# runner: Restart=always, 256 MiB, loopback only, no privileges, no sudo, and
# none of host.env (the host token stays the host's). It runs only where the
# host is sp-host (the marker): with the host as $AGENT_USER, sessions could
# reach the wire socket. A restart closes clients with 1012; they reconnect.
cat > /etc/systemd/system/slack-presence-wire.service <<EOF
[Unit]
Description=slack-presence client relay (WebSocket and /files of the Computer API)
After=network-online.target slack-presence-host.service
Wants=network-online.target
ConditionPathExists=$ETC/host-user-sp-host
ConditionPathExists=$SP_CURRENT/dist/wire.js

[Service]
Type=simple
User=$WIRE_USER
Group=$WIRE_USER
SupplementaryGroups=$AGENT_USER
WorkingDirectory=$SP_CURRENT
Environment=SP_RUN=$SP_RUN
Environment=SP_WIRE_LISTEN=127.0.0.1:$WIRE_PORT
Environment=SP_WIRE_SOCKET=$SP_RUN/wire/wire.sock
Environment=SP_REGION=${SP_REGION:-}
EnvironmentFile=$SP_CURRENT/.sp-version.env
ExecStart=$(command -v node) --enable-source-maps $SP_CURRENT/dist/wire.js
Restart=always
RestartSec=1
TimeoutStopSec=10
MemoryMax=256M
TasksMax=256
LimitNOFILE=65536
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
InaccessiblePaths=-$DATA
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now slack-presence-imds-block.service
systemctl start user@"$AGENT_UID".service
# Pick up the slice definition and environment.d (re-read on reload).
runuser -u "$AGENT_USER" -- env XDG_RUNTIME_DIR=/run/user/"$AGENT_UID" systemctl --user daemon-reload || true

# A computer migrated to sp-host (work 077) stays migrated: its users, sudoers and drop-in, re-applied.
# The host already runs as sp-host here, so nothing changes hands under it: the chowns in `apply` change nothing.
# A new computer (no host.env yet: its host has never run) starts migrated; a reverted one stays reverted.
# If that fails, the new computer starts unmigrated rather than not at all (the sp-host workflow migrates it later).
if [[ ! -f $HOST_ENV ]]; then
  install -d -m 0755 "$ETC"; touch "$ETC/host-user-sp-host"
  if ! AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" SP_DATA="$DATA" bash "$SP_CURRENT/deploy/vm/sp-host.sh" apply; then
    warn "could not start this computer's host as sp-host; it runs as $AGENT_USER"
    rm -f "$ETC/host-user-sp-host" /etc/systemd/system/slack-presence-host.service.d/20-sp-host.conf
    systemctl daemon-reload
    AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" bash "$SP_CURRENT/deploy/vm/sp-host.sh" run-dirs
    chown -R "$AGENT_USER:$AGENT_USER" "$DATA/state" "$SP_RUN/traces" 2>/dev/null || true
  fi
fi
AGENT_USER="$AGENT_USER" SP_RUN="$SP_RUN" SP_DATA="$DATA" bash "$SP_CURRENT/deploy/vm/sp-host.sh" apply

# --------------------------------------------------------------------------- host.env
install -d -m 0755 "$ETC"
install -m 0644 "$SP_CURRENT/deploy/vm/host.env.example" "$ETC/host.env.example" 2>/dev/null || true
if [[ -n ${SP_HOST_TOKEN:-} ]]; then
  [[ -n ${SP_GATEWAY_URL:-} ]] || die "SP_HOST_TOKEN given without SP_GATEWAY_URL"
  log "writing $HOST_ENV"
  umask 077
  cat > "$HOST_ENV" <<EOF
# Written by provision.sh. Root-only; systemd reads it for the host agent.
SP_GATEWAY_URL=$SP_GATEWAY_URL
SP_HOST_TOKEN=$SP_HOST_TOKEN
SP_HOST_ID=${SP_HOST_ID:-shared-vm}
EOF
  for k in SP_TELEMETRY_URL SP_TELEMETRY_CREDENTIAL SP_REGION SP_SUBSTRATE; do
    if [[ -n ${!k:-} ]]; then printf '%s=%s\n' "$k" "${!k}" >> "$HOST_ENV"; fi
  done
  umask 022
fi

if [[ -f $HOST_ENV ]]; then
  chmod 0600 "$HOST_ENV"; chown root:root "$HOST_ENV"
  log "starting slack-presence-host"
  systemctl enable slack-presence-host.service
  # Restart picks up the new release; runners are unaffected (see KillMode).
  systemctl restart slack-presence-host.service
  # The relay follows the release too (its clients reconnect after 1012); a no-op unless the host is sp-host.
  systemctl enable -q slack-presence-wire.service
  systemctl restart slack-presence-wire.service || warn "slack-presence-wire did not start: journalctl -u slack-presence-wire"
  sleep 3
  systemctl --no-pager --lines=15 status slack-presence-host.service || true
  systemctl --no-pager --lines=5 status slack-presence-wire.service || true
else
  systemctl enable slack-presence-host.service
  systemctl enable -q slack-presence-wire.service
  log "no $HOST_ENV yet: host agent installed, not started"
  echo "Create it from $ETC/host.env.example (root, mode 0600), then: systemctl start slack-presence-host"
fi

log "done: release $sha, Go $GO_VERSION, $(node --version), data on $(findmnt -no SOURCE "$DATA" 2>/dev/null || echo "$DATA (root disk)")"
