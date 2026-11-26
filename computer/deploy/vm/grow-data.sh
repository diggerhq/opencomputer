#!/usr/bin/env bash
# Grow /data's ext4 filesystem online when its disk got bigger (work 052: a
# computer's Premium SSD v2 data disk is grown in Azure without a reboot).
#
# provision.sh runs `grow-data.sh install`: it copies itself to
# /usr/local/sbin/slack-presence-grow-data, run by slack-presence-grow-data.timer
# a minute after boot and every 10 minutes after.
#
# Invariants:
# - Never formats, never creates or deletes a partition, never touches a
#   filesystem that is not the mounted ext4 labelled sp-data at /data.
# - A no-op (exit 0, no writes) when the filesystem already fills its device.
# - provision.sh formats the whole device (no partition table). A partition
#   (a data disk made elsewhere, e.g. restored from an older host's snapshot)
#   is first extended to the end of its disk with growpart, if installed.
# - resize2fs on a mounted ext4 only grows, online; it never shrinks it.
set -euo pipefail

DATA=/data
DATA_LABEL=sp-data
MIN_GROW=$(( 64 * 1024 * 1024 ))   # ignore slack smaller than this (alignment)

if [[ ${1:-} == install ]]; then
  install -m 0755 "${BASH_SOURCE[0]}" /usr/local/sbin/slack-presence-grow-data
  cat > /etc/systemd/system/slack-presence-grow-data.service <<EOF
# Written by deploy/vm/grow-data.sh install.
[Unit]
Description=Grow $DATA to the size of its disk
ConditionPathIsMountPoint=$DATA

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/slack-presence-grow-data
EOF
  cat > /etc/systemd/system/slack-presence-grow-data.timer <<EOF
# Written by deploy/vm/grow-data.sh install.
[Unit]
Description=Grow $DATA when its disk was made bigger

[Timer]
OnBootSec=1min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now slack-presence-grow-data.timer
fi

mountpoint -q "$DATA" || { echo "$DATA not mounted; nothing to grow"; exit 0; }
dev="$(findmnt -no SOURCE "$DATA")"
[[ -b $dev ]] || { echo "$DATA is on $dev, not a block device; nothing to grow"; exit 0; }
fstype="$(findmnt -no FSTYPE "$DATA")"
label="$(blkid -o value -s LABEL "$dev" 2>/dev/null || true)"
if [[ $fstype != ext4 || $label != "$DATA_LABEL" ]]; then
  echo "$DATA is $fstype label '$label' on $dev, not ext4 '$DATA_LABEL'; not touching it"; exit 0
fi

# The kernel learns a new disk size from the device; ask it to look again.
# SCSI (older sizes): rescan the device. NVMe (v6/v7 sizes): the controller
# usually reports a namespace change by itself; rescan to be sure.
disk="$(lsblk -no PKNAME "$dev" | head -1)"
[[ -n $disk ]] || disk="$(basename "$dev")"
if [[ -w /sys/class/block/$disk/device/rescan ]]; then
  echo 1 > "/sys/class/block/$disk/device/rescan" || true
elif [[ $disk == nvme* && -w /sys/class/block/$disk/device/rescan_controller ]]; then
  echo 1 > "/sys/class/block/$disk/device/rescan_controller" || true
fi
udevadm settle --timeout=10 || true

if [[ "$(lsblk -dno TYPE "$dev")" == part ]]; then
  partnum="$(cat "/sys/class/block/$(basename "$dev")/partition")"
  if command -v growpart >/dev/null; then
    # growpart --dry-run exits 0 only when the partition can grow.
    if growpart --dry-run "/dev/$disk" "$partnum" >/dev/null 2>&1; then
      echo "growing partition $partnum of /dev/$disk"
      growpart "/dev/$disk" "$partnum"
      udevadm settle --timeout=10 || true
    fi
  else
    echo "$dev is a partition and growpart is not installed (cloud-guest-utils); growing the filesystem only"
  fi
fi

dev_bytes="$(blockdev --getsize64 "$dev")"
fs_bytes="$(dumpe2fs -h "$dev" 2>/dev/null | awk -F: '/^Block count:/ {c=$2} /^Block size:/ {s=$2} END {printf "%.0f\n", c * s}')"
[[ $dev_bytes =~ ^[0-9]+$ && $fs_bytes =~ ^[0-9]+$ && $fs_bytes -gt 0 ]] \
  || { echo "cannot read sizes of $dev (device '$dev_bytes', filesystem '$fs_bytes')" >&2; exit 1; }
if (( dev_bytes - fs_bytes < MIN_GROW )); then
  exit 0   # already the size of its device: the common case, say nothing
fi
echo "growing $DATA on $dev: filesystem $((fs_bytes >> 30)) GiB, device $((dev_bytes >> 30)) GiB"
resize2fs "$dev"
df -h "$DATA"
