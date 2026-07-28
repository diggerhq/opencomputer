package api

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// adminSetWorkerDraining toggles the in-memory `Draining` flag on a worker so
// the placement filter (RedisWorkerRegistry.GetLeastLoadedWorker and
// findScaleMigrationTargets) stops routing new sandboxes to it. Existing
// sandboxes on the worker are unaffected.
//
// POST /admin/workers/:id/drain          — mark draining (default)
// POST /admin/workers/:id/drain?drain=false — clear draining
//
// The flag is per-controlplane-instance memory: call this on every active
// control plane to drain consistently across replicas. Heartbeats do not
// overwrite the flag.
func (s *Server) adminSetWorkerDraining(c echo.Context) error {
	if s.workerRegistry == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "worker registry not configured (combined/worker mode)",
		})
	}

	workerID := c.Param("id")
	if workerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "worker id required"})
	}

	drain := c.QueryParam("drain") != "false"

	known := false
	for _, w := range s.workerRegistry.GetAllWorkers() {
		if w.ID == workerID {
			known = true
			break
		}
	}
	if !known {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "worker not registered"})
	}

	s.workerRegistry.SetDraining(workerID, drain)

	// Wipe pooled boxes off a draining worker — they're disposable (generic, no
	// customer data), so destroy rather than migrate/hibernate, and get them off
	// before the roll tries to terminate the worker. Async; best-effort.
	if drain {
		go s.WipeWorkerPool(context.Background(), workerID)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"workerID": workerID,
		"draining": drain,
	})
}

// adminForceHibernate force-deep-hibernates a specific sandbox, bypassing the
// customer-hibernate no-op guard. The manual lever for a box wedging a drain
// (un-migratable: no golden, split→merged base skew, ghost). It goes to S3 and
// wakes later (convert-on-fork rebases any base skew).
//
// POST /admin/sandboxes/:id/hibernate
func (s *Server) adminForceHibernate(c echo.Context) error {
	if s.workerRegistry == nil || s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "not available in this mode"})
	}
	sandboxID := c.Param("id")
	if sandboxID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "sandbox id required"})
	}
	ctx := c.Request().Context()
	session, err := s.store.GetSandboxSession(ctx, sandboxID)
	if err != nil || session == nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}
	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "worker unreachable: " + err.Error()})
	}
	hctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	if _, err := client.HibernateSandbox(hctx, &pb.HibernateSandboxRequest{SandboxId: sandboxID}); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "hibernate failed: " + err.Error()})
	}
	_ = s.store.UpdateSandboxSessionStatus(context.Background(), sandboxID, "hibernated", nil)
	return c.JSON(http.StatusOK, map[string]any{"sandboxID": sandboxID, "status": "hibernated", "worker": session.WorkerID})
}

// adminEvictWorker force-drains a worker: mark draining, wipe pooled boxes, and
// deep-hibernate every remaining running/paused box to S3 — the nuclear lever to
// empty a wedged worker so the roll can terminate it. Async; watch the logs.
//
// POST /admin/workers/:id/evict
func (s *Server) adminEvictWorker(c echo.Context) error {
	if s.workerRegistry == nil || s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "not available in this mode"})
	}
	workerID := c.Param("id")
	client, err := s.workerRegistry.GetWorkerClient(workerID)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "worker unreachable: " + err.Error()})
	}
	s.workerRegistry.SetDraining(workerID, true)
	go func() {
		bg := context.Background()
		s.WipeWorkerPool(bg, workerID)
		list, err := client.ListSandboxes(bg, &pb.ListSandboxesRequest{})
		if err != nil {
			log.Printf("admin evict %s: ListSandboxes failed: %v", workerID, err)
			return
		}
		n := 0
		for _, sb := range list.Sandboxes {
			if sb.Status != "running" && sb.Status != "paused" {
				continue
			}
			hctx, cancel := context.WithTimeout(bg, 120*time.Second)
			if _, herr := client.HibernateSandbox(hctx, &pb.HibernateSandboxRequest{SandboxId: sb.SandboxId}); herr != nil {
				log.Printf("admin evict %s: hibernate %s failed: %v", workerID, sb.SandboxId, herr)
			} else {
				_ = s.store.UpdateSandboxSessionStatus(bg, sb.SandboxId, "hibernated", nil)
				n++
			}
			cancel()
		}
		log.Printf("admin evict %s: deep-hibernated %d box(es)", workerID, n)
	}()
	return c.JSON(http.StatusAccepted, map[string]any{"workerID": workerID, "status": "eviction started (draining + wipe pool + hibernate-all)"})
}
