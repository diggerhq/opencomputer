package qemu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// mergedVariantSuffix names the cache dir of a checkpoint's converted merged
// variant, e.g. "cp-abc123-merged".
const mergedVariantSuffix = "-merged"

// maybeConvertToMergedVariant implements convert-on-fork: when this worker
// creates merged sandboxes, a fork of a legacy SPLIT, disk_only checkpoint is
// transparently served from a memoized MERGED variant instead of a split box,
// so "any new box is merged" holds even for forks of pre-merge templates.
//
// It returns the checkpointID to actually fork from — the merged variant's ID
// when a conversion applies (building it once, on first fork), or "" when no
// conversion is needed (the caller then forks the original as-is). RAM-bearing
// (full) checkpoints are never converted: loadvm welds the saved device model
// to the two-disk topology, so converting would discard process state.
func (m *Manager) maybeConvertToMergedVariant(ctx context.Context, checkpointID string) (string, error) {
	// Only convert when this worker creates merged boxes. On a split worker,
	// forks stay split (dual-mode).
	if !IsMerged(m.cfg.GoldenLayout) {
		return "", nil
	}
	// Don't recurse on an already-merged variant.
	if strings.HasSuffix(checkpointID, mergedVariantSuffix) {
		return "", nil
	}

	srcCacheDir := m.checkpointCacheDir(checkpointID)
	metaPath := filepath.Join(srcCacheDir, "snapshot", "snapshot-meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return "", nil // no local meta — let the normal fork path handle it
	}
	var meta SnapshotMeta
	if json.Unmarshal(data, &meta) != nil {
		return "", nil
	}

	// Already merged → nothing to convert.
	if IsMerged(meta.DiskLayout) {
		return "", nil
	}
	// Only disk_only checkpoints can be converted (no RAM to discard).
	if !isDiskOnlyCheckpoint(srcCacheDir) {
		return "", nil
	}

	mergedID := checkpointID + mergedVariantSuffix
	mergedCacheDir := m.checkpointCacheDir(mergedID)
	if mergedVariantReady(mergedCacheDir) {
		return mergedID, nil // memoized hit
	}

	// Collapse concurrent conversions of the same checkpoint.
	_, err, _ = m.convertSF.Do(mergedID, func() (interface{}, error) {
		if mergedVariantReady(mergedCacheDir) {
			return nil, nil
		}
		log.Printf("qemu: convert-on-fork: building merged variant of %s → %s", checkpointID, mergedID)
		t0 := time.Now()
		if err := m.buildMergedVariant(ctx, srcCacheDir, mergedCacheDir, meta); err != nil {
			return nil, err
		}
		log.Printf("qemu: convert-on-fork: merged variant %s ready (%dms)", mergedID, time.Since(t0).Milliseconds())
		return nil, nil
	})
	if err != nil {
		return "", fmt.Errorf("convert %s to merged: %w", checkpointID, err)
	}
	return mergedID, nil
}

// isDiskOnlyCheckpoint reports whether a checkpoint cache holds only disk state
// (no savevm internal snapshot / no memory dump) — the only kind convertible to
// merged, since it cold-boots rather than loadvm-restoring a device model.
func isDiskOnlyCheckpoint(cacheDir string) bool {
	return !fileExists(filepath.Join(cacheDir, "snapshot-name")) &&
		!fileExists(filepath.Join(cacheDir, "mem")) &&
		!fileExists(filepath.Join(cacheDir, "mem.zst"))
}

// mergedVariantReady reports whether a merged variant cache dir is fully built.
func mergedVariantReady(cacheDir string) bool {
	return fileExists(filepath.Join(cacheDir, "rootfs.qcow2")) &&
		fileExists(filepath.Join(cacheDir, "snapshot", "snapshot-meta.json"))
}

// buildMergedVariant produces a merged (single-disk) checkpoint from a split
// disk_only checkpoint: flatten the split rootfs into a self-contained image,
// grow it to the merged default size, fold the workspace's contents into
// /home/sandbox, and publish it atomically with merged metadata.
//
// The result is a SELF-CONTAINED (backing-less) rootfs, tagged merged with an
// empty GoldenVersion — the split OS bytes differ from the merged golden's, so
// it can't be safely rebased onto it; ensureCheckpointRebased skips it.
//
// Requires a Linux host with qemu-nbd + root (the fold step loop-mounts qcow2s).
func (m *Manager) buildMergedVariant(ctx context.Context, srcCacheDir, dstCacheDir string, srcMeta SnapshotMeta) error {
	staging := dstCacheDir + ".staging"
	os.RemoveAll(staging)
	if err := os.MkdirAll(filepath.Join(staging, "snapshot"), 0755); err != nil {
		return fmt.Errorf("mkdir staging: %w", err)
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(staging)
		}
	}()

	srcRootfs := filepath.Join(srcCacheDir, "rootfs.qcow2")
	srcWorkspace := filepath.Join(srcCacheDir, "workspace.qcow2")
	dstRootfs := filepath.Join(staging, "rootfs.qcow2")

	// Point the split rootfs at its correct base so the flatten below pulls in
	// the full OS (best-effort — resolveBaseForVersion may need the store).
	if srcMeta.GoldenVersion != "" {
		if basePath, berr := m.resolveBaseForVersion(ctx, srcMeta.GoldenVersion); berr == nil {
			if rerr := rebaseMetadataOnly(ctx, srcRootfs, basePath); rerr != nil {
				log.Printf("qemu: convert-on-fork: pre-flatten rebase of %s failed (continuing): %v", srcRootfs, rerr)
			}
		}
	}

	// 1. Copy + flatten the split rootfs into a self-contained image (merges the
	//    backing base into the overlay; preserves internal state).
	if err := copyFileReflink(srcRootfs, dstRootfs); err != nil {
		return fmt.Errorf("copy rootfs: %w", err)
	}
	if out, err := exec.CommandContext(ctx, "qemu-img", "rebase", "-b", "", dstRootfs).CombinedOutput(); err != nil {
		return fmt.Errorf("flatten rootfs: %w (%s)", err, strings.TrimSpace(string(out)))
	}

	// 2. Grow the image to the merged default size (region past the old ext4
	//    reads as zeros until resize2fs in the fold step extends the fs).
	targetMB := m.cfg.DefaultDiskMB
	if targetMB <= 0 {
		targetMB = 20480
	}
	if err := ResizeWorkspace(dstRootfs, targetMB); err != nil {
		return fmt.Errorf("grow rootfs to %dMB: %w", targetMB, err)
	}

	// 3. Fold the workspace's /home/sandbox data into the merged rootfs (also
	//    grows the root ext4 to fill the resized image).
	if fileExists(srcWorkspace) {
		if err := foldWorkspaceIntoRootfs(ctx, dstRootfs, srcWorkspace); err != nil {
			return fmt.Errorf("fold workspace into rootfs: %w", err)
		}
	} else {
		// No workspace to fold — still grow the ext4 to fill the image.
		if err := growRootfsFilesystem(ctx, dstRootfs); err != nil {
			return fmt.Errorf("grow rootfs filesystem: %w", err)
		}
	}

	// 4. Write merged metadata: self-contained (no GoldenVersion), single disk.
	mergedMeta := srcMeta
	mergedMeta.DiskLayout = LayoutMerged
	mergedMeta.GoldenVersion = ""
	mergedMeta.WorkspacePath = ""
	mergedMeta.RootfsPath = ""
	mergedMeta.SnapshotedAt = time.Now()
	metaJSON, _ := json.Marshal(&mergedMeta)
	if err := os.WriteFile(filepath.Join(staging, "snapshot", "snapshot-meta.json"), metaJSON, 0644); err != nil {
		return fmt.Errorf("write merged meta: %w", err)
	}

	// 5. Publish atomically under the cache write lock.
	m.checkpointCacheMu.Lock()
	os.RemoveAll(dstCacheDir)
	renameErr := os.Rename(staging, dstCacheDir)
	m.checkpointCacheMu.Unlock()
	if renameErr != nil {
		return fmt.Errorf("publish merged variant: %w", renameErr)
	}
	success = true
	return nil
}

// foldWorkspaceIntoRootfs loop-mounts the (resized) merged rootfs and the split
// workspace via qemu-nbd, grows the root ext4 to fill the image, then rsyncs the
// workspace's contents into /home/sandbox. Linux + qemu-nbd + root only.
func foldWorkspaceIntoRootfs(ctx context.Context, rootfsQcow2, workspaceQcow2 string) error {
	return runNBDScript(ctx, foldScript, rootfsQcow2, workspaceQcow2)
}

// growRootfsFilesystem grows the root ext4 to fill a resized image when there is
// no workspace to fold.
func growRootfsFilesystem(ctx context.Context, rootfsQcow2 string) error {
	return runNBDScript(ctx, growScript, rootfsQcow2)
}

func runNBDScript(ctx context.Context, script string, args ...string) error {
	cmdArgs := append([]string{"-c", script, "fold"}, args...)
	cmd := exec.CommandContext(ctx, "bash", cmdArgs...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// foldScript connects the rootfs (rw) and workspace (ro) via qemu-nbd, grows the
// root ext4, and copies workspace → /home/sandbox. $1=rootfs.qcow2 $2=workspace.qcow2
const foldScript = `
set -euo pipefail
ROOTFS="$1"; WS="$2"
modprobe nbd max_part=8 2>/dev/null || true
pick_nbd() {
  for i in $(seq 0 15); do
    if [ -e "/dev/nbd$i" ] && [ ! -s "/sys/block/nbd$i/pid" ]; then echo "/dev/nbd$i"; return 0; fi
  done
  return 1
}
NBD_ROOT=$(pick_nbd) || { echo "no free nbd device"; exit 1; }
qemu-nbd --connect="$NBD_ROOT" "$ROOTFS"
sleep 0.5
NBD_WS=$(pick_nbd) || { qemu-nbd --disconnect "$NBD_ROOT" 2>/dev/null || true; echo "no free nbd device (2)"; exit 1; }
qemu-nbd --connect="$NBD_WS" --read-only "$WS"
sleep 0.5
MNT_ROOT=$(mktemp -d); MNT_WS=$(mktemp -d)
cleanup() {
  umount "$MNT_WS" 2>/dev/null || true
  umount "$MNT_ROOT" 2>/dev/null || true
  qemu-nbd --disconnect "$NBD_WS" 2>/dev/null || true
  qemu-nbd --disconnect "$NBD_ROOT" 2>/dev/null || true
  rmdir "$MNT_ROOT" "$MNT_WS" 2>/dev/null || true
}
trap cleanup EXIT
e2fsck -fy "$NBD_ROOT" || true
resize2fs "$NBD_ROOT"
mount "$NBD_ROOT" "$MNT_ROOT"
mount -o ro "$NBD_WS" "$MNT_WS"
mkdir -p "$MNT_ROOT/home/sandbox"
rsync -aHAX --numeric-ids "$MNT_WS/" "$MNT_ROOT/home/sandbox/"
sync
`

// growScript connects the rootfs (rw) via qemu-nbd and grows the root ext4 to
// fill the resized image (no workspace to fold). $1=rootfs.qcow2
const growScript = `
set -euo pipefail
ROOTFS="$1"
modprobe nbd max_part=8 2>/dev/null || true
pick_nbd() {
  for i in $(seq 0 15); do
    if [ -e "/dev/nbd$i" ] && [ ! -s "/sys/block/nbd$i/pid" ]; then echo "/dev/nbd$i"; return 0; fi
  done
  return 1
}
NBD_ROOT=$(pick_nbd) || { echo "no free nbd device"; exit 1; }
qemu-nbd --connect="$NBD_ROOT" "$ROOTFS"
sleep 0.5
cleanup() { qemu-nbd --disconnect "$NBD_ROOT" 2>/dev/null || true; }
trap cleanup EXIT
e2fsck -fy "$NBD_ROOT" || true
resize2fs "$NBD_ROOT"
sync
`
