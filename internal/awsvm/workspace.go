package awsvm

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// workspace.go — moving a sandbox's files in and out of blob storage.
//
// This is what hibernation means on this backend. AWS exposes Suspend/Resume
// but no way to export a snapshot (the SDK has 24 operations and none of them
// save state), so a sandbox that must outlive its host has to be captured as
// ordinary files. The 8h ceiling counts RUNNING and SUSPENDED together and is
// not adjustable, so "outlive its host" is every sandbox parked longer than
// that.
//
// Only /home/sandbox travels. The image is the system on this backend, so
// anything installed outside the workspace does not survive a restore — a
// narrower promise than a QEMU disk snapshot, and one worth stating plainly
// rather than discovering.

// workspaceDir is the only path that survives hibernation. It matches the
// agent's working directory (see deploy/microvm/Dockerfile).
const workspaceDir = "/home/sandbox"

// archivePath is where the tarball is staged inside the guest. /tmp is
// deliberately outside workspaceDir: including the archive in its own input
// would race the writer against the reader.
const archivePath = "/tmp/osb-workspace.tgz"

// exportTimeout bounds the in-guest tar. Generous because it scales with the
// customer's data, and the alternative to waiting is losing it.
const exportTimeout = 10 * time.Minute

// maxWorkspaceBytes caps what will be captured. Past this the export fails
// loudly rather than silently truncating: a restore that quietly drops half a
// customer's files is worse than a hibernate that refuses.
const maxWorkspaceBytes = 2 << 30 // 2 GiB

// ExportWorkspace archives the sandbox's workspace and returns it for upload,
// along with its size. The caller closes the reader.
//
// Two steps rather than streaming `tar czf -` straight out: Exec is one-shot
// and buffers its output, so piping a multi-gigabyte archive through it would
// hold the whole thing in the control plane's memory. Writing to a file inside
// the guest and streaming that back keeps memory flat.
func (m *Manager) ExportWorkspace(ctx context.Context, sandboxID string) (io.ReadCloser, int64, error) {
	// The cancel is deliberately NOT deferred: the reader returned below is
	// still streaming when this function returns, and cancelling here would
	// kill it mid-read — the stream fails with "context canceled" on every
	// archive large enough to still be in flight, which is every archive that
	// matters. Ownership passes to the returned ReadCloser instead.
	ctx, cancel := context.WithTimeout(ctx, exportTimeout)
	failed := true
	defer func() {
		if failed {
			cancel()
		}
	}()

	// -C so paths are relative: a restore must be able to land them in the same
	// place without depending on the absolute layout of the machine that made
	// the archive.
	res, err := m.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args: []string{"-c", fmt.Sprintf(
			"rm -f %s && tar czf %s -C %s . && stat -c %%s %s",
			archivePath, archivePath, workspaceDir, archivePath)},
	})
	if err != nil {
		return nil, 0, fmt.Errorf("awsvm: export %s: tar: %w", sandboxID, err)
	}
	if res.ExitCode != 0 {
		return nil, 0, fmt.Errorf("awsvm: export %s: tar exit %d: %s", sandboxID, res.ExitCode, trimOut(res.Stderr))
	}

	var size int64
	if _, err := fmt.Sscanf(trimOut(res.Stdout), "%d", &size); err != nil {
		return nil, 0, fmt.Errorf("awsvm: export %s: unreadable archive size %q: %w", sandboxID, trimOut(res.Stdout), err)
	}
	if size > maxWorkspaceBytes {
		return nil, 0, fmt.Errorf("awsvm: export %s: workspace archive is %d bytes, over the %d limit",
			sandboxID, size, maxWorkspaceBytes)
	}

	rc, _, err := m.ReadFileStream(ctx, sandboxID, archivePath)
	if err != nil {
		return nil, 0, fmt.Errorf("awsvm: export %s: read archive: %w", sandboxID, err)
	}
	failed = false
	return &cancelOnClose{ReadCloser: rc, cancel: cancel}, size, nil
}

// cancelOnClose ties a context's lifetime to the stream it feeds, so the
// timeout still bounds the read but only expires when the caller is done.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// ImportWorkspace restores an archive produced by ExportWorkspace into a
// running sandbox.
//
// The unpack is additive rather than a wipe-and-replace: the target is a fresh
// box from the image, so its workspace holds the image's own scaffolding, and
// deleting that before unpacking would strip files the sandbox expects.
func (m *Manager) ImportWorkspace(ctx context.Context, sandboxID string, r io.Reader) error {
	ctx, cancel := context.WithTimeout(ctx, exportTimeout)
	defer cancel()

	// 0644, not 0600: the stream is written by the agent's file service while
	// exec runs as the unprivileged sandbox user, so a mode only the writer can
	// read makes the untar fail with "Cannot open: Permission denied" — after a
	// full download, which is the most expensive possible place to discover it.
	if _, err := m.WriteFileStream(ctx, sandboxID, archivePath, 0o644, r); err != nil {
		return fmt.Errorf("awsvm: import %s: write archive: %w", sandboxID, err)
	}
	res, err := m.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		// Cleanup is best-effort and must not affect the exit code: the archive
		// is written by the agent's file service but exec runs as the
		// unprivileged sandbox user, and /tmp is sticky — so the rm fails with
		// "Operation not permitted" even though the restore itself succeeded.
		// Letting that decide the result fails every wake after a working untar.
		Args: []string{"-c", fmt.Sprintf("tar xzf %s -C %s && { rm -f %s 2>/dev/null || true; }",
			archivePath, workspaceDir, archivePath)},
	})
	if err != nil {
		return fmt.Errorf("awsvm: import %s: untar: %w", sandboxID, err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("awsvm: import %s: untar exit %d: %s", sandboxID, res.ExitCode, trimOut(res.Stderr))
	}
	return nil
}

// stageArchive spools a reader to a local temp file, because CheckpointStore
// uploads from a path rather than a stream. Returns the path and its size; the
// caller removes it.
func stageArchive(r io.Reader, dir string) (string, int64, error) {
	f, err := os.CreateTemp(dir, "osb-hib-*.tgz")
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		_ = os.Remove(f.Name())
		return "", 0, err
	}
	return f.Name(), n, nil
}

// hibernationKey is the blob path for a sandbox's workspace archive. One key
// per sandbox: CreateHibernation supersedes the previous record and hands back
// the old key to delete, so storage stays bounded at one archive per sandbox.
func hibernationKey(sandboxID string) string {
	return filepath.Join("hibernations", sandboxID+".tgz")
}

func trimOut(s string) string {
	if len(s) > 400 {
		return s[:400]
	}
	return s
}
