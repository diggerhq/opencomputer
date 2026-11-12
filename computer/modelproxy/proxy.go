// The API socket's handler: one request from a model client (Claude Code,
// Codex, anything that speaks to a local base URL), in order
//  1. placeholder: the caller carries no credential of its own (401);
//  2. caller unit from the connection (identity.go); none → 401;
//     2b. the unit's in-flight cap (-max-inflight-per-unit; held requests count):
//     over it → 429 with Retry-After: 1, so one session cannot queue enough
//     hanging requests to starve the others;
//  3. the unit's credential, held up to the hold cap until its bind arrives
//     (bindings.go; the host's `synced` does not end a hold); timeout → 503
//     for a known unit, 401 for an unknown one; a refuse bind → 401 with its
//     reason;
//     3b. a rebind to another profile pending until the unit is idle → 503
//     (retryable, reason swap_pending, so new requests cannot starve it);
//  4. the binding's profile (profile.go): its route for the method and path
//     (404; a protocol upgrade anywhere but a WS route → 426, since
//     ReverseProxy would otherwise tunnel it unobserved), the route's
//     `require` (403), the profile's `concurrency` cap (429). Header
//     compares only, never contacting upstream;
//  5. rewrite by the profile's own ReverseProxy (outbound.go);
//  6. response streamed with an immediate flush; its status and reported
//     headers observed for the host (observed.go); one telemetry event when
//     it ends (telemetry.go).
//
// On a request to upgrade, every refusal is a 426 (websocket.go).
//
// Invariant: a binding's variables are only ever in the lease and the
// outbound headers; never logged, never in an event.
package main

import (
	"context"
	"io"
	"mime"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type ctxKey int

const (
	unitKey ctxKey = iota
	stateKey
)

type Proxy struct {
	bindings    *Bindings
	observer    *Observer
	out         sender
	profiles    *profiles
	placeholder string        // -placeholder
	hold        time.Duration // -hold-timeout
	perUnit     *inflight     // -max-inflight-per-unit
	wsIdle      time.Duration // -ws-idle-timeout
	wsDrain     chan struct{} // closed at shutdown (websocket.go)
	wsDrainOnce sync.Once
	wsOpen      sync.WaitGroup // open tunnels
	statsHook   func(*reqState)
	now         func() time.Time
}

// NewProxy serves ps; every profile's upstream must be set (newOutbound).
func NewProxy(b *Bindings, o *Observer, out sender, ps *profiles, placeholder string, hold time.Duration, perUnit int) *Proxy {
	return &Proxy{bindings: b, observer: o, out: out, profiles: ps, placeholder: placeholder, hold: hold, now: time.Now,
		wsIdle: 5 * time.Minute, wsDrain: make(chan struct{}), perUnit: newInflight(perUnit)}
}

// activeStreams is every profile's requests in flight upstream.
func (p *Proxy) activeStreams() int64 {
	var n int64
	for _, prof := range p.profiles.sorted {
		n += prof.up.streams.Load()
	}
	return n
}

// connIdentity resolves a connection's unit once, at its first request.
type connIdentity struct {
	once    sync.Once
	c       net.Conn
	resolve Resolver
	unit    string
}

func (ci *connIdentity) get() string {
	ci.once.Do(func() { ci.unit = ci.resolve(ci.c) })
	return ci.unit
}

// ConnContext attaches the caller's identity to every request on a connection.
func ConnContext(resolve Resolver) func(context.Context, net.Conn) context.Context {
	return func(ctx context.Context, c net.Conn) context.Context {
		return context.WithValue(ctx, unitKey, &connIdentity{c: c, resolve: resolve})
	}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	st := &reqState{start: p.now(), path: r.URL.Path, upgrade: isUpgrade(r.Header)}
	defer p.finish(st, r)

	if !placeholderOK(r.Header, p.placeholder) {
		st.deny(w, "refused", http.StatusUnauthorized, "authentication_error", textCredentials)
		return
	}
	if ci, ok := r.Context().Value(unitKey).(*connIdentity); ok {
		st.unit = ci.get()
	}
	if st.unit == "" {
		st.deny(w, "unknown_unit", http.StatusUnauthorized, "authentication_error", textUnknownUnit)
		return
	}
	if !p.perUnit.enter(st.unit) {
		st.deny(w, "inflight_cap", http.StatusTooManyRequests, "rate_limit_error", textUnitCap)
		return
	}
	defer p.perUnit.leave(st.unit)

	l, res := p.bindings.Acquire(r.Context(), st.unit, p.hold)
	st.held = p.now().Sub(st.start)
	switch res {
	case holdTimeoutKnown:
		st.holdEnd = "timeout"
		st.prof = p.bindings.knownProfile(st.unit) // the one the unit waits for
		st.deny(w, "", http.StatusServiceUnavailable, "api_error", st.text().notReady)
		return
	case holdTimeoutUnknown:
		st.holdEnd = "timeout"
		st.deny(w, "unknown_unit", http.StatusUnauthorized, "authentication_error", textUnbound)
		return
	case holdCanceled:
		st.holdEnd = "cancelled"
		st.cancelled.Store(true)
		return
	}
	defer l.Done()
	if l.waited {
		st.holdEnd = "bound"
	}
	st.sessionKey, st.prof, st.key, st.swapped = l.sessionKey, l.cred.prof, l.cred.key, l.swapped
	txt := st.text()
	if l.cred.refuse {
		st.refuse = true
		msg := txt.refused
		if l.cred.reason != "" {
			msg = txt.refusedPrefix + l.cred.reason
		}
		st.deny(w, "refused", http.StatusUnauthorized, "authentication_error", msg)
		return
	}
	prof := l.cred.prof
	if l.pending != nil && l.pending != prof {
		// A rebind to another profile waits for the unit's streams on the old
		// one to end. Until it applies, every new request is not ready
		// (retryable 503): one meant for the new profile cannot be served
		// yet, and admitting more on the old one would keep the unit busy
		// and starve the swap. In-flight streams finish; a rebind within the
		// profile admits as before.
		st.deny(w, "swap_pending", http.StatusServiceUnavailable, "api_error", txt.notReady)
		return
	}
	rs := prof.route(r, st.upgrade)
	switch {
	case rs == nil && st.upgrade, rs != nil && rs.ws && !prof.ws:
		st.denyAs(w, "websocket", "websocket", http.StatusUpgradeRequired, "invalid_request_error", textNoWebSocket)
		return
	case rs == nil:
		st.deny(w, "route", http.StatusNotFound, "not_found_error", textNotFound)
		return
	}
	st.rs, st.route = rs, rs.name
	if (rs.ws && !wsHandshakeOK(r.Header)) || !rs.requireOK(r.Header) {
		st.deny(w, "shape", http.StatusForbidden, "permission_error", txt.require)
		return
	}
	if prof.perKey != nil {
		st.concKey = prof.concKey.expand(l.cred.vars)
		if !prof.perKey.enter(st.concKey) {
			st.denyAs(w, "account_inflight_cap", "account_inflight", http.StatusTooManyRequests, "rate_limit_error", txt.concurrency)
			return
		}
		if rs.ws {
			prof.perKey.leave(st.concKey) // a tunnel counts its responses instead (websocket.go)
		} else {
			defer prof.perKey.leave(st.concKey)
		}
	}
	st.vars, st.lease = l.cred.vars, l
	st.leased = st.since()
	st.proxied = true

	prof.up.streams.Add(1)
	defer prof.up.streams.Add(-1)
	ww := &respWriter{ResponseWriter: w, st: st}
	ctx := context.WithValue(r.Context(), stateKey, st)
	defer func() { // also when ReverseProxy aborts the handler
		if st.ws != nil {
			st.ws.end()
		}
	}()
	prof.rp.ServeHTTP(ww, r.WithContext(ctx))
}

// respWriter counts bytes, notes the first flush to the client and client
// write failures. ReverseProxy flushes through http.ResponseController.
type respWriter struct {
	http.ResponseWriter
	st *reqState
}

func (w *respWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.st.bytesOut.Add(int64(n))
	if err != nil {
		w.st.clientErr.Store(true)
	}
	return n, err
}

func (w *respWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	w.st.firstOut.CompareAndSwap(0, w.st.since())
	if err != nil {
		w.st.clientErr.Store(true)
	}
	return err
}

func (w *respWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type countingBody struct {
	io.ReadCloser
	n *atomic.Int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.n.Add(int64(n))
	return n, err
}

// upstreamBody notes a failed upstream read (a stream cut by the upstream).
type upstreamBody struct {
	io.ReadCloser
	st *reqState
}

func (b *upstreamBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil && err != io.EOF {
		b.st.upstreamReadErr.Store(true)
	}
	return n, err
}

func isEventStream(ct string) bool {
	mt, _, err := mime.ParseMediaType(ct)
	return err == nil && mt == "text/event-stream"
}

type bufferPool struct {
	size int
	p    sync.Pool
}

func newBufferPool(size int) *bufferPool {
	return &bufferPool{size: size, p: sync.Pool{New: func() any { b := make([]byte, size); return &b }}}
}

func (b *bufferPool) Get() []byte  { return *(b.p.Get().(*[]byte)) }
func (b *bufferPool) Put(x []byte) { b.p.Put(&x) }
