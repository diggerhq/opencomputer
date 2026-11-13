package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// wsPeer is one end of a WebSocket in a test: the client's frames are
// masked, the upstream's are not.
type wsPeer struct {
	t    testing.TB
	r    *bufio.Reader
	w    io.Writer
	c    io.Closer
	mask []byte
}

func (p *wsPeer) send(msg string) {
	p.t.Helper()
	if _, err := p.w.Write(wsFrame(1, true, []byte(msg), p.mask)); err != nil {
		p.t.Fatal(err)
	}
}

// recv is the next data message, its fragments joined, control frames skipped.
func (p *wsPeer) recv() string {
	p.t.Helper()
	var msg []byte
	for {
		op, fin, b, err := readWSFrame(p.r)
		if err != nil {
			p.t.Fatalf("recv: %v", err)
		}
		if op >= 8 {
			continue
		}
		msg = append(msg, b...)
		if fin {
			return string(msg)
		}
	}
}

// closed: the peer's connection ends within 3 s.
func (p *wsPeer) closed() {
	p.t.Helper()
	done := make(chan error, 1)
	go func() {
		for {
			if _, _, _, err := readWSFrame(p.r); err != nil {
				done <- err
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		p.t.Fatal("connection not closed")
	}
}

// wsUpstream is a fake upstream: a handshake gets status (101: switched,
// the connection handed to the test on conns), its headers on reqs.
func wsUpstream(t testing.TB, status int, hdr http.Header, body string, reqs chan<- *http.Request, conns chan<- *wsPeer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reqs != nil {
			reqs <- r.Clone(context.Background())
		}
		if status != http.StatusSwitchingProtocols {
			for k, v := range hdr {
				w.Header()[k] = v
			}
			w.WriteHeader(status)
			io.WriteString(w, body)
			return
		}
		c, brw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n" +
			"X-Quota-Used: 12\r\n\r\n")
		brw.Flush()
		conns <- &wsPeer{t: t, r: brw.Reader, w: c, c: c}
	})
}

// wsHandshake is a client's handshake on the alt profile's WS route.
func (h *harness) wsHandshake() *http.Request {
	req, _ := http.NewRequest(http.MethodGet, h.apiURL+"/v1/responses", nil)
	for k, v := range map[string]string{
		"Connection": "Upgrade", "Upgrade": "websocket", "Sec-Websocket-Version": "13",
		"Sec-Websocket-Key": wsNonce, "Sec-Websocket-Extensions": "permessage-deflate; client_max_window_bits",
		"Authorization": placeholderAuth, "X-Proto": "ws=1", "Originator": "its-own",
		"User-Agent": "test-client/1.0", "X-Turn-Metadata": `{"turn":1}`,
	} {
		req.Header.Set(k, v)
	}
	return req
}

// openWS opens the client's end, failing unless it switched.
func (h *harness) openWS(caller string) *wsPeer {
	h.t.Helper()
	res, err := h.client(caller).Do(h.wsHandshake())
	if err != nil {
		h.t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		b, _ := io.ReadAll(res.Body)
		h.t.Fatalf("handshake: %d %s", res.StatusCode, b)
	}
	rwc := res.Body.(io.ReadWriteCloser)
	h.t.Cleanup(func() { rwc.Close() })
	return &wsPeer{t: h.t, r: bufio.NewReader(rwc), w: rwc, c: rwc, mask: []byte{7, 1, 9, 3}}
}

// The tunnel: the handshake reaches the upstream with the binding's
// variables and no compression offer; frames pass both ways unchanged (fragments and
// pings included); each response is its own model.request (ttfb, first
// output, tier, prewarm), the connection one more when it ends.
func TestWSTunnel(t *testing.T) {
	reqs, conns := make(chan *http.Request, 1), make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", reqs, conns)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	up, r := <-conns, <-reqs
	if r.URL.Path != "/base/x/responses" || r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("X-Account") != altAccount ||
		r.Header.Get("Sec-Websocket-Extensions") != "" || r.Header.Get("X-Proto") != "ws=1" || r.Header.Get("Upgrade") != "websocket" ||
		r.Header.Get("Originator") != "fixed" || r.Header.Get("X-Turn-Metadata") == "" {
		t.Fatalf("handshake upstream: %s %v", r.URL.Path, r.Header)
	}

	warm := `{"type":"response.create","model":"m","generate":false,"input":[]}`
	c.send(warm)
	if got := up.recv(); got != warm {
		t.Fatalf("upstream got %q", got)
	}
	for _, m := range []string{`{"type":"response.created","response":{"id":"r1"}}`, `{"type":"response.completed","response":{"id":"r1","service_tier":"default"}}`} {
		up.send(m)
		if got := c.recv(); got != m {
			t.Fatalf("client got %q", got)
		}
	}
	e := k.waitFor(isRoute("responses"))
	if d := evData(e); e["outcome"] != "completed" || d["transport"] != "websocket" || d["prewarm"] != true || d["service_tier"] != "default" ||
		d["ttfb_ms"] == nil || d["key"] != "fpC" || e["session_key"] != "s1" || e["profile"] != altProfile {
		t.Fatalf("prewarm event %v", e)
	}

	// The next request in fragments, a ping between them.
	c.w.Write(wsFrame(1, false, []byte(`{"type":"response.cre`), c.mask))
	c.w.Write(wsFrame(9, true, []byte("p"), c.mask))
	c.w.Write(wsFrame(0, true, []byte(`ate","previous_response_id":"r1","input":[{"type":"message"}]}`), c.mask))
	if got := up.recv(); !strings.HasPrefix(got, `{"type":"response.create","previous_response_id":"r1"`) {
		t.Fatalf("upstream got %q", got)
	}
	big := strings.Repeat("z", 10000)
	for _, m := range []string{
		`{"type":"response.created","response":{"id":"r2","service_tier":"auto"}}`,
		`{"type":"response.output_item.added","item":{"type":"message"}}`,
		`{"type":"response.output_text.delta","delta":"` + big + `"}`,
		`{"type":"response.completed","response":{"id":"r2","output":[{"text":"` + big + `"}],"service_tier":"priority"}}`,
	} {
		up.send(m)
		if got := c.recv(); got != m {
			t.Fatalf("client got %.60q", got)
		}
	}
	e = k.waitFor(isRoute("responses"))
	if d := evData(e); e["outcome"] != "completed" || d["prewarm"] != nil || d["service_tier"] != "priority" || d["first_output_ms"] == nil {
		t.Fatalf("event %v", e)
	}

	c.c.Close()
	e = k.waitFor(isRoute("responses_ws"))
	if d := evData(e); e["outcome"] != "completed" || d["status"] != float64(101) || d["responses"] != float64(2) || d["transport"] != "websocket" || d["closed"] != nil {
		t.Fatalf("connection event %v", e)
	}
	up.closed()
}

// A rebind applies at once; the response in flight on a tunnel ends, then
// the proxy closes the tunnel (it carried the old variables).
func TestWSRebindClosesBetweenResponses(t *testing.T) {
	conns := make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	up := <-conns
	c.send(`{"type":"response.create","input":[]}`)
	up.recv()
	up.send(`{"type":"response.created"}`)
	c.recv()

	h.bindAltReady(k, altCaller, "s1", "tok2", "fp2", altAccount)
	up.send(`{"type":"response.completed","response":{}}`)
	c.recv()
	c.closed()
	if e := k.waitFor(isRoute("responses_ws")); evData(e)["closed"] != "rebind" {
		t.Fatalf("connection event %v", e)
	}
}

// An idle tunnel closes after -ws-idle-timeout, and at shutdown.
func TestWSIdleAndDrain(t *testing.T) {
	conns := make(chan *wsPeer, 2)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns), wsIdle: 150 * time.Millisecond})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	c.closed()
	if e := k.waitFor(isRoute("responses_ws")); evData(e)["closed"] != "idle" {
		t.Fatalf("connection event %v", e)
	}

	h.srv.proxy.wsIdle = 0
	c = h.openWS(altCaller)
	<-conns
	<-conns
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	h.srv.proxy.drainWS(ctx, true)
	c.closed()
	if e := k.waitFor(isRoute("responses_ws")); evData(e)["closed"] != "drain" {
		t.Fatalf("connection event %v", e)
	}
}

// Every refusal on the route is a 426, so the client goes on over HTTP at
// once: a profile without a WS route, the proxy's own (the concurrency cap
// here), the upstream's (its 429 is still reported to the binder).
func TestWSRefusals(t *testing.T) {
	expect426 := func(h *harness, k *ctl) {
		t.Helper()
		res, err := h.client(altCaller).Do(h.wsHandshake())
		if err != nil {
			t.Fatal(err)
		}
		e := decodeAPIError(t, res)
		res.Body.Close()
		if res.StatusCode != http.StatusUpgradeRequired || !strings.HasPrefix(e.Error.Message, wsUseHTTP) {
			t.Fatalf("%d %+v", res.StatusCode, e)
		}
	}

	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: recordingUpstream(&hits, nil), noWS: true})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	expect426(h, k)
	if e := k.waitFor(isEvent("model.denied")); evData(e)["reason"] != "websocket" || hits.Load() != 0 {
		t.Fatalf("no WS route: %v, %d hits", e, hits.Load())
	}

	// The cap counts a tunnel's responses, not the tunnel: an idle
	// one blocks nothing, one with a response in flight is the whole cap of 1.
	conns := make(chan *wsPeer, 3)
	h = newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns), perKey: 1})
	k = h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	up := <-conns
	h.openWS(altCaller).c.Close()
	<-conns
	c.send(`{"type":"response.create","input":[]}`)
	up.recv()
	expect426(h, k)
	if e := k.waitFor(isEvent("model.denied")); evData(e)["reason"] != "concurrency_cap" {
		t.Fatalf("cap: %v", e)
	}
	up.send(`{"type":"response.completed","response":{"id":"r1"}}`)
	c.recv()
	k.waitFor(isRoute("responses"))
	h.openWS(altCaller).c.Close()
	<-conns

	limit := http.Header{"Content-Type": {"application/json"}, "X-Quota-Kind": {"primary"}, "X-Other": {"no"}}
	h = newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: wsUpstream(t, 429, limit, `{"error":{"type":"quota","resets_at":1792513800}}`, nil, nil)})
	k = h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	expect426(h, k)
	m := k.waitFor(isT("observed"))
	if hd, _ := m["headers"].(map[string]any); m["status"] != float64(429) || m["profile"] != altProfile || m["key"] != "fpC" ||
		len(hd) != 1 || hd["x-quota-kind"] != "primary" || m["body"] != `{"error":{"type":"quota","resets_at":1792513800}}` {
		t.Fatalf("observed %v", m)
	}
	if e := k.waitFor(isRoute("responses_ws")); e["error_type"] != "provider_rate_limited" || evData(e)["status"] != float64(429) {
		t.Fatalf("event %v", e)
	}
}

// An `error` event is an HTTP error's WebSocket form: its status and
// headers are reported to the binder, and it ends the response in flight.
func TestWSErrorEvent(t *testing.T) {
	conns := make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	up := <-conns
	if m := k.waitFor(isT("observed")); m["status"] != float64(101) || m["headers"].(map[string]any)["x-quota-used"] != "12" {
		t.Fatalf("observed %v", m)
	}
	c.send(`{"type":"response.create","input":[]}`)
	up.recv()
	up.send(`{"type":"error","status":429,"error":{"type":"quota","message":"limit","resets_at":1792513800},"headers":{"x-quota-used":100,"x-other":"no"}}`)
	c.recv()
	if e := k.waitFor(isRoute("responses")); e["outcome"] != "failed" || e["error_type"] != "provider_rate_limited" || evData(e)["status"] != float64(429) {
		t.Fatalf("event %v", e)
	}
	m := k.waitFor(isT("observed"))
	if hd, _ := m["headers"].(map[string]any); m["status"] != float64(429) || len(hd) != 1 || hd["x-quota-used"] != "100" ||
		!strings.Contains(m["body"].(string), `"resets_at":1792513800`) {
		t.Fatalf("observed %v", m)
	}
}

func keySlots(h *harness) int {
	c := h.srv.profiles.get(altProfile).perKey
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[altAccount]
}

func callerSlots(h *harness, caller string) int {
	c := h.srv.proxy.perCaller
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[caller]
}

// A response.create on a tunnel whose lease is no longer current is never
// sent: the tunnel closes instead, whatever is still in flight on it.
func TestWSNoCreateOnStaleTunnel(t *testing.T) {
	conns := make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	up := <-conns
	c.send(`{"type":"response.create","model":"m","input":[]}`)
	up.recv()
	h.bindAltReady(k, altCaller, "s1", "tok2", "fpD", altAccount)

	c.w.Write(wsFrame(1, true, []byte(`{"type":"response.create","model":"m","input":["second"]}`), c.mask))
	c.closed()
	if _, _, b, err := readWSFrame(up.r); err == nil {
		t.Fatalf("the upstream got %q on the old credential", b)
	}
	e := k.waitFor(isRoute("responses_ws"))
	if d := evData(e); d["closed"] != "rebind" || d["responses"] != float64(1) || keySlots(h) != 0 {
		t.Fatalf("event %v, key slots %d", e, keySlots(h))
	}
}

// A response.create read as the tunnel ends (the copy to the upstream may
// outlive the handler by a write) leaves no concurrency slot counted.
func TestWSCreateAtEndLeavesNoSlot(t *testing.T) {
	conns := make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns)})
	ended := make(chan *wsTunnel, 1)
	h.srv.proxy.statsHook = func(st *reqState) { ended <- st.ws }
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	h.openWS(altCaller).c.Close()
	(<-ended).created(false)
	if n := keySlots(h); n != 0 {
		t.Fatalf("key slots %d", n)
	}
}

// A tunnel the upstream closed ends, and frees its caller's slot, without
// waiting for the client to close its side.
func TestWSUpstreamCloseEndsTunnel(t *testing.T) {
	conns := make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	h.openWS(altCaller)
	(<-conns).c.Close()
	k.waitFor(isRoute("responses_ws"))
	if n := callerSlots(h, altCaller); n != 0 {
		t.Fatalf("caller slots %d", n)
	}
}

// A draining proxy waits for a tunnel's response without spinning.
func TestWSDrainDoesNotSpin(t *testing.T) {
	conns := make(chan *wsPeer, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: wsUpstream(t, 101, nil, "", nil, conns)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	c := h.openWS(altCaller)
	up := <-conns
	c.send(`{"type":"response.create","model":"m","input":[]}`)
	up.recv()
	cpu := func() time.Duration {
		var ru syscall.Rusage
		syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
		return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
	}
	h.srv.proxy.drainWS(context.Background(), false)
	before := cpu()
	time.Sleep(400 * time.Millisecond)
	if used := cpu() - before; used > 200*time.Millisecond {
		t.Fatalf("%v of CPU in 400 ms of draining", used)
	}
	up.send(`{"type":"response.completed","response":{"id":"r1"}}`)
	c.closed()
}
