package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The behaviour under test is the one that produced "sandbox <id> not found" on
// a create→exec run: a sub-op arriving between the edge's 201 and the claim
// finalizing. It must wait for the finalize rather than answer 404, and it must
// come back the instant the finalize lands — not on a poll interval.
func TestWaitEdgeFinalizeReleasesOnFinalize(t *testing.T) {
	s := &Server{}
	s.registerEdgePending("sb-race")

	done := make(chan error, 1)
	go func() { done <- s.waitEdgeFinalize(context.Background(), "sb-race") }()

	// Give the waiter a moment to park, then finalize.
	time.Sleep(20 * time.Millisecond)
	start := time.Now()
	s.resolveEdgePending("sb-race", nil)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("waiter got %v, want nil", err)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("waiter released after %s — it is polling, not waiting on the finalize", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never released after the claim finalized")
	}

	// Resolved entries are forgotten, so a later sub-op takes the normal path
	// instead of waiting on a claim that already happened.
	if err := s.waitEdgeFinalize(context.Background(), "sb-race"); err != nil {
		t.Fatalf("post-finalize wait returned %v, want nil", err)
	}
}

// A finalize that fails must wake anyone already parked WITH the failure,
// rather than releasing them to a lookup that 404s — the box never bound, and
// "creation failed: reservation lost" is a far more useful answer than "no such
// sandbox".
func TestWaitEdgeFinalizeReportsFailureToParkedWaiter(t *testing.T) {
	s := &Server{}
	s.registerEdgePending("sb-lost")
	want := errors.New("reservation lost")

	done := make(chan error, 1)
	go func() { done <- s.waitEdgeFinalize(context.Background(), "sb-lost") }()
	time.Sleep(20 * time.Millisecond)
	s.resolveEdgePending("sb-lost", want)

	select {
	case got := <-done:
		if !errors.Is(got, want) {
			t.Fatalf("waiter got %v, want %v", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never released after the claim failed")
	}
}

// A caller that arrives AFTER a failed claim was resolved takes the normal
// path, not the stored error. Resolving forgets the id, deliberately — see the
// note on resolveEdgePending. This pins that contract: the gate's job is to
// stop callers racing an in-flight finalize, and once one is no longer in
// flight the ordinary lookup is authoritative.
func TestWaitEdgeFinalizeFallsThroughAfterResolve(t *testing.T) {
	s := &Server{}
	s.registerEdgePending("sb-lost-late")
	s.resolveEdgePending("sb-lost-late", errors.New("reservation lost"))

	if got := s.waitEdgeFinalize(context.Background(), "sb-lost-late"); got != nil {
		t.Fatalf("late caller got %v, want nil so the normal lookup answers", got)
	}
}

// An id that was never an edge reservation must not wait at all — this runs on
// every lookup miss, including genuinely unknown sandboxes.
func TestWaitEdgeFinalizeIgnoresUnknownID(t *testing.T) {
	s := &Server{}
	start := time.Now()
	if err := s.waitEdgeFinalize(context.Background(), "sb-never-reserved"); err != nil {
		t.Fatalf("got %v, want nil", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("waited %s on an unknown id — every 404 would now be slow", elapsed)
	}
}

// A finalize that never arrives must not hold the request open. The waiter
// gives up and lets the normal lookup answer, which is exactly today's
// behaviour — the gate can only make things better, never hang them.
func TestWaitEdgeFinalizeGivesUp(t *testing.T) {
	s := &Server{}
	s.registerEdgePending("sb-stuck")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := s.waitEdgeFinalize(ctx, "sb-stuck")
	if elapsed := time.Since(start); elapsed >= edgePendingWait {
		t.Fatalf("waited %s — the caller's own deadline should have cut it short", elapsed)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v, want the caller's deadline", err)
	}
}

// Re-reserving an id must not orphan a waiter already parked on it.
func TestRegisterEdgePendingIsIdempotent(t *testing.T) {
	s := &Server{}
	s.registerEdgePending("sb-dup")
	done := make(chan error, 1)
	go func() { done <- s.waitEdgeFinalize(context.Background(), "sb-dup") }()
	time.Sleep(20 * time.Millisecond)

	s.registerEdgePending("sb-dup") // second reserve of the same id
	s.resolveEdgePending("sb-dup", nil)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("waiter got %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("re-registering stranded the existing waiter")
	}
}
