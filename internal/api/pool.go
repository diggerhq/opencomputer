package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// Pool refill + drain-wipe (pre-warmed sandbox pool, Phase 3/4).
//
// The reconciler keeps ~N pre-warmed pooled boxes per (region, template) so that
// createSandboxRemote's fast-path (tryClaimPooled) can claim one instead of
// paying the ~260ms cold golden restore. Boxes are manufactured generic (no
// customer), parked paused, never billed. On worker drain they are wiped
// (disposable) rather than migrated/hibernated.

// poolTarget is the PER-WORKER warm-pool size for THIS cell. A cell == one
// region, so it's a single per-cell integer: OPENSANDBOX_POOL_TARGET (settable
// in Infisical per cell), default 10 (10 warm boxes on every worker in the
// cell's region). 0 disables the pool for this cell.
func (s *Server) poolTarget() int {
	if v := os.Getenv("OPENSANDBOX_POOL_TARGET"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return 10
}

// poolRefillBatch is the max boxes a worker is topped up per reconcile tick.
// They're manufactured concurrently (see reconcilePool), so this bounds the
// burst of simultaneous golden-restores per worker. Default 3 (gentle cold
// ramp); crank via OPENSANDBOX_POOL_REFILL_BATCH to recover a drained pool fast.
func poolRefillBatch() int {
	if v := os.Getenv("OPENSANDBOX_POOL_REFILL_BATCH"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 3
}

// poolRefillInterval is how often the reconciler tops the pool up. Default 15s;
// shorten via OPENSANDBOX_POOL_REFILL_INTERVAL_MS so a drained pool recovers
// between bursts instead of over minutes.
func poolRefillInterval() time.Duration {
	if v := os.Getenv("OPENSANDBOX_POOL_REFILL_INTERVAL_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return 15 * time.Second
}

// poolMaxMemPct is the host-memory ceiling for pool refill: once a worker's
// memory is above this, the reconciler stops manufacturing pool boxes onto it.
// The pool always yields to real customer load — this matches the scaler's
// memory scale-up trigger (resourceMemThreshold), so at the point new workers
// are being added for pressure the pool stops adding to it. Paused pool boxes
// have their RAM reclaimed, but manufacture briefly restores a full VM and a
// burst of claims resumes them, so gating on real headroom prevents the pool
// from tipping a hot worker over.
const poolMaxMemPct = 70.0

func poolTemplateName() string {
	if v := os.Getenv("OPENSANDBOX_POOL_TEMPLATE"); v != "" {
		return v
	}
	return "base"
}

// manufacturePoolBox creates one generic pool box on the least-loaded (non-
// draining) worker in region: insert the 'pooled' session row (org = pool),
// then CreateSandbox{pooled:true} — the worker golden-restores it and parks it
// paused. Rolls back the PG row if the worker create fails.
func (s *Server) manufacturePoolBoxOn(ctx context.Context, workerID, region, template, goldenVersion string) error {
	// Golden gate: a pool box with no golden_version can't be migrated/rebased
	// later (the drain fails "no goldenVersion"). Refuse to make one — the worker
	// hasn't reported its golden yet, so skip it this tick.
	if goldenVersion == "" {
		return fmt.Errorf("pool: worker %s reports no golden version yet — skipping", workerID)
	}
	grpcClient, err := s.workerRegistry.GetWorkerClient(workerID)
	if err != nil {
		return fmt.Errorf("pool: no client for %s: %w", workerID, err)
	}
	sandboxID := "sb-" + uuid.New().String()[:8]
	if err := s.store.CreatePooledSession(ctx, sandboxID, template, region, workerID, json.RawMessage(`{}`)); err != nil {
		return fmt.Errorf("pool: create session %s: %w", sandboxID, err)
	}
	grpcCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	resp, err := grpcClient.CreateSandbox(grpcCtx, &pb.CreateSandboxRequest{
		SandboxId: sandboxID,
		Template:  template,
		Pooled:    true,
	})
	if err != nil {
		_ = s.store.WipePooled(ctx, sandboxID) // roll back the reserved row
		return fmt.Errorf("pool: manufacture %s on %s: %w", sandboxID, workerID, err)
	}
	// Capability gate: a pool-capable worker parks the box and returns
	// status="pooled". An OLD worker that doesn't understand the flag ignores it,
	// makes a normal RUNNING box, and returns "running" — a malformed pool box
	// that can't be claimed and wedges drains. Destroy it and refuse to pool on
	// this worker (so the pool can never pollute an un-rolled fleet).
	if resp.GetStatus() != string(types.SandboxStatusPooled) {
		dctx, dcancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, _ = grpcClient.DestroySandbox(dctx, &pb.DestroySandboxRequest{SandboxId: sandboxID})
		dcancel()
		_ = s.store.WipePooled(ctx, sandboxID)
		return fmt.Errorf("pool: worker %s not pool-capable (CreateSandbox returned status=%q, want pooled) — skipping until rolled", workerID, resp.GetStatus())
	}
	// Stamp the authoritative golden the worker reported (fall back to the
	// registry value) so the box is migratable/rebasable later.
	golden := resp.GetGoldenVersion()
	if golden == "" {
		golden = goldenVersion
	}
	_ = s.store.SetSandboxGoldenVersion(ctx, sandboxID, golden)
	log.Printf("pool: manufactured %s (template=%s, golden=%s) on %s", sandboxID, template, golden, workerID)
	return nil
}

// StartPoolReconciler runs the refill loop until ctx is cancelled. isLeader (may
// be nil in single-CP mode) gates each tick so only one control plane refills.
// No-op unless the pool is enabled. Intended to be run in its own goroutine.
func (s *Server) StartPoolReconciler(ctx context.Context, isLeader func() bool) {
	if !s.poolEnabled() {
		log.Printf("pool: reconciler disabled (OPENSANDBOX_POOL_ENABLED=0)")
		return
	}
	if s.poolTarget() <= 0 {
		log.Printf("pool: OPENSANDBOX_POOL_TARGET=0 for this cell — reconciler idle")
		return
	}
	region := s.region
	if region == "" {
		region = "iad"
	}
	template := poolTemplateName()
	log.Printf("pool: reconciler started (region=%s per_worker_target=%d template=%s, leader-gated)", region, s.poolTarget(), template)

	t := time.NewTicker(poolRefillInterval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if isLeader != nil && !isLeader() {
				continue
			}
			if target := s.poolTarget(); target > 0 {
				s.reconcilePool(ctx, region, template, target)
			}
		}
	}
}

// reconcilePool tops up EACH live, non-draining worker in the region to
// perWorkerTarget pooled boxes. Per-worker (not per-region total) so the pool
// spreads evenly by construction and scales with the fleet: a 4-worker region at
// target 25 warms ~100, and adding/removing a worker adjusts automatically (a
// drained worker's pool is wiped and never refilled here since it's skipped).
func (s *Server) reconcilePool(ctx context.Context, region, template string, perWorkerTarget int) {
	var wg sync.WaitGroup
	for _, w := range s.workerRegistry.GetAllWorkers() {
		if w.Region != region || w.Draining {
			continue
		}
		// Memory-pressure gate: stop filling the pool on a worker whose host
		// memory is over the ceiling. Real customer load takes priority — the
		// pool is a latency optimization, not something that should push a hot
		// worker into pressure. It resumes refilling once the box gets headroom.
		if w.MemPct > poolMaxMemPct {
			log.Printf("pool: %s at %.0f%% memory (> %.0f%%) — skipping refill", w.ID, w.MemPct, poolMaxMemPct)
			continue
		}
		have, err := s.store.CountPooledOnWorker(ctx, w.ID, template)
		if err != nil {
			log.Printf("pool: count on %s failed: %v", w.ID, err)
			continue
		}
		deficit := perWorkerTarget - have
		if deficit <= 0 {
			continue
		}
		// Cap per worker per tick. Manufactured concurrently (below) so a cranked
		// batch actually recovers a drained pool instead of serializing golden
		// restores; the cap bounds the simultaneous-restore burst per worker.
		batch := deficit
		if max := poolRefillBatch(); batch > max {
			batch = max
		}
		w := w
		wg.Add(1)
		go func() {
			defer wg.Done()
			var mwg sync.WaitGroup
			var made int64
			for i := 0; i < batch; i++ {
				mwg.Add(1)
				go func() {
					defer mwg.Done()
					if err := s.manufacturePoolBoxOn(ctx, w.ID, region, template, w.GoldenVersion); err != nil {
						log.Printf("pool: manufacture on %s failed: %v", w.ID, err)
						return
					}
					atomic.AddInt64(&made, 1)
				}()
			}
			mwg.Wait()
			if made > 0 {
				log.Printf("pool: %s refilled %d (had %d, per-worker target %d)", w.ID, made, have, perWorkerTarget)
			}
		}()
	}
	wg.Wait()
}

// WipeWorkerPool destroys all pooled boxes parked on a worker — called when the
// worker is marked draining. Pool boxes are disposable (generic, no customer
// data), so they are wiped rather than migrated/hibernated; this also prevents
// them from blocking the worker's termination during a rolling replace. The
// refill reconciler self-heals the count onto healthy workers.
func (s *Server) WipeWorkerPool(ctx context.Context, workerID string) {
	if s.store == nil {
		return
	}
	ids, err := s.store.ListPooledOnWorker(ctx, workerID)
	if err != nil {
		log.Printf("pool: list pooled on %s failed: %v", workerID, err)
		return
	}
	if len(ids) == 0 {
		return
	}
	client, cerr := s.workerRegistry.GetWorkerClient(workerID)
	for _, id := range ids {
		if cerr == nil {
			dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			_, _ = client.DestroySandbox(dctx, &pb.DestroySandboxRequest{SandboxId: id})
			cancel()
		}
		_ = s.store.WipePooled(ctx, id) // mark stopped regardless — the box is disposable
	}
	log.Printf("pool: wiped %d pooled box(es) off draining worker %s", len(ids), workerID)
}
