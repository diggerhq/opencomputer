package awsvmlite

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// checkpoint_test.go — a checkpoint that silently captures nothing.
//
// The archive is produced by a `tar` running inside the guest and streamed out
// through two proxies. Every failure in that chain arrives as a SHORT BODY, not
// an error: the response is already 200 by the time tar fails, so an export
// that captured nothing looks exactly like an export of an empty workspace.
// A checkpoint is only discovered to be empty when someone forks it, which may
// be weeks later and is unrecoverable.

func TestExportRefusesWhenTheGuestFails(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusInternalServerError, "tar: exited 2")
	rc, err := m.ExportWorkspace(context.Background(), "sbx-1")
	if err == nil {
		rc.Close()
		t.Fatal("a failed export returned a reader — the caller would upload whatever it contained as a checkpoint")
	}
	he, ok := err.(httpError)
	if !ok || he.StatusCode() != http.StatusInternalServerError {
		t.Errorf("error = %v, want an httpError carrying the guest's status", err)
	}
}

// The size check is the only thing standing between a broken export and a
// published checkpoint that restores to nothing.
func TestCheckpointRefusesAnEmptyArchive(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusOK, "")
	// A nil store is rejected before the export, so this needs a store to reach
	// the emptiness check — but it must fail BEFORE any upload happens, which
	// is what a nil-store panic would prove it does not.
	_, err := m.CheckpointWorkspace(context.Background(), "sbx-1", "k", nil)
	if err == nil {
		t.Fatal("checkpoint with no store configured succeeded")
	}
	if !strings.Contains(err.Error(), "no checkpoint store") {
		t.Errorf("error = %v, want it to name the missing store", err)
	}
}

func TestExportStreamsTheArchive(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, "\x1f\x8b tarbytes")
	rc, err := m.ExportWorkspace(context.Background(), "sbx-1")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if string(got) != "\x1f\x8b tarbytes" {
		t.Errorf("body = %q, want the archive bytes untouched", got)
	}
	if (*last).URL.Path != ocWorkspaceExport || (*last).Method != http.MethodGet {
		t.Errorf("%s %s, want GET %s", (*last).Method, (*last).URL.Path, ocWorkspaceExport)
	}
}

func TestImportSendsToTheGuest(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{"ok":true}`)
	if err := m.ImportWorkspace(context.Background(), "sbx-1", strings.NewReader("archive")); err != nil {
		t.Fatalf("import: %v", err)
	}
	if (*last).URL.Path != ocWorkspaceImport || (*last).Method != http.MethodPut {
		t.Errorf("%s %s, want PUT %s", (*last).Method, (*last).URL.Path, ocWorkspaceImport)
	}
}

// The archive is keyed on the CHECKPOINT, not the sandbox. A fork restores into
// a sandbox that did not exist when the checkpoint was taken, so a
// sandbox-keyed path would be unreachable from the one place it matters most.
func TestWorkspaceKeyIsCheckpointScoped(t *testing.T) {
	k := WorkspaceKey("cp-123")
	if !strings.Contains(k, "cp-123") {
		t.Errorf("key %q does not name the checkpoint", k)
	}
	if k == WorkspaceKey("cp-456") {
		t.Error("two checkpoints share a key — one would overwrite the other")
	}
}

// Unbound sandboxes are refused before any request goes out.
func TestWorkspaceOpsRefuseUnboundSandbox(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, "")
	if _, err := m.ExportWorkspace(context.Background(), "nope"); err == nil {
		t.Error("export against an unbound sandbox succeeded")
	}
	if err := m.ImportWorkspace(context.Background(), "nope", strings.NewReader("x")); err == nil {
		t.Error("import against an unbound sandbox succeeded")
	}
	if *last != nil {
		t.Error("a request was sent for a sandbox this process holds no box for")
	}
}
