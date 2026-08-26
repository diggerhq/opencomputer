package api

import (
	"context"
	"sync"
	"time"
)

// materialize.go — keep "make sure this row exists" off the create hot path.
//
// The edge is authoritative on org and user identity, so a cell has to lazily
// create its local rows the first time it serves an org. That was done inline on
// every create, and both statements are an INSERT ... ON CONFLICT against a
// SINGLE row — the same org id and the same user id for every create an org
// makes.
//
// Postgres takes a row-level lock to resolve the conflict, so concurrent creates
// for one org do not merely repeat the work, they QUEUE for it. Measured on dev
// with a 20-way burst, control-plane create handlers came back 8, 11, 19, 34,
// 42, 53, 58, 66, 72, 79, 86ms — a flat ramp at roughly one statement's latency
// per request, which is a serialization signature rather than a slow query. The
// rows in question already existed for all twenty.
//
// So the work is memoized. The first create for an org still does it inline,
// because the session insert has foreign keys to both rows and must not race
// them. Everything after that inside the TTL skips it entirely.
//
// WHAT THE TTL COSTS: the cell's copy of `plan` and `billing_provider` is a
// mirror of D1, refreshed by this upsert. Memoizing it means a plan change takes
// up to the TTL to reach the cell. That is acceptable because the edge — not the
// cell — enforces every billing gate; the cell's copy only tags usage events. A
// TTL of zero would restore the old behaviour exactly.

// materializeTTL is how long a successful materialization is trusted. Short
// enough that a plan change reaches the cell's event tagging promptly, long
// enough that no realistic burst pays for it twice.
const materializeTTL = 5 * time.Minute

// materializer memoizes idempotent "ensure this row exists" work per key.
//
// Per-key locking, not one global lock: two different orgs creating at once must
// not block each other, and holding a single mutex across database I/O would
// make one slow upsert stall every create on the cell.
type materializer struct {
	ttl time.Duration

	mu   sync.Mutex
	seen map[string]*materializeEntry
}

type materializeEntry struct {
	mu sync.Mutex
	at time.Time // zero until the first success
}

func newMaterializer(ttl time.Duration) *materializer {
	return &materializer{ttl: ttl, seen: map[string]*materializeEntry{}}
}

// ensure runs fn unless it has already succeeded for this key inside the TTL.
//
// Concurrent callers for the same key collapse onto one run: the rest block on
// the entry's mutex and then observe the fresh timestamp. That is the property
// that matters for a burst — twenty simultaneous creates for one org do the work
// once, rather than twenty times through a row lock.
//
// A failure is not cached, so the next create retries. The error is returned for
// the caller to decide about; both current callers treat it as non-fatal,
// because a create can still succeed when the mirror is stale.
func (m *materializer) ensure(ctx context.Context, key string, fn func(context.Context) error) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	e, ok := m.seen[key]
	if !ok {
		e = &materializeEntry{}
		m.seen[key] = e
	}
	m.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.at.IsZero() && time.Since(e.at) < m.ttl {
		return nil
	}
	if err := fn(ctx); err != nil {
		return err
	}
	e.at = time.Now()
	return nil
}

// forget drops a key's memo, so the next caller re-runs the work. For a caller
// that learns the row is gone.
func (m *materializer) forget(key string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	delete(m.seen, key)
	m.mu.Unlock()
}
