// Per-request measurements and the events they become. README.md lists every
// event with its fields; testdata/control/event-*.json has one of each:
//   - model.request: once per request that reached the upstream, after it ends;
//   - model.held: a request that waited for its caller's bind (served, or
//     503/401 at the cap);
//   - model.denied: a request the proxy refused (refuse.go), with its reason:
//     credentials | unknown_caller | caller_cap | unbound | refused | route |
//     websocket | require | concurrency_cap | upstream_busy.
//
// Every one carries `profile`: the name of the binding's profile, or none
// before the binding is known.
//
// Envelope enums: outcome completed | failed | cancelled | timed_out;
// error_type provider_error | provider_rate_limited | timeout | socket |
// websocket | concurrency | unknown.
//
// Proxy overhead is time inside the proxy only: lease → upstream request
// headers written, minus waiting for an upstream connection (reported apart
// as `conn_wait_ms`, with `conn_reused`); plus upstream first response byte
// → first flush to the client.
//
// A request on a `responses` route also reports `first_output_ms` (headers
// written → its first output item) and the `service_tier` it was served on,
// from its stream (responses.go); `ttfb_ms` ends at `response.created`,
// before the model produced anything.
//
// Over a WebSocket (websocket.go) the handshake's model.request (status 101)
// spans the connection and adds `transport`, `responses` (how many it
// carried) and `closed` (idle | rebind | drain, when the proxy closed it);
// each response on it has its own model.request (the route of the same path
// over HTTP, transport websocket, ttfb_ms from its response.create, and
// `prewarm` for a generate:false warm-up).
package main

import (
	"errors"
	"net/http"
	"net/http/httptrace"
	"sync/atomic"
	"time"
)

type reqState struct {
	start      time.Time
	path       string
	upgrade    bool // the request asks to switch protocols
	caller     string
	prof       *profile   // the binding's; nil before it is known
	rs         *routeSpec // nil: not (yet) on the profile's allowlist
	route      string     // rs.name
	concKey    string     // the profile's concurrency key, expanded
	held       time.Duration
	holdEnd    string // "" (never waited) | bound | timeout | cancelled
	sessionKey string
	key        string
	vars       map[string]string // never logged, never in an event
	lease      *lease
	connWait   *time.Timer // cancels the request if no upstream connection comes (proxy.go)
	ws         *wsTunnel   // a WS route, once switched
	swapped    bool
	proxied    bool
	leased     int64

	denyReason string
	denyErr    string // the denial's envelope error_type, if it has one
	ownErrType string
	resp       responsesFacts // a responses route: what its stream said (responses.go)
	status     int
	stream     bool

	// offsets from start in ns (+1 so 0 means unset); set from transport goroutines
	getConn, gotConn, wroteHeaders, firstByte, firstOut atomic.Int64
	reused                                              atomic.Bool
	bytesIn, bytesOut                                   atomic.Int64
	clientErr, upstreamReadErr, cancelled               atomic.Bool
	transportErr                                        string
}

func (s *reqState) since() int64 { return int64(time.Since(s.start)) + 1 }

// profileName is the event's profile: "" before the binding is known.
func (s *reqState) profileName() string {
	if s.prof == nil {
		return ""
	}
	return s.prof.name
}

func (s *reqState) trace(up *upstream) *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GetConn: func(string) { s.getConn.CompareAndSwap(0, s.since()) },
		GotConn: func(i httptrace.GotConnInfo) {
			if s.connWait != nil {
				s.connWait.Stop()
			}
			s.gotConn.CompareAndSwap(0, s.since())
			s.reused.Store(i.Reused)
			if !i.Reused {
				up.poolMiss.Add(1)
			}
		},
		WroteHeaders:         func() { s.wroteHeaders.CompareAndSwap(0, s.since()) },
		GotFirstResponseByte: func() { s.firstByte.CompareAndSwap(0, s.since()) },
	}
}

// overheadPre: lease → upstream headers written, minus the connection wait.
func (s *reqState) overheadPre() (time.Duration, bool) {
	wh := s.wroteHeaders.Load()
	if wh == 0 || s.leased == 0 {
		return 0, false
	}
	d := wh - s.leased
	if gc, gt := s.getConn.Load(), s.gotConn.Load(); gc != 0 && gt >= gc {
		d -= gt - gc
	}
	return time.Duration(max(d, 0)), true
}

// overheadFirstByte: upstream first byte → first flush to the client.
func (s *reqState) overheadFirstByte() (time.Duration, bool) {
	fb, fo := s.firstByte.Load(), s.firstOut.Load()
	if fb == 0 || fo == 0 || fo < fb {
		return 0, false
	}
	return time.Duration(fo - fb), true
}

func (p *Proxy) finish(st *reqState, r *http.Request) {
	rec := recover()
	if rec != nil && !errors.Is(asError(rec), http.ErrAbortHandler) {
		panic(rec)
	}
	now := p.now()
	if st.holdEnd == "bound" || st.holdEnd == "timeout" {
		e := newEvent(now, "model.held")
		e.SessionKey = st.sessionKey
		e.Profile = st.profileName()
		e.DurationMs = msPtr(st.held)
		e.Outcome = "completed"
		if st.holdEnd == "timeout" {
			e.Outcome, e.ErrorType = "timed_out", "timeout"
		}
		e.Data = map[string]any{"held_ms": ms(st.held), "released": st.holdEnd}
		p.out.send(e)
	}
	if st.denyReason != "" {
		e := newEvent(now, "model.denied")
		e.SessionKey = st.sessionKey
		e.Profile = st.profileName()
		e.Outcome = "failed"
		e.ErrorType = st.denyErr
		route := st.route
		if route == "" {
			route = "other"
		}
		e.Data = map[string]any{"reason": st.denyReason, "route": route}
		p.out.send(e)
		if ok, skipped := p.refusals.allow(now, st.caller, st.denyReason); ok {
			logWarn("denied", "reason", st.denyReason, "error_type", st.denyErr, "profile", e.Profile, "route", route,
				"path", truncate(st.path, 120), "caller", st.caller, "session_key", st.sessionKey, "unlogged", skipped)
		}
	}
	if st.proxied {
		p.out.send(p.requestEvent(st, r, now, rec != nil))
	}
	if p.statsHook != nil {
		p.statsHook(st)
	}
	if rec != nil {
		panic(rec)
	}
}

func (p *Proxy) requestEvent(st *reqState, r *http.Request, now time.Time, aborted bool) eventMsg {
	e := newEvent(now, "model.request")
	e.SessionKey = st.sessionKey
	e.Profile = st.profileName()
	e.DurationMs = msPtr(now.Sub(st.start))
	switch {
	case st.resp.completed.Load():
		// A client may hang up once it has read response.completed: the request is done, not cancelled.
		e.Outcome = "completed"
	case st.cancelled.Load() || st.clientErr.Load() || r.Context().Err() != nil:
		e.Outcome = "cancelled"
	case st.transportErr != "":
		e.Outcome, e.ErrorType = "failed", "socket"
		if st.transportErr == "timeout" {
			e.ErrorType = "timeout"
		}
	case st.upstreamReadErr.Load() || aborted:
		e.Outcome, e.ErrorType = "failed", "socket"
	case st.status == http.StatusTooManyRequests:
		e.Outcome, e.ErrorType = "failed", "provider_rate_limited"
	case st.status >= 400:
		e.Outcome, e.ErrorType = "failed", "provider_error"
	default:
		e.Outcome = "completed"
	}
	data := map[string]any{"route": st.route, "stream": st.stream, "swapped": st.swapped}
	if st.status != 0 {
		data["status"] = st.status
	}
	if st.key != "" {
		data["key"] = st.key
	}
	if gc, gt := st.getConn.Load(), st.gotConn.Load(); gc != 0 && gt >= gc {
		data["conn_wait_ms"], data["conn_reused"] = ms(time.Duration(gt-gc)), st.reused.Load()
	}
	pre, ok1 := st.overheadPre()
	fb, ok2 := st.overheadFirstByte()
	if ok1 || ok2 {
		data["overhead_us"] = (pre + fb).Microseconds()
	}
	if wh, fbt := st.wroteHeaders.Load(), st.firstByte.Load(); wh != 0 && fbt >= wh {
		data["ttfb_ms"] = ms(time.Duration(fbt - wh))
	}
	if wh, fo := st.wroteHeaders.Load(), st.resp.firstOutput.Load(); wh != 0 && fo >= wh {
		data["first_output_ms"] = ms(time.Duration(fo - wh))
	}
	if t := st.resp.serviceTier(); t != "" {
		data["service_tier"] = t
	}
	if st.ws != nil {
		st.ws.summary(data)
	}
	e.Data = data
	return e
}

func asError(v any) error {
	if err, ok := v.(error); ok {
		return err
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
