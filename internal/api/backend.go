package api

import (
	"context"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// backend.go — the seam between sandbox runtimes.
//
// sandbox.Manager already abstracts what you do *to* a sandbox: exec, files,
// stats, kill. What it never abstracted is everything around it — which runtime
// serves a create, how to reach a sandbox once it exists, whether a cell has
// capacity, and who owns a given worker_id. Those decisions were open-coded as
// `if s.microvm != nil` at each site, which is how a MicroVM-only cell shipped
// with its claim in a handler the edge never calls, its exec routed to a worker
// proxy that marked healthy boxes dead, and its sandboxes reaped seconds after
// creation by a sweep that equates "no registered worker" with "gone".
//
// Every one of those failed silently. That is the signature of a missing seam
// rather than missing code: a new call site has no way to know it owed the
// question an answer.
//
// Deliberately NOT covered here: the worker registry itself. Fifty-one call
// sites across admin, dashboard, pool manufacture, and the scaler read it
// directly, and almost all are genuine QEMU-fleet operations rather than
// sandbox placement. Pulling them behind this interface would multiply the
// work without making any runtime decision clearer.

// Backend is one sandbox runtime: how to place a sandbox on it, how to reach
// one it holds, what capacity it has, and how to recognize what it owns.
type Backend interface {
	// Name identifies the backend in logs and telemetry. Never returned to a
	// customer — nothing here should describe our infrastructure to them.
	Name() string

	// OwnsWorkerID reports whether a persisted worker_id belongs to this
	// backend. This is the durable identity question: the reconciler, the
	// orphan sweep, and the event publisher all need to know who holds a
	// sandbox using only what is in the database.
	OwnsWorkerID(workerID string) bool

	// WorkerIDPrefixes lists every worker_id prefix this backend writes or
	// still reads. Queries that must reason about ownership in SQL — the
	// restore scan, the orphan sweep — take these instead of hardcoding
	// literals, so adding a backend cannot leave a predicate behind. Empty
	// means the backend uses real registered worker ids.
	WorkerIDPrefixes() []string

	// Route returns the manager serving a sandbox this backend holds, or false
	// if it does not hold it. False must mean "not mine", never "mine but
	// unavailable" — the caller reads false as permission to try elsewhere.
	Route(ctx context.Context, sandboxID string) (sandbox.Manager, bool)

	// Capacity reports placement numbers for the cell, in the shape the edge
	// consumes: it gates routing on available > 0.
	Capacity() (healthy, available, running int)

	// Reconcile settles persisted state against the runtime's own view —
	// adopting what is still alive, closing out what is gone. Nothing else
	// notices a backend-side death, so skipping it leaks both database rows
	// and running compute.
	Reconcile(ctx context.Context, store *db.Store)

	// Close releases whatever the backend holds that would outlive the process.
	// Warm stock is the case that matters: a redeploy that abandons it leaks a
	// full pool on every rollout, and those hosts bill and hold capacity until
	// their lifetime cap. Must be safe on a disabled backend.
	Close()
}

// knownBackends is every backend this build can run, enabled or not. Their
// prefix methods must be safe on a nil receiver — they are called on the zero
// value here.
//
// Separate from the Server's registry because the orphan sweep runs from
// cmd/server before any Server exists, and because its predicate should cover
// backends that are currently disabled: rows written while one was enabled
// outlive the flag, and forgetting them would reap live sandboxes.
var knownBackends = []Backend{(*microvmBackend)(nil)}

// ManagedWorkerIDPrefixes is the union of every known backend's worker_id
// prefixes, for callers that must recognize managed sandboxes in SQL before the
// Server is constructed.
func ManagedWorkerIDPrefixes() []string {
	var out []string
	for _, b := range knownBackends {
		out = append(out, b.WorkerIDPrefixes()...)
	}
	return out
}

// Placer is a Backend that can accept new sandboxes.
//
// Split from Backend because the two capabilities are genuinely independent: a
// runtime can own and serve existing sandboxes without being somewhere new ones
// should land — a backend being drained, or one whose creates are still handled
// by another path. Folding Claim into Backend made registration imply placement,
// so registering a runtime for routing alone would silently divert every create
// to it and fail them.
type Placer interface {
	Backend

	// Claim places a new sandbox and returns the worker_id to persist. An
	// error is terminal for the create — the caller must not fall through to
	// another path, because a backend that could not place a sandbox has
	// already decided the answer.
	Claim(ctx context.Context, p placement) (workerID string, err error)

	// Activate starts the host chosen by Claim. It runs AFTER the pending row
	// is written, because a backend may need that row to exist while booting —
	// see runCreate for the ordering and why it is not negotiable.
	//
	// A backend whose hosts are already running has nothing to start and
	// returns immediately; the create is complete once the row is written.
	Activate(ctx context.Context, a activation) (activated, error)

	// RequiresPersistedRow reports whether losing the session row strands the
	// host, which decides whether a failed database write fails the create.
	//
	// False for a backend that can enumerate what it is running on its own —
	// its reconciler rediscovers the sandbox and the missing row is a temporary
	// gap, so failing the create would destroy a working sandbox over a
	// database blip. True for a backend that rebuilds its view *from* these
	// rows, where an unwritten row is a host nothing will ever reclaim.
	RequiresPersistedRow() bool

	// Release gives back a claim that will not be activated, after a create
	// fails between the two calls.
	//
	// Without it every failed create leaks whatever Claim reserved. What that
	// costs depends on the backend — a held connection, or a running host that
	// bills and occupies capacity with nothing tracking it — so the backend
	// decides what giving it back means. Must be safe to call for a sandbox
	// that was never claimed.
	Release(ctx context.Context, sandboxID, workerID string)
}

// placement is the request-scoped input to Claim.
//
// Region is here rather than on the backend because it is a property of the
// request, not the runtime: the caller may override the cell's own region per
// create. Passing it through the config would not work — SandboxConfig is the
// customer's document and carries no placement fields.
type placement struct {
	sandboxID string
	region    string
	cfg       types.SandboxConfig
}

// activation is everything needed to start a host Claim already chose.
//
// Wider than SandboxConfig because activation depends on work done between the
// two calls: the template resolved to concrete drive keys, and the sandbox got
// an identity a host can present when dialing back to us. Squeezing those into
// the customer's config would put control-plane internals in a document the
// customer writes.
type activation struct {
	sandboxID string
	workerID  string
	cfg       types.SandboxConfig

	// templateRootfsKey and templateWorkspaceKey are the resolved snapshot
	// drives, empty for a base-golden create.
	templateRootfsKey    string
	templateWorkspaceKey string

	// connectToken authorizes the host's outbound data-plane dial back to us.
	connectToken string
}

// activated is what the host reported once it was up.
//
// goldenVersion is the image the host actually built the sandbox from, which is
// not always the one the placement record implies — a worker mid-roll can serve
// a create from either. A later live-migrate rebases against this value, so a
// wrong or empty one makes the sandbox unmigratable.
type activated struct {
	sandboxID     string
	status        string
	goldenVersion string
}

// registerBackend adds a runtime to the dispatch set.
//
// Order is significant: claimBackend serves new sandboxes from the first
// registered backend, so registration order is placement policy.
func (s *Server) registerBackend(b Backend) {
	if b == nil {
		return
	}
	s.backends = append(s.backends, b)
}

// backendFor finds the backend holding an existing sandbox.
//
// Asks each backend rather than consulting worker_id, because routing happens
// on the request path where the in-memory binding is authoritative and a
// database read is not free. OwnsWorkerID covers the cases that start from
// persisted state instead.
func (s *Server) backendFor(ctx context.Context, sandboxID string) (Backend, sandbox.Manager, bool) {
	for _, b := range s.backends {
		if mgr, ok := b.Route(ctx, sandboxID); ok {
			return b, mgr, true
		}
	}
	return nil, nil, false
}

// managedWorkerIDPrefixes collects the prefixes of every registered backend,
// for the SQL that has to recognize managed sandboxes without a live lookup.
func (s *Server) managedWorkerIDPrefixes() []string {
	var out []string
	for _, b := range s.backends {
		out = append(out, b.WorkerIDPrefixes()...)
	}
	return out
}

// backendForWorkerID finds the backend that owns a persisted worker_id, for
// callers working from database rows rather than live requests.
func (s *Server) backendForWorkerID(workerID string) (Backend, bool) {
	for _, b := range s.backends {
		if b.OwnsWorkerID(workerID) {
			return b, true
		}
	}
	return nil, false
}

// claimBackend returns the backend that should serve a new create, or false to
// leave the create to the worker path.
//
// Only Placers are considered, so a backend registered for routing or identity
// alone never becomes the create path by accident.
//
// The QEMU fleet is deliberately not registered: it is reached by falling
// through, exactly as before. Making it a Placer means splitting
// createSandboxRemote, which today mixes worker selection, a 30s capacity
// poll, persistence, token minting, and response shaping in one function on
// the path that serves all current traffic. That split is worth doing
// deliberately, not as a side effect of introducing the seam.
func (s *Server) claimBackend() (Placer, bool) {
	for _, b := range s.backends {
		if p, ok := b.(Placer); ok {
			return p, true
		}
	}
	return nil, false
}

// dispatchDataPlane picks between serving a request in-process and proxying it
// to the worker that holds the sandbox.
//
// The default must be the proxy: a sandbox with no registered backend is a
// worker's, and that is every sandbox on the QEMU fleet. Getting this backwards
// is not a graceful degradation — the local handlers assume a manager that is
// nil there, and the proxy assumes a registry entry that does not exist for a
// backend-held sandbox.
func (s *Server) dispatchDataPlane(local, proxied echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if _, mgr, ok := s.backendFor(c.Request().Context(), c.Param("id")); ok && mgr != nil {
			return local(c)
		}
		return proxied(c)
	}
}

// managerFor returns the manager that should serve this request: the holding
// backend's when one holds the sandbox, otherwise the local manager.
//
// Handlers that reach for s.manager directly are correct only on a cell that
// has one. On a control plane serving a managed backend s.manager is nil, so
// those handlers answer "sandbox execution not available in server-only mode"
// for a sandbox that is running fine — which is exactly what the filesystem
// routes did once they were dispatched in-process.
func (s *Server) managerFor(c echo.Context) sandbox.Manager {
	if _, mgr, ok := s.backendFor(c.Request().Context(), c.Param("id")); ok && mgr != nil {
		return mgr
	}
	return s.manager
}

// execManagerFor reports the manager serving a sandbox in-process, if any.
// Retained as the name the data-plane routes call; the decision now comes from
// the backend registry rather than a hardcoded runtime check.
func (s *Server) execManagerFor(sandboxID string) (sandbox.Manager, bool) {
	_, mgr, ok := s.backendFor(context.Background(), sandboxID)
	return mgr, ok
}
