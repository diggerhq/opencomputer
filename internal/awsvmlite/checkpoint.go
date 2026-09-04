package awsvmlite

// checkpoint.go — checkpoints, as much of one as this runtime can offer.
//
// WHAT A CHECKPOINT IS HERE, and it is not what it is on QEMU. There, a
// checkpoint is savevm: the guest's RAM and its disks, captured whole, restored
// into a process mid-instruction. None of that is available through an API that
// BUILDS images from a Dockerfile rather than capturing them from a running
// box. There is no snapshot verb to call.
//
// So a checkpoint here is the WORKSPACE: a gzipped tar of /home/sandbox, taken
// by the guest and streamed straight to blob storage. Restoring unpacks it.
// Forking unpacks it onto a fresh box.
//
// The honest differences, which belong in the product docs and not only here:
//
//	no memory state     a restored sandbox has no running processes; it is a
//	                    fresh box holding the same files, not a paused one
//	                    resumed
//	workspace only      anything installed OUTSIDE /home/sandbox at runtime came
//	                    from the image and comes back from the image; anything
//	                    else does not survive
//
// What it is nevertheless good for is the thing most checkpoints are actually
// used for: capture the state of some work, and fork it.
//
// IT ALSO UNLOCKS TWO THINGS THAT ARE NOT CHECKPOINTS. Both of the hard limits
// on this runtime exist because there was no durable copy of a sandbox:
//
//   - hibernate could only suspend, never terminate, so a parked box holds
//     regional quota forever (see hibernate.go's cap)
//   - the 8h service cap killed boxes and took the customer's work with them
//
// With an archive, hibernate can become archive-then-terminate and give the
// quota back, and a box approaching 8h can be archived and restored onto a
// fresh one. Neither is wired up here; this is the primitive both need.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/opensandbox/opensandbox/internal/storage"
)

const (
	ocWorkspaceExport = "/oc/workspace/export"
	ocWorkspaceImport = "/oc/workspace/import"
)

// exportTimeout bounds an archive. Generous — it scales with the customer's
// workspace, and cutting a large but healthy transfer short would produce a
// truncated checkpoint, which is worse than a slow one.
const exportTimeout = 15 * time.Minute

// ExportWorkspace streams a gzipped tar of the sandbox's workspace.
//
// The caller owns the returned reader and must close it. The context must
// outlive the read — cancelling it mid-stream truncates the archive, which is
// exactly the failure a checkpoint must not have.
func (m *Manager) ExportWorkspace(ctx context.Context, sandboxID string) (io.ReadCloser, error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return nil, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	resp, err := m.do(ctx, b, http.MethodGet, ocWorkspaceExport, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		return nil, httpError{status: resp.StatusCode, op: ocWorkspaceExport, msg: string(msg)}
	}
	m.stampTouch(b)
	return resp.Body, nil
}

// ImportWorkspace unpacks an archive into the sandbox's workspace.
func (m *Manager) ImportWorkspace(ctx context.Context, sandboxID string, r io.Reader) error {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	resp, err := m.doStream(ctx, b, http.MethodPut, ocWorkspaceImport, r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return httpError{status: resp.StatusCode, op: ocWorkspaceImport, msg: string(msg)}
	}
	m.stampTouch(b)
	return nil
}

// CheckpointWorkspace archives a sandbox to blob storage under key.
//
// Spooled through a temp file rather than piped straight to the uploader,
// because the store uploads from a path — and because a length is needed to
// record a truthful size. Deleted on the way out either way.
func (m *Manager) CheckpointWorkspace(ctx context.Context, sandboxID, key string, store *storage.CheckpointStore) (int64, error) {
	if store == nil {
		return 0, fmt.Errorf("awsvmlite: checkpoint %s: no checkpoint store configured", sandboxID)
	}
	ctx, cancel := context.WithTimeout(ctx, exportTimeout)
	defer cancel()

	rc, err := m.ExportWorkspace(ctx, sandboxID)
	if err != nil {
		return 0, fmt.Errorf("awsvmlite: checkpoint %s: export: %w", sandboxID, err)
	}
	defer rc.Close()

	f, err := os.CreateTemp("", "oc-workspace-*.tgz")
	if err != nil {
		return 0, err
	}
	local := f.Name()
	defer os.Remove(local)

	written, err := io.Copy(f, rc)
	closeErr := f.Close()
	if err != nil {
		return 0, fmt.Errorf("awsvmlite: checkpoint %s: stage: %w", sandboxID, err)
	}
	if closeErr != nil {
		return 0, closeErr
	}
	// A zero-byte archive means the export produced nothing, and uploading it
	// would publish a checkpoint that restores to an empty workspace — silent
	// data loss the customer only discovers on a fork.
	if written == 0 {
		return 0, fmt.Errorf("awsvmlite: checkpoint %s: export produced an empty archive", sandboxID)
	}

	uploaded, err := store.Upload(ctx, key, local)
	if err != nil {
		return 0, fmt.Errorf("awsvmlite: checkpoint %s: upload: %w", sandboxID, err)
	}
	if uploaded > 0 {
		written = uploaded
	}
	return written, nil
}

// RestoreWorkspace downloads an archive and unpacks it into a sandbox.
func (m *Manager) RestoreWorkspace(ctx context.Context, sandboxID, key string, store *storage.CheckpointStore) error {
	if store == nil {
		return fmt.Errorf("awsvmlite: restore %s: no checkpoint store configured", sandboxID)
	}
	rc, err := store.Download(ctx, key)
	if err != nil {
		return fmt.Errorf("awsvmlite: restore %s: download: %w", sandboxID, err)
	}
	defer rc.Close()
	if err := m.ImportWorkspace(ctx, sandboxID, rc); err != nil {
		return fmt.Errorf("awsvmlite: restore %s: import: %w", sandboxID, err)
	}
	return nil
}

// WorkspaceKey is where a checkpoint's archive lives.
//
// Keyed on the CHECKPOINT id, not the sandbox: a fork restores into a sandbox
// that did not exist when the checkpoint was taken, so a sandbox-keyed path
// would be unreachable from the one place it is needed most.
// The v2 suffix is load-bearing, not decoration. v1 archives were rooted at
// /home/sandbox and carried bare `./...` entries; v2 is rooted at / and carries
// `home/sandbox/...`, `usr/local/...`, `opt/...`. Extracting a v1 archive with
// the v2 importer would scatter a customer's home directory across the
// filesystem root. Changing the key means an old checkpoint is simply NOT
// FOUND — a clean error instead of a destructive restore.
func WorkspaceKey(checkpointID string) string {
	return "checkpoints/" + checkpointID + "/rootpaths-v2.tgz"
}

// RestoreWorkspaceKey unpacks an archive named by its storage key.
//
// Separate from RestoreWorkspace, which derives the key from a checkpoint id:
// the create path is handed a key directly (the resolved template drive) and
// has no checkpoint id to derive from.
func (m *Manager) RestoreWorkspaceKey(ctx context.Context, sandboxID, key string) error {
	if m.store == nil {
		return fmt.Errorf("awsvmlite: restore %s: no checkpoint store configured", sandboxID)
	}
	rc, err := m.store.Download(ctx, key)
	if err != nil {
		return fmt.Errorf("awsvmlite: restore %s: download %s: %w", sandboxID, key, err)
	}
	defer rc.Close()
	return m.ImportWorkspace(ctx, sandboxID, rc)
}
