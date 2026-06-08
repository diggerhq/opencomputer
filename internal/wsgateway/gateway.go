package wsgateway

import (
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Gateway is the per-cell broker. One instance per cell-CP process,
// holding a map of sandboxID → sandboxActor. The cell-CP's WS route
// handlers (handlers added in Phase 2) call Gateway.Serve with the
// upgraded client conn and a function that resolves the worker WS URL
// + sandbox JWT.
//
// Routing model: each sandbox gets at most one sandboxActor. Multiple
// concurrent WS upgrades to the same sandbox (dashboard + SDK, two
// dashboard tabs, etc.) all share that actor and run as independent
// sessions inside it. The actor owns a keepalive ticker that fires
// across all its sessions every AlarmInterval, and a cap-token cache
// shared across them.
//
// Lifecycle:
//   - First Serve for a sandbox creates the actor.
//   - Subsequent Serves attach new Sessions to the existing actor.
//   - When the last session closes, the actor's keepalive loop notices
//     during its next tick, signals shutdown, and the Gateway drops the
//     map entry. Idempotent and tolerant of races.
type Gateway struct {
	mu        sync.Mutex
	sandboxes map[string]*sandboxActor
}

// NewGateway constructs an empty Gateway ready to accept Serve calls.
func NewGateway() *Gateway {
	return &Gateway{
		sandboxes: make(map[string]*sandboxActor),
	}
}

// ServeOpts is everything the broker needs to bridge one client WS to
// the worker. All fields are required.
type ServeOpts struct {
	SandboxID string
	SessionID string
	CellPath  string // e.g. "/api/sandboxes/sb-xxx/pty/yyy" — purely for logging + isExec detection

	// ResolveWorker returns the worker WS URL plus the per-request
	// sandbox JWT the worker expects in the Authorization header. Called
	// once on initial dial and again on each redial — so a worker change
	// (post-migration) is picked up automatically.
	ResolveWorker func() (workerWSURL string, sandboxToken string, err error)
}

// Serve upgrades the request to a WebSocket, then runs the broker
// session against the worker. Returns nil on a clean handoff; non-nil
// error before the upgrade can be returned to the caller for a normal
// HTTP error response. Once the upgrade succeeds, all further error
// reporting happens via WS close frames — Serve returns nil and the
// caller's HTTP path is done.
func (g *Gateway) Serve(w http.ResponseWriter, r *http.Request, upgrader *websocket.Upgrader, opts ServeOpts) error {
	if opts.SandboxID == "" || opts.SessionID == "" || opts.ResolveWorker == nil {
		return errEmpty("missing required ServeOpts")
	}

	clientWS, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote a response.
		return nil
	}

	actor := g.getOrCreateActor(opts.SandboxID)
	sess := &Session{
		actor:         actor,
		sandboxID:     opts.SandboxID,
		sessionID:     opts.SessionID,
		cellPath:      opts.CellPath,
		isExec:        strings.Contains(opts.CellPath, "/exec/") || strings.Contains(opts.CellPath, "/agent/"),
		clientWS:      clientWS,
		workerWSURLFn: opts.ResolveWorker,
		done:          make(chan struct{}),
	}
	actor.addSession(sess)
	// Run synchronously so the Echo Context the route handler captured —
	// closures like ResolveWorker that call back into c.Request().Context()
	// + auth.GetOrgID(c) need it — stays valid until the session ends.
	// Echo pools Contexts and recycles them once the handler returns; if
	// we spawned Run() in a goroutine and returned, those closures would
	// see torn-down/reused state on the next call (404 spam from store
	// lookups using a stale Context).
	sess.Run()
	return nil
}

// SessionCount returns the total number of live sessions across all
// sandbox actors. Used by tests + admin endpoints; cheap O(N) over
// actors, not hot-path.
func (g *Gateway) SessionCount() int {
	g.mu.Lock()
	actors := make([]*sandboxActor, 0, len(g.sandboxes))
	for _, a := range g.sandboxes {
		actors = append(actors, a)
	}
	g.mu.Unlock()
	total := 0
	for _, a := range actors {
		a.mu.Lock()
		total += len(a.sessions)
		a.mu.Unlock()
	}
	return total
}

// getOrCreateActor returns the actor for sandboxID, creating + starting
// its keepalive ticker if absent.
func (g *Gateway) getOrCreateActor(sandboxID string) *sandboxActor {
	g.mu.Lock()
	defer g.mu.Unlock()
	if a, ok := g.sandboxes[sandboxID]; ok {
		return a
	}
	a := &sandboxActor{
		sandboxID: sandboxID,
		gw:        g,
		sessions:  make(map[*Session]struct{}),
		stop:      make(chan struct{}),
	}
	g.sandboxes[sandboxID] = a
	go a.runKeepalive()
	return a
}

// removeActor drops the actor from the map. Called by the actor itself
// when it observes "no more sessions" during a keepalive tick.
func (g *Gateway) removeActor(a *sandboxActor) {
	g.mu.Lock()
	defer g.mu.Unlock()
	// Guard against races: another Serve might have attached a session
	// to this actor between the actor's empty-check and removeActor.
	a.mu.Lock()
	live := len(a.sessions)
	a.mu.Unlock()
	if live > 0 {
		return
	}
	if g.sandboxes[a.sandboxID] == a {
		delete(g.sandboxes, a.sandboxID)
		close(a.stop)
	}
}

// sandboxActor holds the per-sandbox state shared across concurrent
// Sessions: the set of live sessions, the cap-token cache (for future
// re-mint paths), and a keepalive ticker goroutine.
type sandboxActor struct {
	sandboxID string
	gw        *Gateway

	mu       sync.Mutex
	sessions map[*Session]struct{}

	capCacheMu sync.Mutex
	capCache   *capCacheEntry

	stop chan struct{} // closed by gateway.removeActor
}

func (a *sandboxActor) addSession(s *Session) {
	a.mu.Lock()
	a.sessions[s] = struct{}{}
	count := len(a.sessions)
	a.mu.Unlock()
	log.Printf("wsgateway: attached session sandbox=%s session=%s active=%d", a.sandboxID, s.sessionID, count)
}

func (a *sandboxActor) removeSession(s *Session) {
	a.mu.Lock()
	delete(a.sessions, s)
	count := len(a.sessions)
	a.mu.Unlock()
	log.Printf("wsgateway: detached session sandbox=%s session=%s active=%d", a.sandboxID, s.sessionID, count)
}

// runKeepalive fires every AlarmInterval. Sends an empty frame on every
// session's client+upstream conn, then checks for "no sessions left → ask
// gateway to drop me." Exits when the gateway closes a.stop.
func (a *sandboxActor) runKeepalive() {
	t := time.NewTicker(AlarmInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			a.mu.Lock()
			alive := make([]*Session, 0, len(a.sessions))
			for s := range a.sessions {
				alive = append(alive, s)
			}
			a.mu.Unlock()
			if len(alive) == 0 {
				log.Printf("wsgateway: alarm sandbox=%s — idle, releasing", a.sandboxID)
				a.gw.removeActor(a)
				return
			}
			for _, s := range alive {
				s.Keepalive()
			}
			log.Printf("wsgateway: alarm sandbox=%s sessions=%d", a.sandboxID, len(alive))
		case <-a.stop:
			return
		}
	}
}

// capCacheEntry mirrors the DO's v5 cap-token cache. The cell-CP doesn't
// currently mint cap-tokens — the edge does that before forwarding — so
// this cache is reserved for future use (e.g. if the broker grows the
// ability to mint a fresh token on redial when the edge-provided one has
// expired). Kept here as the actor's home for shared cross-session state.
type capCacheEntry struct {
	Token    string
	MintedAt time.Time
	OrgID    string
	CellID   string
	Plan     string
}

// errEmpty is the canonical pre-upgrade error so callers don't have to
// import "errors".
type errEmpty string

func (e errEmpty) Error() string { return string(e) }
