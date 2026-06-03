package controlplane

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/opensandbox/opensandbox/internal/db"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// ReconcileStoppedOnWorker re-issues DestroySandbox for any sandbox the cell
// believes is stopped on this worker but the worker may still be hosting.
//
// Why this exists:
//   When the worker is unreachable, the customer's DELETE goes through the
//   cell-side fallback at internal/api/sandbox.go's destroy handler — the
//   cell marks the session stopped in PG and publishes a `stopped` lifecycle
//   event "to close the drift" with D1. Worker never receives the gRPC
//   Destroy. When the worker becomes reachable again, the cell already
//   thinks the sandbox is dead, but the worker still has m.vms[id] alive,
//   qemu still running, usage_ticker still emitting `usage_tick` events.
//   That window has run for 74h+ in the wild before a worker restart finally
//   cleared the m.vms map.
//
// This reconcile closes that gap: on worker rejoin (RedisWorkerRegistry's
// OnWorkerRejoined callback), the cell sweeps every sandbox it has marked
// stopped on that worker within the last 24h and re-issues DestroySandbox.
// The RPC is idempotent — manager.Kill returns "sandbox not found" cleanly
// for entries the worker doesn't have, so genuine first-seen workers (empty
// m.vms) are a cheap no-op.
//
// Paired with: Fix A/B/C in internal/qemu/ghost_reaper.go which catches the
// case where qemu died but m.vms wasn't cleaned. This function catches the
// symmetric case where the cell already declared the sandbox dead but the
// worker (with live qemu) doesn't know.
func ReconcileStoppedOnWorker(ctx context.Context, registry *RedisWorkerRegistry, store *db.Store, workerID string) {
	if store == nil || registry == nil {
		return
	}

	ids, err := store.ListSandboxIDsByWorkerStatus(ctx, workerID, "stopped")
	if err != nil {
		log.Printf("controlplane: reconcile %s: list stopped sessions failed: %v", workerID, err)
		return
	}
	if len(ids) == 0 {
		return
	}

	client, err := registry.GetWorkerClient(workerID)
	if err != nil {
		// Worker was just added to the registry by handleHeartbeat; if the
		// gRPC dial is still in flight (or just failed) we'll catch the
		// next rejoin. Don't retry inline — that'd block other rejoins.
		log.Printf("controlplane: reconcile %s: GetWorkerClient failed: %v", workerID, err)
		return
	}

	log.Printf("controlplane: reconcile %s: sweeping %d cell-stopped sandboxes", workerID, len(ids))

	var killed, notFound, errored int
	for _, id := range ids {
		rpcCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := client.DestroySandbox(rpcCtx, &pb.DestroySandboxRequest{SandboxId: id})
		cancel()
		if err != nil {
			// "sandbox not found" is the success-case: the worker didn't
			// have it (either a genuine new worker or the entry was cleaned
			// up another way). Only log+count non-not-found errors.
			if isSandboxNotFound(err) {
				notFound++
			} else {
				log.Printf("controlplane: reconcile %s: DestroySandbox %s failed: %v", workerID, id, err)
				errored++
			}
			continue
		}
		killed++
	}
	log.Printf("controlplane: reconcile %s: done — killed=%d not_found=%d errored=%d (of %d cell-stopped within 24h)",
		workerID, killed, notFound, errored, len(ids))
}

// isSandboxNotFound is a heuristic for the worker's "sandbox not found" error
// surface — the qemu/firecracker managers both return `fmt.Errorf("sandbox %s
// not found", id)` from Kill on unknown IDs, which propagates through the
// gRPC layer as an Unknown error containing that string. We treat that as the
// success case for reconcile: nothing to clean up.
func isSandboxNotFound(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "sandbox not found") ||
		strings.Contains(err.Error(), "not found")
}

// ReconcileRunningOnWorker is the symmetric direction of ReconcileStoppedOnWorker:
//
//   forward  — cell says STOPPED on this worker, worker may still be hosting →
//              re-issue Destroy via RPC. ReconcileStoppedOnWorker above.
//   reverse  — cell says RUNNING on this worker, worker doesn't have it →
//              close the row on the cell side. THIS function.
//
// Why both directions are needed:
//   The cell-side fallback at internal/api/sandbox.go (worker-unreachable
//   destroy path) covers the forward direction. There's no symmetric fallback
//   for "worker died, never finished EndScaleEvent on its way out" — when a
//   worker process crashes/OOMs/restarts, its m.vms is cleared but cell PG
//   keeps the scale event open. usage-reporter sums (now - started_at)
//   indefinitely; customer gets billed for compute that hasn't run for days.
//
// Empirical fingerprint from prod: 49 still-open scale events on two workers
// that were known to have restarted ~3-5 days prior, accumulating ~$2k of
// phantom Pro billing per restart event.
//
// Process:
//   1. Ask cell PG: what sandboxes are status='running' on this worker?
//   2. Ask worker (existing ListSandboxes RPC): what do you actually have?
//   3. For each cell-PG-running entry the worker doesn't claim:
//        - UpdateSandboxSessionStatus → stopped
//        - EndScaleEvent → closes the open billing row
//        - publish stopped lifecycle event so events-ingest updates D1
func ReconcileRunningOnWorker(ctx context.Context, registry *RedisWorkerRegistry, store *db.Store, cellID, workerID string) {
	if store == nil || registry == nil {
		return
	}

	cellRunning, err := store.ListSandboxesByWorkerStatus(ctx, workerID, "running")
	if err != nil {
		log.Printf("controlplane: reverse-reconcile %s: list running sessions failed: %v", workerID, err)
		return
	}
	if len(cellRunning) == 0 {
		return
	}

	client, err := registry.GetWorkerClient(workerID)
	if err != nil {
		log.Printf("controlplane: reverse-reconcile %s: GetWorkerClient failed: %v", workerID, err)
		return
	}

	rpcCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	resp, err := client.ListSandboxes(rpcCtx, &pb.ListSandboxesRequest{})
	cancel()
	if err != nil {
		log.Printf("controlplane: reverse-reconcile %s: ListSandboxes RPC failed: %v", workerID, err)
		return
	}

	workerHas := make(map[string]struct{}, len(resp.Sandboxes))
	for _, sb := range resp.Sandboxes {
		workerHas[sb.SandboxId] = struct{}{}
	}

	log.Printf("controlplane: reverse-reconcile %s: cell-running=%d worker-has=%d", workerID, len(cellRunning), len(workerHas))

	reason := "reverse_reconcile_worker_lost_session"
	var closed, alive int
	for _, ref := range cellRunning {
		if _, has := workerHas[ref.SandboxID]; has {
			alive++
			continue
		}
		// Close the cell-side state. Order matters: status first (so future
		// dashboard reads see the right thing immediately), then scale event
		// (so usage-reporter stops billing), then the lifecycle event (so D1
		// gets the same signal via events-ingest).
		errMsg := reason
		if err := store.UpdateSandboxSessionStatus(ctx, ref.SandboxID, "stopped", &errMsg); err != nil {
			log.Printf("controlplane: reverse-reconcile %s: UpdateSandboxSessionStatus %s: %v", workerID, ref.SandboxID, err)
			continue
		}
		if err := store.EndScaleEvent(ctx, ref.SandboxID); err != nil {
			log.Printf("controlplane: reverse-reconcile %s: EndScaleEvent %s: %v", workerID, ref.SandboxID, err)
			// Don't continue — the status update already happened, so emit
			// the lifecycle event anyway. The scale event being orphaned is
			// at worst a per-row leak the usage-reporter will eventually
			// notice; the lifecycle event is what unblocks D1.
		}
		publishStoppedLifecycleEvent(ctx, registry.RedisClient(), cellID, ref.SandboxID, ref.OrgID.String(), workerID, reason)
		closed++
	}
	log.Printf("controlplane: reverse-reconcile %s: closed=%d still-alive-on-worker=%d (of %d cell-running)", workerID, closed, alive, len(cellRunning))
}

// publishStoppedLifecycleEvent emits a `stopped` event onto this cell's events
// stream so events-ingest mirrors it into D1 sandboxes_index. Mirrors the
// shape of internal/api/checkpoint_events.go's publishSandboxLifecycleEvent
// — extracted here so the reconcile (which lives in controlplane, doesn't
// have an *api.Server handle) can call it directly.
func publishStoppedLifecycleEvent(ctx context.Context, rdb *redis.Client, cellID, sandboxID, orgID, workerID, reason string) {
	if rdb == nil || cellID == "" || sandboxID == "" {
		return
	}
	envelope := map[string]any{
		"id":         uuid.NewString(),
		"type":       "stopped",
		"sandbox_id": sandboxID,
		"org_id":     orgID,
		"worker_id":  workerID,
		"cell_id":    cellID,
		"payload":    map[string]any{"reason": reason},
		"timestamp":  time.Now().UTC().Format(time.RFC3339Nano),
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		log.Printf("controlplane: publishStoppedLifecycleEvent: marshal: %v", err)
		return
	}
	streamKey := "events:" + cellID
	xaddCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := rdb.XAdd(xaddCtx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: 100000,
		Approx: true,
		Values: map[string]any{"event": string(body)},
	}).Err(); err != nil {
		log.Printf("controlplane: publishStoppedLifecycleEvent: XADD %s: %v", sandboxID, err)
	}
}
