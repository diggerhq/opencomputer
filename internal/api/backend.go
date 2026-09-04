package api

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"

	"github.com/opensandbox/opensandbox/internal/storage"
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
var knownBackends = []Backend{(*liteBackend)(nil)}

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

// IdleTimeouter is a backend that can park a sandbox after a period of
// customer inactivity.
//
// Separate from Hibernator because the two answer different questions: that one
// parks on demand, this one decides WHEN. A runtime may honour a timeout only
// partly — a provider that destroys hosts on its own schedule caps what any
// timeout can promise — so the setter reports the value actually in force
// rather than echoing the request.
type IdleTimeouter interface {
	// SetIdleTimeout applies a timeout and returns the one now in effect.
	// Zero means no timeout is running, whether because the caller asked for
	// none or because the runtime could not honour the one requested.
	SetIdleTimeout(sandboxID string, d time.Duration) (time.Duration, error)
}

// checkpointKindUnsupported reports whether the runtime holding a sandbox is
// unable to capture memory state, which is what a "full" checkpoint is.
//
// Asked of the backend rather than hardcoded per runtime: the property being
// tested is "can this host's RAM be snapshotted", and only the backend knows.
// A worker-held sandbox answers false and every existing QEMU path is
// unchanged.
func (s *Server) checkpointKindUnsupported(workerID string) bool {
	b, ok := s.backendForWorkerID(workerID)
	if !ok {
		return false
	}
	c, ok := b.(MemoryStateCapturer)
	return ok && !c.CapturesMemoryState()
}

// MemoryStateCapturer is a backend that can say whether its hosts support
// snapshotting RAM. Absent means "yes", so a backend that never thought about
// it keeps today's behaviour.
type MemoryStateCapturer interface {
	CapturesMemoryState() bool
}

// dispatchIdleTimeout sends a timeout request to the backend that owns the
// sandbox, falling back to the proxy for a worker-held one.
//
// Needed because the proxy route is wrapped in refuseIfManaged, which 501s
// every managed sandbox — correct while this runtime had no idle policy, and
// wrong now that it does. Without this the customer's timeout is rejected
// outright. Mirrors dispatchPTY.
func (s *Server) dispatchIdleTimeout(local, proxied echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if s.store != nil {
			if session, err := s.store.GetSandboxSession(c.Request().Context(), c.Param("id")); err == nil && session != nil {
				if _, ok := s.idleTimeouterFor(session.WorkerID); ok {
					return local(c)
				}
			}
		}
		return proxied(c)
	}
}

// idleTimeouterFor resolves the backend that owns a sandbox's idle policy.
func (s *Server) idleTimeouterFor(workerID string) (IdleTimeouter, bool) {
	b, ok := s.backendForWorkerID(workerID)
	if !ok {
		return nil, false
	}
	t, ok := b.(IdleTimeouter)
	return t, ok
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

	// templateImageARN is set when the named template is backed by its own
	// MicroVM image. Carried on placement rather than resolved in the backend
	// because only the caller has the template row.
	templateImageARN string
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

	// templateImageARN is set when the template is an image rather than a
	// tarball. The box was already launched FROM this image by Claim; it is
	// carried here so Activate can refuse loudly if the two ever disagree.
	templateImageARN string

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
	// endAt is when the runtime's provider will destroy this host regardless of
	// anything we do, or zero when there is no such deadline (the QEMU fleet) or
	// it cannot be determined. Stamped on the row so that a row outliving its
	// host stops being something a sweep has to notice — see migration 056.
	endAt time.Time
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
// HaltRestoreSpec is the shape a halted sandbox has to come back as. Carried
// explicitly rather than re-read from the runtime, because by resume time the
// runtime holds nothing: the host was released at halt.
type HaltRestoreSpec struct {
	Template string
	MemoryMB int
	CPUCount int
}

// haltArchiver is implemented by a backend whose sandboxes can be parked in a
// way that OUTLIVES their host — the state goes to durable storage and the host
// is given back entirely.
//
// This exists because suspending is not enough on every runtime. The MicroVM
// provider counts suspended time against the same hard lifetime cap as running
// time, so a suspended sandbox still dies at the cap and takes its disk with
// it. A credit halt routinely lasts days, so parking that way would quietly
// destroy the data of every org that failed to pay within one lifetime.
//
// The three methods are deliberately NOT one call. Archiving and releasing are
// separated so the caller can durably record the archive while the host is
// still alive: releasing first would mean a failed record write leaves an
// archive nothing points at and a host that no longer exists, which is
// unrecoverable. Everything else in this file that destroys something records
// it first for the same reason.
type haltArchiver interface {
	// ArchiveForHalt writes durable state to the checkpoint store and does NOT
	// touch the host.
	ArchiveForHalt(ctx context.Context, sandboxID string, store *storage.CheckpointStore) (key string, sizeBytes int64, err error)
	// ReleaseForHalt terminates the host. The point of no return — only safe
	// once the archive from ArchiveForHalt has been recorded.
	ReleaseForHalt(ctx context.Context, sandboxID string) error
	// RestoreForResume gives the sandbox a NEW host and lays the archive back
	// onto it, returning the worker id now serving it.
	RestoreForResume(ctx context.Context, sandboxID, key string, store *storage.CheckpointStore, spec HaltRestoreSpec) (workerID string, err error)
}

// haltArchiverFor resolves the backend that can deep-park a sandbox, keyed by
// the worker id on its row.
//
// Keyed by worker id rather than by a live lookup because at RESUME time the
// sandbox has no host at all — the id is the only surviving evidence of which
// runtime was serving it.
func (s *Server) haltArchiverFor(workerID string) (haltArchiver, bool) {
	b, ok := s.backendForWorkerID(workerID)
	if !ok {
		return nil, false
	}
	ha, ok := b.(haltArchiver)
	return ha, ok
}

// placementExplainer is implemented by a Placer that can say WHY it refused a
// create, when the reason is permanent.
//
// Without it every refusal collapses into "out of capacity", which is both
// wrong and actively misleading for a request we are never going to serve: a
// customer asking for a size this region does not offer is told to wait for
// capacity and retry, and no amount of waiting or retrying will change the
// answer. Only permanent reasons belong here — a transient shortage really is
// a capacity answer and should stay one.
type placementExplainer interface {
	ExplainRefusal(p placement) error
}

// explainRefusal asks every registered backend whether it refused this create
// for a permanent reason, returning the first such reason. Nil means no
// backend claimed a permanent objection, so the refusal is a capacity answer.
func (s *Server) explainRefusal(p placement) error {
	for _, b := range s.backends {
		ex, ok := b.(placementExplainer)
		if !ok {
			continue
		}
		if err := ex.ExplainRefusal(p); err != nil {
			return err
		}
	}
	return nil
}

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

// runtimeFor reads the runtime this request's create belongs on.
//
// Three sources, in order of authority:
//
//  1. The capability token, when the edge minted one. The edge has already
//     applied both the org pin and SDK-version routing, so its answer is final
//     — including its decision to send nothing.
//  2. orgs.runtime, synced into this cell's Postgres. This is the PIN, and it
//     wins over the calling SDK in both directions.
//  3. The calling SDK's major version, for an unpinned org on the
//     direct-to-cell path. See runtime_gate.go: this is what lets a customer
//     migrate by upgrading @opencomputer/sdk and roll back by pinning the old
//     major, without us touching a row.
//
// Empty resolves to the QEMU fleet, which is the only safe default: a create
// whose runtime we cannot establish must land on the backend that can serve
// anything, never on a specialised one.
func (s *Server) runtimeFor(c echo.Context) string {
	claims, _ := c.Get(capClaimsKey).(*auth.CapabilityClaims)
	if claims != nil && claims.Runtime != "" {
		return claims.Runtime
	}
	// No cap-token: this is the direct-to-cell create, authenticated with an
	// API key against this cell rather than through the edge. D1 is still
	// authoritative on org runtime, but there is no token here carrying it, so
	// read the copy synced from the last cap-token create.
	//
	// Deliberately per-ORG, not per-cell. A cell-wide default would divert
	// every unlabeled create — including QEMU orgs that simply have no runtime
	// set — onto whichever backend the cell happened to prefer. Keying on the
	// org means QEMU stays the default for everyone and orgs move over one at
	// a time by setting this column.
	orgID, ok := auth.GetOrgID(c)
	if !ok || orgID == uuid.Nil || s.store == nil {
		return ""
	}
	rt, ok := s.orgRuntime.get(orgID)
	if !ok {
		var err error
		if rt, err = s.store.GetOrgRuntime(c.Request().Context(), orgID); err != nil {
			// Unknown runtime resolves to QEMU, the backend that serves anything.
			return ""
		}
		s.orgRuntime.put(orgID, rt)
	}
	if rt != "" {
		return rt // pinned, in either direction
	}
	// Unpinned. If a cap token got this far it carried an empty runtime, which
	// is the EDGE's answer for this org and this SDK — including when the gate
	// is switched off there. Re-deciding here would defeat that kill switch and
	// route the same call two different ways depending on which door it came in.
	if claims != nil {
		return ""
	}
	return runtimeForSDK(c)
}

// orgRuntimeTTL bounds how long a runtime flip in Postgres takes to reach this
// cell's create path. Short enough to move an org over without a restart, long
// enough that a burst does not re-read the same row 100 times.
const orgRuntimeTTL = 30 * time.Second

// orgRuntimeCache is a small TTL memo in front of the orgs.runtime read.
//
// The read is local Postgres and cheap, but it sits on the create path and a
// burst asks the same question for the same org every time. The TTL is what
// bounds how long a runtime flip takes to take effect on this cell.
type orgRuntimeCache struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[uuid.UUID]orgRuntimeEntry
}

type orgRuntimeEntry struct {
	runtime string
	expires time.Time
}

func newOrgRuntimeCache(ttl time.Duration) *orgRuntimeCache {
	return &orgRuntimeCache{ttl: ttl, m: map[uuid.UUID]orgRuntimeEntry{}}
}

func (c *orgRuntimeCache) get(orgID uuid.UUID) (string, bool) {
	if c == nil {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[orgID]
	if !ok || time.Now().After(e.expires) {
		return "", false
	}
	return e.runtime, true
}

func (c *orgRuntimeCache) put(orgID uuid.UUID, runtime string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[orgID] = orgRuntimeEntry{runtime: runtime, expires: time.Now().Add(c.ttl)}
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

// refuseIfManaged wraps a proxy-only route so a sandbox held by a registered
// backend is answered rather than proxied.
//
// The routes this guards — PTY, agent sessions, mounts, timeout, token refresh,
// bidi exec streaming — are the ones no managed backend implements, so they go
// straight to the worker proxy. That was not a graceful degradation. The proxy
// resolves through the worker registry, a managed sandbox has no entry there,
// and it concludes the worker was lost and writes the row to `stopped`: one PTY
// request would destroy a healthy sandbox and every later request would 410.
//
// 501 is the honest answer — this runtime will never serve this — as opposed to
// a 5xx that invites a retry against a sandbox that is fine.
func (s *Server) refuseIfManaged(proxied echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if b, _, ok := s.backendFor(c.Request().Context(), c.Param("id")); ok {
			return c.JSON(http.StatusNotImplemented, map[string]string{
				"error": fmt.Sprintf("%s sandboxes do not support this operation", b.Name()),
			})
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
