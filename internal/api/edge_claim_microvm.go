package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// edge_claim_microvm.go — the MicroVM half of the edge-claim protocol.
//
// The QEMU implementation next door runs the whole reservation state machine in
// Postgres, because there a pool box is already a row: it was created by a
// worker, it has a sandbox id, and the CP's only job is to flip its status. None
// of that is true here. A MicroVM pool box is an in-memory *awsvm.StockEntry
// holding a live gRPC channel; it has no row, no sandbox id, and it cannot be
// serialized anywhere. So this path implements the same transitions against the
// pool's own reservation map:
//
//	pooled → reserved   EdgeReserve   (pool.Reserve)
//	reserved → bound    EdgeFinalize  (pool.ClaimReserved; the caller writes the row)
//	reserved → pooled   EdgeRelease   (pool.ReleaseReserved — never tokened)
//	reserved → gone     pool.expireReservations, which TERMINATES (see its
//	                    docstring: a stale reservation may already be in a
//	                    customer's hands, so re-pooling it is cross-tenant access)
//
// The one real design difference from QEMU: the sandbox id is assigned at
// RESERVE, not at finalize, and the box is bound to it immediately. That is what
// makes the edge answer safe. The edge returns a 201 the moment it pops a box
// from DO stock, and the customer's first exec can arrive before finalize has
// run — on the QEMU path that resolves anyway because the cell proxies by
// worker_id, but here routing goes through the manager's sandbox→box map. If
// that map were only written at finalize, every create would have a window where
// its own sandbox id 404s. Binding at reserve closes it: by the time the id
// exists anywhere outside this process, it already routes.
//
// The cost of binding early is that a reservation which dies unclaimed leaves a
// binding behind, which is what PoolConfig.OnExpire is for.

// edgeBox is one reserved box as the PoolStock DO sees it: an identity, nothing
// more. The tunnel and the entry stay in this process.
type edgeBox struct {
	SandboxID string
	WorkerID  string

	// Reach-info: how to talk to this box WITHOUT going through this process.
	// The endpoint is a public TLS host and the token is a port-scoped header
	// credential, so handing them to the edge lets it hold the agent tunnel
	// itself and take the control plane out of the exec data path entirely.
	//
	// Delivered here, at reserve, rather than fetched later on purpose: the
	// sandbox id is already assigned at this point, so the edge can open and
	// guest-attach the tunnel while the box is still sitting in stock — before
	// any customer exists. Measured, that is the difference between a first exec
	// of ~30ms and one of ~1.1s, because the AWS proxy only connects to the
	// guest when payload first arrives and somebody has to pay for that.
	//
	// Empty on the Postgres path: those cells route through a worker, and this
	// is a MicroVM-only shortcut.
	Endpoint string
	Token    string
	Port     int32
}

// edgeClaimer is a backend that serves edge-claim from its own stock instead of
// the shared Postgres pool. A backend that does not implement it falls through
// to the PG path, which is what every QEMU cell does.
//
// Deliberately store-free: the row write is identical for every backend and the
// handler already owns every other store call on this path, so keeping it there
// leaves this interface about stock and bindings only.
type edgeClaimer interface {
	EdgeReserve(n int) []edgeBox
	EdgeRelease(sandboxIDs []string) int
	EdgeFinalize(sandboxID string, cfg types.SandboxConfig) (workerID string, err error)
}

var _ edgeClaimer = (*microvmBackend)(nil)

// edgeReservedMap tracks reservations this backend made for the edge, keyed by
// the AWS host id so an expiry callback — which only knows the host — can find
// the sandbox id it has to forget.
type edgeReservedMap struct {
	mu sync.Mutex
	m  map[string]string // microvmID → sandboxID
}

func (r *edgeReservedMap) put(microvmID, sandboxID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = make(map[string]string)
	}
	r.m[microvmID] = sandboxID
}

func (r *edgeReservedMap) take(microvmID string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.m[microvmID]
	if ok {
		delete(r.m, microvmID)
	}
	return id, ok
}

func (r *edgeReservedMap) depth() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.m)
}

// sandboxIDs returns the sandbox ids currently held as edge reservations.
//
// A reservation has a binding in the manager but no running row — it is
// deliberately parked between the two. Anything reconciling bindings against
// rows has to subtract these first, or every reservation reads as a binding
// whose sandbox has vanished.
func (r *edgeReservedMap) sandboxIDs() map[string]struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]struct{}, len(r.m))
	for _, id := range r.m {
		out[id] = struct{}{}
	}
	return out
}

// EdgeReserve promises up to n warm boxes to the edge's PoolStock DO, assigning
// each a sandbox id and binding it now — see the file docstring for why the
// binding cannot wait for finalize.
//
// Returns fewer than n, or none, when stock is short. Not an error: the DO tops
// up again on its next alarm, and a create that finds empty stock falls back to
// the control plane, which is exactly the path this optimization skips.
func (b *microvmBackend) EdgeReserve(n int) []edgeBox {
	if b == nil || b.pool == nil {
		return nil
	}
	entries := b.pool.Reserve(n)
	if len(entries) == 0 {
		return nil
	}
	out := make([]edgeBox, 0, len(entries))
	for _, e := range entries {
		sandboxID := "sb-" + uuid.New().String()[:8]
		// Empty cfg deliberately: nobody has asked for anything yet. It resolves
		// to the delivered size, which is what this runtime hands out regardless
		// of the request (see deliveredSize), so the billing shape is already
		// correct before the customer arrives. EdgeFinalize re-tracks with the
		// real config once there is one.
		b.manager.TrackClaimed(sandboxID, e, types.SandboxConfig{})
		b.edgeReserved.put(e.MicrovmID, sandboxID)
		out = append(out, edgeBox{
			SandboxID: sandboxID,
			WorkerID:  microvmWorkerID(e.MicrovmID),
			Endpoint:  e.Endpoint,
			Token:     e.Token,
			Port:      b.pool.AgentPort(),
		})
	}
	log.Printf("microvm: edge-reserved %d box(es) (asked %d, %d left in stock)", len(out), n, b.pool.Depth())
	return out
}

// EdgeRelease takes back stock the DO discarded without ever handing it to a
// customer. Safe to re-pool precisely because of that assertion — which is the
// DO's to make, not ours; see expireReservations for the case where we cannot
// make it and must terminate instead.
func (b *microvmBackend) EdgeRelease(sandboxIDs []string) int {
	if b == nil || b.pool == nil {
		return 0
	}
	released := 0
	for _, sandboxID := range sandboxIDs {
		microvmID, ok := b.manager.MicrovmIDFor(sandboxID)
		if !ok {
			continue
		}
		if !b.pool.ReleaseReserved(microvmID) {
			// Already claimed, or already expired. Leave the binding alone: if it
			// was claimed it belongs to a customer now, and forgetting it here
			// would strand a live sandbox.
			continue
		}
		// Hand the tunnel back to the pool before dropping the binding. Forget
		// would CLOSE it, and the box then re-enters stock with no tunnel — so
		// the next customer to claim it pays a full cold dial on their first
		// exec (measured 549ms vs 76ms warm). Safe here and nowhere else: the DO
		// is asserting it never handed this box to a customer, which is the same
		// assertion that makes re-pooling the box itself legal.
		//
		// Ordered after ReleaseReserved deliberately — if that failed the box is
		// claimed, the customer owns the channel, and we must not take it.
		if a := b.manager.DetachAgent(sandboxID); a != nil {
			b.pool.AttachAgent(microvmID, a)
		}
		b.edgeReserved.take(microvmID)
		// Back to anonymous stock, so this id must stop resolving — the box will
		// be reissued under a different one at the next reserve.
		b.manager.Forget(sandboxID)
		released++
	}
	if released > 0 {
		log.Printf("microvm: edge released %d reservation(s) back to stock", released)
	}
	return released
}

// EdgeFinalize redeems the reservation and rebinds the box to the config the
// customer actually sent. The caller writes the durable row; this is the part
// only the backend can do.
//
// Redeeming is what makes finalizing late safe: ClaimReserved fails if the
// reaper got there first, so a finalize racing expiry reports the loss instead
// of confirming a box that no longer exists.
func (b *microvmBackend) EdgeFinalize(sandboxID string, cfg types.SandboxConfig) (string, error) {
	if b == nil || b.pool == nil {
		return "", fmt.Errorf("microvm: backend disabled")
	}
	microvmID, ok := b.manager.MicrovmIDFor(sandboxID)
	if !ok {
		return "", fmt.Errorf("microvm: finalize %s: no box bound to that sandbox", sandboxID)
	}
	entry, ok := b.pool.ClaimReserved(microvmID)
	if !ok {
		return "", fmt.Errorf("microvm: finalize %s: reservation lost (box %s)", sandboxID, microvmID)
	}
	b.edgeReserved.take(microvmID)

	// Re-track with the real config. Track overwrites the byID entry only — the
	// agent channel lives in a separate map keyed by sandbox id — so the
	// pre-dialled tunnel adopted at reserve survives this.
	b.manager.TrackClaimed(sandboxID, entry, cfg)
	return microvmWorkerID(microvmID), nil
}

// forgetExpiredReservation is the PoolConfig.OnExpire callback: a reservation
// died unredeemed and its box has been terminated, so the sandbox id bound at
// reserve must stop resolving.
func (b *microvmBackend) forgetExpiredReservation(microvmID string) {
	sandboxID, ok := b.edgeReserved.take(microvmID)
	if !ok {
		return
	}
	b.manager.Forget(sandboxID)
	if b.onReservationLost != nil {
		b.onReservationLost(sandboxID, errors.New("edge reservation expired before it was claimed"))
	}
	log.Printf("microvm: edge reservation %s (box %s) expired unclaimed — binding dropped", sandboxID, microvmID)
}

// edgeClaimBackend returns this cell's backend if it serves edge-claim from its
// own stock. Dispatching on the placing backend rather than on the caller's org
// is deliberate: a reserve request arrives from a Durable Object holding stock
// for THIS cell, so the question is what this cell runs — a fact the cell knows
// without consulting anyone.
func (s *Server) edgeClaimBackend() (edgeClaimer, bool) {
	b, ok := s.claimBackend(placement{runtime: runtimeMicrovm})
	if !ok {
		return nil, false
	}
	ec, ok := b.(edgeClaimer)
	return ec, ok
}

// poolStockRegion is the region stamped on rows and on the reserve response.
// "local" stands in for an unset region so a dev cell still writes a row that
// the reconciler's region-scoped queries can find.
func (s *Server) poolStockRegion() string {
	if s.region == "" {
		return "local"
	}
	return s.region
}

// boxesInUse reports the boxes the pool cannot see: ones bound to a live
// sandbox. It is what PoolConfig.InUse asks, and the budget adds it to the
// pool's own committed count to decide whether there is room to refill.
//
// The subtraction is the whole point. EdgeReserve binds a box to its sandbox id
// at RESERVE rather than at finalize (see the file header for why that window
// has to be closed), so a box waiting in a PoolStock shard is tracked by the
// manager AND counted by committed()'s len(p.reserved). Left uncorrected the
// budget sees roughly SHARDS × POOL_STOCK_TARGET boxes that do not exist —
// measured on dev as "130 in use + 124 committed" against a fleet of 130 —
// which holds the pool at a permanent refill freeze.
func (b *microvmBackend) boxesInUse() int {
	if b == nil || b.manager == nil {
		return 0
	}
	n := len(b.manager.TrackedMicrovmIDs()) - b.edgeReserved.depth()
	if n < 0 {
		// The two counts are taken without a shared lock, so a reserve landing
		// between them can transiently invert the difference. Reporting a
		// negative would credit the budget with headroom it does not have.
		return 0
	}
	return n
}

// warmReservedTunnels keeps the agent channel alive on every box reserved to the
// edge but not yet claimed by a customer. Wired to PoolConfig.OnMaintain.
//
// These boxes are the pool's whole reason for existing and they are the ones
// nothing else warms. EdgeReserve moves the channel to the manager and takes the
// entry out of p.stock, so the pool's own warmTunnels cannot see it — measured
// on dev, that left ~126 of 150 boxes unwarmed while only the 24 free ones were
// being maintained. A reservation then sits in a PoolStock shard for minutes
// with no traffic, its tunnel lapses, and the customer who claims it pays the
// re-handshake on their FIRST exec, which is exactly what TTI measures
// (383ms cold vs 75ms warm).
//
// Safe to ping precisely because no customer owns these yet: the idle-suspend
// policy that forbids keepalive on a live sandbox has nothing to say about warm
// stock, which is supposed to be running and ready.
func (b *microvmBackend) warmReservedTunnels() {
	if b == nil || b.manager == nil {
		return
	}
	reserved := b.edgeReserved.sandboxIDs()
	if len(reserved) == 0 {
		return
	}
	if n := b.manager.WarmAgents(reserved); n > 0 {
		log.Printf("microvm: re-warmed %d idle tunnel(s) across %d edge reservation(s)", n, len(reserved))
	}
	// Reconnecting the channel is not enough to keep the box awake — only guest
	// traffic is. Edge reservations matter most here: they are the boxes a
	// customer is about to claim, so a suspended one turns into ~1s on the very
	// first exec. See the keepalive block in internal/awsvm/agent.go.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if ok, failed, retired, sample := b.manager.PingAgents(ctx, reserved); ok+failed > 0 {
		// The sampled cause is the point of the line. A bare failure count is what
		// let the stock pool decay from 130 live tunnels to 5 without anything in
		// the log naming a reason.
		msg := fmt.Sprintf("microvm: keepalive pinged %d reserved box(es) (%d failed", ok, failed)
		if retired > 0 {
			msg += fmt.Sprintf(", %d channel(s) retired for re-dial", retired)
		}
		msg += ")"
		if sample != nil {
			msg += fmt.Sprintf("; first failure: %v", sample)
		}
		log.Print(msg)
	}
}
