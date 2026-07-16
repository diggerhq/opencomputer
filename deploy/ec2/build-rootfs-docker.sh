#!/usr/bin/env bash
# build-rootfs-docker.sh — Build ext4 rootfs images using Docker (no Podman needed)
#
# Designed to run ON an EC2 instance (Amazon Linux 2023) where Podman isn't available.
# Uses Docker instead for the container build + export steps.
#
# Usage:
#   sudo ./deploy/ec2/build-rootfs-docker.sh AGENT_BIN IMAGES_DIR [IMAGE_NAME]
#
# Example:
#   sudo ./deploy/ec2/build-rootfs-docker.sh /usr/local/bin/osb-agent /data/firecracker/images default
#
# Requirements:
#   - Docker (installed by user_data)
#   - e2fsprogs (installed by user_data)
#   - Root privileges (for mount/umount)

set -euo pipefail

AGENT_BIN="${1:?Usage: $0 AGENT_BIN IMAGES_DIR [IMAGE_NAME]}"
IMAGES_DIR="${2:?Usage: $0 AGENT_BIN IMAGES_DIR [IMAGE_NAME]}"
IMAGE_NAME="${3:-default}"

# DISK_LAYOUT selects the block topology this base image is built for:
#   split  (default) — legacy two-disk: a 4GB rootfs (OS) + a separate workspace
#                      disk (vdb) mounted at /home/sandbox.
#   merged           — single-disk: OS and /home/sandbox on ONE ~20GB rootfs, no
#                      vdb. The rootfs image content is identical (same init,
#                      which already no-ops the vdb mount when no vdb is present);
#                      only the size floor differs so /home/sandbox has room.
DISK_LAYOUT="${DISK_LAYOUT:-split}"
if [ "$DISK_LAYOUT" = "merged" ]; then
    EXT4_SIZE_MB="${EXT4_SIZE_MB:-20480}"
    ROOTFS_MIN_MB="${ROOTFS_MIN_MB:-20480}"
else
    EXT4_SIZE_MB="${EXT4_SIZE_MB:-4096}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKERFILE_DIR="$PROJECT_ROOT/deploy/firecracker/rootfs"
DOCKERFILE="$DOCKERFILE_DIR/Dockerfile.${IMAGE_NAME}"

log() { echo "[build-rootfs-docker] $*"; }
err() { echo "[build-rootfs-docker] ERROR: $*" >&2; }

# Validate
if [ "$(id -u)" -ne 0 ]; then
    err "This script requires root privileges (for mount/umount)."
    err "Run with: sudo $0 $*"
    exit 1
fi

if [ ! -f "$AGENT_BIN" ]; then
    err "Agent binary not found: $AGENT_BIN"
    exit 1
fi

if [ ! -f "$DOCKERFILE" ]; then
    err "Dockerfile not found: $DOCKERFILE"
    exit 1
fi

command -v docker &>/dev/null || { err "Docker not found"; exit 1; }
command -v mkfs.ext4 &>/dev/null || { err "mkfs.ext4 not found (install e2fsprogs)"; exit 1; }

log "Building $IMAGE_NAME rootfs from $DOCKERFILE"

TMPDIR=$(mktemp -d /tmp/osb-rootfs-docker-XXXXXXXX)
trap 'rm -rf $TMPDIR' EXIT

# Copy Dockerfile to build context
cp "$DOCKERFILE" "$TMPDIR/Dockerfile"

# Copy agent binary
cp "$AGENT_BIN" "$TMPDIR/osb-agent"
chmod +x "$TMPDIR/osb-agent"

# Generate init script (same as scripts/build-rootfs.sh)
cat > "$TMPDIR/init" << 'INIT_EOF'
#!/bin/busybox sh
# OpenSandbox VM init script — PID 1 inside Firecracker microVM

# Mount minimal virtual filesystems needed for setup
mount -t proc proc /proc
mount -t devtmpfs devtmpfs /dev

# Load kernel modules (needed for QEMU with modular kernel)
if [ -d /lib/modules/vsock ]; then
    for mod in /lib/modules/vsock/vsock.ko /lib/modules/vsock/vmw_vsock_virtio_transport_common.ko /lib/modules/vsock/vmw_vsock_virtio_transport.ko; do
        [ -f "$mod" ] && insmod "$mod" 2>/dev/null || true
    done
    echo "init: kernel modules loaded"
fi

# Load virtio-mem module (for dynamic memory scaling)
# Try modprobe first (handles signatures + deps), fall back to insmod.
# This is best-effort at boot — golden snapshot creation will fail hard if not loaded.
if command -v modprobe >/dev/null 2>&1; then
    modprobe virtio_mem 2>/dev/null && echo "init: virtio_mem loaded (modprobe)" || true
else
    for vmem in "/lib/modules/$(uname -r)/kernel/drivers/virtio/virtio_mem.ko" "/lib/modules/vsock/virtio_mem.ko"; do
        if [ -f "$vmem" ]; then
            insmod "$vmem" 2>/dev/null || true
            echo "init: virtio_mem loaded ($vmem)"
            break
        fi
    done
fi

# ── Mount workspace: data disk at /home/sandbox (persistent user data) ──
# /workspace is a symlink to /home/sandbox, so mount the real path.
mkdir -p /home/sandbox
if mount /dev/vdb /home/sandbox 2>/dev/null || mount /dev/vdb1 /home/sandbox 2>/dev/null; then
    chown sandbox:sandbox /home/sandbox 2>/dev/null
    echo "init: workspace mounted (/dev/vdb -> /home/sandbox)"
else
    # No vdb attached — merged single-disk layout. /home/sandbox is a directory
    # on the rootfs (persistent, captured in checkpoints/snapshots), not ephemeral.
    mkdir -p /home/sandbox
    chown sandbox:sandbox /home/sandbox 2>/dev/null
    echo "init: single-disk (merged) layout — /home/sandbox on rootfs"
fi

# ── Mount virtual filesystems (in the final root) ──
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mount -t tmpfs tmpfs /tmp
mount -t tmpfs tmpfs /run

[ -c /dev/null ] || mknod -m 666 /dev/null c 1 3
[ -c /dev/zero ] || mknod -m 666 /dev/zero c 1 5
[ -c /dev/random ] || mknod -m 444 /dev/random c 1 8
[ -c /dev/urandom ] || mknod -m 444 /dev/urandom c 1 9
[ -c /dev/tty ] || mknod -m 666 /dev/tty c 5 0
[ -c /dev/console ] || mknod -m 600 /dev/console c 5 1
[ -d /dev/pts ] || mkdir -p /dev/pts
mount -t devpts devpts /dev/pts
[ -d /dev/shm ] || mkdir -p /dev/shm
mount -t tmpfs tmpfs /dev/shm

for param in $(cat /proc/cmdline); do
    case "$param" in
        ip=*)
            IP_CONFIG="${param#ip=}"
            GUEST_IP=$(echo "$IP_CONFIG" | cut -d: -f1)
            GATEWAY=$(echo "$IP_CONFIG" | cut -d: -f3)
            NETMASK=$(echo "$IP_CONFIG" | cut -d: -f4)
            IFACE=$(echo "$IP_CONFIG" | cut -d: -f6)
            ;;
        osb.gateway=*)
            GATEWAY="${param#osb.gateway=}"
            ;;
    esac
done

if [ -n "$GUEST_IP" ] && [ -n "$IFACE" ]; then
    ip link set lo up
    ip addr add "${GUEST_IP}/30" dev "$IFACE"
    ip link set "$IFACE" up
    if [ -n "$GATEWAY" ]; then
        ip route add default via "$GATEWAY" dev "$IFACE"
    fi
fi

echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf

hostname sandbox

# Debug: check for virtio-serial device
ls -la /dev/vport* /dev/virtio-ports/ 2>/dev/null || echo "init: no virtio-serial devices found"

# ── Cgroup v2: sandbox resource limits ──
# Agent (PID 1) stays in root cgroup (protected from user resource exhaustion).
# User processes are placed in /sys/fs/cgroup/sandbox/ by the agent's exec handler.
mkdir -p /sys/fs/cgroup
mount -t cgroup2 cgroup2 /sys/fs/cgroup 2>/dev/null
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # Enable controllers in root
    echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
    # Create sandbox cgroup
    mkdir -p /sys/fs/cgroup/sandbox
    # Defaults: 4096 pids, 90% of total memory, 90% of CPUs.
    # 4096 is enough headroom for typical dev tooling (npm install, go test,
    # multi-process build systems) while still bounding fork-bomb damage.
    # The previous default of 128 was below an interactive shell + LSP +
    # build agent working set, and customers hit "fork failed: resource
    # temporarily unavailable" inside otherwise-idle sandboxes.
    # CPU limit reserves 10% for the agent (PID 1) so it stays responsive
    # even under fork bomb / CPU exhaustion attacks.
    echo 4096 > /sys/fs/cgroup/sandbox/pids.max
    SANDBOX_MEM=$(awk '/MemTotal/{printf "%.0f", $2 * 1024 * 0.9}' /proc/meminfo)
    echo "$SANDBOX_MEM" > /sys/fs/cgroup/sandbox/memory.max 2>/dev/null
    # cpu.max: limit user processes to 80% of available CPUs.
    # This reserves 20% for the agent (PID 1) so it stays responsive
    # even under fork bomb / CPU saturation.
    NUM_CPUS=$(nproc)
    CPU_MAX=$(( 80000 * NUM_CPUS ))
    echo "$CPU_MAX 100000" > /sys/fs/cgroup/sandbox/cpu.max 2>/dev/null
    # cpu.weight: lower priority than agent
    echo 50 > /sys/fs/cgroup/sandbox/cpu.weight 2>/dev/null
    echo "init: cgroup sandbox ready (pids=4096, mem=${SANDBOX_MEM}, cpu=${CPU_MAX}/100000)"
else
    echo "init: warning: cgroup v2 not available"
fi

# Note: user commands run as root inside the VM. This is safe because:
# - Each VM is fully isolated (separate QEMU process, separate kernel)
# - cgroup v2 prevents processes inside a cgroup from modifying their own limits
# - The agent (PID 1) is in the root cgroup, user processes in /sandbox cgroup

exec /usr/local/bin/osb-agent
INIT_EOF
chmod +x "$TMPDIR/init"

# Copy claude-agent-wrapper source (for images that include it)
WRAPPER_DIR="$PROJECT_ROOT/scripts/claude-agent-wrapper"
if [ -d "$WRAPPER_DIR" ]; then
    mkdir -p "$TMPDIR/scripts"
    cp -r "$WRAPPER_DIR" "$TMPDIR/scripts/claude-agent-wrapper"
fi

# Append agent/init injection to Dockerfile
cat >> "$TMPDIR/Dockerfile" << 'INJECT_EOF'

# --- OpenSandbox agent injection ---
# Create sandbox user (UID 1000) for exec sessions — agent runs as root (PID 1),
# but user commands run as this non-root user for cgroup/security isolation.
RUN useradd -m -u 1000 -s /bin/bash sandbox && \
    echo 'sandbox ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    chown sandbox:sandbox /workspace 2>/dev/null || true
COPY osb-agent /usr/local/bin/osb-agent
RUN chmod +x /usr/local/bin/osb-agent
# PID 1 is our custom init at /sbin/init (it execs osb-agent). That path is
# normally owned by systemd-sysv, which ships /sbin/init as a symlink to
# systemd. The base image has systemd-sysv removed so the path is ours — but a
# user image build that runs `apt install` of anything pulling libpam-systemd
# (cups, at-spi, many GUI/browser libs) drags systemd-sysv back in, and its
# maintainer scripts reclaim /sbin/init -> /lib/systemd/systemd. The finalized
# image then cold-boots systemd instead of osb-agent, the agent socket never
# comes up, and the build fails at finalize with "agent not ready after 30s".
# dpkg-divert redirects any future packaged /sbin/init to /sbin/init.distrib so
# our init stays PID 1 no matter what the guest installs. Must run BEFORE we
# place our init so the diversion is registered against the path first.
RUN dpkg-divert --local --rename --divert /sbin/init.distrib /sbin/init
COPY init /sbin/init
RUN chmod +x /sbin/init
RUN mkdir -p /mnt/data /mnt/overlay
INJECT_EOF

# Build with Docker
log "Building container image..."
docker build --no-cache -t "osb-rootfs-${IMAGE_NAME}:build" -f "$TMPDIR/Dockerfile" "$TMPDIR"

# Create container and export filesystem
log "Exporting filesystem..."
docker rm -f osb-rootfs-tmp 2>/dev/null || true
docker create --name osb-rootfs-tmp "osb-rootfs-${IMAGE_NAME}:build" /bin/true
docker export osb-rootfs-tmp -o "$TMPDIR/rootfs.tar"
docker rm -f osb-rootfs-tmp

# Convert tar to ext4. When ROOTFS_UUID is set (by caller), stamp that UUID into
# the filesystem so identical inputs produce byte-identical ext4 output — the
# goldenVersion (sha256 of the file) then stays stable across builds that
# didn't actually change the rootfs content. When unset, mkfs generates a
# random UUID (previous behaviour), which makes every build produce a new
# goldenVersion even for identical inputs.
# Eagerly initialize the inode tables + journal at mkfs time. Default (lazy)
# init leaves most inode-table groups uninitialized, so ext4lazyinit zeroes them
# in the BACKGROUND on first mount of every sandbox — and a 20GB fs has ~5x the
# inode tables of the 4GB split rootfs. Under a create-burst that background I/O
# contends and starves the in-guest agent, producing multi-second (sometimes
# ~30s) agent-ready times. Eager init pays that cost once, at build.
MKFS_E="lazy_itable_init=0,lazy_journal_init=0"

# Resolve guest kernel version once (shared across every ext4 we emit).
GUEST_KVER_FILE="/opt/opensandbox/guest-kernel-version"
if [ -f "$GUEST_KVER_FILE" ]; then
    GUEST_KVER=$(cat "$GUEST_KVER_FILE")
elif ls -d /lib/modules/*-generic >/dev/null 2>&1; then
    GUEST_KVER=$(ls -d /lib/modules/*-generic | sort -V | tail -1 | xargs basename)
fi

# make_ext4 OUTNAME SIZE_MB FLOOR_MB — build a populated ext4 from rootfs.tar.
# Merged and split bases have IDENTICAL content (the init already no-ops the vdb
# mount when no vdb is present); only the size/floor differ. So one rootfs build
# emits both default.ext4 (4GB split) and default-merged.ext4 (20GB merged),
# letting one worker image carry both so enabling merged-create is a pure env
# flip (OPENSANDBOX_GOLDEN_DISK_LAYOUT=merged) rather than an image rebuild.
make_ext4() {
    local outname="$1" size_mb="$2" floor_mb="$3"
    local ext4_path="$TMPDIR/${outname}.ext4"
    log "Converting to ext4 (${outname}: ${size_mb}MB, floor ${floor_mb}MB)..."
    rm -f "$ext4_path"
    truncate -s "${size_mb}M" "$ext4_path"
    if [ -n "${ROOTFS_UUID:-}" ]; then
        mkfs.ext4 -q -F -L rootfs -U "$ROOTFS_UUID" -E "hash_seed=$ROOTFS_UUID,$MKFS_E" "$ext4_path"
    else
        mkfs.ext4 -q -F -L rootfs -E "$MKFS_E" "$ext4_path"
    fi

    local mnt_dir="$TMPDIR/mnt"
    mkdir -p "$mnt_dir"
    mount -o loop "$ext4_path" "$mnt_dir"

    tar xf "$TMPDIR/rootfs.tar" -C "$mnt_dir"

    # Ensure key directories exist (workspace is created by Dockerfile)
    for dir in proc sys dev dev/pts dev/shm tmp run; do
        mkdir -p "$mnt_dir/$dir"
    done

    # Inject guest kernel modules (full /lib/modules/<kver> tree — Docker
    # networking, vsock, overlay, virtio_mem, etc. with correct dependencies).
    if [ -n "${GUEST_KVER:-}" ] && [ -d "/lib/modules/$GUEST_KVER" ]; then
        rm -rf "$mnt_dir/lib/modules"/*
        mkdir -p "$mnt_dir/lib/modules"
        cp -a "/lib/modules/$GUEST_KVER" "$mnt_dir/lib/modules/"
        depmod -b "$mnt_dir" "$GUEST_KVER" 2>/dev/null || log "depmod failed (non-fatal)"
        local mod_count
        mod_count=$(find "$mnt_dir/lib/modules/$GUEST_KVER" -name "*.ko*" | wc -l)
        log "Injected $mod_count modules for kernel $GUEST_KVER"
    else
        log "WARNING: No guest kernel modules found — Docker networking and virtio_mem will not work"
    fi

    sync
    umount "$mnt_dir"

    # Shrink to a usable floor — the ext4 is inside a qcow2 COW overlay, so unused
    # space costs nothing on disk.
    log "Resizing ${outname} to ${floor_mb}MB floor (sparse)..."
    resize2fs "$ext4_path" "${floor_mb}M" 2>/dev/null || log "resize2fs failed (non-fatal)"

    mkdir -p "$IMAGES_DIR"
    cp "$ext4_path" "$IMAGES_DIR/${outname}.ext4"
    log "Done: $IMAGES_DIR/${outname}.ext4 ($(du -h "$IMAGES_DIR/${outname}.ext4" | cut -f1))"
}

# assert_merged_base FILE MIN_MB — fail the build unless FILE is a valid ext4
# whose FILESYSTEM (not just the file) is at least ~MIN_MB. Catches a resize2fs
# that silently left the merged base at the 4GB split size. Since merged-create
# is the default, a bad merged base bricks every worker's golden build — so this
# is fatal on purpose.
assert_merged_base() {
    local f="$1" min_mb="$2" blocks bsize fs_mb
    [ -f "$f" ] || { err "merged base $f missing after derivation"; exit 1; }
    dumpe2fs -h "$f" >/dev/null 2>&1 || { err "merged base $f is not a valid ext4"; exit 1; }
    blocks=$(dumpe2fs -h "$f" 2>/dev/null | awk -F: '/Block count/{gsub(/ /,"",$2);print $2}')
    bsize=$(dumpe2fs -h "$f" 2>/dev/null | awk -F: '/Block size/{gsub(/ /,"",$2);print $2}')
    fs_mb=$(( blocks * bsize / 1024 / 1024 ))
    if [ "$fs_mb" -lt $(( min_mb * 95 / 100 )) ]; then
        err "merged base $f filesystem is ${fs_mb}MB, expected ~${min_mb}MB — resize2fs failed"
        exit 1
    fi
    log "merged base verified: ${fs_mb}MB ext4"
}

ROOTFS_MIN_MB="${ROOTFS_MIN_MB:-4096}"

# Primary base for this build's configured layout.
make_ext4 "$IMAGE_NAME" "$EXT4_SIZE_MB" "$ROOTFS_MIN_MB"

# Companion merged base: alongside the split "default" build, ship
# default-merged.ext4 so one worker image carries both bases (enabling merged-
# create is then a pure OPENSANDBOX_GOLDEN_DISK_LAYOUT=merged flip). The two are
# byte-identical content; the merged one is just grown to 20GB. Derive it from
# the split base (cp, grow the file, resize2fs the ext4) rather than a fresh
# mkfs so it can be reproduced from a CACHED default.ext4 with no rootfs tar —
# the Packer worker-image build applies the exact same derivation on a rootfs-
# cache hit. Merged-create is the DEFAULT, so a missing/wrong-sized merged base
# would brick every worker's golden build — assert_merged_base fails the build
# loudly rather than shipping a bad image. Skipped for the merged build itself,
# non-default templates, or EMIT_MERGED_VARIANT=0.
if [ "$IMAGE_NAME" = "default" ] && [ "$DISK_LAYOUT" != "merged" ] && [ "${EMIT_MERGED_VARIANT:-1}" = "1" ]; then
    MERGED_SIZE_MB="${MERGED_SIZE_MB:-20480}"
    MERGED_PATH="$IMAGES_DIR/default-merged.ext4"
    log "Deriving companion merged base default-merged.ext4 (${MERGED_SIZE_MB}MB) from ${IMAGE_NAME}.ext4..."
    cp --reflink=auto "$IMAGES_DIR/${IMAGE_NAME}.ext4" "$MERGED_PATH" 2>/dev/null \
        || cp "$IMAGES_DIR/${IMAGE_NAME}.ext4" "$MERGED_PATH"
    truncate -s "${MERGED_SIZE_MB}M" "$MERGED_PATH"           # grow the file before growing the fs
    e2fsck -fy "$MERGED_PATH" >/dev/null 2>&1 || true          # resize2fs needs a clean fs
    resize2fs "$MERGED_PATH" "${MERGED_SIZE_MB}M"              # grow the ext4 to fill (fatal via set -e)
    assert_merged_base "$MERGED_PATH" "$MERGED_SIZE_MB"
    log "Done: $MERGED_PATH ($(du -h "$MERGED_PATH" | cut -f1))"
fi

# Clean up Docker image
docker rmi -f "osb-rootfs-${IMAGE_NAME}:build" &>/dev/null || true
