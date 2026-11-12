// The outbound half of a proxied request, one per profile (profile.go): its
// upstream, its own httputil.ReverseProxy, and the rewrite that applies the
// profile's header policy, in this order:
//
//	URL      the profile's scheme and host; its base path, then the route's
//	         `to` (else the path the route matched, re-encoded: never the
//	         caller's own encoding of it); the query kept as sent
//	removed  Authorization and X-Api-Key (the caller's placeholder), then
//	         the profile's `remove` globs
//	set      the profile's `set`, then the route's, with the binding's
//	         variables; then the route's `default`, where the header is absent
//	WS       Sec-WebSocket-Extensions dropped, so no compression is
//	         negotiated and frames stay readable (websocket.go)
//
// Every other header passes untouched. Hop-by-hop headers and
// X-Forwarded-For/-Host/-Proto/Forwarded are stripped by ReverseProxy; the
// request body is streamed and never read; the response is flushed
// immediately and never read ahead of the client.
//
// Invariant: a profile's ReverseProxy only ever dials its own upstream, and
// is only handed requests whose lease is on that profile (proxy.go), so a
// binding's variables never reach another profile's host.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/http/httputil"
	"time"
)

type outbound struct {
	prof *profile
	p    *Proxy
}

// newOutbound gives prof its upstream and ReverseProxy.
func newOutbound(p *Proxy, prof *profile, up *upstream, pool httputil.BufferPool) {
	o := &outbound{prof: prof, p: p}
	prof.up = up
	prof.rp = &httputil.ReverseProxy{
		Rewrite:        o.rewrite,
		Transport:      up.transport,
		FlushInterval:  -1,
		BufferPool:     pool,
		ModifyResponse: o.modifyResponse,
		ErrorHandler:   o.errorHandler,
		ErrorLog:       discardLog,
	}
}

func (o *outbound) rewrite(pr *httputil.ProxyRequest) {
	st := pr.In.Context().Value(stateKey).(*reqState)
	out := pr.Out
	o.prof.target(out, st.rs)
	o.prof.headers(out.Header, st.rs, st.vars)
	if out.Body != nil {
		out.Body = &countingBody{ReadCloser: out.Body, n: &st.bytesIn}
	}
	pr.Out = out.WithContext(httptrace.WithClientTrace(out.Context(), st.trace(o.prof.up)))
}

// target points out at the profile's upstream; its query is left as it is.
func (p *profile) target(out *http.Request, rs *routeSpec) {
	out.URL.Scheme = p.url.Scheme
	out.URL.Host = p.url.Host
	out.Host = p.url.Host
	path := out.URL.Path
	if rs.to != "" {
		path = rs.to
	}
	// The route was matched on the decoded path: that is the one sent, not
	// the caller's own encoding of it.
	out.URL.Path, out.URL.RawPath = p.url.Path+path, ""
}

// headers applies the profile's and the route's header policy to h.
func (p *profile) headers(h http.Header, rs *routeSpec, vars map[string]string) {
	delete(h, "Authorization")
	delete(h, "X-Api-Key")
	if len(p.remove) > 0 {
		for k := range h {
			if matchesAny(p.remove, k) {
				delete(h, k)
			}
		}
	}
	for _, s := range p.set {
		h[s.name] = []string{s.value.expand(vars)}
	}
	for _, s := range rs.set {
		h[s.name] = []string{s.value.expand(vars)}
	}
	for _, s := range rs.def {
		if len(h[s.name]) == 0 {
			h[s.name] = []string{s.value.expand(vars)}
		}
	}
	if rs.ws {
		delete(h, "Sec-Websocket-Extensions")
	}
}

func (o *outbound) modifyResponse(res *http.Response) error {
	st := res.Request.Context().Value(stateKey).(*reqState)
	if st.rs.ws {
		return o.switchWS(st, res)
	}
	st.status = res.StatusCode
	st.stream = isEventStream(res.Header.Get("Content-Type"))
	o.observe(st, res)
	res.Body = &upstreamBody{ReadCloser: res.Body, st: st}
	if st.rs.responses && res.StatusCode == http.StatusOK && res.Header.Get("Content-Encoding") == "" {
		res.Body = watchResponses(st, res.Body)
	}
	return nil
}

// observe reports the response to the host (observed.go). An error's body
// may say what its headers do not: that report waits for the body's start
// as the client reads it, bounded in time, so nothing is read ahead of the
// client. Not for an event stream or a compressed body.
func (o *outbound) observe(st *reqState, res *http.Response) {
	if st.key == "" {
		return
	}
	obs, sub, status := o.p.observer, st.subject(), res.StatusCode
	if status >= statusFirstError && !st.stream && res.Header.Get("Content-Encoding") == "" {
		hdr := res.Header.Clone()
		res.Body = newHeadBody(res.Body, observedBody, func(head []byte) { obs.response(sub, status, hdr, head) })
		return
	}
	obs.response(sub, status, res.Header, nil)
}

// switchWS takes the WebSocket handshake's response: a 101 becomes a
// tunnel (websocket.go); any other status is reported to the host with its
// body's start and reaches the client as a 426, so it goes on over HTTP. The
// refused handshake's body is read here, bounded in size and time: it never
// reaches the client.
func (o *outbound) switchWS(st *reqState, res *http.Response) error {
	st.status = res.StatusCode
	if res.StatusCode != http.StatusSwitchingProtocols {
		stop := time.AfterFunc(errorBodyWait, func() { res.Body.Close() })
		head, _ := io.ReadAll(io.LimitReader(res.Body, wsErrorHead))
		stop.Stop()
		res.Body.Close()
		o.p.observer.response(st.subject(), res.StatusCode, res.Header, head)
		h := http.Header{}
		b := apiErrorHeaders(h, http.StatusUpgradeRequired, "invalid_request_error", wsUseHTTP+fmt.Sprintf(textWSRefused, res.StatusCode))
		res.StatusCode, res.Status, res.Header = http.StatusUpgradeRequired, "426 Upgrade Required", h
		res.Body, res.ContentLength = io.NopCloser(bytes.NewReader(b)), int64(len(b))
		return nil
	}
	up, ok := res.Body.(io.ReadWriteCloser)
	if !ok {
		return errors.New("101 with a body that is not writable") // errorHandler: 426
	}
	o.p.observer.response(st.subject(), http.StatusSwitchingProtocols, res.Header, nil)
	st.ws = newWSTunnel(o.p, st, up)
	res.Body = st.ws
	return nil
}

func (o *outbound) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	st, _ := r.Context().Value(stateKey).(*reqState)
	if r.Context().Err() != nil {
		if st != nil {
			st.cancelled.Store(true)
		}
		return
	}
	class := errorClass(err)
	if st != nil {
		st.transportErr = class
		logWarn("upstream request failed", "profile", o.prof.name, "route", st.route, "session_key", st.sessionKey, "error_type", class)
		o.p.observer.transport(st.subject(), class)
	}
	if st != nil && st.rs.ws {
		// The client goes on over HTTP, where an unreachable upstream is reported as usual.
		writeAPIError(w, http.StatusUpgradeRequired, "invalid_request_error", wsUseHTTP+o.prof.text.unreachable)
		return
	}
	writeAPIError(w, http.StatusBadGateway, "api_error", o.prof.text.unreachable)
}
