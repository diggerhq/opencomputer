package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/awsvmlite"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/worker"
	"github.com/opensandbox/opensandbox/pkg/types"
	"github.com/redis/go-redis/v9"
)

// lite_backend.go — the same MicroVM fleet, reached without a tunnel.
//
// This is a SECOND way of talking to the boxes microvm_backend.go already
// launches, not a second fleet: same image, same region, same idle policy, same
// regional quota, built from the same newMicrovmClient. What differs is the data
// plane. Where that backend carries gRPC to osb-agent inside a WebSocket — the
// only way to reach it, because Lambda's proxy strips the HTTP/2 trailers gRPC
// reports status in — this one issues a plain HTTPS POST to a hook endpoint in
// the guest. See internal/awsvmlite for the measurement that motivated it.
//
// The two are mutually exclusive on a cell, because they would otherwise
// compete for the same regional quota while each believed it owned the fleet.
// OPENSANDBOX_MICROVM_LITE=1 selects this one; anything else keeps the agent
// path, which is what production runs.
//
// Deliberately absent, relative to the agent path: hibernate/wake, file
// transfer, streaming, PTY, checkpoints, edge-claim, and the warm-tunnel tier.
// Their absence is the experiment. What remains is create, exec, destroy.

// liteEnabled reports whether this cell serves MicroVMs over the direct exec
// path instead of the agent tunnel. Requires the MicroVM backend to be enabled
// at all — this is a choice of data plane, not an independent runtime.
func liteEnabled() bool {
	return microvmEnabled() && os.Getenv("OPENSANDBOX_MICROVM_LITE") == "1"
}

type liteBackend struct {
	client *awsvm.Client
	mgr    *awsvmlite.Manager
	// sm is the sandbox.Manager face the control plane's data-plane routes
	// dispatch through. One instance, shared: it holds no state of its own.
	sm *awsvmlite.SandboxManager

	stopRun     context.CancelFunc
	usageTicker *worker.UsageTicker
	eventPub    *worker.RedisEventPublisher
	capacity    *controlplane.CapacityReporter
}

// newLiteBackend builds the direct-exec MicroVM backend, or returns nil if this
// cell is not configured for it.
func newLiteBackend(ctx context.Context) (*liteBackend, error) {
	if !liteEnabled() {
		return nil, nil
	}
	client, err := newMicrovmClient(ctx)
	if err != nil {
		return nil, err
	}

	// Warm target falls back to the agent path's pool target so a cell that is
	// switched over keeps the depth it was sized for, rather than silently
	// dropping to a default and cold-launching every create.
	warm := envInt("OPENSANDBOX_MICROVM_LITE_WARM", envInt("OPENSANDBOX_MICROVM_POOL_TARGET", 20))

	mgr := awsvmlite.New(client, awsvmlite.Config{
		WarmTarget: warm,
		TouchInterval: time.Duration(
			envInt("OPENSANDBOX_MICROVM_LITE_TOUCH_SECONDS", 300)) * time.Second,
	})
	runCtx, stop := context.WithCancel(context.Background())
	b := &liteBackend{client: client, mgr: mgr, sm: awsvmlite.NewSandboxManager(mgr), stopRun: stop}
	go mgr.Run(runCtx)

	log.Printf("vmhost-lite: backend enabled (region=%s warm=%d) — direct exec, no agent tunnel",
		client.Config().Region, warm)
	return b, nil
}

// ── Backend ─────────────────────────────────────────────────────────────────

// Compile-time proof this satisfies the dispatch seam, for the same reason the
// agent-path backend asserts it: a signature drift here surfaces as a silent
// fall-through to the worker path rather than a build failure.
var _ Placer = (*liteBackend)(nil)

func (b *liteBackend) Name() string { return "vmhost-lite" }

// WorkerIDPrefixes and OwnsWorkerID are deliberately IDENTICAL to the agent
// path's. A worker_id names which box holds a sandbox, and the box is the same
// box — switching data planes must not orphan the rows written by the other one,
// because a row nothing claims is a box nothing terminates.
func (b *liteBackend) WorkerIDPrefixes() []string {
	return []string{microvmWorkerPrefix, legacyWorkerPrefix}
}

func (b *liteBackend) OwnsWorkerID(workerID string) bool {
	_, ok := parseMicrovmWorkerID(workerID)
	return ok
}

// Route reports whether this backend holds the sandbox, from its in-memory
// binding only — never an availability check. False sends the caller to another
// backend, so "mine but sick" must not look like "not mine".
func (b *liteBackend) Route(_ context.Context, sandboxID string) (sandbox.Manager, bool) {
	if b == nil {
		return nil, false
	}
	if _, ok := b.mgr.BoxFor(sandboxID); !ok {
		return nil, false
	}
	return b.sm, true
}

// Capacity reports a constant 1 available, as the agent path does and for the
// same reason: the real ceiling is an AWS regional quota far above current use,
// and advertising warm depth would 503 creates this backend can serve. The
// freshness of the report is the load-bearing half — the edge drops a cell whose
// capacity_updated_at is older than 120s, so this doubles as a heartbeat.
func (b *liteBackend) Capacity() (healthy, available, running int) {
	if b == nil {
		return 0, 0, 0
	}
	return 1, 1, len(b.mgr.Bound())
}

// Close stops the warm-set loop and gives the stock back.
//
// Not optional: a redeploy that abandons warm boxes leaks a full set on every
// rollout, and each one bills compute and holds regional memory quota until the
// 8h service cap. Bound sandboxes are left alone — they belong to customers, and
// the reconciler re-adopts them on the way back up.
func (b *liteBackend) Close() {
	if b == nil {
		return
	}
	if b.usageTicker != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = b.usageTicker.Stop(stopCtx)
		cancel()
	}
	// After the ticker, so its final slices are in SQLite before the publisher
	// drains them.
	if b.eventPub != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = b.eventPub.Stop(stopCtx)
		cancel()
	}
	if b.capacity != nil {
		b.capacity.Stop()
	}
	b.stopRun()
	drainCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if n := b.mgr.DrainWarm(drainCtx); n > 0 {
		log.Printf("vmhost-lite: released %d warm box(es) on shutdown", n)
	}
}

// ── Placer ──────────────────────────────────────────────────────────────────

// Accepts mirrors the agent path exactly — same runtime assignment, same
// template rule. It has to: an org pinned to the MicroVM runtime reaches
// whichever of the two backends this cell registered, and a cell that accepted
// a different set of creates depending on its data plane would make the choice
// visible to customers.
func (b *liteBackend) Accepts(p placement) bool {
	if b == nil {
		return false
	}
	if p.runtime != runtimeMicrovm {
		return false
	}
	if p.cfg.Template != "" && p.cfg.Template != "default" && p.cfg.Template != poolTemplateName() {
		return false
	}
	return true
}

// Claim pops a warm box, or launches one when the set is empty.
//
// A miss is slow (a cold launch, ~3s) but not an error — the warm set is a
// latency optimization, not the capacity limit.
func (b *liteBackend) Claim(ctx context.Context, p placement) (string, error) {
	if b == nil {
		return "", errors.New("vmhost-lite: backend disabled")
	}
	start := time.Now()
	box, warm, err := b.mgr.Claim(ctx, p.sandboxID, awsvmlite.Meta{
		Template: p.cfg.Template,
		MemoryMB: p.cfg.MemoryMB,
		CPUCount: p.cfg.CpuCount,
	})
	if err != nil {
		return "", err
	}
	if !warm {
		log.Printf("vmhost-lite: COLD CREATE %s -> %s in %s (warm set was empty)",
			p.sandboxID, box.MicrovmID, time.Since(start).Round(time.Millisecond))
	}
	return microvmWorkerID(box.MicrovmID), nil
}

// Activate has nothing to do: Claim returns a box that is already RUNNING.
func (b *liteBackend) Activate(_ context.Context, a activation) (activated, error) {
	return activated{sandboxID: a.sandboxID, status: "running"}, nil
}

// RequiresPersistedRow is true: this backend rebuilds its bindings FROM these
// rows after a restart (see Restore), so a box with no row is one nothing will
// ever terminate.
func (b *liteBackend) RequiresPersistedRow() bool { return true }

// DefersPersist is true: Claim binds sandbox→box in memory before it returns,
// so exec, destroy and routing all resolve without reading the row.
func (b *liteBackend) DefersPersist() bool { return true }

// Release terminates a box whose create failed after Claim. Merely forgetting it
// would leave one billing with nothing tracking it.
func (b *liteBackend) Release(ctx context.Context, sandboxID, _ string) {
	if b == nil {
		return
	}
	if err := b.mgr.Destroy(ctx, sandboxID); err != nil {
		log.Printf("vmhost-lite: release %s: %v", sandboxID, err)
	}
}

// ── Reconciliation ──────────────────────────────────────────────────────────

// Restore rebuilds the sandbox→box map from the database after a restart.
//
// Nothing here survives the process, but the boxes do. Skipping this leaves
// live sandboxes simultaneously unroutable and unreapable — billing until the
// 8h cap with nothing able to find them.
func (b *liteBackend) Restore(ctx context.Context, store *db.Store) {
	b.Reconcile(ctx, store)
}

func (b *liteBackend) Reconcile(ctx context.Context, store *db.Store) {
	if b == nil || store == nil {
		return
	}
	rows, err := store.ListMicrovmSessions(ctx, b.WorkerIDPrefixes())
	if err != nil {
		log.Printf("vmhost-lite: reconcile query failed: %v", err)
		return
	}
	bound := b.mgr.Bindings()

	var adopted, closed int
	seen := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		seen[r.SandboxID] = struct{}{}
		microvmID, ok := parseMicrovmWorkerID(r.WorkerID)
		if !ok {
			continue
		}
		if _, held := bound[r.SandboxID]; held {
			continue
		}
		// Sizing is re-derived from the row rather than defaulted, so a restart
		// does not silently re-meter every sandbox at the default tier for the
		// rest of its life.
		var meta awsvmlite.Meta
		if len(r.Config) > 0 {
			var cfg types.SandboxConfig
			if err := json.Unmarshal(r.Config, &cfg); err != nil {
				log.Printf("vmhost-lite: reconcile %s: config unmarshal failed (%v) — adopting with defaults", r.SandboxID, err)
			} else {
				meta = awsvmlite.Meta{Template: cfg.Template, MemoryMB: cfg.MemoryMB, CPUCount: cfg.CpuCount}
			}
		}
		alive, err := b.mgr.Adopt(ctx, r.SandboxID, microvmID, meta)
		if err != nil {
			// Could not prove anything. Leaving the row alone is the safe
			// direction: a transient describe failure must never close out a
			// live sandbox.
			continue
		}
		if !alive {
			msg := "microvm no longer exists"
			_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
			closed++
			continue
		}
		adopted++
	}

	// The mirror image: a binding whose row has reached a terminal state by some
	// path that never called Kill. Nothing else would ever drop it, and it would
	// keep being metered.
	var forgotten int
	for sandboxID := range bound {
		if _, ok := seen[sandboxID]; ok {
			continue
		}
		alive, err := b.mgr.Alive(ctx, sandboxID)
		if err != nil || alive {
			continue
		}
		b.mgr.Forget(sandboxID)
		forgotten++
	}

	if adopted > 0 || closed > 0 || forgotten > 0 {
		log.Printf("vmhost-lite: reconciled — adopted %d, closed %d dead row(s), forgot %d dead binding(s)",
			adopted, closed, forgotten)
	}
}

// StartReconciler sweeps on a ticker for the life of the process. Nothing
// reports in for these boxes — no worker exists — so this is the only thing that
// ever notices one dying.
func (b *liteBackend) StartReconciler(ctx context.Context, store *db.Store) {
	if b == nil || store == nil {
		return
	}
	go func() {
		t := time.NewTicker(microvmReconcileInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				b.Reconcile(ctx, store)
			}
		}
	}()
}

// ── Billing ─────────────────────────────────────────────────────────────────

// StartUsageTicker meters these sandboxes. There is no worker to emit ticks for
// them, so the control plane does it over the same sandbox.Manager interface.
func (b *liteBackend) StartUsageTicker(ctx context.Context, sandboxDBs *sandbox.SandboxDBManager) {
	if b == nil {
		return
	}
	t := worker.NewUsageTicker(b.sm, sandboxDBs, 20*time.Second, 10)
	if t == nil {
		// Said loudly: silent non-billing is the failure mode nobody notices.
		log.Printf("vmhost-lite: WARNING usage ticker disabled — sandboxes will not be metered")
		return
	}
	b.usageTicker = t
	t.Start(ctx)
	log.Printf("vmhost-lite: usage ticker started")
}

// StartEventPublisher drains those ticks to the cell's Redis stream. Without
// this half the ticks sit on local disk and are never billed — and every log
// line still says metering is working.
func (b *liteBackend) StartEventPublisher(ctx context.Context, sandboxDBs *sandbox.SandboxDBManager, rdb *redis.Client, cellID string, store *db.Store) {
	if b == nil {
		return
	}
	if sandboxDBs == nil || rdb == nil || cellID == "" {
		log.Printf("vmhost-lite: WARNING event publisher disabled (sandboxDBs=%v redis=%v cellID=%q) — usage ticks stay on local disk",
			sandboxDBs != nil, rdb != nil, cellID)
		return
	}

	// events-ingest drops a tick whose worker_id disagrees with
	// sandboxes_index.worker_id, and each of these sandboxes has its own, so the
	// id has to be resolved per sandbox rather than stamped fleet-wide.
	workerIDs := func(sandboxID string) (string, bool) {
		box, ok := b.mgr.BoxFor(sandboxID)
		if !ok {
			return "", false
		}
		return microvmWorkerID(box.MicrovmID), true
	}

	var meta worker.MetadataResolver
	if store != nil {
		meta = func(sandboxID string) (string, string, bool) {
			lookupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			orgIDStr, err := store.GetSandboxOrgID(lookupCtx, sandboxID)
			if err != nil || orgIDStr == "" {
				return "", "", false
			}
			orgID, err := uuid.Parse(orgIDStr)
			if err != nil {
				return "", "", false
			}
			org, err := store.GetOrg(lookupCtx, orgID)
			if err != nil {
				return orgIDStr, "", true
			}
			return orgIDStr, org.Plan, true
		}
	}

	pub, err := worker.NewRedisEventPublisher(worker.RedisEventPublisherConfig{
		Client:           rdb,
		SandboxDBs:       sandboxDBs,
		CellID:           cellID,
		WorkerID:         microvmPublisherWorkerID,
		Resolver:         meta,
		WorkerIDResolver: workerIDs,
	})
	if err != nil {
		log.Printf("vmhost-lite: WARNING event publisher init failed: %v — usage ticks will not be billed", err)
		return
	}
	// Flush before the SQLite file is deleted, or a destroyed sandbox's final
	// usage slice races the 2s poll and is lost.
	sandboxDBs.SetOnRemove(func(sandboxID string) {
		pub.FlushSandbox(context.Background(), sandboxID)
	})
	pub.Start(ctx)
	b.eventPub = pub
	log.Printf("vmhost-lite: event publisher started (stream=events:%s)", cellID)
}

// StartCapacityReporter publishes this cell's capacity, without which the edge
// does not route creates to it at all — its health gate reads the worker
// registry, and a cell with no workers never writes one.
func (b *liteBackend) StartCapacityReporter(ctx context.Context, rdb *redis.Client, cellID string) {
	if b == nil {
		return
	}
	if rdb == nil || cellID == "" {
		log.Printf("vmhost-lite: WARNING capacity reporter disabled (redis=%v cellID=%q) — the edge will not route creates here",
			rdb != nil, cellID)
		return
	}
	cr, err := controlplane.NewCapacityReporter(controlplane.CapacityReporterConfig{
		Redis:  rdb,
		Source: b,
		CellID: cellID,
	})
	if err != nil {
		log.Printf("vmhost-lite: WARNING capacity reporter init failed: %v", err)
		return
	}
	cr.Start(ctx)
	b.capacity = cr
	log.Printf("vmhost-lite: capacity reporter started (cell=%s)", cellID)
}

// Depth reports warm stock, for telemetry.
func (b *liteBackend) Depth() int {
	if b == nil {
		return 0
	}
	return b.mgr.Depth()
}

// Status is the operator's view of the warm set, for the admin endpoint.
func (b *liteBackend) Status() map[string]any {
	if b == nil {
		return map[string]any{"enabled": false}
	}
	return map[string]any{
		"enabled": true,
		"warm":    b.mgr.Depth(),
		"bound":   len(b.mgr.Bound()),
		"region":  b.client.Config().Region,
	}
}

// ServesOwnStock: this backend manufactures and holds its own warm boxes, so the
// cell's Postgres pool is not its supply. See SelfStocking — consulting that
// pool for these creates measured 49-78ms of guaranteed miss per create.
func (b *liteBackend) ServesOwnStock() bool { return true }
