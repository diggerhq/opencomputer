package main

// Ownership of a box is decided HERE, in the guest, and nowhere else.
//
// This is the load-bearing idea behind edge claim. The edge hands out
// "vouchers" — hints that a box is probably free — from a cache it shares with
// every other isolate in its colo. Caches go stale, get evicted, and are read
// concurrently by isolates that cannot see each other, so two creates CAN and
// WILL name the same box. That is not a bug to be engineered away with
// cross-request coordination; the two previous edge-claim attempts both died
// trying (a Durable Object pop put a subrequest on the hot path, which is the
// single largest term in a burst create; a per-isolate hint map fragmented
// across cold isolates and fell back 64 times in 100).
//
// Instead the invariant is: a voucher confers NOTHING. It is a guess. The box
// itself is the only authority, it answers exactly one question — "am I yours?"
// — and it answers it under a mutex. A duplicate costs the loser one retry
// against the next voucher. Staleness, eviction, and duplication all degrade to
// a retry rather than to a double-owned box.
//
// Two properties this must have, both exercised by the tests:
//
//   - IDEMPOTENT by sandbox ID. The edge retries; a retry that reaches a box
//     already bound to the SAME sandbox must succeed, not 409. Otherwise a
//     dropped response turns a healthy claim into a permanent failure.
//   - ATOMIC. The compare and the set happen under one lock, so two concurrent
//     claims for different sandboxes cannot both observe "free".

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// claimPath binds this box to a sandbox ID. Must match internal/awsvmlite.
	claimPath = "/osb/claim"

	// claimAndRunPath binds and then executes in ONE round trip.
	//
	// Fusing them is the whole point of doing the claim on the exec leg: the
	// first exec has to reach the box anyway, so the claim rides along for free
	// instead of costing a second transit. A create then owes the network
	// nothing at all.
	claimAndRunPath = "/osb/claim-and-run"
)

// boxClaim is process-global because the claim is a property of the BOX, not of
// any one request or connection. It lives and dies with the MicroVM.
var boxClaim = &claimState{}

type claimState struct {
	mu        sync.Mutex
	sandboxID string
	at        time.Time
}

// claim binds this box to sandboxID.
//
// owned reports whether the caller may use the box. fresh distinguishes the
// call that did the binding from an idempotent replay — the host uses it to
// count real claims without double-counting retries.
func (c *claimState) claim(sandboxID string) (owned, fresh bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case c.sandboxID == "":
		c.sandboxID, c.at = sandboxID, time.Now()
		return true, true
	case c.sandboxID == sandboxID:
		// Replay. The first claim already succeeded and its response was lost,
		// or the edge fused a claim onto a second exec. Either way the answer
		// is the same one we gave before.
		return true, false
	default:
		return false, false
	}
}

// current reports the binding, for /healthz and host-side reconciliation.
func (c *claimState) current() (string, time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sandboxID, c.at
}

type claimRequest struct {
	SandboxID string `json:"sandboxID"`
}

type claimResult struct {
	SandboxID string `json:"sandboxID"`
	Fresh     bool   `json:"fresh"`
	// OwnedBy is set only on a 409, so the caller can tell "someone else took
	// it" from "the box is sick" without a second request. Only our own edge
	// can reach this port (Lambda's proxy requires the box auth token), so this
	// is not customer-visible.
	OwnedBy string `json:"ownedBy,omitempty"`
}

// claimAndRunRequest is a claim plus the run it is fused to. runCmdRequest is
// embedded so the wire shape of the run half stays byte-identical to /osb/run —
// one command shape, not two that can drift.
type claimAndRunRequest struct {
	SandboxID string `json:"sandboxID"`
	runCmdRequest
}

type claimAndRunResponse struct {
	Claim claimResult     `json:"claim"`
	Run   *runCmdResponse `json:"run,omitempty"`
}

func decodeClaimBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(dst); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) handleClaim(w http.ResponseWriter, r *http.Request) {
	var req claimRequest
	if !decodeClaimBody(w, r, &req) {
		return
	}
	id := strings.TrimSpace(req.SandboxID)
	if id == "" {
		http.Error(w, "sandboxID is required", http.StatusBadRequest)
		return
	}
	owned, fresh := boxClaim.claim(id)
	if !owned {
		owner, _ := boxClaim.current()
		// 409 is the signal the edge retries on. It is an ordinary, expected
		// outcome of an optimistic claim — not an error worth logging loudly.
		writeJSON(w, http.StatusConflict, claimResult{SandboxID: id, OwnedBy: owner})
		return
	}
	writeJSON(w, http.StatusOK, claimResult{SandboxID: id, Fresh: fresh})
}

func (s *server) handleClaimAndRun(w http.ResponseWriter, r *http.Request) {
	var req claimAndRunRequest
	if !decodeClaimBody(w, r, &req) {
		return
	}
	id := strings.TrimSpace(req.SandboxID)
	if id == "" {
		http.Error(w, "sandboxID is required", http.StatusBadRequest)
		return
	}
	owned, fresh := boxClaim.claim(id)
	if !owned {
		owner, _ := boxClaim.current()
		// Claim lost: do NOT run. Running would execute a customer's command on
		// a box owned by someone else, which is the one failure this whole
		// design exists to make impossible.
		writeJSON(w, http.StatusConflict, claimAndRunResponse{
			Claim: claimResult{SandboxID: id, OwnedBy: owner},
		})
		return
	}
	// An empty cmd is a claim-only call that took this path — legal, and cheaper
	// for the caller than a second endpoint.
	if strings.TrimSpace(req.Cmd) == "" {
		writeJSON(w, http.StatusOK, claimAndRunResponse{
			Claim: claimResult{SandboxID: id, Fresh: fresh},
		})
		return
	}
	out, err := runCmd(r.Context(), req.runCmdRequest)
	if err != nil {
		// The claim SUCCEEDED even though the command never started, and the
		// box is now bound. Reporting a bare 500 would tell the edge to retry
		// elsewhere and strand this box, so the claim result goes back with it.
		writeJSON(w, http.StatusOK, claimAndRunResponse{
			Claim: claimResult{SandboxID: id, Fresh: fresh},
			Run: &runCmdResponse{
				Stderr:   "could not start command: " + err.Error(),
				ExitCode: -1,
			},
		})
		return
	}
	writeJSON(w, http.StatusOK, claimAndRunResponse{
		Claim: claimResult{SandboxID: id, Fresh: fresh},
		Run:   &out,
	})
}
