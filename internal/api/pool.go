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

func poolTargetN() int {
	if v := os.Getenv("OPENSANDBOX_POOL_TARGET"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return 5
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
func (s *Server) manufacturePoolBox(ctx context.Context, region, template string) error {
	worker, grpcClient, err := s.workerRegistry.GetLeastLoadedWorker(region)
	if err != nil {
		return fmt.Errorf("pool: no worker in %s: %w", region, err)
	}
	sandboxID := "sb-" + uuid.New().String()[:8]
	if err := s.store.CreatePooledSession(ctx, sandboxID, template, region, worker.ID, json.RawMessage(`{}`)); err != nil {
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
		return fmt.Errorf("pool: manufacture %s on %s: %w", sandboxID, worker.ID, err)
	}
	if worker.GoldenVersion != "" {
		_ = s.store.SetSandboxGoldenVersion(ctx, sandboxID, worker.GoldenVersion)
	}
	log.Printf("pool: manufactured %s (template=%s) on %s", sandboxID, template, worker.ID)
	return nil
}

// StartPoolReconciler runs the refill loop until ctx is cancelled. isLeader (may
// be nil in single-CP mode) gates each tick so only one control plane refills.
// No-op unless the pool is enabled. Intended to be run in its own goroutine.
func (s *Server) StartPoolReconciler(ctx context.Context, isLeader func() bool) {
	if !s.poolEnabled() {
		log.Printf("pool: reconciler disabled (OPENSANDBOX_POOL_ENABLED != 1)")
		return
	}
	region := s.region
	if region == "" {
		region = "iad"
	}
	template := poolTemplateName()
	target := poolTargetN()
	log.Printf("pool: reconciler started (region=%s template=%s target=%d, leader-gated)", region, template, target)

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
			s.reconcilePool(ctx, region, template, target)
		}
	}
}

func (s *Server) reconcilePool(ctx context.Context, region, template string, target int) {
	have, err := s.store.CountPooled(ctx, region, template)
	if err != nil {
		log.Printf("pool: count failed: %v", err)
		return
	}
	deficit := target - have
	if deficit <= 0 {
		return
	}
	// Manufacture at most a small batch per tick so a cold start doesn't burst
	// the whole fleet at once. Stop on the first failure (no capacity / worker
	// error) and retry next tick.
	batch := deficit
	if batch > 3 {
		batch = 3
	}
	made := 0
	for i := 0; i < batch; i++ {
		if err := s.manufacturePoolBox(ctx, region, template); err != nil {
			log.Printf("pool: manufacture failed (%d/%d this tick): %v", made, batch, err)
			break
		}
		made++
	}
	if made > 0 {
		log.Printf("pool: refilled %d (had %d, target %d)", made, have, target)
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
