// A profile's WS route: a Responses WebSocket (`WS /v1/responses`), tunnelled
// to the upstream. Over it a client such as Codex keeps one connection per
// session, warms it when the thread starts (a `generate:false` request) and
// sends each request as only its new input on top of the previous response
// (`previous_response_id`); over HTTP every request carries the whole
// context again.
//
// The handshake is admitted like any request (proxy.go: placeholder, unit,
// caps, hold, lease, the route's `require`) and rewritten like one
// (outbound.go), minus Sec-WebSocket-Extensions, so no compression is
// negotiated and frames stay readable. Every refusal of an upgrade, the
// proxy's own or the upstream's (any status but 101), reaches the client as
// a 426: on a 426 Codex goes on over HTTP at once, where the same refusal is
// served in its usual terms; on a 401/403/404/503 it would first reconnect
// for several seconds, and on a 429 it fails the turn.
//
// Once switched, ReverseProxy copies bytes both ways through wsTunnel, which
// reads the frames as they pass (wsframe.go) for:
//   - one model.request per response (transport websocket): ttfb from its
//     response.create to its first event, first output, the tier served,
//     the outcome;
//   - `observed` (observed.go): the handshake's headers, then each
//     response.completed as an HTTP 200 and each `error` event's status and
//     headers as an HTTP error's;
//   - when to close: with no response in flight, once the lease is no longer
//     current (a rebind, refuse or release waits for the unit to be idle,
//     and the handshake carried the old variables), or after
//     -ws-idle-timeout, or once the proxy is draining (http.Server.Shutdown
//     does not wait for a hijacked connection; shutdown waits for tunnels
//     itself, up to -drain-timeout). The client reconnects on its next
//     request and sends it whole.
//
// Invariants: a tunnel is one request for the unit's cap and the lease,
// held for its whole life, and each response on it one for the profile's
// concurrency cap (the handshake is refused at the cap; a response.create on
// an open tunnel cannot be, so it counts past it); frames are never altered,
// held back or read ahead of either side; the proxy never cuts a response in
// flight (unless it has run wsStuck without an end this reader knows);
// nothing from a frame is kept but the facts above.
package main

import (
	"context"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// wsTypeHead: an event's `type` is among its first bytes.
	wsTypeHead = 256
	// wsErrorHead: an `error` event is short; this much is read of one.
	wsErrorHead = 4 << 10
	// wsUseHTTP starts every refusal of an upgrade: the client shows it only
	// if HTTP fails too.
	wsUseHTTP = "Use HTTP: "
	// wsStuck: a response in flight this long no longer keeps the tunnel
	// open past a rebind, idle or drain (an end this reader missed).
	wsStuck = time.Hour
)

// markNoGenerate is a warm-up request's flag (a client's startup prewarm).
var markNoGenerate = []byte(`"generate":false`)

// wsResponse is one response.create on a tunnel, until its last event.
type wsResponse struct {
	start, firstEvent, firstOutput time.Time
	tier                           string
	prewarm                        bool
}

type wsTunnel struct {
	io.ReadWriteCloser // the upstream connection, after its 101
	p                  *Proxy
	st                 *reqState // the handshake's
	toUp, toClient     *wsFrames
	client             wsClientMsg
	server             wsServerMsg

	mu        sync.Mutex
	queue     []*wsResponse // in flight, oldest first
	responses int
	closed    string // why the proxy closed it: idle | rebind | drain
	ended     bool
	upErr     bool
	lastByte  atomic.Int64 // unix ns of the last bytes either way; idle counts from it

	kick      chan struct{} // a response ended
	done      chan struct{}
	closeOnce sync.Once
}

func newWSTunnel(p *Proxy, st *reqState, up io.ReadWriteCloser) *wsTunnel {
	p.wsOpen.Add(1)
	t := &wsTunnel{ReadWriteCloser: up, p: p, st: st, kick: make(chan struct{}, 1), done: make(chan struct{})}
	t.lastByte.Store(p.now().UnixNano())
	t.client.t, t.server.t = t, t
	t.toUp, t.toClient = newWSFrames(&t.client), newWSFrames(&t.server)
	go t.watch()
	return t
}

// Write carries the client's bytes upstream.
func (t *wsTunnel) Write(p []byte) (int, error) {
	t.toUp.feed(p)
	t.lastByte.Store(t.p.now().UnixNano())
	return t.ReadWriteCloser.Write(p)
}

// Read carries the upstream's bytes to the client.
func (t *wsTunnel) Read(p []byte) (int, error) {
	n, err := t.ReadWriteCloser.Read(p)
	if n > 0 {
		t.toClient.feed(p[:n])
		t.lastByte.Store(t.p.now().UnixNano())
	}
	if err != nil && err != io.EOF {
		select {
		case <-t.done: // closed by the proxy or the client
		default:
			t.mu.Lock()
			t.upErr = true
			t.mu.Unlock()
		}
	}
	return n, err
}

func (t *wsTunnel) Close() error {
	err := error(nil)
	t.closeOnce.Do(func() {
		close(t.done)
		err = t.ReadWriteCloser.Close()
	})
	return err
}

// watch closes the tunnel between responses once its lease is stale or it
// has been idle too long.
func (t *wsTunnel) watch() {
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		changed := t.p.bindings.changes()
		why, wait := t.closeReason()
		if why != "" {
			t.Close()
			return
		}
		timer.Reset(wait)
		select {
		case <-t.done:
			return
		case <-changed:
		case <-t.p.wsDrain:
		case <-t.kick:
		case <-timer.C:
		}
	}
}

// closeReason: why to close now, else how long until the idle limit.
func (t *wsTunnel) closeReason() (string, time.Duration) {
	now := t.p.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.queue) > 0 {
		// A response's end kicks. One never seen to end (an event this
		// reader does not know) stops holding the tunnel open after wsStuck.
		if age := now.Sub(t.queue[0].start); age < wsStuck {
			return "", wsStuck - age
		}
	}
	switch {
	case t.ended:
		return "", time.Hour
	case t.p.draining():
		t.closed = "drain"
	case !t.st.lease.current():
		t.closed = "rebind"
	case t.p.wsIdle <= 0:
		return "", time.Hour
	default:
		left := t.p.wsIdle - now.Sub(time.Unix(0, t.lastByte.Load()))
		if left > 0 {
			return "", left
		}
		t.closed = "idle"
	}
	return t.closed, 0
}

func (t *wsTunnel) created(prewarm bool) {
	now := t.p.now()
	t.mu.Lock()
	t.queue = append(t.queue, &wsResponse{start: now, prewarm: prewarm})
	t.responses++
	t.mu.Unlock()
	t.st.prof.perKey.add(t.st.concKey)
}

// event is one upstream event: typ is its `type`, tier the service tier it
// names, head its first bytes (all of a short one).
func (t *wsTunnel) event(typ, tier string, head []byte) {
	now := t.p.now()
	status, hdr := 0, http.Header(nil)
	if typ == "error" {
		status, hdr = wsError(head)
	}
	outcome, errType := "", ""
	switch typ {
	case "response.completed", "response.incomplete":
		outcome = "completed"
	case "response.failed", "error":
		outcome, errType = "failed", "provider_error"
		if status == http.StatusTooManyRequests {
			errType = "provider_rate_limited"
		}
	}
	t.mu.Lock()
	var r *wsResponse
	if len(t.queue) > 0 {
		r = t.queue[0]
		if r.firstEvent.IsZero() {
			r.firstEvent = now
		}
		if typ == "response.output_item.added" && r.firstOutput.IsZero() {
			r.firstOutput = now
		}
		if tier != "" {
			r.tier = tier
		}
		if outcome != "" {
			t.queue = t.queue[1:]
		}
	}
	t.mu.Unlock()
	if r != nil && outcome != "" {
		t.st.prof.perKey.leave(t.st.concKey)
		t.p.out.send(t.responseEvent(r, now, outcome, errType, status))
		select {
		case t.kick <- struct{}{}:
		default:
		}
	}
	switch {
	case typ == "response.completed":
		t.p.observer.response(t.st.subject(), http.StatusOK, nil, nil)
	case typ == "error" && status != 0:
		t.p.observer.response(t.st.subject(), status, hdr, head)
	}
}

// end follows ReverseProxy's copy: responses still in flight end cancelled,
// or failed (socket) when the upstream cut the connection.
func (t *wsTunnel) end() {
	defer t.p.wsOpen.Done()
	t.Close()
	now := t.p.now()
	t.mu.Lock()
	q, upErr := t.queue, t.upErr
	t.queue, t.ended = nil, true
	t.mu.Unlock()
	for _, r := range q {
		t.st.prof.perKey.leave(t.st.concKey)
		if upErr {
			t.p.out.send(t.responseEvent(r, now, "failed", "socket", 0))
		} else {
			t.p.out.send(t.responseEvent(r, now, "cancelled", "", 0))
		}
	}
}

// draining: shutdown has begun.
func (p *Proxy) draining() bool {
	select {
	case <-p.wsDrain:
		return true
	default:
		return false
	}
}

// drainWS has every tunnel close at its next response boundary, then waits
// for them up to ctx. Called once, at shutdown.
func (p *Proxy) drainWS(ctx context.Context, wait bool) {
	p.wsDrainOnce.Do(func() { close(p.wsDrain) })
	if !wait {
		return
	}
	done := make(chan struct{})
	go func() { p.wsOpen.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// summary is what the handshake's own model.request adds.
func (t *wsTunnel) summary(data map[string]any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	data["transport"] = "websocket"
	data["responses"] = t.responses
	if t.closed != "" {
		data["closed"] = t.closed
	}
}

func (t *wsTunnel) responseEvent(r *wsResponse, now time.Time, outcome, errType string, status int) eventMsg {
	e := newEvent(now, "model.request")
	e.SessionKey = t.st.sessionKey
	e.Provider = t.st.prof.name
	e.DurationMs = msPtr(now.Sub(r.start))
	e.Outcome, e.ErrorType = outcome, errType
	data := map[string]any{"route": t.st.rs.respName, "transport": "websocket", "stream": true}
	if status != 0 {
		data["status"] = status
	}
	if t.st.key != "" {
		data["fingerprint"] = t.st.key
	}
	if !r.firstEvent.IsZero() {
		data["ttfb_ms"] = ms(r.firstEvent.Sub(r.start))
	}
	if !r.firstOutput.IsZero() {
		data["first_output_ms"] = ms(r.firstOutput.Sub(r.start))
	}
	if r.tier != "" {
		data["service_tier"] = r.tier
	}
	if r.prewarm {
		data["prewarm"] = true
	}
	e.Data = data
	return e
}
