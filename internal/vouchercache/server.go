// Package vouchercache is the in-region voucher store the edge pops from.
//
// It runs INSIDE the guest agent rather than as its own process, and that is
// not a packaging preference — it is forced. The AWS proxy forwards only to the
// port declared in the image's hook config, and the auth token it mints is
// scoped to that single port (see internal/awsvm/agent.go). A second listener
// on a box is unreachable: a standalone build of this answered every request
// with "403 Access to port denied". So the cache is mounted by the process that
// already owns the allowed port.
//
// Why it exists at all: the previous store was Cloudflare's colo Cache API,
// which is not atomic, is per-colo, and — the part that actually hurt — is
// EVICTABLE. A colo that lost its book rebuilt it from the control plane in
// westus2, and burst TTI went from ~300ms to 1498ms. A benchmark arriving cold
// paid that every time. Holding the stock in RAM in us-east-1 removes all
// three properties at once: one mutex makes a pop atomic, one instance serves
// every colo, and a process does not evict.
//
// Two invariants, and everything else follows from them:
//
//  1. A POP NEVER REFILLS. Stock arrives by push from the control plane on a
//     timer, off the hot path. An empty cache answers 204 immediately and the
//     edge falls through to the (slower, correct) control-plane create. No
//     customer request ever waits behind a restock — that coupling is exactly
//     what made the colo book cliff.
//
//  2. THE CACHE IS NEVER AUTHORITATIVE ON OWNERSHIP. A voucher is a hint that a
//     box is probably free; the guest CAS settles it. That is what lets this
//     side hand one out with no durable write, and why losing every voucher in
//     a restart is a throughput event rather than a correctness one.
//
// The control plane pushes rather than this side pulling, so the cell's signing
// secret never has to live on a box.

package vouchercache

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/awsvmlite"
)

// Peer is one instance of this service, as the control plane sees it.
//
// It is echoed back on every pop so the edge relearns the current set on
// ordinary traffic. Rotation depends on this: boxes die at the 8h service cap,
// so the control plane stands a replacement up and adds it here BEFORE retiring
// the incumbent, and the edge follows along without ever asking anyone where to
// go. Only a completely cold edge has to fall back to the control plane.
type Peer struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
	Port     int32  `json:"port"`
	// RetireAtUnix lets the edge prefer an instance that is not about to
	// vanish, rather than discovering it the hard way on a pop.
	RetireAtUnix int64 `json:"retireAtUnix,omitempty"`
}

type fillRequest struct {
	Vouchers []awsvmlite.Voucher `json:"vouchers"`
	Peers    []Peer              `json:"peers,omitempty"`
	// Target is the depth the control plane is aiming for. Reported on health
	// so the filler's own view and this process's view can be compared without
	// correlating two logs.
	Target int `json:"target,omitempty"`
}

type popResponse struct {
	Voucher *awsvmlite.Voucher `json:"voucher"`
	Peers   []Peer             `json:"peers,omitempty"`
	Depth   int                `json:"depth"`
}

type Server struct {
	secret string

	mu    sync.Mutex
	stock []awsvmlite.Voucher
	// held dedups fills. The control plane re-sends its whole warm set on
	// every tick (it is stateless about what we already have), so without this
	// a box would appear several times and be handed to several sandboxes —
	// survivable, since the CAS settles it, but it wastes a create's ladder.
	held     map[string]struct{}
	peers    []Peer
	target   int
	lastFill time.Time
	ready    bool

	pops    int64
	empties int64
	fills   int64
}

// expiryGuard drops a voucher this close to its reaper deadline rather than
// handing out one that will lose its race with ReconcileVouchers.
const expiryGuard = 120 * time.Second

func (s *Server) authed(w http.ResponseWriter, r *http.Request) bool {
	if s.secret == "" || r.Header.Get("X-osb-cache-auth") == s.secret {
		return true
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return false
}

// handleFill replaces what we hold with what the control plane currently
// believes is free.
//
// Additive, not authoritative: a voucher already in stock is left where it is
// (so a fill does not reorder the queue under a concurrent pop), and one the
// control plane has stopped listing is NOT removed — it may be sitting in an
// edge isolate about to be redeemed, and dropping it here would not recall it
// anyway. Expiry is what removes stock, and the reaper on the cell side is what
// makes that safe.
func (s *Server) handleFill(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	var req fillRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	now := time.Now()
	s.mu.Lock()
	added := 0
	for _, v := range req.Vouchers {
		if v.MicrovmID == "" || v.Endpoint == "" {
			continue
		}
		if time.Unix(v.ExpiresAtUnix, 0).Sub(now) <= expiryGuard {
			continue
		}
		if _, dup := s.held[v.MicrovmID]; dup {
			continue
		}
		s.held[v.MicrovmID] = struct{}{}
		s.stock = append(s.stock, v)
		added++
	}
	s.dropExpiredLocked(now)
	if len(req.Peers) > 0 {
		s.peers = req.Peers
	}
	if req.Target > 0 {
		s.target = req.Target
	}
	s.lastFill = now
	s.fills++
	// Readiness is depth-gated, not fill-gated. A fresh instance must not take
	// traffic on an empty or half-filled first push — it would answer 204 to
	// creates that the outgoing instance could have served, which is exactly
	// the gap a rotation is supposed to hide.
	if !s.ready && len(s.stock) > 0 && (s.target == 0 || len(s.stock)*2 >= s.target) {
		s.ready = true
		log.Printf("voucher-cache: READY depth=%d target=%d", len(s.stock), s.target)
	}
	depth := len(s.stock)
	s.mu.Unlock()

	writeJSON(w, map[string]any{"ok": true, "added": added, "depth": depth})
}

// dropExpiredLocked prunes stock that aged out while it sat here. Callers hold
// s.mu.
func (s *Server) dropExpiredLocked(now time.Time) {
	keep := s.stock[:0]
	for _, v := range s.stock {
		if time.Unix(v.ExpiresAtUnix, 0).Sub(now) > expiryGuard {
			keep = append(keep, v)
			continue
		}
		delete(s.held, v.MicrovmID)
	}
	s.stock = keep
}

// handlePop hands out exactly one voucher.
//
// This is the whole point of the service: the mutex makes "which caller gets
// this box" a decision rather than a race. The colo cache could not do that —
// concurrent draws collided by birthday (37 of 100 at a 120-slot book), and the
// free-list claim that fixed it cost a probe loop per create.
//
// It does NOT refill on empty. See the file header.
func (s *Server) handlePop(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	now := time.Now()
	s.mu.Lock()
	if !s.ready {
		s.mu.Unlock()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	s.dropExpiredLocked(now)
	var out *awsvmlite.Voucher
	if len(s.stock) > 0 {
		v := s.stock[0]
		s.stock = s.stock[1:]
		delete(s.held, v.MicrovmID)
		out = &v
		s.pops++
	} else {
		s.empties++
	}
	resp := popResponse{Voucher: out, Peers: s.peers, Depth: len(s.stock)}
	empties, pops := s.empties, s.pops
	s.mu.Unlock()

	if out == nil {
		// Said out loud: an empty cache is a sizing failure, and it is silent
		// from the edge's side (the create just takes the slow path and still
		// succeeds). Without this line the only symptom is a latency
		// regression nobody can attribute.
		if empties%50 == 1 {
			log.Printf("voucher-cache: EMPTY pops=%d empties=%d — stock exhausted, creates falling through", pops, empties)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, resp)
}

// handleRelease takes a voucher back.
//
// Only for a voucher the edge is certain it never handed to a customer — it
// drew one and then failed before the claim. A box that lost a CAS is NOT
// released here: it is live under someone else's sandbox, and re-pooling it
// would hand a running box to a second customer. The edge cannot tell those
// apart, so it only calls this on its own local failures.
func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	var v awsvmlite.Voucher
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil || v.MicrovmID == "" {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	if _, dup := s.held[v.MicrovmID]; !dup && time.Unix(v.ExpiresAtUnix, 0).Sub(time.Now()) > expiryGuard {
		s.held[v.MicrovmID] = struct{}{}
		s.stock = append(s.stock, v)
	}
	depth := len(s.stock)
	s.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "depth": depth})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	age := int64(-1)
	if !s.lastFill.IsZero() {
		age = time.Since(s.lastFill).Milliseconds()
	}
	out := map[string]any{
		"ready":         s.ready,
		"depth":         len(s.stock),
		"target":        s.target,
		"pops":          s.pops,
		"empties":       s.empties,
		"fills":         s.fills,
		"lastFillAgeMs": age,
		"peers":         len(s.peers),
	}
	s.mu.Unlock()
	writeJSON(w, out)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// New builds an empty cache. It serves nothing until the control plane fills
// it — see the readiness gate in handleFill.
func New(secret string) *Server {
	return &Server{secret: secret, held: map[string]struct{}{}}
}

// Mount attaches the cache under prefix on the guest agent's mux.
//
// Sharing the agent's listener is what makes this reachable at all, and it also
// means a cache instance is an ordinary box: no extra binary to install, no
// second port, and the same proxy keepalive already keeps it warm.
func (s *Server) Mount(mux *http.ServeMux, prefix string) {
	mux.HandleFunc(prefix+"fill", s.handleFill)
	mux.HandleFunc(prefix+"pop", s.handlePop)
	mux.HandleFunc(prefix+"release", s.handleRelease)
	mux.HandleFunc(prefix+"stats", s.handleHealth)
}

// Depth reports current stock, for the agent's own logging.
func (s *Server) Depth() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.stock)
}
