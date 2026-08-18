package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// backend_hibernation.go — hibernate and wake for backends that hold their own
// sandboxes.
//
// The QEMU fleet reaches these operations by gRPC to one specific worker, and
// which worker is load-bearing: a wake prefers the machine that hibernated the
// sandbox because the qcow2 files are still on its disk, and refuses to move
// while the archive upload is unfinished. That logic stays in
// hibernateSandboxRemote / wakeSandboxRemote, untouched by any of this.
//
// A managed backend has no such hop — the control plane holds the manager, so
// the operation is a local call. Before this those handlers had no way to say
// so: both branch on `s.workerRegistry != nil`, and a backend-served cell HAS a
// registry (it still answers worker_id lookups) with no workers in it. So every
// hibernate and wake on such a cell dispatched into an empty fleet and failed
// with "no workers available", which is why the MicroVM tiered hibernation was
// reachable from cmd/microvm-harness and from nothing else.
//
// What is deliberately NOT shared with the QEMU path: the row-side bookkeeping
// below is written out again rather than factored into a helper both call. The
// two differ in ways that matter — which worker_id gets persisted, whether a
// checkpoint-patch pass applies — and a single function with two modes would
// hide exactly the differences worth seeing.

// hibernatorForSandbox resolves the backend that can park or revive a sandbox,
// along with its session row, which the caller needs either way.
//
// Returns false when no registered backend owns the sandbox, which is the
// common case: the QEMU fleet does not implement Hibernator, so its sandboxes
// fall through to the worker-registry paths unchanged.
func (s *Server) hibernatorForSandbox(ctx context.Context, sandboxID string) (Hibernator, *db.SandboxSession, bool) {
	if s == nil || s.store == nil {
		return nil, nil, false
	}
	session, err := s.store.GetSandboxSession(ctx, sandboxID)
	if err != nil || session == nil {
		// No row means nothing to resolve ownership from. Fall through rather
		// than guess — the registry paths have their own not-found answers.
		return nil, nil, false
	}
	h, ok := s.hibernatorFor(session.WorkerID)
	if !ok {
		return nil, nil, false
	}
	return h, session, true
}

// hibernateViaBackend parks a sandbox on a backend that holds it.
func (s *Server) hibernateViaBackend(c echo.Context, sandboxID string, h Hibernator, session *db.SandboxSession) error {
	ctx := c.Request().Context()

	result, err := h.Hibernate(ctx, sandboxID)
	if err != nil {
		log.Printf("api: hibernate %s via %s: %v", sandboxID, h.Name(), err)
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to hibernate the sandbox",
		})
	}

	// Record the archive before flipping status. A row marked hibernated with
	// no hibernation record is unwakeable — GetActiveHibernation finds nothing
	// — so the order here is what makes the sandbox recoverable.
	orgID, hasOrg := auth.GetOrgID(c)
	if s.store != nil && hasOrg {
		cfg := json.RawMessage("{}")
		template, region := "base", s.region
		if session != nil {
			cfg = session.Config
			template = session.Template
			region = session.Region
		}
		if _, superseded, cErr := s.store.CreateHibernation(ctx, sandboxID, orgID,
			result.HibernationKey, result.SizeBytes, region, template, cfg); cErr != nil {
			log.Printf("api: hibernate %s: record hibernation: %v", sandboxID, cErr)
		} else {
			s.deleteSupersededHibernation(superseded)
		}
		_ = s.store.UpdateSandboxSessionStatus(ctx, sandboxID, "hibernated", nil)
	}

	if s.router != nil {
		s.router.MarkHibernated(sandboxID, 600*time.Second)
	}
	if s.sandboxDBs != nil {
		_ = s.sandboxDBs.Remove(sandboxID)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"sandboxID":      sandboxID,
		"status":         "hibernated",
		"hibernationKey": result.HibernationKey,
		"sizeBytes":      result.SizeBytes,
	})
}

// wakeViaBackend revives a sandbox on a backend that holds it.
func (s *Server) wakeViaBackend(c echo.Context, sandboxID string, h Hibernator, session *db.SandboxSession, req types.WakeRequest) error {
	ctx := c.Request().Context()

	// Already running: a wake is idempotent from the customer's side, and
	// re-entering the restore path for a live sandbox would rebuild it from an
	// archive that is older than the sandbox itself.
	if session != nil && session.Status == "running" {
		return c.JSON(http.StatusOK, map[string]interface{}{
			"sandboxID": sandboxID, "status": "running",
		})
	}

	hibernation, err := s.store.GetActiveHibernation(ctx, sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "no active hibernation found"})
	}

	workerID, err := h.Wake(ctx, sandboxID, hibernation.HibernationKey, req.Timeout)
	if err != nil {
		log.Printf("api: wake %s via %s: %v", sandboxID, h.Name(), err)
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to wake the sandbox",
		})
	}

	// Persist the host that is actually serving it now. A restore lands on a
	// NEW host, so writing the old worker_id here would leave a live sandbox
	// that routing, ownership checks, and the reaper all look for in the wrong
	// place. This is also what flips the row back to running.
	if err := s.store.UpdateSandboxSessionForWake(ctx, sandboxID, workerID); err != nil {
		log.Printf("api: wake %s: update session to %s: %v", sandboxID, workerID, err)
	}
	_ = s.store.MarkHibernationRestored(ctx, sandboxID)

	if s.router != nil {
		timeout := req.Timeout
		if timeout < 0 {
			timeout = 0
		}
		s.router.Register(sandboxID, time.Duration(timeout)*time.Second)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"sandboxID": sandboxID,
		"status":    "running",
	})
}
