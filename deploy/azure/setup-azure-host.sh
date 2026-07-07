#!/usr/bin/env bash
# setup-azure-host.sh — Provision an Azure VM for OpenSandbox with QEMU backend.
# Run as root on a fresh Ubuntu 24.04 x86_64 instance.
set -euo pipefail

echo "=== OpenSandbox Azure Host Setup ==="

# Architecture detection
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  GOARCH="amd64"; KERNEL_ARCH="x86_64" ;;
    aarch64) GOARCH="arm64";  KERNEL_ARCH="aarch64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
echo "Architecture: $ARCH (Go: $GOARCH)"

# --- System packages ---
echo "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    qemu-system-x86 qemu-utils \
    e2fsprogs git podman uidmap slirp4netns \
    postgresql-client jq curl zstd

# Host kernel extras — provide the zram module for the compressed-swap tier the
# pause/hibernate reclaim uses. zram.ko lives in linux-modules-extra, which the
# Azure base image does NOT ship by default. Install the -azure META package so
# the extras track whatever azure kernel actually boots (the apt upgrade above
# may bump the kernel; a versioned package would then mismatch on reboot). Fall
# back to the currently-booted kernel's versioned package. Non-fatal: without
# zram the disk-swap tier still carries the pause feature (just less dense).
apt-get install -y -qq linux-modules-extra-azure \
    || apt-get install -y -qq "linux-modules-extra-$(uname -r)" \
    || echo "WARNING: linux-modules-extra (zram) not installed — pause tier will fall back to disk swap only"

# --- Docker ---
echo "Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# --- Go ---
GO_VERSION="1.24.1"
if [ ! -d "/usr/local/go" ] || ! /usr/local/go/bin/go version 2>/dev/null | grep -q "$GO_VERSION"; then
    echo "Installing Go $GO_VERSION..."
    rm -rf /usr/local/go
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" | tar -C /usr/local -xzf -
fi
cat > /etc/profile.d/golang.sh << 'EOF'
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
EOF
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
echo "Go: $(/usr/local/go/bin/go version)"

# --- Guest kernel for QEMU ---
# Use a generic Ubuntu kernel (has VIRTIO_BLK=y, VIRTIO_NET=y, VIRTIO_PCI=y built-in).
# We also need vsock and overlay as modules — those get baked into the rootfs image.
#
# The guest kernel is PINNED to an exact version. Hibernate/wake (savevm/loadvm)
# correctness depends on guest kernel behavior, so kernel bumps must be
# deliberate, validated changes — never whatever the Ubuntu archive happens to
# serve on build day. To move the pin: bump GUEST_KVER_PIN, build the image, and
# validate create → hibernate → wake → exec (plus e2fsck of the woken rootfs)
# on dev before any prod roll.
echo "Setting up guest kernel..."
KERNEL_DIR="/opt/opensandbox"
mkdir -p "$KERNEL_DIR"

GUEST_KVER_PIN="6.8.0-117"

# Install the exact pinned kernel (generic flavor: virtio built-in, unlike the
# azure kernel). A missing package fails the build loudly — that's correct for
# a pin; resolve by choosing and validating a new pin, not by unpinning.
apt-get install -y -qq "linux-image-${GUEST_KVER_PIN}-generic"

GENERIC_VMLINUZ="/boot/vmlinuz-${GUEST_KVER_PIN}-generic"
[ -f "$GENERIC_VMLINUZ" ] || GENERIC_VMLINUZ=""
if [ -n "$GENERIC_VMLINUZ" ]; then
    cp "$GENERIC_VMLINUZ" "$KERNEL_DIR/vmlinux"
    chmod 644 "$KERNEL_DIR/vmlinux"
    GENERIC_KVER=$(basename "$GENERIC_VMLINUZ" | sed 's/vmlinuz-//')
    echo "Guest kernel: $GENERIC_VMLINUZ ($GENERIC_KVER)"

    # Install full kernel modules for the guest rootfs.
    # The guest needs modules for Docker networking (bridge, veth, netfilter),
    # vsock, overlay, and virtio_mem. Instead of cherry-picking individual .ko
    # files, install the matching linux-modules package so all dependencies
    # are satisfied and depmod works correctly inside the guest.
    echo "Installing guest kernel modules ($GENERIC_KVER)..."
    apt-get install -y -qq "linux-modules-$GENERIC_KVER" "linux-modules-extra-$GENERIC_KVER" 2>/dev/null || \
        apt-get install -y -qq "linux-modules-$GENERIC_KVER" 2>/dev/null || true

    # Store kernel version for the rootfs build to use
    echo "$GENERIC_KVER" > "$KERNEL_DIR/guest-kernel-version"

    # Validate critical modules exist
    MODDIR="/lib/modules/$GENERIC_KVER"
    for mod in virtio_mem bridge veth; do
        if ! find "$MODDIR" -name "${mod}.ko*" | grep -q .; then
            echo "WARNING: ${mod}.ko not found for kernel $GENERIC_KVER"
        fi
    done
else
    echo "WARNING: No generic kernel found. Guest VMs may not boot correctly."
fi

# --- KVM + vhost-vsock ---
echo "Loading kernel modules..."
modprobe kvm || true

# Load architecture-specific KVM module
case "$ARCH" in
    x86_64)
        modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
        ;;
    aarch64)
        # KVM is built-in on ARM64, no separate module needed
        ;;
esac

modprobe vhost_vsock || true

# Persist modules across reboots
cat > /etc/modules-load.d/kvm.conf << 'EOF'
kvm
vhost_vsock
EOF

# Ensure /dev/kvm and /dev/vhost-vsock are accessible
chmod 666 /dev/kvm 2>/dev/null || true
chmod 666 /dev/vhost-vsock 2>/dev/null || true

# Add udev rule for persistent permissions
cat > /etc/udev/rules.d/99-opensandbox.rules << 'EOF'
KERNEL=="kvm", GROUP="kvm", MODE="0666"
KERNEL=="vhost-vsock", MODE="0666"
EOF

# --- sysctl tuning ---
cat > /etc/sysctl.d/99-opensandbox.conf << 'EOF'
# IP forwarding for VM networking
net.ipv4.ip_forward = 1
net.ipv4.conf.all.route_localnet = 1

# ARP table thresholds (many VMs = many ARP entries)
net.ipv4.neigh.default.gc_thresh1 = 1024
net.ipv4.neigh.default.gc_thresh2 = 4096
net.ipv4.neigh.default.gc_thresh3 = 8192

# File and inotify limits
fs.file-max = 1000000
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 8192

# --- Memory reclaim / pause-tier tuning ---
# The pause/hibernate tier reclaims a paused guest's RAM via explicit
# process_madvise(MADV_PAGEOUT) into swap (zram + disk, set up below). That
# path does not depend on swappiness — so keep swappiness LOW so the kernel's
# *background* reclaim does not eagerly swap out the RAM of running (active)
# guests under transient pressure and add latency. Swap stays available for the
# explicit pageout and for genuine emergencies.
vm.swappiness = 10
# Each QEMU has many memory regions (base RAM, virtio-mem pool, device BARs);
# at high VM density per host the default 65530 map limit can be hit. Raise it.
vm.max_map_count = 1048576
EOF
sysctl --system -q

# --- Memory density: zram compressed swap + KSM (pause-tier prerequisites) ---
# These are the hard prerequisites for the RAM-resident "pause" hibernation
# tier: without a swap target, process_madvise(MADV_PAGEOUT) has nowhere to
# page a paused guest's RAM and reclaim collapses to ~1x. zram is the
# high-priority compressed tier (idle guest pages are zero-heavy, ~3-4x); a
# file-backed disk swap on /data is the lower-priority overflow, set up at
# first boot by the worker cloud-init (it needs /data mounted first).
#
# Sizing is computed at BOOT from live RAM (the AMI builder VM is smaller than
# the runtime worker), so this is a boot-time oneshot, not baked-in numbers.
echo "Installing memory-tuning (zram + KSM) setup..."
cat > /usr/local/bin/opensandbox-memory-setup.sh << 'MEMEOF'
#!/usr/bin/env bash
# Set up the zram compressed-swap tier and enable KSM. Sized from live RAM.
set -euo pipefail

MEM_KB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
MEM_BYTES=$((MEM_KB * 1024))

# --- zram: high-priority compressed swap ---
# Expose 1.5x RAM of logical swap, but hard-cap the REAL RAM zram may consume
# at 40% of RAM (mem_limit). The 1.5x is only reachable when pages compress
# well — which paused guests do — so this never eats more than the cap.
DISKSIZE=$(( MEM_BYTES * 3 / 2 ))
MEMLIMIT=$(( MEM_BYTES * 2 / 5 ))

modprobe zram num_devices=1 2>/dev/null || true
if [ ! -e /sys/block/zram0/disksize ]; then
  echo "zram device not available — skipping zram (disk swap still applies)"
else
  # Idempotent: reset a previously-configured device before reconfiguring.
  if [ "$(cat /sys/block/zram0/disksize)" != "0" ]; then
    swapoff /dev/zram0 2>/dev/null || true
    echo 1 > /sys/block/zram0/reset 2>/dev/null || true
  fi
  echo zstd > /sys/block/zram0/comp_algorithm 2>/dev/null || true
  echo "$MEMLIMIT" > /sys/block/zram0/mem_limit
  echo "$DISKSIZE" > /sys/block/zram0/disksize
  mkswap -U clear /dev/zram0 >/dev/null
  swapon --priority 100 /dev/zram0
  echo "zram0: disksize=$DISKSIZE mem_limit=$MEMLIMIT (zstd), swap priority 100"
fi

# --- KSM: dedup identical guest pages across VMs ---
# QEMU advises guest RAM MADV_MERGEABLE by default (machine mem-merge=on), so
# KSM finds cross-VM duplicates (shared golden pages, zeroed regions) for extra
# density on top of the pause tier. Best-effort — skip cleanly if unsupported.
if [ -d /sys/kernel/mm/ksm ]; then
  echo 1000 > /sys/kernel/mm/ksm/pages_to_scan 2>/dev/null || true
  echo 20   > /sys/kernel/mm/ksm/sleep_millisecs 2>/dev/null || true
  echo 1    > /sys/kernel/mm/ksm/merge_across_nodes 2>/dev/null || true
  echo 1    > /sys/kernel/mm/ksm/run 2>/dev/null || true
  echo "KSM enabled (pages_to_scan=1000 sleep_millisecs=20)"
else
  echo "KSM not supported by kernel — skipping"
fi
MEMEOF
chmod +x /usr/local/bin/opensandbox-memory-setup.sh

cat > /etc/systemd/system/opensandbox-memory.service << 'EOF'
[Unit]
Description=OpenSandbox memory density (zram swap + KSM) for the pause tier
DefaultDependencies=no
After=local-fs.target
# Swap must be online and KSM enabled before the worker launches any guests.
Before=opensandbox-worker.service swap.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/opensandbox-memory-setup.sh
ExecStop=/bin/sh -c 'swapoff /dev/zram0 2>/dev/null || true; echo 1 > /sys/block/zram0/reset 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

# --- Directory structure ---
mkdir -p /data/sandboxes /data/firecracker/images /data/checkpoints /etc/opensandbox

# --- PostgreSQL + Redis containers ---
echo "Starting PostgreSQL and Redis..."
if ! docker ps --format '{{.Names}}' | grep -q '^opensandbox-postgres$'; then
    docker run -d --name opensandbox-postgres \
        --restart unless-stopped \
        -p 5432:5432 \
        -e POSTGRES_USER=opensandbox \
        -e POSTGRES_PASSWORD=opensandbox \
        -e POSTGRES_DB=opensandbox \
        -v /data/postgres:/var/lib/postgresql/data \
        postgres:16
fi

if ! docker ps --format '{{.Names}}' | grep -q '^opensandbox-redis$'; then
    docker run -d --name opensandbox-redis \
        --restart unless-stopped \
        -p 6379:6379 \
        redis:7-alpine
fi

# Wait for PostgreSQL
echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
    if PGPASSWORD=opensandbox psql -h localhost -U opensandbox -d opensandbox -c '\q' 2>/dev/null; then
        break
    fi
    sleep 2
done

# --- systemd units ---
echo "Installing systemd units..."

cat > /etc/systemd/system/opensandbox-worker.service << 'EOF'
[Unit]
Description=OpenSandbox Worker (QEMU backend)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=/sbin/modprobe vhost_vsock
EnvironmentFile=/etc/opensandbox/worker.env
ExecStart=/usr/local/bin/opensandbox-worker
Restart=on-failure
RestartSec=5
LimitNOFILE=1000000
LimitNPROC=infinity
KillMode=process
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/opensandbox-server.service << 'EOF'
[Unit]
Description=OpenSandbox Server
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/opensandbox/server.env
ExecStart=/usr/local/bin/opensandbox-server
Restart=on-failure
RestartSec=5
LimitNOFILE=1000000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable opensandbox-worker opensandbox-server opensandbox-memory

echo "=== Azure host setup complete ==="
echo "  QEMU: $(qemu-system-x86_64 --version | head -1)"
echo "  Go:   $(/usr/local/go/bin/go version)"
echo "  KVM:  $(ls -la /dev/kvm 2>/dev/null || echo 'not available')"
echo "  VSOCK: $(ls -la /dev/vhost-vsock 2>/dev/null || echo 'not available')"
