// The API socket's handler: one request from a model client (Claude Code,
// Codex, anything that speaks to a local base URL), in stages. Each stage
// either refuses the request (refuse.go) or passes it on:
//
//	identify      the caller carries no credential of its own, only the
//	              placeholder (401); the connection has a caller
//	              (connlimit.go; none → 401); the caller is under its
//	              in-flight cap (-max-inflight-per-caller, held requests
//	              count; over → 429), so one session cannot queue enough
//	              hanging requests to starve the others
//	awaitBinding  the caller's credential, held up to -hold-timeout until
//	              its bind arrives (lease.go). At the timeout: 503 for a
//	              caller the binder has named or may yet name (no `synced`
//	              since the start), 401 for one it has not. A refuse bind →
//	              401 with its reason
//	matchRoute    the profile's route for the method and path (404; a
//	              protocol upgrade anywhere but a WS route → 426, since
//	              ReverseProxy would otherwise tunnel it unobserved)
//	check         the route's `require` (403) and the profile's
//	              `concurrency` cap (429): header compares only, never
//	              contacting the upstream
//	forward       the profile's own ReverseProxy (outbound.go), the response
//	              streamed with an immediate flush. A request still queued
//	              for one of the upstream's connections (-max-conns-per-host)
//	              after -hold-timeout → 503; an upstream that cannot be
//	              reached is a 502, on the dial's own limits (upstream.go)
//
// When the request ends, whatever stage it reached, finish sends its
// telemetry (telemetry.go). On a request to upgrade, every refusal is a 426
// (websocket.go).
//
// Invariant: a binding's variables are only ever in the lease and the
// outbound headers; never logged, never in an event.
package main

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type ctxKey int

const (
	callerKey ctxKey = iota
	stateKey
)

type Proxy struct {
	bindings    *Bindings
	observer    *Observer
	out         sender
	profiles    *profiles
	placeholder string        // -placeholder
	hold        time.Duration // -hold-timeout
	perCaller   *inflight     // -max-inflight-per-caller
	wsIdle      time.Duration // -ws-idle-timeout
	wsDrain     chan struct{} // closed at shutdown (websocket.go)
	wsDrainOnce sync.Once
	wsOpen      sync.WaitGroup // open tunnels
	refusals    refusalLog
	statsHook   func(*reqState)
	now         func() time.Time
}

// NewProxy serves ps; every profile's upstream must be set (newOutbound).
func NewProxy(b *Bindings, o *Observer, out sender, ps *profiles, placeholder string, hold time.Duration, perCaller int) *Proxy {
	return &Proxy{bindings: b, observer: o, out: out, profiles: ps, placeholder: placeholder, hold: hold, now: time.Now,
		wsIdle: 5 * time.Minute, wsDrain: make(chan struct{}), perCaller: newInflight(perCaller), refusals: refusalLog{every: refusalEvery}}
}

// activeStreams is every profile's requests in flight upstream.
func (p *Proxy) activeStreams() int64 {
	var n int64
	for _, prof := range p.profiles.sorted {
		n += prof.up.streams.Load()
	}
	return n
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	st := &reqState{start: p.now(), path: r.URL.Path, upgrade: isUpgrade(r.Header)}
	defer p.finish(st, r)

	if !p.identify(w, r, st) {
		return
	}
	defer p.perCaller.leave(st.caller)
	l := p.awaitBinding(w, r, st)
	if l == nil {
		return
	}
	if !p.matchRoute(w, r, st) {
		return
	}
	release, ok := p.check(w, r, st, l)
	if !ok {
		return
	}
	defer release()
	p.forward(w, r, st, l)
}

// identify names the caller and takes its in-flight slot, which the caller
// of identify gives back.
func (p *Proxy) identify(w http.ResponseWriter, r *http.Request, st *reqState) bool {
	if !placeholderOK(r.Header, p.placeholder) {
		st.deny(w, "credentials", http.StatusUnauthorized, "authentication_error", textCredentials)
		return false
	}
	st.caller, _ = r.Context().Value(callerKey).(string)
	if st.caller == "" {
		st.deny(w, "unknown_caller", http.StatusUnauthorized, "authentication_error", textUnknownCaller)
		return false
	}
	if !p.perCaller.enter(st.caller) {
		st.deny(w, "caller_cap", http.StatusTooManyRequests, "rate_limit_error", textCallerCap)
		return false
	}
	return true
}

// awaitBinding leases the caller's credential, holding the request for it.
func (p *Proxy) awaitBinding(w http.ResponseWriter, r *http.Request, st *reqState) *lease {
	l, res := p.bindings.Acquire(r.Context(), st.caller, p.hold)
	st.held = p.now().Sub(st.start)
	switch res {
	case holdNotReady:
		st.holdEnd = "timeout"
		st.prof = p.bindings.knownProfile(st.caller) // the one the caller waits for
		st.deny(w, "", http.StatusServiceUnavailable, "api_error", st.text().notReady)
		return nil
	case holdUnknown:
		st.holdEnd = "timeout"
		st.deny(w, "unbound", http.StatusUnauthorized, "authentication_error", textUnbound)
		return nil
	case holdCanceled:
		st.holdEnd = "cancelled"
		st.cancelled.Store(true)
		return nil
	}
	if l.waited {
		st.holdEnd = "bound"
	}
	st.sessionKey, st.prof, st.key, st.swapped = l.sessionKey, l.cred.prof, l.cred.key, l.swapped
	if l.cred.refuse {
		msg := st.text().refused
		if l.cred.reason != "" {
			msg = st.text().refusedPrefix + l.cred.reason
		}
		st.deny(w, "refused", http.StatusUnauthorized, "authentication_error", msg)
		return nil
	}
	return l
}

// matchRoute finds the request's route on the binding's profile.
func (p *Proxy) matchRoute(w http.ResponseWriter, r *http.Request, st *reqState) bool {
	rs := st.prof.route(r, st.upgrade)
	switch {
	case rs == nil && st.upgrade, rs != nil && rs.ws && !st.prof.ws:
		st.denyAs(w, "websocket", "websocket", http.StatusUpgradeRequired, "invalid_request_error", textNoWebSocket)
		return false
	case rs == nil:
		st.deny(w, "route", http.StatusNotFound, "not_found_error", textNotFound)
		return false
	}
	st.rs, st.route = rs, rs.name
	return true
}

// check applies the route's `require` and the profile's concurrency cap;
// release gives the cap's slot back.
func (p *Proxy) check(w http.ResponseWriter, r *http.Request, st *reqState, l *lease) (release func(), ok bool) {
	prof, rs := st.prof, st.rs
	if (rs.ws && !wsHandshakeOK(r.Header)) || !rs.requireOK(r.Header) {
		st.deny(w, "require", http.StatusForbidden, "permission_error", st.text().require)
		return nil, false
	}
	if prof.perKey == nil {
		return func() {}, true
	}
	st.concKey = prof.concKey.expand(l.cred.vars)
	if !prof.perKey.enter(st.concKey) {
		st.denyAs(w, "concurrency_cap", "concurrency", http.StatusTooManyRequests, "rate_limit_error", st.text().concurrency)
		return nil, false
	}
	if rs.ws {
		prof.perKey.leave(st.concKey) // a tunnel counts its responses instead (websocket.go)
		return func() {}, true
	}
	return func() { prof.perKey.leave(st.concKey) }, true
}

// errConnWait cancels a request that got no upstream connection in time.
var errConnWait = errors.New("no free upstream connection within the hold timeout")

// forward hands the request to the profile's ReverseProxy.
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, st *reqState, l *lease) {
	prof := st.prof
	st.vars, st.lease = l.cred.vars, l
	st.leased = st.since()
	st.proxied = true

	prof.up.streams.Add(1)
	defer prof.up.streams.Add(-1)
	ctx, cancel := context.WithCancelCause(context.WithValue(r.Context(), stateKey, st))
	defer cancel(nil)
	// Stopped when the transport hands over a connection or starts dialling
	// one for this request (reqState.trace).
	st.connWait = time.AfterFunc(p.hold, func() { cancel(errConnWait) })
	defer st.connWait.Stop()
	defer func() { // also when ReverseProxy aborts the handler
		if st.ws != nil {
			st.ws.end()
		}
	}()
	prof.rp.ServeHTTP(&respWriter{ResponseWriter: w, st: st}, r.WithContext(ctx))
}

// placeholderOK: the caller sends no credential, or only the placeholder its
// client needs to be configured with (-placeholder). The proxy injects the
// real one; anything else is a caller trying its own.
func placeholderOK(h http.Header, placeholder string) bool {
	if v := h.Values("Authorization"); len(v) > 1 || (len(v) == 1 && v[0] != "Bearer "+placeholder) {
		return false
	}
	v := h.Values("X-Api-Key")
	return len(v) == 0 || (len(v) == 1 && v[0] == placeholder)
}

// isUpgrade: the request asks to switch protocols (a WebSocket): its
// Connection lists `upgrade` (RFC 9110 §7.8). Only a profile's WS route
// serves one; anywhere else it is refused with 426 rather than let
// ReverseProxy tunnel a connection the proxy cannot observe. A bare Upgrade
// header is no request to switch: it is a hop-by-hop header ReverseProxy
// strips.
func isUpgrade(h http.Header) bool { return connectionLists(h, "upgrade") }

// connectionLists: the request's Connection header names token, which makes
// a header of that name hop-by-hop: ReverseProxy strips it.
func connectionLists(h http.Header, token string) bool {
	for _, v := range h["Connection"] {
		for t := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

// wsHandshakeOK: a WebSocket upgrade, version 13, with a key.
func wsHandshakeOK(h http.Header) bool {
	return strings.EqualFold(h.Get("Upgrade"), "websocket") && h.Get("Sec-Websocket-Version") == "13" && h.Get("Sec-Websocket-Key") != ""
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
