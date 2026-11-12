package main

import (
	"testing"
	"time"
)

// A bind pre-dials one TLS connection; the first request uses
// it instead of dialing.
func TestPreDialOnBind(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{warm: 2})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	u := h.srv.profiles.get(mainProfile).up
	deadline := time.Now().Add(2 * time.Second)
	for u.warmCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if u.warmCount() != 1 || u.dials.Load() != 1 {
		t.Fatalf("warm %d dials %d", u.warmCount(), u.dials.Load())
	}
	if res := do(t, h, testUnit); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if u.warmHits.Load() != 1 || u.dials.Load() != 1 {
		t.Fatalf("warm hits %d dials %d", u.warmHits.Load(), u.dials.Load())
	}
	// The pool event carries the gauges and the counters since the last one.
	e := mainPool(h)
	if e.Name != "model.pool" || e.Data["warm_hits"] != int64(1) || e.Data["dials"] != int64(1) || e.Data["warm_failed"] != int64(0) ||
		e.Data["bindings"] != 1 || e.Data["open_conns"].(int64) < 1 {
		t.Fatalf("pool event %+v", e.Data)
	}
	if e := mainPool(h); e.Data["dials"] != int64(0) {
		t.Fatalf("counters not reset: %+v", e.Data)
	}
}

// A pre-dial that fails is counted for the pool event.
func TestPreDialFailureCounted(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{warm: 1})
	h.upstream.Close()
	u := h.srv.profiles.get(mainProfile).up
	u.prewarm()
	deadline := time.Now().Add(2 * time.Second)
	for u.warmFailed.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if e := mainPool(h); e.Data["warm_failed"] != int64(1) {
		t.Fatalf("pool event %+v", e.Data)
	}
}

// A parked connection the server closed is detected and never handed out.
func TestPreDialedConnClosedByServer(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{warm: 1})
	u := h.srv.profiles.get(mainProfile).up
	u.prewarm()
	deadline := time.Now().Add(2 * time.Second)
	for u.warmCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	h.upstream.CloseClientConnections()
	time.Sleep(100 * time.Millisecond)
	if tc := u.takeWarm(); tc != nil {
		t.Fatal("dead connection handed out")
	}
}

// mainPool is the main profile's pool event, as the first profile's.
func mainPool(h *harness) eventMsg {
	e, _ := h.srv.poolEvent(h.srv.profiles.get(mainProfile), true)
	return e
}

// Each profile reports its own pool; an idle one that is not the first has
// nothing to say, and only the first carries the proxy-wide gauges.
func TestPoolEventPerProfile(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	if res := do(t, h, testUnit); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if _, ok := h.srv.poolEvent(h.srv.profiles.get(altProfile), false); ok {
		t.Fatal("an idle profile reported its pool")
	}
	e, ok := h.srv.poolEvent(h.srv.profiles.get(mainProfile), false)
	if !ok || e.Provider != mainProfile || e.Data["dials"] != int64(1) || e.Data["bindings"] != nil {
		t.Fatalf("pool event %+v", e)
	}
	if e, ok := h.srv.poolEvent(h.srv.profiles.get(altProfile), true); !ok || e.Data["bindings"] != 1 {
		t.Fatalf("first profile's event %+v", e)
	}
}
