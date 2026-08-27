package api

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/db"
)

// The whole point of the single flight is what happens when N callers miss at
// the same instant, so the fetch blocks until every caller has arrived.
func TestTemplateCacheLookupSingleFlights(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	want := &db.DBTemplate{ID: uuid.New()}

	const n = 100
	var calls atomic.Int32
	release := make(chan struct{})
	var arrived sync.WaitGroup
	arrived.Add(n)

	var wg sync.WaitGroup
	got := make([]*db.DBTemplate, n)
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			arrived.Done()
			got[i], errs[i] = c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) {
				calls.Add(1)
				<-release // hold the flight open so all n callers pile onto it
				return want, nil
			})
		}()
	}

	arrived.Wait()
	// Give the goroutines a moment to actually reach lookup and join the flight.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if c := calls.Load(); c != 1 {
		t.Fatalf("fetch ran %d times, want exactly 1 (the herd is the bug)", c)
	}
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("caller %d: unexpected error %v", i, errs[i])
		}
		if got[i] != want {
			t.Fatalf("caller %d: got %v, want the single flight's result %v", i, got[i], want)
		}
	}
}

// A hit must not start a flight at all.
func TestTemplateCacheLookupServesCached(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	want := &db.DBTemplate{ID: uuid.New()}

	if _, err := c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) { return want, nil }); err != nil {
		t.Fatalf("seed lookup: %v", err)
	}
	got, err := c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) {
		t.Fatal("fetch ran on a cached entry")
		return nil, nil
	})
	if err != nil || got != want {
		t.Fatalf("got (%v, %v), want (%v, nil)", got, err, want)
	}
}

// Errors are shared by the flight rather than silently cached: every waiter
// sees the failure, and the NEXT caller retries instead of inheriting it.
func TestTemplateCacheLookupSharesErrorAndDoesNotCacheIt(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	boom := errors.New("edge unreachable")

	var calls atomic.Int32
	release := make(chan struct{})
	var wg sync.WaitGroup
	errsOut := make([]error, 8)
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errsOut[i] = c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) {
				calls.Add(1)
				<-release
				return nil, boom
			})
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if c := calls.Load(); c != 1 {
		t.Fatalf("fetch ran %d times, want 1", c)
	}
	for i, err := range errsOut {
		if !errors.Is(err, boom) {
			t.Fatalf("waiter %d got %v, want the flight's error", i, err)
		}
	}

	// A failure must leave nothing behind — the retry has to reach the edge.
	want := &db.DBTemplate{ID: uuid.New()}
	got, err := c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) { return want, nil })
	if err != nil || got != want {
		t.Fatalf("after a failed flight got (%v, %v), want a fresh fetch", got, err)
	}
}

// A nil template (name resolves to nothing) must not be cached as a positive,
// or create-template-then-use-it breaks for the length of the TTL.
func TestTemplateCacheLookupDoesNotCacheNil(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()

	var calls atomic.Int32
	fetch := func(context.Context) (*db.DBTemplate, error) { calls.Add(1); return nil, nil }
	for range 3 {
		if got, err := c.lookup(t.Context(), org, "ghost", fetch); got != nil || err != nil {
			t.Fatalf("got (%v, %v), want (nil, nil)", got, err)
		}
	}
	if c := calls.Load(); c != 3 {
		t.Fatalf("fetch ran %d times, want 3 — a nil result must stay uncached", c)
	}
}

// Distinct keys must not share a flight.
func TestTemplateCacheLookupKeysAreIndependent(t *testing.T) {
	c := newTemplateCache()
	orgA, orgB := uuid.New(), uuid.New()
	a := &db.DBTemplate{ID: uuid.New()}
	b := &db.DBTemplate{ID: uuid.New()}

	gotA, _ := c.lookup(t.Context(), orgA, "base", func(context.Context) (*db.DBTemplate, error) { return a, nil })
	gotB, _ := c.lookup(t.Context(), orgB, "base", func(context.Context) (*db.DBTemplate, error) { return b, nil })
	gotName, _ := c.lookup(t.Context(), orgA, "other", func(context.Context) (*db.DBTemplate, error) { return b, nil })

	if gotA != a || gotB != b || gotName != b {
		t.Fatalf("keys bled together: orgA=%v orgB=%v otherName=%v", gotA, gotB, gotName)
	}
}

// The load-bearing one: a STALE entry must be served immediately and refreshed
// behind the response. If this regresses, a burst blocks on the edge round trip
// again — the 580ms handler.
func TestTemplateCacheLookupServesStaleWithoutBlocking(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	old := &db.DBTemplate{ID: uuid.New()}
	fresh := &db.DBTemplate{ID: uuid.New()}

	if _, err := c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) { return old, nil }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Age the entry past the TTL but well inside the stale ceiling.
	key := templateCacheKey(org, "base")
	c.mu.Lock()
	e := c.m[key]
	e.at = time.Now().Add(-(templateCacheTTL + time.Second))
	c.m[key] = e
	c.mu.Unlock()

	refreshed := make(chan struct{})
	start := time.Now()
	got, err := c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) {
		time.Sleep(300 * time.Millisecond) // a slow edge, the whole point
		close(refreshed)
		return fresh, nil
	})
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("stale lookup errored: %v", err)
	}
	if got != old {
		t.Fatalf("got %v, want the STALE value %v served immediately", got, old)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("stale lookup blocked for %v — it must not wait on the refresh", elapsed)
	}

	select {
	case <-refreshed:
	case <-time.After(3 * time.Second):
		t.Fatal("background refresh never ran")
	}
	// And the refreshed value replaces it.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got, _ := c.get(org, "base"); got == fresh {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("refresh completed but the cache still holds the stale value")
}

// Concurrent stale reads must kick exactly ONE background refresh, not one each.
func TestTemplateCacheStaleRefreshIsSingleFlighted(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	old := &db.DBTemplate{ID: uuid.New()}

	if _, err := c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) { return old, nil }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	key := templateCacheKey(org, "base")
	c.mu.Lock()
	e := c.m[key]
	e.at = time.Now().Add(-(templateCacheTTL + time.Second))
	c.m[key] = e
	c.mu.Unlock()

	var calls atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.lookup(t.Context(), org, "base", func(context.Context) (*db.DBTemplate, error) {
				calls.Add(1)
				time.Sleep(100 * time.Millisecond)
				return old, nil
			})
		}()
	}
	wg.Wait()
	time.Sleep(300 * time.Millisecond) // let the refresh finish

	if n := calls.Load(); n != 1 {
		t.Fatalf("%d background refreshes ran, want 1", n)
	}
}

// The default-template path: a cold key must return nil IMMEDIATELY rather than
// wait, and fill behind the caller.
func TestTemplateCacheLookupNonBlockingNeverWaits(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	want := &db.DBTemplate{ID: uuid.New()}
	filled := make(chan struct{})

	start := time.Now()
	got := c.lookupNonBlocking(org, "base", func(context.Context) (*db.DBTemplate, error) {
		time.Sleep(300 * time.Millisecond) // a saturated edge
		close(filled)
		return want, nil
	})
	elapsed := time.Since(start)

	if got != nil {
		t.Fatalf("cold key returned %v, want nil (it must not wait to find out)", got)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("blocked for %v — the default template must never block a create", elapsed)
	}

	select {
	case <-filled:
	case <-time.After(3 * time.Second):
		t.Fatal("background fill never ran")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.lookupNonBlocking(org, "base", func(context.Context) (*db.DBTemplate, error) {
			return nil, errors.New("should not refetch a fresh entry")
		}) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fill completed but the cache never served it")
}

// A burst on a cold default key must kick ONE fill, not one per caller.
func TestTemplateCacheNonBlockingBurstFillsOnce(t *testing.T) {
	c := newTemplateCache()
	org := uuid.New()
	var calls atomic.Int32

	var wg sync.WaitGroup
	for range 70 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.lookupNonBlocking(org, "base", func(context.Context) (*db.DBTemplate, error) {
				calls.Add(1)
				time.Sleep(150 * time.Millisecond)
				return &db.DBTemplate{ID: uuid.New()}, nil
			})
		}()
	}
	wg.Wait()
	time.Sleep(400 * time.Millisecond)

	if n := calls.Load(); n != 1 {
		t.Fatalf("%d fills ran for one cold key, want 1", n)
	}
}

// isDefaultTemplate decides whether an unresolved name 404s. If it stopped
// matching the pool's template name, every ordinary create would 404 on a cold
// cache — so pin the two together.
func TestIsDefaultTemplateTracksPoolTemplateName(t *testing.T) {
	if !isDefaultTemplate(poolTemplateName()) {
		t.Fatalf("isDefaultTemplate(%q) is false — an unresolved default would 404 every create", poolTemplateName())
	}
	if isDefaultTemplate("some-custom-template") {
		t.Fatal("a custom template must NOT be exempt from the not-found 404")
	}
	if isDefaultTemplate("") {
		t.Fatal("the empty name has its own earlier short-circuit; it must not match here")
	}
}

// A nil cache still resolves (the edge-less / test path).
func TestTemplateCacheLookupNilReceiver(t *testing.T) {
	var c *templateCache
	want := &db.DBTemplate{ID: uuid.New()}
	got, err := c.lookup(t.Context(), uuid.New(), "base", func(context.Context) (*db.DBTemplate, error) { return want, nil })
	if err != nil || got != want {
		t.Fatalf("got (%v, %v), want (%v, nil)", got, err, want)
	}
}
