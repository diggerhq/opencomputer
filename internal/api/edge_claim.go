package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// Edge claim: the api-edge Worker's PoolStock Durable Object reserves parked
// pool boxes ahead of time (edge-reserve), answers default-shape creates
// entirely at the edge (pop + mint token + 201), then finalizes the claim
// asynchronously here (claim-finalize). The cell never sits on a create's
// critical path for a stocked default-shape request.
//
// Reservation lifecycle and why the states matter:
//   pooled → edge_reserved   edge-reserve (batch, SKIP LOCKED)
//   edge_reserved → pending  claim-finalize (by id; ClaimSandbox rebinds worker)
//   edge_reserved → pooled   edge-release — ONLY for stock the DO discarded
//                            before handing to a customer (never tokened)
//   edge_reserved → destroyed reapStaleEdgeReservations backstop — the CP
//                            can't prove a stale reservation was never tokened,
//                            and a re-issued box with a live foreign token
//                            would be cross-tenant access.

// edgeReserveTTL is the backstop age after which an unclaimed reservation is
// destroyed. Must comfortably exceed the DO's own stock-entry TTL (the DO
// discards + releases entries well before this; the reaper only fires when a
// DO dies without releasing).
const edgeReserveTTL = 15 * time.Minute

// edgeReservePool handles POST /internal/pool/edge-reserve {count} — flips up
// to count pooled boxes to edge_reserved and returns them for the DO's stock.
func (s *Server) edgeReservePool(c echo.Context) error {
	var req struct {
		Count int `json:"count"`
	}
	if err := c.Bind(&req); err != nil || req.Count <= 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "count must be > 0"})
	}
	if req.Count > 50 {
		req.Count = 50
	}
	region := s.region
	if region == "" {
		region = "local"
	}
	boxes, err := s.store.ReservePooledForEdge(c.Request().Context(), region, poolTemplateName(), req.Count)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	out := make([]map[string]string, 0, len(boxes))
	for _, b := range boxes {
		out = append(out, map[string]string{"sandboxID": b.SandboxID, "workerID": b.WorkerID})
	}
	log.Printf("pool: edge-reserved %d box(es) (asked %d)", len(out), req.Count)
	return c.JSON(http.StatusOK, map[string]interface{}{
		"region":        region,
		"sandboxDomain": s.sandboxDomain,
		"boxes":         out,
	})
}

// edgeReleasePool handles POST /internal/pool/edge-release {sandboxIDs} — the
// DO returning stock it discarded without ever handing out (safe to re-pool).
func (s *Server) edgeReleasePool(c echo.Context) error {
	var req struct {
		SandboxIDs []string `json:"sandboxIDs"`
	}
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid body"})
	}
	n, err := s.store.ReleaseEdgeReservations(c.Request().Context(), req.SandboxIDs)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	if n > 0 {
		log.Printf("pool: edge released %d reservation(s) back to pool", n)
	}
	return c.JSON(http.StatusOK, map[string]int{"released": n})
}

// claimFinalize handles POST /internal/sandboxes/claim-finalize — the async
// bookkeeping half of an edge claim. The edge has ALREADY returned the 201
// (token minted, route cache seeded); this binds the box to the customer:
// PG rebind, worker ClaimSandbox (billing suppression off, idle timeout,
// envs), pending→running promote, and the resource grow if the request isn't
// the pre-grown default shape. Mirrors tryClaimPooled minus the HTTP response.
//
// Failure here means the customer holds a token for a box that never bound —
// rare (reservation reaped or worker died in the window). We mark the session
// failed so the box is never re-issued and the customer's first op surfaces a
// clean error instead of a phantom.
func (s *Server) claimFinalize(c echo.Context) error {
	// SandboxConfig.SandboxID is json:"-" (it's an internal pre-assignment
	// field), so carry the id in a wrapper — the outer field shadows the
	// embedded one for JSON binding.
	var req struct {
		types.SandboxConfig
		SandboxID string `json:"sandboxID"`
	}
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if req.SandboxID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "sandboxID required"})
	}
	cfg := req.SandboxConfig
	cfg.SandboxID = req.SandboxID
	// Edge eligibility should have filtered these; enforce anyway so finalize
	// can't silently skip a capability the box was never given.
	if cfg.SecretStore != "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "secret stores are not edge-claimable"})
	}
	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusForbidden, map[string]string{"error": "no org in capability token"})
	}
	ctx := c.Request().Context()

	cfgJSON, _ := json.Marshal(cfgForPersistence(cfg))
	metadataJSON, _ := json.Marshal(cfg.Metadata)
	box, err := s.store.ClaimReservedSession(ctx, cfg.SandboxID, orgID, auth.GetUserID(c), cfgJSON, metadataJSON, nil)
	if err != nil {
		// Reservation lost (reaped/drained). Nothing is bound; make sure the
		// row can never be claimed by anyone else and report the loss.
		log.Printf("sandbox: EDGE CLAIM FINALIZE LOST %s (%v)", cfg.SandboxID, err)
		_ = s.store.WipePooled(ctx, cfg.SandboxID)
		return c.JSON(http.StatusConflict, map[string]string{"error": "reservation lost"})
	}

	client, err := s.workerRegistry.GetWorkerClient(box.WorkerID)
	if err != nil {
		msg := "pool worker unreachable at claim-finalize"
		_ = s.store.UpdateSandboxSessionStatus(ctx, box.SandboxID, "failed", &msg)
		return c.JSON(http.StatusBadGateway, map[string]string{"error": msg})
	}
	grpcCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	claimResp, err := client.ClaimSandbox(grpcCtx, &pb.ClaimSandboxRequest{
		SandboxId:  box.SandboxID,
		Timeout:    int32(cfg.Timeout),
		Envs:       cfg.Envs,
		SecretEnvs: cfg.SecretEnvs,
		MemoryMb:   int32(cfg.MemoryMB),
		CpuCount:   int32(cfg.CpuCount),
	})
	if err != nil {
		log.Printf("sandbox: edge claim-finalize ClaimSandbox %s failed: %v", box.SandboxID, err)
		msg := err.Error()
		_ = s.store.UpdateSandboxSessionStatus(ctx, box.SandboxID, "failed", &msg)
		return c.JSON(http.StatusBadGateway, map[string]string{"error": msg})
	}

	_ = s.store.UpdateSandboxSessionStatus(ctx, box.SandboxID, "running", nil)
	if g := claimResp.GetGoldenVersion(); g != "" {
		_ = s.store.SetSandboxGoldenVersion(ctx, box.SandboxID, g)
	}

	// Grow past the pre-grown default shape if asked (mirrors tryClaimPooled).
	// Boxes are manufactured at the default create shape, so this is a no-op
	// for edge-eligible requests; kept general for safety.
	if cfg.MemoryMB > 0 || cfg.CpuCount > 0 {
		scaleMB := cfg.MemoryMB
		if scaleMB <= 0 {
			scaleMB = 1024
		}
		cpuCount := cfg.CpuCount
		if cpuCount <= 0 {
			cpuCount = scaleMB / 4096
			if cpuCount < 1 {
				cpuCount = 1
			}
		}
		scaleCtx, scaleCancel := context.WithTimeout(ctx, 10*time.Second)
		_, scaleErr := client.SetSandboxLimits(scaleCtx, &pb.SetSandboxLimitsRequest{
			SandboxId:      box.SandboxID,
			MaxMemoryBytes: int64(scaleMB) * 1024 * 1024,
			CpuMaxUsec:     int64(cpuCount) * 100000,
			CpuPeriodUsec:  100000,
		})
		scaleCancel()
		if scaleErr != nil {
			log.Printf("sandbox: edge claim-finalize post-scale %s failed: %v (continuing)", box.SandboxID, scaleErr)
		}
	}

	s.emitEvent("create", box.SandboxID, box.WorkerID, "claimed from warm pool (edge)")
	log.Printf("sandbox: EDGE CLAIM FINALIZED %s (worker=%s)", box.SandboxID, box.WorkerID)
	return c.JSON(http.StatusOK, map[string]string{
		"sandboxID": box.SandboxID,
		"workerID":  box.WorkerID,
		"status":    "running",
	})
}

// reapStaleEdgeReservations destroys edge_reserved boxes older than
// edgeReserveTTL — the backstop for a Durable Object that died without
// releasing its stock. Destroyed, never re-pooled: see the lifecycle note.
func (s *Server) reapStaleEdgeReservations(ctx context.Context) {
	boxes, err := s.store.ListStaleEdgeReservations(ctx, edgeReserveTTL)
	if err != nil {
		log.Printf("pool: list stale edge reservations failed: %v", err)
		return
	}
	for _, b := range boxes {
		if client, cerr := s.workerRegistry.GetWorkerClient(b.WorkerID); cerr == nil {
			dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			_, _ = client.DestroySandbox(dctx, &pb.DestroySandboxRequest{SandboxId: b.SandboxID})
			cancel()
		}
		_ = s.store.WipePooled(ctx, b.SandboxID)
	}
	if len(boxes) > 0 {
		log.Printf("pool: reaped %d stale edge reservation(s)", len(boxes))
	}
}
