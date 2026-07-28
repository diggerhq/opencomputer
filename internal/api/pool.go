package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/google/uuid"

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
	if _, err := grpcClient.CreateSandbox(grpcCtx, &pb.CreateSandboxRequest{
		SandboxId: sandboxID,
		Template:  template,
		Pooled:    true,
	}); err != nil {
		_ = s.store.WipePooled(ctx, sandboxID) // roll back the reserved row
		return fmt.Errorf("pool: manufacture %s on %s: %w", sandboxID, workerID, err)
	}
	if goldenVersion != "" {
		_ = s.store.SetSandboxGoldenVersion(ctx, sandboxID, goldenVersion)
	}
	log.Printf("pool: manufactured %s (template=%s) on %s", sandboxID, template, workerID)
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

	t := time.NewTicker(15 * time.Second)
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
	for _, w := range s.workerRegistry.GetAllWorkers() {
		if w.Region != region || w.Draining {
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
		// Cap per worker per tick so a cold start ramps instead of bursting.
		batch := deficit
		if batch > 3 {
			batch = 3
		}
		made := 0
		for i := 0; i < batch; i++ {
			if err := s.manufacturePoolBoxOn(ctx, w.ID, region, template, w.GoldenVersion); err != nil {
				log.Printf("pool: manufacture on %s failed (%d/%d): %v", w.ID, made, batch, err)
				break
			}
			made++
		}
		if made > 0 {
			log.Printf("pool: %s refilled %d (had %d, per-worker target %d)", w.ID, made, have, perWorkerTarget)
		}
	}
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
