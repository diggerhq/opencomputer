package api

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The whole point is that a burst of creates for one org does this work ONCE.
// Doing it per create is what made concurrent creates queue on a Postgres row
// lock, because both callers upsert a single row.
func TestConcurrentEnsuresForOneKeyCollapseToASingleRun(t *testing.T) {
	m := newMaterializer(time.Minute)
	var runs atomic.Int64

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = m.ensure(context.Background(), "org:a", func(context.Context) error {
				runs.Add(1)
				// Long enough that every other goroutine is definitely inside
				// ensure while this one holds the entry.
				time.Sleep(20 * time.Millisecond)
				return nil
			})
		}()
	}
	wg.Wait()

	if n := runs.Load(); n != 1 {
		t.Fatalf("ran %d times for 20 concurrent callers, want 1 — the rest still contend", n)
	}
}

// Different keys must not block each other, or one org's slow upsert stalls
// every other org's creates on the cell.
func TestDifferentKeysDoNotSerialize(t *testing.T) {
	m := newMaterializer(time.Minute)
	release := make(chan struct{})
	started := make(chan struct{})

	go func() {
		_ = m.ensure(context.Background(), "org:slow", func(context.Context) error {
			close(started)
			<-release
			return nil
		})
	}()
	<-started

	done := make(chan struct{})
	go func() {
		_ = m.ensure(context.Background(), "org:fast", func(context.Context) error { return nil })
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("a second key blocked behind the first — per-key locking is not working")
	}
	close(release)
}

// A failure must NOT be memoized: the row still does not exist, and the session
// insert that follows has foreign keys to it.
func TestFailureIsNotCached(t *testing.T) {
	m := newMaterializer(time.Minute)
	var runs atomic.Int64
	boom := errors.New("boom")

	if err := m.ensure(context.Background(), "k", func(context.Context) error {
		runs.Add(1)
		return boom
	}); !errors.Is(err, boom) {
		t.Fatalf("ensure returned %v, want the underlying error", err)
	}
	_ = m.ensure(context.Background(), "k", func(context.Context) error {
		runs.Add(1)
		return nil
	})
	if n := runs.Load(); n != 2 {
		t.Fatalf("ran %d times, want 2 — a failed materialization was cached", n)
	}
}

// Past the TTL the work runs again, so the cell's mirrored plan does not go
// stale forever.
func TestWorkRerunsAfterTheTTL(t *testing.T) {
	m := newMaterializer(20 * time.Millisecond)
	var runs atomic.Int64
	run := func() {
		_ = m.ensure(context.Background(), "k", func(context.Context) error { runs.Add(1); return nil })
	}

	run()
	run()
	if n := runs.Load(); n != 1 {
		t.Fatalf("ran %d times inside the TTL, want 1", n)
	}
	time.Sleep(30 * time.Millisecond)
	run()
	if n := runs.Load(); n != 2 {
		t.Fatalf("ran %d times after the TTL expired, want 2", n)
	}
}

// forget drops the memo, for a caller that learns the row is gone.
func TestForgetForcesARerun(t *testing.T) {
	m := newMaterializer(time.Hour)
	var runs atomic.Int64
	run := func() {
		_ = m.ensure(context.Background(), "k", func(context.Context) error { runs.Add(1); return nil })
	}

	run()
	m.forget("k")
	run()
	if n := runs.Load(); n != 2 {
		t.Fatalf("ran %d times, want 2 — forget did not drop the memo", n)
	}
}

// A nil materializer must be inert rather than panic: it is a field on Server,
// and tests construct Servers directly.
func TestNilMaterializerIsInert(t *testing.T) {
	var m *materializer
	if err := m.ensure(context.Background(), "k", func(context.Context) error {
		t.Fatal("fn ran on a nil materializer")
		return nil
	}); err != nil {
		t.Fatalf("nil ensure returned %v", err)
	}
	m.forget("k")
}
