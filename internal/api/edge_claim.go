package api

import (
	"context"
	"encoding/json"
	"errors"
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

// THE FINALIZE RACE
//
// The edge answers a create from stock and returns the 201 before this process
// has heard of the sandbox: the claim is finalized afterwards, off the create
// path and (on the queue-backed edge) off the create's isolate entirely. So the
// customer holds a usable sandbox id for a window in which GetSandboxSession
// still misses, and their first exec — which the SDK fires immediately — used
// to come back "sandbox <id> not found". Measured on dev: 3 of 8 creates in a
// back-to-back create→exec run.
//
// A 404 is the wrong answer to "the row is a few hundred milliseconds behind",
// and worse than wrong for a benchmark, where a fast failure reads as a fast
// exec. So a reservation registers a pending claim here, and any sub-op that
// arrives during the window waits for the finalize instead of being told the
// box does not exist. It is not a retry loop and it is not a sleep: the waiter
// is released the moment claim-finalize completes.
//
// It is deliberately bounded on both ends. edgePendingWait caps how long any
// one caller waits, after which the normal lookup runs and answers 404 exactly
// as before — a broken finalize must not turn into a hung request. And a
// pending entry is dropped on finalize, on release, and by the stale-reservation
// reaper, so an id that never becomes a sandbox cannot accumulate.
const edgePendingWait = 5 * time.Second

// edgePending is one reserved-but-not-yet-finalized sandbox id.
type edgePending struct {
	done chan struct{} // closed when the claim resolves, either way
	err  error         // set before closing done; non-nil = the claim failed
}

// registerEdgePending records that sandboxID has been reserved for the edge and
// that a claim-finalize for it may arrive. Idempotent: a re-reserve of the same
// id keeps the existing waiter rather than orphaning it.
func (s *Server) registerEdgePending(sandboxID string) {
	s.pendingEdgeClaims.LoadOrStore(sandboxID, &edgePending{done: make(chan struct{})})
}

// resolveEdgePending releases anyone waiting on sandboxID and forgets it. Called
// on every terminal outcome for a reservation — finalized, released back to the
// pool, or reaped — so the map tracks only claims that are genuinely in flight.
//
// Forgetting it means err reaches only callers ALREADY parked. Someone arriving
// afterwards gets the ordinary lookup, which by then is authoritative: the row
// exists if the claim worked, and 404s if it didn't. Keeping failures around as
// tombstones would buy a better message at the cost of a second thing to expire.
func (s *Server) resolveEdgePending(sandboxID string, err error) {
	val, ok := s.pendingEdgeClaims.LoadAndDelete(sandboxID)
	if !ok {
		return
	}
	p := val.(*edgePending)
	p.err = err
	close(p.done)
}

// waitEdgeFinalize blocks until sandboxID's claim-finalize resolves, or gives up
// and lets the caller take the normal (404) path. Returns nil for an id that was
// never an edge reservation, so it is safe to call for every lookup miss.
func (s *Server) waitEdgeFinalize(ctx context.Context, sandboxID string) error {
	val, ok := s.pendingEdgeClaims.Load(sandboxID)
	if !ok {
		return nil
	}
	p := val.(*edgePending)
	timer := time.NewTimer(edgePendingWait)
	defer timer.Stop()
	select {
	case <-p.done:
		// A failed finalize is reported rather than swallowed: the box never
		// bound, and a clean error beats a phantom the customer keeps poking.
		return p.err
	case <-timer.C:
		log.Printf("sandbox: edge claim %s still unfinalized after %s — proceeding without it", sandboxID, edgePendingWait)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

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
		s.registerEdgePending(b.SandboxID)
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
	// Released stock was never handed to a customer, so nobody can be waiting on
	// it — but the pending entry must go either way or the id lingers in the map
	// until the reaper notices.
	for _, id := range req.SandboxIDs {
		s.resolveEdgePending(id, nil)
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
	// Release anyone whose sub-op is parked waiting for this claim, whatever the
	// outcome — a finalize that fails has to wake them with the failure rather
	// than leave them waiting out edgePendingWait for a box that never bound.
	// Defaults to an error so an unexpected return path still reports one.
	finalizeErr := errors.New("claim-finalize did not complete")
	defer func() { s.resolveEdgePending(cfg.SandboxID, finalizeErr) }()
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
		finalizeErr = err
		_ = s.store.WipePooled(ctx, cfg.SandboxID)
		return c.JSON(http.StatusConflict, map[string]string{"error": "reservation lost"})
	}

	client, err := s.workerRegistry.GetWorkerClient(box.WorkerID)
	if err != nil {
		msg := "pool worker unreachable at claim-finalize"
		finalizeErr = errors.New(msg)
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
		finalizeErr = err
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
	finalizeErr = nil
	out := map[string]string{
		"sandboxID": box.SandboxID,
		"workerID":  box.WorkerID,
		"status":    "running",
	}
	// An edge-claimed box was launched before this request, so its deadline is
	// measured from ITS launch and not from now. Asking the backend keeps that
	// distinction; computing it here would restart the clock and hand every
	// claimed box a deadline later than the one its provider will enforce.
	if b, ok := s.backendForWorkerID(box.WorkerID); ok {
		if d, ok := b.(interface {
			DeadlineFor(string) time.Time
		}); ok {
			if at := d.DeadlineFor(box.SandboxID); !at.IsZero() {
				out["endAt"] = at.UTC().Format(time.RFC3339)
			}
		}
	}
	return c.JSON(http.StatusOK, out)
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
		// The box is gone, so a waiter must be told rather than left to time
		// out — and the pending entry must not outlive the reservation.
		s.resolveEdgePending(b.SandboxID, errors.New("edge reservation expired before it was claimed"))
	}
	if len(boxes) > 0 {
		log.Printf("pool: reaped %d stale edge reservation(s)", len(boxes))
	}
}
