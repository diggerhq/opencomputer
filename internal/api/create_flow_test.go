package api

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// create_flow_test.go — the create sequence, which until now was a comment.
//
// The ordering constraint ("persist before activate, because the worker reads
// org_id from the row while booting") lived only in prose inside a 292-line
// handler that no test could reach. These pin it.

// recorder captures the order steps ran in.
type recorder struct{ calls []string }

func (r *recorder) mark(s string) { r.calls = append(r.calls, s) }
func (r *recorder) seq() string   { return strings.Join(r.calls, ",") }

func okSteps(r *recorder) createSteps {
	return createSteps{
		claim: func(context.Context) (string, error) {
			r.mark("claim")
			return "w-1", nil
		},
		persist:  func(context.Context, string) error { r.mark("persist"); return nil },
		activate: func(context.Context, string) error { r.mark("activate"); return nil },
		promote:  func(context.Context, string) error { r.mark("promote"); return nil },
		cleanup:  func(context.Context, string, error) { r.mark("cleanup") },
	}
}

// The row must exist before the host boots. Reversing these is not a cosmetic
// reordering: the QEMU worker looks up org_id in that row while starting the
// VM, so a later write races the thing that reads it.
func TestRunCreatePersistsBeforeActivating(t *testing.T) {
	r := &recorder{}
	workerID, err := runCreate(context.Background(), "sb-1", okSteps(r))
	if err != nil {
		t.Fatalf("runCreate: %v", err)
	}
	if workerID != "w-1" {
		t.Fatalf("got worker %q, want w-1", workerID)
	}
	if got := r.seq(); got != "claim,persist,activate,promote" {
		t.Fatalf("sequence was %q, want claim,persist,activate,promote", got)
	}
}

// A create that could not choose a host must not write a row. Otherwise the
// database gains a sandbox with no host behind it, which the reconciler has to
// clean up and which bills in the meantime.
func TestRunCreateStopsWhenClaimFails(t *testing.T) {
	r := &recorder{}
	steps := okSteps(r)
	steps.claim = func(context.Context) (string, error) {
		r.mark("claim")
		return "", errors.New("no capacity")
	}

	if _, err := runCreate(context.Background(), "sb-1", steps); err == nil {
		t.Fatal("runCreate succeeded despite a failed claim")
	}
	if got := r.seq(); got != "claim" {
		t.Fatalf("sequence was %q — steps ran after the claim failed", got)
	}
}

// A host that failed to start must not be promoted to running, and its row must
// be cleaned up. Promoting here is how a sandbox ends up 'running' with nothing
// behind it — the customer's next request 502s and billing has already started.
func TestRunCreateCleansUpAndSkipsPromoteWhenActivateFails(t *testing.T) {
	r := &recorder{}
	steps := okSteps(r)
	boom := errors.New("worker refused")
	steps.activate = func(context.Context, string) error {
		r.mark("activate")
		return boom
	}

	_, err := runCreate(context.Background(), "sb-1", steps)
	if err == nil {
		t.Fatal("runCreate succeeded despite a failed activate")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("error %v lost the underlying cause", err)
	}
	if got := r.seq(); got != "claim,persist,activate,cleanup" {
		t.Fatalf("sequence was %q, want cleanup and no promote", got)
	}
}

// A persist failure must not abort a create whose host is already running.
// Failing here would strand a live host with nothing tracking it — strictly
// worse than a missing row, which the reconciler settles.
func TestRunCreateContinuesWhenPersistFails(t *testing.T) {
	r := &recorder{}
	steps := okSteps(r)
	steps.persist = func(context.Context, string) error {
		r.mark("persist")
		return errors.New("pg down")
	}

	if _, err := runCreate(context.Background(), "sb-1", steps); err != nil {
		t.Fatalf("runCreate aborted on a non-fatal persist failure: %v", err)
	}
	if got := r.seq(); got != "claim,persist,activate,promote" {
		t.Fatalf("sequence was %q — a persist failure changed the flow", got)
	}
}

// For a backend that rebuilds its view of what it is running *from* these rows,
// an unwritten row is not a gap the reconciler closes — it is a host nothing
// will ever reclaim, billing and holding capacity until its hard lifetime cap.
// Those backends must fail the create and give the host back.
func TestRunCreateFailsWhenRequiredPersistFails(t *testing.T) {
	r := &recorder{}
	steps := okSteps(r)
	steps.persistRequired = true
	boom := errors.New("pg down")
	steps.persist = func(context.Context, string) error {
		r.mark("persist")
		return boom
	}

	_, err := runCreate(context.Background(), "sb-1", steps)
	if err == nil {
		t.Fatal("runCreate handed out a sandbox it could not record")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("error %v lost the underlying cause", err)
	}
	if got := r.seq(); got != "claim,persist,cleanup" {
		t.Fatalf("sequence was %q, want the host released and nothing started", got)
	}
}

// A backend whose hosts are already running supplies no activate. The sequence
// must still complete rather than treating the nil as a failure.
func TestRunCreateSkipsNilActivate(t *testing.T) {
	r := &recorder{}
	steps := okSteps(r)
	steps.activate = nil

	if _, err := runCreate(context.Background(), "sb-1", steps); err != nil {
		t.Fatalf("runCreate: %v", err)
	}
	if got := r.seq(); got != "claim,persist,promote" {
		t.Fatalf("sequence was %q, want the activate step skipped", got)
	}
}

// The whole point of deferPersist is that the customer is not waiting on the
// database. Blocking the write and asserting the create still returns proves
// that directly — if persist were inline this test would deadlock until the
// timeout, which is exactly the 230ms we are removing from every create.
func TestDeferPersistAnswersBeforeTheWriteCompletes(t *testing.T) {
	release := make(chan struct{})
	persistStarted := make(chan struct{})
	promoted := make(chan struct{})

	steps := createSteps{
		claim:        func(context.Context) (string, error) { return "vmhost:mvm-1", nil },
		deferPersist: true,
		persist: func(context.Context, string) error {
			close(persistStarted)
			<-release
			return nil
		},
		promote: func(context.Context, string) error { close(promoted); return nil },
	}

	done := make(chan string, 1)
	go func() {
		id, err := runCreate(context.Background(), "sb-1", steps)
		if err != nil {
			t.Errorf("runCreate: %v", err)
		}
		done <- id
	}()

	select {
	case id := <-done:
		if id != "vmhost:mvm-1" {
			t.Fatalf("workerID = %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("create blocked on the deferred write — it is still on the request path")
	}

	// And the write really does happen, rather than being dropped.
	select {
	case <-persistStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("deferred persist never started")
	}
	close(release)
	select {
	case <-promoted:
	case <-time.After(3 * time.Second):
		t.Fatal("deferred promote never ran after persist succeeded")
	}
}

// A failed deferred persist must not promote: flipping a row to running that
// was never inserted is a partial write nothing else expects. The box is still
// recoverable — the reconciler adopts it from AWS — but the row must not lie.
func TestDeferPersistSkipsPromoteWhenPersistFails(t *testing.T) {
	promoteCalled := make(chan struct{}, 1)
	steps := createSteps{
		claim:        func(context.Context) (string, error) { return "vmhost:mvm-2", nil },
		deferPersist: true,
		persist:      func(context.Context, string) error { return errors.New("db down") },
		promote:      func(context.Context, string) error { promoteCalled <- struct{}{}; return nil },
	}
	if _, err := runCreate(context.Background(), "sb-2", steps); err != nil {
		t.Fatalf("create must succeed even when the deferred write will fail: %v", err)
	}
	select {
	case <-promoteCalled:
		t.Fatal("promoted a row that was never inserted")
	case <-time.After(300 * time.Millisecond):
	}
}
