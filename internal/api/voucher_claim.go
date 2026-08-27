package api

// The control-plane half of zero-subrequest edge claim.
//
// The edge pulls a book of vouchers per colo, OFF the create hot path, and then
// answers creates out of that book without calling anyone. This endpoint is what
// it pulls from. Everything about it is shaped by the fact that it is never on a
// customer's critical path: it can be slow, it can return fewer than asked, and
// it can be called by only one request in a colo per refresh window.
//
// See internal/awsvmlite/voucher.go for the warm/vouchered/bound state machine
// and cmd/microvm-hooks/claim.go for where ownership is actually decided.

import (
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/awsvmlite"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// maxVoucherBatch caps one pull.
//
// Sized against the burst it has to absorb, not against the pool: the edge wants
// enough vouchers that concurrent draws from one colo's book rarely collide
// (N >= 4x burst keeps collisions to a few percent), and a collision only costs
// a retry. The manager clamps this again to what stock actually allows, minus
// the reserve it keeps for the control-plane path.
const maxVoucherBatch = 512

// voucherPublisher is a backend that can promise boxes to a colo ahead of any
// customer asking. Only the direct-exec (lite) backend implements it today —
// the pool-backed MicroVM backend serves the older PoolStock path instead.
type voucherPublisher interface {
	Vouchers(colo string, n int) []awsvmlite.Voucher
}

var _ voucherPublisher = (*liteBackend)(nil)

func (s *Server) voucherBackend() (voucherPublisher, bool) {
	b, ok := s.claimBackend(placement{runtime: runtimeMicrovm})
	if !ok {
		return nil, false
	}
	vp, ok := b.(voucherPublisher)
	return vp, ok
}

type voucherResponse struct {
	Vouchers []awsvmlite.Voucher `json:"vouchers"`
	// Stock is what remains unpromised after this pull, so the edge can widen or
	// narrow its next request instead of guessing.
	Stock int `json:"stock"`
}

// publishVouchers handles GET /internal/pool/vouchers?colo=&n=.
//
// Fewer than n — including zero — is a normal answer, not an error. The edge
// serves whatever it got and falls back to the control-plane create path when
// its book runs dry, which is exactly the path this mechanism exists to skip but
// which stays correct on its own.
func (s *Server) publishVouchers(c echo.Context) error {
	vp, ok := s.voucherBackend()
	if !ok {
		// This cell does not run the direct-exec backend. Not an error — the
		// edge asks every cell it routes to and expects some to say no.
		return c.JSON(http.StatusOK, voucherResponse{Vouchers: []awsvmlite.Voucher{}})
	}
	colo := c.QueryParam("colo")
	if colo == "" {
		colo = "unknown"
	}
	n, _ := strconv.Atoi(c.QueryParam("n"))
	if n <= 0 {
		n = 64
	}
	if n > maxVoucherBatch {
		n = maxVoucherBatch
	}
	out := vp.Vouchers(colo, n)
	if out == nil {
		out = []awsvmlite.Voucher{}
	}
	return c.JSON(http.StatusOK, voucherResponse{Vouchers: out, Stock: s.voucherStock()})
}

// There is deliberately no edge-initiated release endpoint. The edge cannot
// assert that a voucher was never handed to a customer — under a shared book,
// the box behind a losing claim is live under someone else's sandbox — so
// reclaiming is the cell's job, and it verifies with the box first. See
// awsvmlite.ReconcileVouchers.

// voucherStock reports unpromised stock, or -1 when this cell has no lite
// backend to ask.
func (s *Server) voucherStock() int {
	b, ok := s.claimBackend(placement{runtime: runtimeMicrovm})
	if !ok {
		return -1
	}
	lb, ok := b.(*liteBackend)
	if !ok || lb == nil || lb.mgr == nil {
		return -1
	}
	return lb.mgr.Depth()
}

// voucherRedeemer is the backend half of a voucher finalize: the thing that can
// turn (box, sandbox) into a binding. Separate from edgeClaimer because the
// voucher path has no reservation — the box was promised, not reserved.
type voucherRedeemer interface {
	RedeemVoucher(microvmID, sandboxID string, cfg types.SandboxConfig) (workerID string, rebound bool, err error)
}

func (s *Server) voucherRedeemer() (voucherRedeemer, bool) {
	b, ok := s.claimBackend(placement{runtime: runtimeMicrovm})
	if !ok {
		return nil, false
	}
	vr, ok := b.(voucherRedeemer)
	return vr, ok
}

// cachePeerPublisher is a backend that runs an in-region voucher cache.
type cachePeerPublisher interface {
	CachePeers() []awsvmlite.CachePeer
}

// publishCachePeers handles GET /internal/pool/cache-peers.
//
// The edge's COLD path only. In steady state it learns the instance set from
// the peer list echoed on every pop, so rotation never costs a create anything;
// this exists for an isolate that has never popped and has nothing cached, and
// for the case where every known instance has gone away at once.
//
// An empty list is a normal answer — a cell with no cache configured, or one
// whose first instance is still filling. The edge treats it as "no fast path
// available" and takes the control-plane create.
func (s *Server) publishCachePeers(c echo.Context) error {
	b, ok := s.claimBackend(placement{runtime: runtimeMicrovm})
	if !ok {
		return c.JSON(http.StatusOK, map[string]any{"peers": []awsvmlite.CachePeer{}})
	}
	cp, ok := b.(cachePeerPublisher)
	if !ok {
		return c.JSON(http.StatusOK, map[string]any{"peers": []awsvmlite.CachePeer{}})
	}
	peers := cp.CachePeers()
	if peers == nil {
		peers = []awsvmlite.CachePeer{}
	}
	return c.JSON(http.StatusOK, map[string]any{"peers": peers})
}
