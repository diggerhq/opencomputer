package vouchercache

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/awsvmlite"
)

func newTestServer() *Server {
	return New("")
}

func vouchers(n int) []awsvmlite.Voucher {
	exp := time.Now().Add(time.Hour).Unix()
	out := make([]awsvmlite.Voucher, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, awsvmlite.Voucher{
			MicrovmID:     "mvm-" + strconvItoa(i),
			Endpoint:      "e.example",
			Token:         "t",
			Port:          8080,
			ExpiresAtUnix: exp,
		})
	}
	return out
}

func strconvItoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func fill(t *testing.T, s *Server, req fillRequest) {
	t.Helper()
	body, _ := json.Marshal(req)
	rec := httptest.NewRecorder()
	s.handleFill(rec, httptest.NewRequest(http.MethodPost, "/fill", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("fill: %d %s", rec.Code, rec.Body.String())
	}
}

func pop(s *Server) (*awsvmlite.Voucher, int) {
	rec := httptest.NewRecorder()
	s.handlePop(rec, httptest.NewRequest(http.MethodPost, "/pop", nil))
	if rec.Code != http.StatusOK {
		return nil, rec.Code
	}
	var r popResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &r)
	return r.Voucher, rec.Code
}

// THE property. The colo cache could not give us this: concurrent draws
// collided by birthday, and the free-list claim that patched it cost a probe
// loop on every create. A mutex makes it a decision.
func TestPopNeverHandsTheSameBoxTwice(t *testing.T) {
	s := newTestServer()
	fill(t, s, fillRequest{Vouchers: vouchers(200), Target: 200})

	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, _ := pop(s)
			if v == nil {
				return
			}
			mu.Lock()
			seen[v.MicrovmID]++
			mu.Unlock()
		}()
	}
	wg.Wait()

	if len(seen) != 200 {
		t.Fatalf("got %d distinct boxes from 200 concurrent pops, want 200", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("box %s handed out %d times", id, n)
		}
	}
}

// An empty cache must answer immediately, not restock. A pop that refilled
// would put a control-plane round trip back on a customer's create — the exact
// coupling that made a lost colo book cost 1498ms.
func TestPopOnEmptyIsImmediateAndDoesNotRefill(t *testing.T) {
	s := newTestServer()
	fill(t, s, fillRequest{Vouchers: vouchers(1), Target: 1})
	if v, _ := pop(s); v == nil {
		t.Fatal("first pop should have served the only voucher")
	}
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		s.handlePop(rec, httptest.NewRequest(http.MethodPost, "/pop", nil))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("empty pop: %d, want 204", rec.Code)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fills != 1 {
		t.Fatalf("fills = %d, want 1 — a pop refilled", s.fills)
	}
}

// A fresh instance must not take traffic before it has stock. Answering 204
// during a rotation would strand creates the outgoing instance could still
// have served, which is the gap rotation exists to hide.
func TestNotReadyUntilStocked(t *testing.T) {
	s := newTestServer()
	rec := httptest.NewRecorder()
	s.handlePop(rec, httptest.NewRequest(http.MethodPost, "/pop", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("cold pop: %d, want 503", rec.Code)
	}
	// A first push that only half-covers target is still not ready.
	fill(t, s, fillRequest{Vouchers: vouchers(3), Target: 100})
	s.mu.Lock()
	ready := s.ready
	s.mu.Unlock()
	if ready {
		t.Fatal("ready on 3 of a 100 target — a rotation would open a hole")
	}
	fill(t, s, fillRequest{Vouchers: vouchers(60), Target: 100})
	if v, code := pop(s); v == nil {
		t.Fatalf("pop after adequate fill: code %d", code)
	}
}

// The control plane re-sends its whole warm set every tick. Without dedup the
// same box accumulates and gets handed to several sandboxes — survivable (the
// CAS settles it) but it burns a create's retry ladder for nothing.
func TestFillIsIdempotent(t *testing.T) {
	s := newTestServer()
	for i := 0; i < 5; i++ {
		fill(t, s, fillRequest{Vouchers: vouchers(10), Target: 10})
	}
	s.mu.Lock()
	depth := len(s.stock)
	s.mu.Unlock()
	if depth != 10 {
		t.Fatalf("depth = %d after 5 identical fills, want 10", depth)
	}
}

// A voucher near its reaper deadline is worse than no voucher: the create
// spends its ladder on a box the cell is about to take back.
func TestExpiredStockIsNeverHandedOut(t *testing.T) {
	s := newTestServer()
	good := vouchers(2)
	stale := vouchers(2)
	for i := range stale {
		stale[i].MicrovmID = "stale-" + strconvItoa(i)
		stale[i].ExpiresAtUnix = time.Now().Add(10 * time.Second).Unix()
	}
	fill(t, s, fillRequest{Vouchers: append(append([]awsvmlite.Voucher{}, good...), stale...), Target: 4})

	seen := map[string]bool{}
	for i := 0; i < 4; i++ {
		v, _ := pop(s)
		if v == nil {
			break
		}
		seen[v.MicrovmID] = true
	}
	for id := range seen {
		if len(id) > 5 && id[:5] == "stale" {
			t.Fatalf("handed out %s, which expires inside the guard", id)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("served %d vouchers, want the 2 live ones", len(seen))
	}
}

// Release is for a voucher the edge drew and never used. It must come back —
// otherwise every edge-side failure permanently shrinks the pool.
func TestReleaseReturnsStock(t *testing.T) {
	s := newTestServer()
	fill(t, s, fillRequest{Vouchers: vouchers(2), Target: 2})
	v, _ := pop(s)
	if v == nil {
		t.Fatal("pop failed")
	}
	body, _ := json.Marshal(v)
	rec := httptest.NewRecorder()
	s.handleRelease(rec, httptest.NewRequest(http.MethodPost, "/release", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("release: %d", rec.Code)
	}
	s.mu.Lock()
	depth := len(s.stock)
	s.mu.Unlock()
	if depth != 2 {
		t.Fatalf("depth = %d after release, want 2", depth)
	}
	// ...and releasing the same voucher twice must not duplicate it.
	rec2 := httptest.NewRecorder()
	s.handleRelease(rec2, httptest.NewRequest(http.MethodPost, "/release", bytes.NewReader(body)))
	s.mu.Lock()
	depth = len(s.stock)
	s.mu.Unlock()
	if depth != 2 {
		t.Fatalf("depth = %d after double release, want 2", depth)
	}
}

// Rotation hinges on this: the edge learns the replacement instance from
// ordinary pop traffic, so it is already talking to the new box before the old
// one hits the 8h cap.
func TestPopCarriesThePeerList(t *testing.T) {
	s := newTestServer()
	peers := []Peer{{Endpoint: "a.example", Token: "t1", Port: 8079}, {Endpoint: "b.example", Token: "t2", Port: 8079}}
	fill(t, s, fillRequest{Vouchers: vouchers(4), Target: 4, Peers: peers})

	rec := httptest.NewRecorder()
	s.handlePop(rec, httptest.NewRequest(http.MethodPost, "/pop", nil))
	var r popResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(r.Peers) != 2 || r.Peers[1].Endpoint != "b.example" {
		t.Fatalf("peers = %+v, want both instances", r.Peers)
	}
}

func TestSecretIsEnforced(t *testing.T) {
	s := newTestServer()
	s.secret = "shh"
	rec := httptest.NewRecorder()
	s.handlePop(rec, httptest.NewRequest(http.MethodPost, "/pop", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated pop: %d, want 401", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/pop", nil)
	req.Header.Set("X-osb-cache-auth", "shh")
	rec2 := httptest.NewRecorder()
	s.handlePop(rec2, req)
	if rec2.Code == http.StatusUnauthorized {
		t.Fatal("correct secret was rejected")
	}
}
