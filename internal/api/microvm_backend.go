package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/worker"
	"github.com/opensandbox/opensandbox/pkg/types"
	"github.com/redis/go-redis/v9"
)

// microvm_backend.go — the AWS Lambda MicroVM backend, owned by the control
// plane.
//
// It lives here rather than in cmd/worker on purpose. The point of this backend
// is that AWS holds the VM, so there is nothing for a QEMU worker host to own;
// running it from the worker would keep the very hop it exists to remove and
// add an Azure→AWS leg to every exec. The control plane already decides which
// cell serves a create, so backend selection belongs at the same level.
//
// The QEMU path is untouched. When this backend is disabled — the default —
// nothing here runs and no AWS call is ever made.
//
// Measured on us-east-1 (3-box runs, laptop client):
//
//	claim       0s (zero AWS calls, by construction)
//	first exec  ~224ms   (pre-dialled tunnel + agent-path warm-up in the image)
//	warm exec   ~83ms
//
// Two platform constraints shape everything and are documented where they bite
// (internal/awsvm/agent.go): the proxy strips HTTP/2 trailers, so gRPC rides
// inside a WebSocket; and it forwards only to the image's declared hook port.

// microvmBackend holds the CP's MicroVM client and warm pool. nil when the
// backend is disabled, which is the only state the QEMU fleet ever sees.
type microvmBackend struct {
	client  *awsvm.Client
	pool    *awsvm.Pool
	manager *awsvm.Manager

	// usageTicker emits the billing ticks these sandboxes would otherwise never
	// produce. On the QEMU fleet the worker runs one; there is no worker here,
	// so the control plane runs it directly over the same sandbox.Manager
	// interface. Without it MicroVM sandboxes run entirely unmetered.
	usageTicker *worker.UsageTicker

	// eventPub drains those ticks off local disk to the cell's Redis stream.
	// The ticker without the publisher meters into a file nobody reads.
	eventPub *worker.RedisEventPublisher

	// capacity tells the edge this cell exists and can take creates. A cell that
	// never reports is not routed to at all.
	capacity *controlplane.CapacityReporter

	// coldSlots caps concurrent cold launches (see maxColdCreates).
	coldSlots chan struct{}

	// stopPool ends the maintenance loop on shutdown so a redeploying CP does
	// not leave stock running: abandoned boxes bill compute and hold regional
	// memory quota until the 8h service cap.
	stopPool context.CancelFunc
}

// microvmEnabled reports whether this cell serves MicroVM-backed sandboxes.
// Off unless explicitly turned on: this backend is regional (us-east-1 today)
// and cannot serve a cell whose customers expect QEMU semantics like
// checkpoints or fork, which it does not implement.
func microvmEnabled() bool {
	return os.Getenv("OPENSANDBOX_MICROVM_ENABLED") == "1"
}

// newMicrovmBackend builds the backend from environment config, or returns nil
// if disabled. An error here is fatal to startup by design — a cell configured
// for MicroVMs that silently fell back to QEMU would be far more confusing than
// a refusal to boot.
func newMicrovmBackend(ctx context.Context) (*microvmBackend, error) {
	if !microvmEnabled() {
		return nil, nil
	}

	image := os.Getenv("OPENSANDBOX_MICROVM_IMAGE_ARN")
	if image == "" {
		return nil, fmt.Errorf("OPENSANDBOX_MICROVM_ENABLED=1 but OPENSANDBOX_MICROVM_IMAGE_ARN is unset")
	}
	region := os.Getenv("OPENSANDBOX_MICROVM_REGION")
	if region == "" {
		region = "us-east-1"
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("microvm: load AWS config: %w", err)
	}

	// Idle policy. Measured on dev: with idle=60s and suspended=300s, a sandbox
	// was TERMINATED — disk and all — roughly six minutes after its last
	// request. The old defaults (900/1800) put that at 45 minutes of inactivity,
	// which silently destroys any sandbox a customer steps away from.
	//
	//   idle      seconds without inbound proxy traffic before AWS suspends.
	//             A persistent agent tunnel does NOT count as traffic — only
	//             requests through the proxy do, which is why an open connection
	//             does not keep a box alive.
	//   suspended seconds a box may stay suspended before AWS TERMINATES it.
	//             This, not the 8h ceiling, is what actually bounds a parked
	//             sandbox, and when it fires the disk goes with it.
	//   resume    whether an inbound request wakes a suspended box. With this
	//             off, nothing can reach a box during its suspended window, so
	//             the window always runs out and the sandbox is destroyed.
	//
	// Default idle deliberately exceeds the pool's MaxBoxAge (7h) so stock never
	// drifts into SUSPENDED while waiting — the pool's docstring requires that,
	// and the previous 900s default did not deliver it. Auto-resume defaults ON
	// so that anything which does suspend is recoverable rather than doomed.
	idleSec := envInt("OPENSANDBOX_MICROVM_IDLE_SECONDS", 28_800)
	// Default to the hard ceiling rather than 1800: AWS terminates a suspended
	// box when this fires, taking its disk with it, so a 30-minute default made
	// "hibernate" mean "deleted in half an hour". At the ceiling this timer
	// never fires before the 8h total cap does, which leaves the cap as the
	// single deadline to reason about — and the one the blob promotion works
	// against.
	suspendedSec := envInt("OPENSANDBOX_MICROVM_SUSPENDED_SECONDS", 28_800)
	autoResume := os.Getenv("OPENSANDBOX_MICROVM_AUTO_RESUME") != "0"
	client := awsvm.NewClient(awsCfg, awsvm.Config{
		Region:                   region,
		ImageIdentifier:          image,
		ExecutionRoleArn:         os.Getenv("OPENSANDBOX_MICROVM_EXECUTION_ROLE_ARN"),
		MaxIdleDurationSeconds:   int32(idleSec),
		SuspendedDurationSeconds: int32(suspendedSec),
		AutoResume:               autoResume,
	})
	log.Printf("microvm: idle policy — suspend after %ds idle, terminate after %ds suspended, auto-resume=%v",
		idleSec, suspendedSec, autoResume)

	pool := awsvm.NewPool(client, awsvm.PoolConfig{
		TargetStock: envInt("OPENSANDBOX_MICROVM_POOL_TARGET", 20),
	})

	poolCtx, stop := context.WithCancel(context.Background())
	go pool.Run(poolCtx)

	log.Printf("microvm: backend enabled (region=%s image=%s poolTarget=%d)",
		region, image, envInt("OPENSANDBOX_MICROVM_POOL_TARGET", 20))

	return &microvmBackend{
		client:    client,
		pool:      pool,
		manager:   awsvm.NewManager(client, os.TempDir()),
		coldSlots: make(chan struct{}, maxColdCreates),
		stopPool:  stop,
	}, nil
}

// claimPooled binds a warm host to a sandbox id and returns whether one was
// available. It makes NO provider calls — that is the property the whole pool
// design exists to preserve, because launch and resume are both rate-limited
// and a burst cannot afford either.
//
// A miss is not an error here; Claim decides what to do about it.
func (b *microvmBackend) claimPooled(sandboxID string, cfg types.SandboxConfig) (string, bool) {
	if b == nil {
		return "", false
	}
	entry, ok := b.pool.Claim()
	if !ok {
		log.Printf("microvm: pool empty on claim for %s — cold create", sandboxID)
		return "", false
	}
	// TrackClaimed adopts the tunnel the pool already established. Losing that
	// here would cost ~700ms on the customer's first command, which is most of
	// what this backend's latency story is about.
	b.manager.TrackClaimed(sandboxID, entry, cfg)
	// Encoded, not raw: Claim's contract is "the worker_id to persist", and the
	// raw host id is not a worker_id this backend recognizes as its own.
	return microvmWorkerID(entry.MicrovmID), true
}

// maxColdCreates bounds concurrent cold launches. RunMicrovm is rate-limited at
// 5/s, so letting an unbounded burst through would convert one empty pool into
// a wall of throttling errors — turning a slow create into a failed one for
// requests that had nothing to do with the burst.
const maxColdCreates = 5

// coldCreateTimeout bounds a single cold launch. Generous relative to the ~1.5s
// a healthy launch takes, because the alternative for the customer is a failed
// create, not a fast one.
const coldCreateTimeout = 45 * time.Second

// Claim serves a sandbox from warm stock, falling back to launching one.
//
// The pool is a latency optimization, not the capacity limit: the real ceiling
// is an AWS regional quota far above normal use. Before this existed a pool miss
// fell through to the worker path and sat in its 30s poll waiting for a worker
// that a MicroVM cell never has — so every create past pool depth failed after
// 30 seconds against a backend that would have launched a box in ~1.5s.
//
// Returns ErrQuotaExceeded only when AWS says the region is genuinely full, so
// the caller can report "out of capacity" and mean it.
func (b *microvmBackend) Claim(ctx context.Context, p placement) (string, error) {
	if b == nil {
		return "", errors.New("microvm: backend disabled")
	}
	sandboxID, cfg := p.sandboxID, p.cfg
	if id, ok := b.claimPooled(sandboxID, cfg); ok {
		return id, nil
	}

	// Bound concurrency rather than queueing indefinitely: a caller blocked here
	// is a customer waiting on a create, so failing fast beats a long hold.
	select {
	case b.coldSlots <- struct{}{}:
		defer func() { <-b.coldSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}

	launchCtx, cancel := context.WithTimeout(ctx, coldCreateTimeout)
	defer cancel()

	start := time.Now()
	box, err := b.client.Run(launchCtx, "")
	if err != nil {
		return "", err // already classified (quota vs throttle) by awsvm
	}
	ready, err := b.client.WaitRunning(launchCtx, box.ID, coldCreateTimeout)
	if err != nil {
		// The box may be mid-boot rather than dead, but we cannot hand out one
		// we could not confirm — terminate it instead of leaking a box that
		// bills and holds quota with nothing tracking it.
		go func() { _ = b.client.Terminate(context.Background(), box.ID) }()
		return "", fmt.Errorf("microvm: cold create %s never became ready: %w", box.ID, err)
	}
	// WaitRunning returns the settled box — it carries the endpoint the agent
	// tunnel dials, which the pre-ready Run response does not.
	box = ready

	// Track, not TrackClaimed: there is no pre-dialled tunnel on this path, so
	// the first exec pays the dial. That is the cost of missing the pool.
	b.manager.Track(sandboxID, box, cfg)
	log.Printf("microvm: COLD CREATE %s -> %s in %s", sandboxID, box.ID, time.Since(start).Round(time.Millisecond))
	return microvmWorkerID(box.ID), nil
}

// Restore rebuilds the in-memory sandbox→MicroVM map from the database after a
// control-plane restart, and closes out rows whose box AWS no longer has.
//
// Skipping this does not merely lose routing: an untracked box is one nothing
// will ever terminate, so it keeps billing compute and holding regional memory
// quota — which is the real ceiling on pool depth — until the 8h cap.
func (b *microvmBackend) Restore(ctx context.Context, store *db.Store) {
	b.reconcileOnce(ctx, store)
}

// microvmReconcileInterval paces the background sweep. Boxes die on their own
// schedule — the 8h service cap, or AWS terminating one underneath us — so this
// is the only thing that ever notices. Five minutes is far tighter than the
// window in which a stale row could matter, and each pass is one cheap
// GetMicrovm per live sandbox.
const microvmReconcileInterval = 5 * time.Minute

// StartReconciler sweeps for boxes that died without anyone telling us.
//
// Unlike the QEMU fleet, nothing here reports in, so a dead box keeps a running
// row forever unless this sweep notices — inflating concurrency and quota counts
// with sandboxes that no longer exist.
//
// The inverse hazard is real too, and cost a dev cell every sandbox it created:
// MarkOrphanedSandboxes reaps any session whose worker_id is missing from the
// live worker registry, and "microvm:<id>" is missing from it by construction.
// It now skips these rows explicitly (internal/db/store.go). Anything else that
// infers liveness from the worker registry has to do the same — AWS is the only
// authority on whether one of these boxes is alive.
func (b *microvmBackend) StartReconciler(ctx context.Context, store *db.Store) {
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
				b.reconcileOnce(ctx, store)
			}
		}
	}()
}

// reconcileOnce reconciles persisted MicroVM sandboxes against AWS: adopt the
// ones still alive, close out the ones that are gone. Used both at boot (where
// the adopt half matters, after a restart drops the in-memory map) and on the
// ticker (where the close half matters).
func (b *microvmBackend) reconcileOnce(ctx context.Context, store *db.Store) {
	if b == nil || store == nil {
		return
	}
	rows, err := store.ListMicrovmSessions(ctx, b.WorkerIDPrefixes())
	if err != nil {
		log.Printf("microvm: restore query failed: %v", err)
		return
	}

	var restored, closed int
	for _, r := range rows {
		microvmID, ok := parseMicrovmWorkerID(r.WorkerID)
		if !ok {
			continue
		}
		// Already tracked AND still alive — nothing to do. Skipping avoids a
		// GetMicrovm per sandbox per tick once the map is warm.
		//
		// The status matters, not just the error: Get returns a nil error with
		// status stopped for a box AWS has terminated. Reading only the error
		// meant this shortcut fired for exactly the sandboxes the sweep exists
		// to close, so dead boxes kept their rows at 'running' indefinitely —
		// holding concurrency quota and reporting healthy — while the usage
		// ticker logged "not alive, reaper should drain it" for a reaper that
		// could never see them.
		if sb, err := b.manager.Get(ctx, r.SandboxID); err == nil && sb.Status == types.SandboxStatusRunning {
			continue
		}
		box, err := b.client.Get(ctx, microvmID)
		if err != nil || !box.Alive() {
			// The box is gone (terminated, or aged past the 8h cap) but the row
			// still says running. Close it, or wake/exec will 404 forever
			// against a sandbox that cannot exist.
			msg := "microvm no longer exists"
			_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
			closed++
			continue
		}
		// Re-derive the config from the persisted row rather than tracking a
		// bare id. Track fills zero sizing with the backend default, so a
		// restore that skipped this would re-meter a 4096MB sandbox at 2048
		// for the rest of its life — under-billing that nothing surfaces,
		// since every log line still reports ticks flowing.
		cfg := types.SandboxConfig{SandboxID: r.SandboxID}
		if len(r.Config) > 0 {
			if err := json.Unmarshal(r.Config, &cfg); err != nil {
				log.Printf("microvm: restore %s: config unmarshal failed (%v) — tracking with defaults", r.SandboxID, err)
			}
			cfg.SandboxID = r.SandboxID
		}
		b.manager.Track(r.SandboxID, box, cfg)
		restored++
	}
	if restored > 0 || closed > 0 {
		log.Printf("microvm: reconciled — adopted %d sandbox(es), closed %d dead row(s)", restored, closed)
	}
}

// Kill terminates a MicroVM-backed sandbox. Reports whether this backend owned
// it, so the caller can fall through to the worker path when it did not.
func (b *microvmBackend) Kill(ctx context.Context, sandboxID string) (bool, error) {
	if b == nil {
		return false, nil
	}
	if _, err := b.manager.Get(ctx, sandboxID); err != nil {
		return false, nil
	}
	return true, b.manager.Kill(ctx, sandboxID)
}

// Depth reports current stock, for telemetry and for the sizing invariant: if
// the edge shards claims, the shards' aggregate target must not exceed this
// pool or they starve while hoarding — the failure that cost 1045ms vs 174ms on
// the QEMU fleet.
func (b *microvmBackend) Depth() int {
	if b == nil {
		return 0
	}
	return b.pool.Depth()
}

// StartUsageTicker begins emitting billing ticks for MicroVM sandboxes.
//
// UsageTicker takes a sandbox.Manager, which awsvm.Manager already satisfies,
// so this is wiring rather than a second implementation. It also relies on
// IsSandboxAlive to drop dead sandboxes — and this backend deliberately asks
// AWS there instead of trusting its local map, which is exactly what stops a
// stale entry billing for a VM that no longer exists.
func (b *microvmBackend) StartUsageTicker(ctx context.Context, sandboxDBs *sandbox.SandboxDBManager) {
	if b == nil {
		return
	}
	t := worker.NewUsageTicker(b.manager, sandboxDBs, 20*time.Second, 10)
	if t == nil {
		// nil sandboxDBs disables it. Say so loudly: silent non-billing is the
		// failure mode that does not page anyone.
		log.Printf("microvm: WARNING usage ticker disabled — sandboxes will not be metered")
		return
	}
	b.usageTicker = t
	t.Start(ctx)
	log.Printf("microvm: usage ticker started")
}

// StartEventPublisher drains the ticks the usage ticker writes into per-sandbox
// SQLite out to the cell's Redis stream, where event_forwarder picks them up for
// events-ingest → D1 `usage_samples`.
//
// This is the second half of billing and is easy to miss, because omitting it
// looks fine from inside the control plane: LogEvent succeeds, the ticks are on
// disk, and nothing errors — they simply never leave the box. On the QEMU fleet
// cmd/worker runs this publisher; with no worker in the MicroVM path, the
// control plane has to.
//
// Off unless both Redis and a cell id are configured, matching the worker: with
// no consumer, the stream is a slow leak rather than a billing path.
func (b *microvmBackend) StartEventPublisher(ctx context.Context, sandboxDBs *sandbox.SandboxDBManager, rdb *redis.Client, cellID string, store *db.Store) {
	if b == nil {
		return
	}
	if sandboxDBs == nil || rdb == nil || cellID == "" {
		log.Printf("microvm: WARNING event publisher disabled (sandboxDBs=%v redis=%v cellID=%q) — usage ticks stay on local disk and are never billed",
			sandboxDBs != nil, rdb != nil, cellID)
		return
	}

	// Each MicroVM sandbox carries its own owner id, so the envelope's worker_id
	// has to be resolved per sandbox rather than stamped from the publisher.
	// events-ingest drops a tick whose worker_id disagrees with
	// sandboxes_index.worker_id, and every one of these disagrees with any
	// single fleet-wide id.
	workerIDs := func(sandboxID string) (string, bool) {
		hostID, ok := b.manager.MicrovmIDFor(sandboxID)
		if !ok {
			return "", false
		}
		return microvmWorkerID(hostID), true
	}

	// org_id + plan are denormalized onto the envelope so events-ingest can
	// route without a D1 lookup per event. Blank plan means "unknown" there,
	// which skips the debit — so a missing org row costs metering, not a
	// mis-bill.
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
		log.Printf("microvm: WARNING event publisher init failed: %v — usage ticks will not be billed", err)
		return
	}

	// Flush before the SQLite file is deleted. Without this the terminal events
	// of a destroyed sandbox — including its final usage slice — race the 2s
	// poll and are lost.
	sandboxDBs.SetOnRemove(func(sandboxID string) {
		pub.FlushSandbox(context.Background(), sandboxID)
	})

	pub.Start(ctx)
	b.eventPub = pub
	log.Printf("microvm: event publisher started (stream=events:%s)", cellID)
}

// Capacity reports this cell's placement numbers to the edge, in the shape a
// QEMU cell reports worker counts. Implements controlplane.CapacitySource.
//
// `available` is a constant 1: this backend has no cell-level capacity worth
// publishing. Its real ceiling is an AWS regional memory quota that is raised
// on request and sits orders of magnitude above current use, so any number we
// computed would say "yes" until the day it didn't.
//
// It reported pool depth first, which was wrong in the direction that costs
// customers: the pool is warmth, not capacity. Advertising depth 503'd creates
// the backend could serve — every burst past the pool, plus a 30s window after
// each refill where a fully-stocked cell still advertised zero.
//
// What this keeps is the freshness half. The edge also requires
// capacity_updated_at inside 120s, so this doubles as a liveness heartbeat: a
// CP that dies, loses Redis, or stops forwarding drops its cell out of routing
// on its own. That is how a stopped dev CP announced itself rather than
// silently black-holing creates.
//
// Not covered: a live CP whose AWS credentials have expired keeps publishing 1
// while failing every launch. Closing that means gating on a recent-success
// signal rather than a constant — worth doing when this backend carries real
// traffic, and deliberately not built now.
func (b *microvmBackend) Capacity() (healthy, available, running int) {
	if b == nil {
		return 0, 0, 0
	}
	n, err := b.manager.Count(context.Background())
	if err != nil {
		n = 0
	}
	return 1, 1, n
}

// StartCapacityReporter publishes this cell's capacity so the edge will route
// to it at all.
//
// Without this a MicroVM cell is invisible rather than unhealthy: the edge's
// isHealthy() gate requires available_workers > 0 and a capacity_updated_at
// inside 120s, both of which only ever came from the QEMU worker registry. A
// cell with no workers never wrote either, so every create — including one
// pinned to it by cellId — fell through to "no cells available with capacity".
func (b *microvmBackend) StartCapacityReporter(ctx context.Context, rdb *redis.Client, cellID string) {
	if b == nil {
		return
	}
	if rdb == nil || cellID == "" {
		log.Printf("microvm: WARNING capacity reporter disabled (redis=%v cellID=%q) — the edge will not route creates to this cell",
			rdb != nil, cellID)
		return
	}
	cr, err := controlplane.NewCapacityReporter(controlplane.CapacityReporterConfig{
		Redis:  rdb,
		Source: b,
		CellID: cellID,
	})
	if err != nil {
		log.Printf("microvm: WARNING capacity reporter init failed: %v — the edge will not route creates to this cell", err)
		return
	}
	cr.Start(ctx)
	b.capacity = cr
	log.Printf("microvm: capacity reporter started (cell=%s)", cellID)
}

// Close stops the maintenance loop and terminates remaining stock.
func (b *microvmBackend) Close() {
	if b == nil {
		return
	}
	if b.usageTicker != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = b.usageTicker.Stop(stopCtx)
		cancel()
	}
	// After the ticker, so its final slices are in SQLite before the publisher
	// drains. Stop() does a last flush; skipping it drops the ticks accrued
	// since the previous 2s poll on every redeploy.
	if b.eventPub != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = b.eventPub.Stop(stopCtx)
		cancel()
	}
	if b.capacity != nil {
		b.capacity.Stop()
	}
	b.stopPool()
	b.pool.Drain()
	b.manager.Close()
}

// microvmWorkerPrefix marks sandbox_sessions.worker_id as backed by this
// runtime and carries the underlying host id after the colon.
//
// There is no worker: the host is managed for us, which is the point of this
// backend. But worker_id is NOT NULL and every existing lookup keys on it, so
// this keeps those queries working. Encoding the host id here rather than
// adding a column is deliberate — it is the only durable link between our
// sandbox id and the host, and without it a control-plane restart loses the
// mapping: the sandboxes become unroutable AND unreapable, billing compute
// until the hard duration cap.
//
// worker_id travels well beyond the database — it is returned in the create
// response, written to D1 sandboxes_index, and rendered in the dashboard — so
// both halves of it are ours to choose, and neither describes the runtime.
const microvmWorkerPrefix = "vmhost:"

// legacyWorkerPrefix is still read so rows predating the current encoding stay
// routable and reapable; dropping it would strand those hosts billing until
// their duration cap with nothing able to parse, reconcile, or terminate them.
// Never written.
const legacyWorkerPrefix = "microvm:"

// hostIDPrefix is the fixed prefix the platform puts on every host id. Trimmed
// on the way into worker_id and restored on the way out, so the id we publish
// is ours end to end while the value we hand back to the platform is unchanged.
// A host id that does not carry it is stored verbatim.
const hostIDPrefix = "microvm-"

// microvmPublisherWorkerID is the event publisher's fallback stamp, used only
// for a sandbox whose host binding is already gone from memory — which in
// practice means its final flush during shutdown or after a reconcile drop.
// The per-sandbox resolver supplies the real owner in every other case.
const microvmPublisherWorkerID = "vmhost-cp"

// microvmWorkerID encodes a host id for storage in worker_id.
func microvmWorkerID(microvmID string) string {
	return microvmWorkerPrefix + strings.TrimPrefix(microvmID, hostIDPrefix)
}

// parseMicrovmWorkerID recovers the host id, reporting whether the row is
// backed by this runtime at all.
func parseMicrovmWorkerID(workerID string) (string, bool) {
	for _, prefix := range []string{microvmWorkerPrefix, legacyWorkerPrefix} {
		if !strings.HasPrefix(workerID, prefix) {
			continue
		}
		id := strings.TrimPrefix(workerID, prefix)
		if id == "" {
			return "", false
		}
		// Rows stored before the id was trimmed already carry it.
		if !strings.HasPrefix(id, hostIDPrefix) {
			id = hostIDPrefix + id
		}
		return id, true
	}
	return "", false
}

// execManagerFor returns the sandbox.Manager that owns a sandbox.
//
// This is the routing seam for step 3: MicroVM-backed sandboxes are served by
// the awsvm manager in this process, everything else by the existing
// worker/cell path. Membership is decided by the awsvm manager's own tracking
// rather than a DB read, so the exec hot path stays in memory.
// ── Backend implementation ──────────────────────────────────────────────────

// Compile-time proof this backend satisfies the dispatch seam. Without it a
// method-signature drift would not surface until a call site failed at runtime,
// which for this backend has repeatedly meant a silent failure rather than a
// loud one.
var _ Placer = (*microvmBackend)(nil)

func (b *microvmBackend) Name() string { return "vmhost" }

func (b *microvmBackend) WorkerIDPrefixes() []string {
	return []string{microvmWorkerPrefix, legacyWorkerPrefix}
}

func (b *microvmBackend) OwnsWorkerID(workerID string) bool {
	_, ok := parseMicrovmWorkerID(workerID)
	return ok
}

// Route reports whether this backend holds the sandbox, from its in-memory
// binding only. Deliberately not an availability check: a false here sends the
// caller to another backend, so "mine but sick" must never look like "not
// mine".
func (b *microvmBackend) Route(_ context.Context, sandboxID string) (sandbox.Manager, bool) {
	if b == nil {
		return nil, false
	}
	if _, ok := b.manager.MicrovmIDFor(sandboxID); !ok {
		return nil, false
	}
	return b.manager, true
}

// Activate has nothing to do: Claim returns a host that is already running,
// either popped from warm stock or launched and waited for. There is no second
// step, which is the whole reason this backend answers a create in ~350ms.
//
// It reports running rather than an empty status so the caller does not have to
// know which backends boot lazily.
func (b *microvmBackend) Activate(_ context.Context, a activation) (activated, error) {
	return activated{sandboxID: a.sandboxID, status: "running"}, nil
}

// RequiresPersistedRow is true: this backend rebuilds its map of what it is
// running *from* these rows, so a host with no row is one nothing will ever
// terminate — it bills compute and holds regional capacity until the service's
// hard lifetime cap.
func (b *microvmBackend) RequiresPersistedRow() bool { return true }

// Release terminates the host, because here Claim already produced a running
// one — from warm stock or a cold launch. Merely forgetting it would leave a
// box that bills compute and holds regional capacity with nothing tracking it,
// until its hard lifetime cap hours later.
func (b *microvmBackend) Release(ctx context.Context, sandboxID, _ string) {
	if b == nil {
		return
	}
	if err := b.manager.Kill(ctx, sandboxID); err != nil {
		log.Printf("microvm: release %s: %v", sandboxID, err)
	}
}

func (b *microvmBackend) Reconcile(ctx context.Context, store *db.Store) {
	b.reconcileOnce(ctx, store)
}

// respondManagerErr maps a sandbox.Manager error to a response, turning
// "this backend cannot do that" into 501 Not Implemented rather than 500.
//
// The distinction matters to callers: a 500 invites a retry and reads as our
// bug, while 501 says the operation will never succeed on this runtime. The
// MicroVM backend returns ErrUnsupported for checkpoint/fork/reboot/power-cycle
// — operations with no counterpart in a service where images are built through
// an API rather than captured from a running VM.
func respondManagerErr(c echo.Context, err error) error {
	if errors.Is(err, awsvm.ErrUnsupported) {
		return c.JSON(http.StatusNotImplemented, map[string]string{
			"error": "this operation is not supported for this sandbox",
		})
	}
	// Logged, not returned: internal errors carry upstream service names,
	// resource ids, and wording.
	log.Printf("microvm: operation failed: %v", err)
	return c.JSON(http.StatusInternalServerError, map[string]string{
		"error": "the sandbox could not complete this operation",
	})
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
		log.Printf("microvm: ignoring malformed %s=%q, using %d", key, v, def)
	}
	return def
}
