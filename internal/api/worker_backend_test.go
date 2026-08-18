package api

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/controlplane"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// worker_backend_test.go — first coverage of worker selection.
//
// This branching has run every create on the fleet since the beginning with no
// test behind it, because the handler reached directly into a Redis-backed
// struct. The three outcomes are materially different for a customer — served
// now, served after a wait, or told the cell is full — and the failure mode of
// the last one is a request that hangs for the full timeout before failing.

// fakeSelector answers a scripted sequence of attempts.
type fakeSelector struct {
	// failures is how many attempts fail before one succeeds. Negative means
	// never succeed.
	failures int32
	attempts int32
}

func (f *fakeSelector) GetLeastLoadedWorker(region string) (*controlplane.WorkerEntry, pb.SandboxWorkerClient, error) {
	n := atomic.AddInt32(&f.attempts, 1)
	if f.failures < 0 || n <= f.failures {
		return nil, nil, errors.New("no workers available")
	}
	return &controlplane.WorkerEntry{ID: "w-test-1"}, nil, nil
}

func testWorkerBackend(f *fakeSelector) *workerBackend {
	return &workerBackend{
		selector:     f,
		waitTimeout:  200 * time.Millisecond,
		waitInterval: 10 * time.Millisecond,
	}
}

// The common case must not pay the queue at all — a create with capacity
// available should never touch the ticker.
func TestSelectWorkerReturnsImmediatelyWhenCapacityExists(t *testing.T) {
	f := &fakeSelector{failures: 0}
	start := time.Now()
	w, _, err := testWorkerBackend(f).selectWorker(context.Background(), "us-west-2")
	if err != nil {
		t.Fatalf("selectWorker: %v", err)
	}
	if w == nil || w.ID != "w-test-1" {
		t.Fatalf("got worker %v, want w-test-1", w)
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Fatalf("immediate selection took %s — it queued when it should not have", elapsed)
	}
	if got := atomic.LoadInt32(&f.attempts); got != 1 {
		t.Fatalf("made %d selection attempts, want 1", got)
	}
}

// The scaler may be mid-launch, so a create that arrives during a gap should be
// served late rather than refused. Losing this turns every burst past current
// capacity into customer-visible errors.
func TestSelectWorkerQueuesUntilCapacityArrives(t *testing.T) {
	f := &fakeSelector{failures: 3}
	w, _, err := testWorkerBackend(f).selectWorker(context.Background(), "us-west-2")
	if err != nil {
		t.Fatalf("selectWorker gave up while capacity was arriving: %v", err)
	}
	if w == nil || w.ID != "w-test-1" {
		t.Fatalf("got worker %v, want w-test-1", w)
	}
	if got := atomic.LoadInt32(&f.attempts); got < 2 {
		t.Fatalf("succeeded after %d attempts — it did not actually retry", got)
	}
}

// When capacity never arrives the answer must be ErrNoCapacity, so the caller
// can say 503 rather than 500. A generic error here reads as our bug and
// invites a retry into a cell that is genuinely full.
func TestSelectWorkerGivesUpWithErrNoCapacity(t *testing.T) {
	f := &fakeSelector{failures: -1}
	start := time.Now()
	_, _, err := testWorkerBackend(f).selectWorker(context.Background(), "us-west-2")
	if !errors.Is(err, ErrNoCapacity) {
		t.Fatalf("got %v, want ErrNoCapacity", err)
	}
	// It must actually wait — giving up instantly would refuse creates the
	// scaler was about to serve.
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("gave up after %s, well before the wait budget", elapsed)
	}
}

// A cancelled request must abandon the queue immediately. Without this a client
// that hung up still holds the slot for the full timeout, which is how a burst
// of abandoned creates starves the ones still waiting.
func TestSelectWorkerAbandonsOnContextCancel(t *testing.T) {
	f := &fakeSelector{failures: -1}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	_, _, err := testWorkerBackend(f).selectWorker(ctx, "us-west-2")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
	if elapsed := time.Since(start); elapsed > 150*time.Millisecond {
		t.Fatalf("kept queueing %s after cancellation", elapsed)
	}
}

// Claim and Activate are two calls with a database write between them, so the
// selection has to survive the gap. If it does not, Activate has no worker to
// dispatch to and the create fails after the row already exists.
func TestClaimHoldsTheSelectionForActivate(t *testing.T) {
	w := testWorkerBackend(&fakeSelector{failures: 0})

	if _, err := w.Claim(context.Background(), placement{sandboxID: "sb-1", region: "us-west-2"}); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	held, ok := w.takePending("sb-1")
	if !ok {
		t.Fatal("Claim did not hold the selection — Activate would have nothing to dispatch to")
	}
	if held.entry == nil || held.entry.ID != "w-test-1" {
		t.Fatalf("held %v, want the worker Claim selected", held.entry)
	}
	// Taking it must consume it: a second create for the same id is a different
	// sandbox, and reusing a stale selection would dispatch it to a worker that
	// was chosen for something else.
	if _, ok := w.takePending("sb-1"); ok {
		t.Error("the selection survived being taken")
	}
}

// Activating a sandbox this backend never claimed must fail rather than proceed
// with a nil client, which would panic on the dispatch.
func TestActivateWithoutAClaimFails(t *testing.T) {
	w := testWorkerBackend(&fakeSelector{failures: 0})
	if _, err := w.Activate(context.Background(), activation{sandboxID: "sb-never-claimed"}); err == nil {
		t.Fatal("Activate proceeded without a held claim")
	}
}

// An abandoned create must release its claim. Without this every failed create
// pins a worker entry and its connection for the life of the process.
func TestDropPendingReleasesAnAbandonedClaim(t *testing.T) {
	w := testWorkerBackend(&fakeSelector{failures: 0})
	if _, err := w.Claim(context.Background(), placement{sandboxID: "sb-1"}); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	w.dropPending("sb-1")
	if _, ok := w.takePending("sb-1"); ok {
		t.Error("dropPending left the claim held")
	}
}

// The fleet must never be excluded from the orphan sweep: its sandboxes carry
// real worker ids, and a prefix here would make the sweep skip every one of
// them, leaving dead workers' rows billing forever.
func TestWorkerBackendDeclaresNoManagedPrefixes(t *testing.T) {
	if got := (&workerBackend{}).WorkerIDPrefixes(); len(got) != 0 {
		t.Fatalf("worker backend declared prefixes %v — the orphan sweep would skip the fleet", got)
	}
}

// A nil backend is the state on a cell with no worker registry. Every entry
// point must be inert rather than panicking.
func TestNilWorkerBackendIsInert(t *testing.T) {
	var w *workerBackend
	if w.OwnsWorkerID("w-anything") {
		t.Error("nil worker backend claimed a worker id")
	}
	if h, a, r := w.Capacity(); h != 0 || a != 0 || r != 0 {
		t.Errorf("nil worker backend reported capacity (%d,%d,%d)", h, a, r)
	}
	if _, ok := w.Route(context.Background(), "sb-1"); ok {
		t.Error("nil worker backend claimed a route")
	}
}
