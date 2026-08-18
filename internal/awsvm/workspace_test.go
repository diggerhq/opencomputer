package awsvm

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

// workspace_test.go — the archive path, which is the only thing standing
// between a hibernated sandbox and losing the customer's files.

// The archive must not live inside the directory it archives. Staging it in
// the workspace would make tar read a file it is concurrently writing, which
// produces a corrupt archive on exactly the large workspaces where corruption
// is least recoverable.
func TestArchiveIsStagedOutsideTheWorkspace(t *testing.T) {
	if strings.HasPrefix(archivePath, workspaceDir) {
		t.Fatalf("archive %q is inside the workspace %q — tar would read its own output",
			archivePath, workspaceDir)
	}
}

// The workspace path must match what the image actually gives the customer.
// Archiving the wrong directory restores an empty sandbox and reports success.
func TestWorkspaceDirMatchesTheImage(t *testing.T) {
	if workspaceDir != "/home/sandbox" {
		t.Fatalf("workspaceDir is %q; deploy/microvm/Dockerfile puts the customer in /home/sandbox", workspaceDir)
	}
}

// One key per sandbox, and it must contain the sandbox id. A shared or
// colliding key would let one sandbox's wake restore another's files.
func TestHibernationKeyIsPerSandbox(t *testing.T) {
	a, b := hibernationKey("sb-aaa"), hibernationKey("sb-bbb")
	if a == b {
		t.Fatalf("two sandboxes share the archive key %q", a)
	}
	if !strings.Contains(a, "sb-aaa") {
		t.Fatalf("key %q does not identify its sandbox", a)
	}
	if hibernationKey("sb-aaa") != a {
		t.Fatal("key is not stable across calls — a wake could not find its own archive")
	}
}

// stageArchive spools to disk because the blob store uploads from a path. It
// must report the byte count it actually wrote: that number is persisted as the
// hibernation size and is how a truncated upload would be noticed.
func TestStageArchiveReportsWhatItWrote(t *testing.T) {
	dir := t.TempDir()
	payload := bytes.Repeat([]byte("x"), 4096)

	path, n, err := stageArchive(bytes.NewReader(payload), dir)
	if err != nil {
		t.Fatalf("stageArchive: %v", err)
	}
	defer os.Remove(path)

	if n != int64(len(payload)) {
		t.Fatalf("reported %d bytes, wrote %d", n, len(payload))
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read staged archive: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("staged archive differs from input (%d vs %d bytes)", len(got), len(payload))
	}
}

// A staging failure must not leave a partial file behind. The caller removes
// the path it is given, and on error there is no path to remove — so anything
// already written has to be cleaned up here or it leaks disk on every failure.
func TestStageArchiveCleansUpOnFailure(t *testing.T) {
	dir := t.TempDir()

	_, _, err := stageArchive(failingReader{}, dir)
	if err == nil {
		t.Fatal("stageArchive succeeded on a failing reader")
	}
	entries, rErr := os.ReadDir(dir)
	if rErr != nil {
		t.Fatalf("read dir: %v", rErr)
	}
	if len(entries) != 0 {
		t.Fatalf("left %d file(s) behind after a failed stage", len(entries))
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errRead }

var errRead = &readErr{}

type readErr struct{}

func (*readErr) Error() string { return "read failed" }

// ExportWorkspace returns a stream that is still being read after the function
// returns. Deferring the context cancel there kills the read mid-flight — it
// fails with "context canceled" on exactly the archives big enough to still be
// in transit, which is every archive worth having. The cancel must travel with
// the stream and fire on Close.
func TestExportStreamOutlivesTheCallThatCreatedIt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	inner := io.NopCloser(strings.NewReader("payload"))
	rc := &cancelOnClose{ReadCloser: inner, cancel: cancel}

	// Still readable after the creating scope would have returned.
	if _, err := io.ReadAll(rc); err != nil {
		t.Fatalf("stream unreadable before Close: %v", err)
	}
	if ctx.Err() != nil {
		t.Fatal("context was cancelled while the stream was still open")
	}
	if err := rc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if ctx.Err() == nil {
		t.Fatal("Close did not release the context — the timeout would leak")
	}
}
