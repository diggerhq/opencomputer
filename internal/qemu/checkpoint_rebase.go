package qemu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/storage"
)

// Pin-to-base: checkpoints stay tied to the exact goldenVersion they were
// created against. On fork/restore we ensure that base is available locally
// (either as the current default.ext4, a retained previous base on disk, or
// an on-demand blob download) and do a metadata-only qemu-img rebase -u to
// point the overlay's backing_file field at it. No block copying ever.
//
// Earlier attempts to rebase overlays across goldens (Variants A, B, C) all
// produced subtle corruption: memory dumps reference disk content from the
// old base, so swapping in new-base content under them breaks consistency.

// ensureCheckpointRebased ensures the checkpoint's rootfs.qcow2 backing file
// points at the correct base for its pinned goldenVersion. Name kept for
// call-site stability.
func (m *Manager) ensureCheckpointRebased(ctx context.Context, checkpointID string) error {
	if m.checkpointStore == nil {
		return nil
	}

	cacheDir := filepath.Join(m.cfg.DataDir, "checkpoint-snapshots", checkpointID)
	metaPath := filepath.Join(cacheDir, "snapshot", "snapshot-meta.json")

	m.checkpointCacheMu.RLock()
	data, err := os.ReadFile(metaPath)
	m.checkpointCacheMu.RUnlock()
	if err != nil {
		return nil
	}

	var meta SnapshotMeta
	if json.Unmarshal(data, &meta) != nil {
		return nil
	}

	// A converted merged variant (see convert_merge.go) is a self-contained,
	// flattened rootfs with no backing and no GoldenVersion — there is nothing
	// to rebase, and the size-guard can't catch a same-size/different-content
	// base, so skip rebase entirely for merged-without-golden checkpoints.
	if IsMerged(meta.DiskLayout) && meta.GoldenVersion == "" {
		return nil
	}

	if meta.GoldenVersion == "" {
		return m.checkLegacyCheckpoint(checkpointID, meta)
	}

	basePath, err := m.resolveBaseForVersion(ctx, meta.GoldenVersion)
	if err != nil {
		return fmt.Errorf("resolve base %s: %w", meta.GoldenVersion, err)
	}

	rootfs := filepath.Join(cacheDir, "rootfs.qcow2")
	if !fileExists(rootfs) {
		return nil
	}

	m.checkpointCacheMu.Lock()
	defer m.checkpointCacheMu.Unlock()

	return rebaseMetadataOnly(ctx, rootfs, basePath)
}

// rebaseMetadataOnly runs qemu-img rebase -u to repoint an overlay's backing
// file without touching data clusters.
//
// rebase -u is UNSAFE: it trusts that newBasePath holds exactly the content the
// overlay was built against and only rewrites the backing pointer. Handing it
// the wrong base silently corrupts the guest filesystem (the overlay's clusters
// index the old base's block layout). Two cheap guards before we pull that
// trigger:
//   - Refuse if newBasePath's size != the overlay's virtual size. A size
//     mismatch is an unambiguously wrong base (different template / corrupt
//     golden); rebasing would guarantee corruption, so fail loud instead.
//   - Skip entirely if the overlay already backs onto newBasePath — no need to
//     re-run an unsafe op that would be a no-op.
//
// This does NOT catch a same-size, different-content base (golden skew); that is
// prevented upstream by pinning the overlay to the golden it was actually built
// on (see ForkFromCheckpoint stamping meta.GoldenVersion). This guard is
// defense-in-depth for the grossly-wrong-base case and a safety net if a pin is
// ever wrong again.
func rebaseMetadataOnly(ctx context.Context, overlayPath, newBasePath string) error {
	// Best-effort guard: if we can read BOTH the target base's size and the
	// overlay's virtual size and they disagree, the base is unambiguously wrong
	// (different template / corrupt golden) — refuse rather than corrupt. If
	// introspection is unavailable (qemu-img missing, unreadable overlay), fall
	// through to the rebase; that's no worse than the pre-guard behavior. Also
	// skip a rebase that would be a no-op (overlay already on newBasePath).
	if baseInfo, statErr := os.Stat(newBasePath); statErr == nil {
		if overlayVSize, verr := qcowVirtualSize(ctx, overlayPath); verr == nil {
			if overlayVSize != baseInfo.Size() {
				return fmt.Errorf(
					"refusing unsafe rebase of %s onto %s: base size %d != overlay virtual size %d (wrong base image — recreate the checkpoint)",
					filepath.Base(overlayPath), newBasePath, baseInfo.Size(), overlayVSize)
			}
			if cur, berr := qcowBackingFile(ctx, overlayPath); berr == nil && cur == newBasePath {
				return nil // already correctly based
			}
		}
	}
	cmd := exec.CommandContext(ctx, "qemu-img", "rebase", "-u", "-b", newBasePath, "-F", "raw", overlayPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("qemu-img rebase -u: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// qcowVirtualSize returns a qcow2 image's virtual (guest-visible) size in bytes,
// which must equal its backing file's size for the overlay to be valid.
func qcowVirtualSize(ctx context.Context, path string) (int64, error) {
	out, err := exec.CommandContext(ctx, "qemu-img", "info", "--output=json", path).Output()
	if err != nil {
		return 0, err
	}
	var info struct {
		VirtualSize int64 `json:"virtual-size"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		return 0, err
	}
	return info.VirtualSize, nil
}

// qcowBackingFile returns an overlay's current backing-file path ("" if none).
func qcowBackingFile(ctx context.Context, path string) (string, error) {
	out, err := exec.CommandContext(ctx, "qemu-img", "info", "--output=json", path).Output()
	if err != nil {
		return "", err
	}
	var info struct {
		BackingFilename string `json:"backing-filename"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		return "", err
	}
	return info.BackingFilename, nil
}

// resolveBaseForVersion returns a local path to the base image matching the
// given goldenVersion, downloading from blob storage if needed. Downloaded
// bases are cached persistently at ImagesDir/bases/{version}/default.ext4.
func (m *Manager) resolveBaseForVersion(ctx context.Context, goldenVersion string) (string, error) {
	if goldenVersion == "" {
		return "", fmt.Errorf("empty goldenVersion")
	}
	if goldenVersion == m.GoldenVersion() {
		return filepath.Join(m.cfg.ImagesDir, "default.ext4"), nil
	}

	retained := filepath.Join(m.cfg.ImagesDir, "bases", goldenVersion, "default.ext4")
	if fileExists(retained) {
		return retained, nil
	}

	if err := m.downloadBaseToLocal(ctx, goldenVersion, retained); err != nil {
		return "", err
	}
	return retained, nil
}

// downloadBaseToLocal fetches bases/{goldenVersion}/default.ext4 from blob
// storage. Concurrent callers share one download through an in-flight map.
//
// Cleans up the destination directory if download fails — otherwise an empty
// bases/<ver>/ would be left behind, indistinguishable from a partial state
// on the next attempt. Retries a small number of times on ErrNotFound to
// tolerate the brief window between a peer worker calling
// UploadBaseImageIfNew and the blob becoming visible to the downloader.
func (m *Manager) downloadBaseToLocal(ctx context.Context, goldenVersion, destPath string) error {
	flightMu.Lock()
	if ch, downloading := downloadFlight[goldenVersion]; downloading {
		flightMu.Unlock()
		select {
		case <-ch:
			if fileExists(destPath) {
				return nil
			}
			return m.downloadBaseToLocal(ctx, goldenVersion, destPath)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ch := make(chan struct{})
	downloadFlight[goldenVersion] = ch
	flightMu.Unlock()
	defer func() {
		flightMu.Lock()
		delete(downloadFlight, goldenVersion)
		flightMu.Unlock()
		close(ch)
	}()

	if fileExists(destPath) {
		return nil
	}
	dir := filepath.Dir(destPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("mkdir base cache: %w", err)
	}
	// On failure, clean up the empty dir so subsequent resolves don't see a
	// stub directory that masks the missing base.
	cleanupOnFail := true
	defer func() {
		if !cleanupOnFail {
			return
		}
		if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
			os.Remove(dir)
		}
	}()

	log.Printf("qemu: downloading base %s from blob storage", goldenVersion)
	t0 := time.Now()

	key := fmt.Sprintf("bases/%s/default.ext4", goldenVersion)
	reader, err := m.openBaseReaderWithRetry(ctx, key)
	if err != nil {
		return fmt.Errorf("download %s: %w", key, err)
	}
	defer reader.Close()

	tmpFile, err := os.CreateTemp(dir, "default-dl-*.ext4")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()

	if _, err := io.Copy(tmpFile, reader); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write base image: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	cleanupOnFail = false
	log.Printf("qemu: base %s cached at %s (%dms)", goldenVersion, destPath, time.Since(t0).Milliseconds())
	return nil
}

// openBaseReaderWithRetry retries Download on ErrNotFound with exponential
// backoff (250ms → 500ms → 1s → 2s → 4s, ~8s total). The retry exists for
// the race where a peer worker that just took a checkpoint is still
// uploading its base via UploadBaseImageIfNew. Other errors fail fast.
func (m *Manager) openBaseReaderWithRetry(ctx context.Context, key string) (io.ReadCloser, error) {
	var lastErr error
	delay := 250 * time.Millisecond
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
				delay *= 2
			}
		}
		reader, err := m.checkpointStore.Download(ctx, key)
		if err == nil {
			return reader, nil
		}
		if !errors.Is(err, storage.ErrNotFound) && !strings.Contains(err.Error(), "object not found") {
			return nil, err
		}
		lastErr = err
		log.Printf("qemu: base download for %s: not found yet (attempt %d), retrying", key, attempt+1)
	}
	return nil, lastErr
}

var (
	flightMu       sync.Mutex
	downloadFlight = map[string]chan struct{}{}
)

// UploadBaseImageIfNew archives the current base to blob storage if this
// golden version hasn't been stored yet. Lets workers rolled up later pull
// back checkpoints pinned to earlier goldens.
func (m *Manager) UploadBaseImageIfNew() {
	m.uploadBaseImageIfNew(m.GoldenVersion())
}

func (m *Manager) uploadBaseImageIfNew(goldenVersion string) {
	if m.checkpointStore == nil || goldenVersion == "" {
		return
	}
	baseImage := filepath.Join(m.cfg.ImagesDir, "default.ext4")
	if !fileExists(baseImage) {
		log.Printf("qemu: base image archival skipped: %s not found", baseImage)
		return
	}

	key := fmt.Sprintf("bases/%s/default.ext4", goldenVersion)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	exists, err := m.checkpointStore.Exists(ctx, key)
	if err != nil {
		log.Printf("qemu: base image existence check failed: %v", err)
		return
	}
	if exists {
		return
	}

	uploadCtx, uploadCancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer uploadCancel()
	if _, err := m.checkpointStore.Upload(uploadCtx, key, baseImage); err != nil {
		log.Printf("qemu: base image upload failed for version %s: %v", goldenVersion, err)
		return
	}
	log.Printf("qemu: base image archived for golden version %s", goldenVersion)
}

// checkLegacyCheckpoint handles checkpoints that predate goldenVersion
// tracking. If snapshot-at time is after the current base install, we trust
// the current base is compatible. Otherwise we can't prove compatibility.
func (m *Manager) checkLegacyCheckpoint(checkpointID string, meta SnapshotMeta) error {
	baseImage := filepath.Join(m.cfg.ImagesDir, "default.ext4")
	stat, err := os.Stat(baseImage)
	if err != nil {
		return nil
	}
	baseInstalled := stat.ModTime()

	if meta.SnapshotedAt.IsZero() || meta.SnapshotedAt.After(baseInstalled) {
		return nil
	}
	return fmt.Errorf(
		"checkpoint %s predates current base image (checkpoint created %s, "+
			"base installed %s) and has no goldenVersion recorded. "+
			"Destroy this checkpoint and recreate it",
		checkpointID,
		meta.SnapshotedAt.Format(time.RFC3339),
		baseInstalled.Format(time.RFC3339))
}

