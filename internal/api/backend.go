package api

import (
	"context"

	"github.com/google/uuid"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
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

// Runtime identifiers, as stored in D1 orgs.runtime and carried on the
// capability token the edge mints for every create.
//
// Deliberately NOT Backend.Name(), which is documented as a label for logs and
// telemetry. These strings are persisted config and production routing: renaming
// a backend for readability must never repoint customer traffic.
//
// The empty string is the QEMU fleet, and that is the whole safety property of
// this design — an org with no runtime set, a cap token minted before this
// existed, or a create that never passed the edge all resolve to the runtime
// with the full feature set.
const (
	runtimeQEMU    = "qemu"
	runtimeMicrovm = "microvm"
)

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

	// Accepts reports whether this backend will take a particular sandbox,
	// asked BEFORE Claim and before any side effect.
	//
	// This is the only place a create can change runtimes. Once Claim returns,
	// the sandbox belongs to that backend for its whole life: every later
	// route, hibernate, wake, and reap resolves through OwnsWorkerID on the
	// persisted worker_id, and nothing migrates a sandbox between runtimes.
	// That is deliberate — two runtimes with different snapshot formats, CPU
	// architectures, and lifetime ceilings cannot hand a sandbox back and
	// forth, and a system that tried would fail in ways no one could reason
	// about.
	//
	// So Accepts answers two questions that both have to be settled up front:
	// whether this backend is allowed to serve the org, and whether it can
	// honour the request at all. Declining is normal and cheap; the caller
	// simply offers the sandbox to the next registered Placer.
	//
	// Note what this does NOT do: it is never consulted after a create.
	// Narrowing the rules — removing an org from an allowlist, say — changes
	// where NEW sandboxes land and must never strand the ones already running.
	Accepts(p placement) bool

	// Claim places a new sandbox and returns the worker_id to persist. An
	// error is terminal for the create — the caller must not fall through to
	// another path, because a backend that could not place a sandbox has
	// already decided the answer.
	//
	// Terminal rather than "try the next backend" on purpose. A silent
	// failover would mean a create that asked for one runtime and quietly got
	// another: benchmark numbers that measure the wrong thing, and capability
	// promises made by a backend that never saw the request. Accepts is where
	// a backend declines; Claim failing means the answer was yes and the
	// placement still did not work.
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

	// DefersPersist reports whether the session row may be written after the
	// create has already been answered.
	//
	// True only when Claim itself leaves the sandbox fully serviceable in this
	// process — bound, routable, and warm — so nothing in the request path
	// reads the row it is skipping. A backend that resolves a sandbox by
	// querying the database must answer false, or its own next request races
	// a write that has not landed.
	DefersPersist() bool

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

// SelfStocking is a Backend that keeps its own warm stock.
//
// The cell's Postgres pool belongs to the QEMU fleet: rows claimed by
// resume+rebind on a worker. A backend that manufactures and holds its own boxes
// has a different supply, and consulting that pool for one of its creates is not
// a miss that costs nothing — the claim takes row locks, so under a burst it
// serializes creates behind a query that could never have succeeded.
//
// Optional, and absent means "draws from the cell pool", so the QEMU fleet and
// anything predating this interface behave exactly as before.
type SelfStocking interface {
	Backend

	// ServesOwnStock reports that this backend supplies warm hosts from inside
	// Claim, so the cell pool must not be consulted on its behalf.
	ServesOwnStock() bool
}

// servesOwnStock reports whether a backend supplies its own warm hosts. False
// for nil and for anything not implementing SelfStocking.
func servesOwnStock(b Backend) bool {
	ss, ok := b.(SelfStocking)
	return ok && ss.ServesOwnStock()
}

// Hibernator is a Backend that parks and revives a sandbox in process.
//
// Optional in the same way Placer is, and for the same reason: the capability
// is genuinely independent of serving sandboxes. The QEMU fleet deliberately
// does NOT implement it. Its hibernate and wake dispatch over gRPC to one
// specific worker, and which one is not a detail — a wake prefers the worker
// that hibernated the sandbox because the qcow2 files are still on its disk,
// and refuses a cross-worker wake while the archive upload is unfinished. That
// is placement logic with physics behind it, and this interface has no
// vocabulary for it. Those paths stay on the worker registry
// (hibernateSandboxRemote / wakeSandboxRemote), untouched.
//
// What this interface is for is the other shape: a backend whose sandboxes the
// control plane manages directly, where hibernate is a call into a local
// manager rather than a hop to a host that owns the disk.
type Hibernator interface {
	Backend

	// Hibernate parks the sandbox and reports where its archive landed, so the
	// caller can record it. It does not write to the database — who owns the
	// row is the caller's decision, not the runtime's.
	Hibernate(ctx context.Context, sandboxID string) (*sandbox.HibernateResult, error)

	// Wake revives the sandbox and returns the worker_id now serving it.
	//
	// Returning the id is the whole point rather than an afterthought: a
	// restore from the archive lands on a NEW host, so the persisted row must
	// follow it. A wake that revived the sandbox but left worker_id pointing at
	// the dead host would leave every later route, ownership check, and reap
	// looking in the wrong place — the sandbox would be alive and unreachable.
	Wake(ctx context.Context, sandboxID, hibernationKey string, timeoutSeconds int) (workerID string, err error)
}

// hibernatorFor resolves the backend that can park or revive a sandbox, keyed
// on the worker_id persisted for it.
//
// Deliberately OwnsWorkerID and not Route. Route asks the live routing map,
// which is exactly the wrong question here: a deep-hibernated sandbox has no
// host at all — the retirement sweep terminated it and called Forget — so Route
// answers "not mine" for precisely the sandboxes a wake exists to serve.
// OwnsWorkerID answers from what is in the database, which outlives the host.
func (s *Server) hibernatorFor(workerID string) (Hibernator, bool) {
	b, ok := s.backendForWorkerID(workerID)
	if !ok {
		return nil, false
	}
	h, ok := b.(Hibernator)
	return h, ok
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
	// orgID is who the sandbox is for.
	orgID uuid.UUID
	// runtime is which backend the org is assigned to, from D1 orgs.runtime by
	// way of the capability token. Empty means the QEMU fleet.
	//
	// It rides on the token rather than being read from config or a database
	// here for one reason: which runtime serves an org is a property OF THE ORG,
	// not of the cell that happens to serve it. Per-cell configuration for a
	// per-org fact needs every cell kept in sync by hand, and a cell that missed
	// an update silently serves that org on the wrong runtime.
	runtime string
	cfg     types.SandboxConfig
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
// claimBackend picks the runtime that will serve a create: the first
// registered Placer that accepts it.
//
// Registration order is the policy. A backend registered earlier gets first
// refusal, so a runtime with its own warm stock is offered every create before
// the fleet, and the fleet serves whatever it declines. Moving a
// registerBackend call changes which runtime serves production traffic.
//
// First-accept rather than best-match: there is no scoring here, and there
// should not be. Placement has to be decidable from the request alone, because
// the decision is permanent — see Accepts.
func (s *Server) claimBackend(p placement) (Placer, bool) {
	for _, b := range s.backends {
		placer, ok := b.(Placer)
		if !ok {
			continue
		}
		if !placer.Accepts(p) {
			continue
		}
		return placer, true
	}
	return nil, false
}

// orgRuntime reads the runtime this org is assigned to off the capability
// token the edge minted for this request.
//
// Empty whenever there is no token — combined mode, and any path that did not
// come through the edge. That resolves to the QEMU fleet, which is the only
// safe default: a create whose runtime we cannot establish must land on the
// backend that can serve anything, never on a specialised one.
func runtimeFor(c echo.Context) string {
	claims, _ := c.Get(capClaimsKey).(*auth.CapabilityClaims)
	if claims == nil {
		return ""
	}
	return claims.Runtime
}

// canPlace reports whether any registered backend would take a create for this
// org, used only to choose between the shared create flow and legacy combined
// mode.
//
// Region is deliberately absent: it is resolved further down createSandboxRemote
// (template lookup can override it), so it is not known here. That is safe
// today because no backend gates on region, and the authoritative decision is
// made in createSandboxRemote with the complete placement. A backend that ever
// does gate on region must not rely on this pre-check.
func (s *Server) canPlace(orgID uuid.UUID, runtime string, cfg types.SandboxConfig) bool {
	_, ok := s.claimBackend(placement{orgID: orgID, runtime: runtime, cfg: cfg})
	return ok
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
