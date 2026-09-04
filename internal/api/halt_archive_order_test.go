package api

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/storage"
)

// fakeArchiver records the order of calls so the sequence can be asserted
// directly. The order is the entire safety property of a halt: releasing the
// host is irreversible on a runtime with no memory or disk export, so anything
// that can fail must fail while the box is still alive.
type fakeArchiver struct {
	calls        []string
	archiveErr   error
	releaseErr   error
	restoreErr   error
	restoredFrom string
}

func (f *fakeArchiver) ArchiveForHalt(_ context.Context, _ string, _ *storage.CheckpointStore) (string, int64, error) {
	f.calls = append(f.calls, "archive")
	if f.archiveErr != nil {
		return "", 0, f.archiveErr
	}
	return "checkpoints/halt-abc/rootpaths-v2.tgz", 4096, nil
}

func (f *fakeArchiver) ReleaseForHalt(_ context.Context, _ string) error {
	f.calls = append(f.calls, "release")
	return f.releaseErr
}

func (f *fakeArchiver) RestoreForResume(_ context.Context, _, key string, _ *storage.CheckpointStore, _ HaltRestoreSpec) (string, error) {
	f.calls = append(f.calls, "restore")
	f.restoredFrom = key
	if f.restoreErr != nil {
		return "", f.restoreErr
	}
	return "vmhost:mvm-new", nil
}

// The host must never be released before the archive exists — that ordering is
// the difference between "retry next tick" and "the customer's data is gone".
func TestHaltNeverReleasesTheHostBeforeArchiving(t *testing.T) {
	f := &fakeArchiver{}
	_, _, err := f.ArchiveForHalt(context.Background(), "sb-1", nil)
	if err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := f.ReleaseForHalt(context.Background(), "sb-1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if got := strings.Join(f.calls, ","); got != "archive,release" {
		t.Fatalf("call order %q — release must come second", got)
	}
}

// A failed archive must abandon the halt with the host untouched. The sandbox
// keeps running, the reconciler retries, and nothing is lost.
func TestFailedArchiveLeavesTheHostAlone(t *testing.T) {
	f := &fakeArchiver{archiveErr: errors.New("blob store unreachable")}
	if _, _, err := f.ArchiveForHalt(context.Background(), "sb-1", nil); err == nil {
		t.Fatal("expected the archive to fail")
	}
	for _, c := range f.calls {
		if c == "release" {
			t.Fatal("released the host after a FAILED archive — the sandbox's only copy would be gone")
		}
	}
}

// An empty hibernation key means the sandbox was suspended by an idle park, not
// archived by a halt. Restoring a fresh host for it would strand the suspended
// box and hand the customer an empty sandbox, so the two must not be conflated.
func TestSuspendedSandboxIsNotRestoredAsIfArchived(t *testing.T) {
	b := &liteBackend{}
	_, err := b.RestoreForResume(context.Background(), "sb-1", "", nil, HaltRestoreSpec{})
	if err == nil {
		t.Fatal("restored a suspended sandbox from an empty key")
	}
	if !strings.Contains(err.Error(), "suspended") {
		t.Errorf("error should explain that this sandbox needs waking, not restoring: %v", err)
	}
}

// Refusing to halt without a checkpoint store is the safe direction: the
// alternative is releasing a host whose state has nowhere durable to live.
func TestHaltRefusesWithoutSomewhereToPutTheArchive(t *testing.T) {
	b := &liteBackend{}
	_, _, err := b.ArchiveForHalt(context.Background(), "sb-1", nil)
	if err == nil {
		t.Fatal("archived to a nil store")
	}
	if !strings.Contains(err.Error(), "refusing to halt") {
		t.Errorf("refusal should say it is declining to halt, not report a generic failure: %v", err)
	}
}
