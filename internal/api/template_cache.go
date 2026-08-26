package api

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/db"
)

// template_cache.go — keep the template lookup off the create hot path.
//
// resolveTemplate asks the edge to turn a template NAME into a row, and it does
// that inside every create, synchronously. Found by tailing the edge rather than
// the control plane: `GET /internal/templates/by-name?name=base` at 66-69ms on
// every single create, for a row that changes about never.
//
// It was invisible from both sides on its own. The control plane's create trace
// stops at the process boundary, so the call showed up only inside the `tmpl`
// span; the edge saw it as an ordinary internal request with nothing to compare
// it against. It took counting requests at the edge during an SDK run to see
// that a "3 request" TTI was actually making five.
//
// POSITIVE RESULTS ONLY. A miss means the template does not exist, and caching
// that would make "create a template, then create a sandbox from it" fail for
// the length of the TTL. That is a correctness bug bought with latency, and the
// latency is available without it — a miss is exactly the case where the extra
// round trip is doing real work.

// templateCacheTTL bounds how stale a resolved template may be. Templates are
// immutable in the way that matters here — the drive keys a name resolves to —
// and a rebuild publishes a new row, so a minute of staleness costs at most one
// create landing on the previous revision.
const templateCacheTTL = 60 * time.Second

// templateStaleMax bounds how old an entry may be and still be served without
// waiting. Past it a create blocks on a fresh read rather than acting on a value
// nothing has been able to confirm for this long — a background refresh that
// keeps failing must eventually surface, not persist silently forever.
//
// Generous on purpose: the cost of being wrong is one create landing on the
// previous revision of a template, while the cost of blocking is the 580ms
// above. A rebuild publishes a new row, and the refresh below picks it up
// within a TTL of the next create.
const templateStaleMax = 30 * time.Minute

// templateRefreshTimeout bounds a background refresh. It is deliberately not
// the request's context: the request returns immediately (that is the point),
// so a refresh tied to it would be cancelled the moment the response is sent.
const templateRefreshTimeout = 15 * time.Second

// A CACHE WITHOUT SINGLE-FLIGHT IS NOT A CACHE UNDER BURST.
//
// The TTL above made this cheap for sequential traffic and did nothing at all
// for a burst: 100 concurrent creates all read the same empty entry in the same
// instant, all miss, and all issue their own control-plane→edge lookup for the
// same name. Measured on dev with a burst of 100, the only difference being
// whether the create body carried a template name:
//
//	body {}                          create.cell (the CP's own answer)  138ms
//	body {"templateID":"base"}       create.cell                        932ms
//
// ~794ms, entirely inside the control plane, for a value that is identical in
// all 100 requests. It hides from sequential benchmarks by construction — the
// first create fills the entry and the rest hit it — so it only exists at
// exactly the concurrency that matters. It reaches every real SDK user, because
// the SDK always sends templateID ("base" by default); a raw client that omits
// the field skips resolveTemplate entirely and never sees it.
//
// The fix is the same one lookupCell needed at the edge: collapse concurrent
// misses for one key into ONE flight and let the rest wait on its result.
//
// SINGLE-FLIGHT ALONE IS NOT ENOUGH, and the trace says why. With 90 concurrent
// creates carrying a template name, on the control plane's own per-create trace:
//
//	ENTER offsets   spread=56ms      (all 90 reach the handler together)
//	handler total   med=580,065us
//	  tmpl          med=579,862us    ← 99.97% of the handler
//	  token=12us bind=8us activate=3us claim=2us
//
// versus a handler median of 64us for a create with no template name. The
// single flight had already collapsed 90 lookups into one; every caller then
// waited on that one lookup, and the lookup itself took 580ms.
//
// It takes 580ms because of the topology, not the work: a create arrives at the
// edge, the edge calls this control plane, and this control plane calls BACK
// INTO THE SAME EDGE for the template. During a burst the edge is already
// saturated holding those creates open, so the lookup queues behind the very
// requests that are blocked waiting for it. Idle, the same call is ~60ms.
//
// So the hot path must never wait on it. An entry that exists is served
// IMMEDIATELY, however old, and refreshed in the background; only a name never
// resolved before can block, which is the one case where the round trip is
// doing real work (it decides between a real template and a 404).
type templateCache struct {
	mu     sync.Mutex
	m      map[string]templateCacheEntry
	flight map[string]*templateFlight
}

type templateCacheEntry struct {
	tmpl *db.DBTemplate
	at   time.Time
}

// templateFlight is one in-progress lookup that later arrivals join instead of
// duplicating. done is closed exactly once, by the goroutine that started it.
type templateFlight struct {
	done chan struct{}
	tmpl *db.DBTemplate
	err  error
}

func newTemplateCache() *templateCache {
	return &templateCache{
		m:      map[string]templateCacheEntry{},
		flight: map[string]*templateFlight{},
	}
}

func templateCacheKey(orgID uuid.UUID, name string) string {
	// Org-scoped: resolution falls back to public templates, so the same name can
	// legitimately mean different rows for different orgs. A global key would
	// serve one org's template to another.
	return orgID.String() + "\x00" + name
}

// get returns a cached template. The bool reports whether the cache answered at
// all — distinct from a cached nil, which this deliberately never stores.
func (c *templateCache) get(orgID uuid.UUID, name string) (*db.DBTemplate, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	e, ok := c.m[templateCacheKey(orgID, name)]
	c.mu.Unlock()
	if !ok || time.Since(e.at) >= templateCacheTTL {
		return nil, false
	}
	return e.tmpl, true
}

// lookup returns the template for name without blocking the caller whenever it
// can avoid it:
//
//	fresh entry (< TTL)          → returned as-is
//	stale entry (< staleMax)     → returned IMMEDIATELY, refreshed in background
//	no entry (or past staleMax)  → blocks, single-flighted across all callers
//
// fetch receives a context because the two paths need different ones: a
// blocking lookup belongs to the request, while a background refresh must
// outlive it (the request returns first, by design).
//
// The result of a joined flight is shared, including its error: a failing
// lookup fails all of its waiters identically, which is what they would each
// have gotten anyway. Only positive results are cached (see put).
func (c *templateCache) lookup(ctx context.Context, orgID uuid.UUID, name string, fetch func(context.Context) (*db.DBTemplate, error)) (*db.DBTemplate, error) {
	if c == nil {
		return fetch(ctx)
	}

	key := templateCacheKey(orgID, name)
	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		age := time.Since(e.at)
		if age < templateCacheTTL {
			c.mu.Unlock()
			return e.tmpl, nil
		}
		if age < templateStaleMax {
			// Serve stale, refresh behind the response. startFlightLocked is a
			// no-op when a refresh for this key is already running, so a burst
			// kicks exactly one.
			c.startRefreshLocked(key, orgID, name, fetch)
			c.mu.Unlock()
			return e.tmpl, nil
		}
	}
	if f, ok := c.flight[key]; ok {
		c.mu.Unlock()
		<-f.done
		return f.tmpl, f.err
	}
	f := &templateFlight{done: make(chan struct{})}
	c.flight[key] = f
	c.mu.Unlock()

	tmpl, err := fetch(ctx)
	c.finishFlight(key, orgID, name, f, tmpl, err)
	return f.tmpl, f.err
}

// lookupNonBlocking returns whatever is cached for name — fresh or stale — and
// NEVER waits on the edge. A key with nothing cached yet returns nil and fills
// in the background.
//
// This is the default-template path. The blocking lookup above still costs one
// cold round trip per key, and a burst that arrives cold is exactly the case
// that cannot afford it: measured after single-flight + stale-while-revalidate,
// a burst of 70 still spent tmpl=156,838us of a 156,943us handler, because
// every caller piled onto the one cold flight.
//
// It is sound only because the create path does not use the result for the
// default template: drive keys are read solely for TemplateType=="sandbox"
// (custom snapshot templates), and the resolved ID feeds a bookkeeping UPDATE
// that already runs after the response. A name that resolves to nothing here
// must therefore NOT 404 — see the caller.
func (c *templateCache) lookupNonBlocking(orgID uuid.UUID, name string, fetch func(context.Context) (*db.DBTemplate, error)) *db.DBTemplate {
	if c == nil {
		return nil
	}
	key := templateCacheKey(orgID, name)
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if ok && time.Since(e.at) < templateCacheTTL {
		return e.tmpl
	}
	// Absent or stale: fill behind the response and answer with what we have
	// (nil on the very first call for this key).
	c.startRefreshLocked(key, orgID, name, fetch)
	if ok {
		return e.tmpl
	}
	return nil
}

// startRefreshLocked kicks a background refresh for key unless one is already in
// flight. Caller must hold c.mu.
func (c *templateCache) startRefreshLocked(key string, orgID uuid.UUID, name string, fetch func(context.Context) (*db.DBTemplate, error)) {
	if _, ok := c.flight[key]; ok {
		return
	}
	f := &templateFlight{done: make(chan struct{})}
	c.flight[key] = f
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), templateRefreshTimeout)
		defer cancel()
		tmpl, err := fetch(ctx)
		if err != nil {
			// Keep serving the existing entry; the next create past the TTL
			// tries again. Logged because a refresh that never succeeds is how
			// a stale template would eventually start blocking creates.
			log.Printf("template cache: background refresh of %q failed: %v", name, err)
		}
		c.finishFlight(key, orgID, name, f, tmpl, err)
	}()
}

// finishFlight publishes a flight's result: cache it (positive only), drop the
// flight, then wake the waiters — in that order, so nobody wakes up and
// re-misses on the entry this flight just produced.
func (c *templateCache) finishFlight(key string, orgID uuid.UUID, name string, f *templateFlight, tmpl *db.DBTemplate, err error) {
	f.tmpl, f.err = tmpl, err
	if err == nil {
		c.put(orgID, name, tmpl)
	}
	c.mu.Lock()
	delete(c.flight, key)
	c.mu.Unlock()
	close(f.done)
}

// put stores a resolved template. A nil template is dropped rather than stored —
// see the package note on negative caching.
func (c *templateCache) put(orgID uuid.UUID, name string, tmpl *db.DBTemplate) {
	if c == nil || tmpl == nil {
		return
	}
	c.mu.Lock()
	if len(c.m) >= 4096 {
		// Unbounded growth would be a slow leak on a cell serving many orgs, and
		// this is a latency cache — dropping it whole is cheaper than tracking
		// eviction order for something that refills in one request.
		c.m = map[string]templateCacheEntry{}
	}
	c.m[templateCacheKey(orgID, name)] = templateCacheEntry{tmpl: tmpl, at: time.Now()}
	c.mu.Unlock()
}
