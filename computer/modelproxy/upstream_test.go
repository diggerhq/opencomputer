package main

import (
	"context"
	"io"
	"net"
	"net/url"
	"testing"
	"time"
)

// The pool event carries the gauges and the counters since the last one.
func TestPoolEvent(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	for range 2 { // the second reuses the first's connection
		res := do(t, h, testCaller)
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
	e := mainPool(h)
	if e.Name != "model.pool" || e.Profile != mainProfile || e.Data["dials"] != int64(1) || e.Data["idle_pool_miss"] != int64(1) ||
		e.Data["bindings"] != 1 || e.Data["open_conns"] != int64(1) || e.Data["dropped_messages"] == nil {
		t.Fatalf("pool event %+v", e)
	}
	if e := mainPool(h); e.Data["dials"] != int64(0) {
		t.Fatalf("counters not reset: %+v", e.Data)
	}
}

// A TLS handshake the upstream never answers ends at the handshake timeout.
func TestStalledHandshake(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			defer c.Close() // accepted, never answered
		}
	}()
	u := newUpstream(upstreamConfig{url: &url.URL{Scheme: "https", Host: l.Addr().String()}})
	u.handshakeTimeout = 100 * time.Millisecond
	start := time.Now()
	_, err = u.dialTLS(context.Background(), "tcp", l.Addr().String())
	if took := time.Since(start); err == nil || errorClass(err) != "timeout" || took > 2*time.Second {
		t.Fatalf("err %v after %v", err, took)
	}
	if u.open.Load() != 0 {
		t.Fatalf("open %d", u.open.Load())
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
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if _, ok := h.srv.poolEvent(h.srv.profiles.get(altProfile), false); ok {
		t.Fatal("an idle profile reported its pool")
	}
	e, ok := h.srv.poolEvent(h.srv.profiles.get(mainProfile), false)
	if !ok || e.Profile != mainProfile || e.Data["dials"] != int64(1) || e.Data["bindings"] != nil {
		t.Fatalf("pool event %+v", e)
	}
	if e, ok := h.srv.poolEvent(h.srv.profiles.get(altProfile), true); !ok || e.Data["bindings"] != 1 {
		t.Fatalf("first profile's event %+v", e)
	}
}
