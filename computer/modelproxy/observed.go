// What upstreams answer, reported to the host as `observed`: the proxy says
// what it saw and the host decides what it means (a spent quota, a revoked
// credential, an outage). For a binding with a key, each upstream answer is
// a candidate:
//
//	status   the response's (a WebSocket: 101 for the handshake, 200 for
//	         each response completed on it, an `error` event's own status)
//	headers  the response headers the profile's `report` globs name
//	body     the start of a 4xx/5xx body that is not an event stream
//	error    instead of a status: the transport error's class (upstream.go)
//
// Per profile and key, sent:
//   - every 401;
//   - an answer below 400: the first, the first after a failure, and
//     otherwise at most once a minute (its headers carry the figures);
//   - any other: when the status or error class changes; with the same one,
//     when the reported headers differ (at most once a second), and at least
//     once a minute;
//   - but not a change back to the status or class before the last, within
//     a second of that one's report: answers that alternate (some requests
//     limited, some not) are not one message each.
//
// So never one per request in the steady state.
//
// A body's start is copied as the client reads it, never ahead of it; the
// report waits for it at most errorBodyWait (headBody).
package main

import (
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	observedEvery    = time.Minute
	observedBurst    = time.Second
	observedBody     = 2 << 10
	observedKeep     = 10 * time.Minute // a key not seen this long is forgotten
	observedPruneAt  = 1024
	statusFirstError = 400
)

// errorBodyWait bounds how long a report waits for the body (a var for tests).
var errorBodyWait = 2 * time.Second

type Observer struct {
	mu  sync.Mutex
	m   map[string]*observedSeen
	out sender
	now func() time.Time
}

type observedSeen struct {
	class  string // "ok", else the status or error class
	hdrSig string
	sentAt time.Time
	// The class before this one and when it was last sent.
	prevClass string
	prevAt    time.Time
}

func NewObserver(out sender) *Observer {
	return &Observer{m: map[string]*observedSeen{}, out: out, now: time.Now}
}

// subject is whose answer it is.
type subject struct {
	prof                  *profile
	sessionKey, unit, key string
}

func (st *reqState) subject() subject {
	return subject{prof: st.prof, sessionKey: st.sessionKey, unit: st.unit, key: st.key}
}

// response reports an upstream response; body is the start of its body, if kept.
func (o *Observer) response(s subject, status int, hdr http.Header, body []byte) {
	if s.key == "" {
		return
	}
	msg := observedMsg{T: "observed", SessionKey: s.sessionKey, Unit: s.unit, Key: s.key, Profile: s.prof.name,
		Status: status, Headers: reported(s.prof.report, hdr), Body: string(body[:min(len(body), observedBody)])}
	class := "ok"
	if status >= statusFirstError {
		class = strconv.Itoa(status)
	}
	o.report(msg, class, status == http.StatusUnauthorized)
}

// transport reports a request that got no response: class is errorClass's.
func (o *Observer) transport(s subject, class string) {
	if s.key == "" || class == "canceled" {
		return
	}
	o.report(observedMsg{T: "observed", SessionKey: s.sessionKey, Unit: s.unit, Key: s.key, Profile: s.prof.name, Error: class}, class, false)
}

func (o *Observer) report(msg observedMsg, class string, always bool) {
	now := o.now()
	sig := headerSig(msg.Headers)
	id := msg.Profile + "\x00" + msg.Key
	o.mu.Lock()
	seen := o.m[id]
	send := always || seen == nil || seen.class != class
	if !send {
		age := now.Sub(seen.sentAt)
		send = age >= observedEvery || (class != "ok" && seen.hdrSig != sig && age >= observedBurst)
	}
	if send && !always && seen != nil && seen.class != class && seen.prevClass == class && now.Sub(seen.prevAt) < observedBurst {
		send = false // flapping
	}
	if send {
		next := &observedSeen{class: class, hdrSig: sig, sentAt: now}
		if seen != nil {
			next.prevClass, next.prevAt = seen.prevClass, seen.prevAt
			if seen.class != class {
				next.prevClass, next.prevAt = seen.class, seen.sentAt
			}
		}
		if seen == nil && len(o.m) >= observedPruneAt {
			for k, v := range o.m {
				if now.Sub(v.sentAt) > observedKeep {
					delete(o.m, k)
				}
			}
		}
		o.m[id] = next
	}
	o.mu.Unlock()
	if send {
		o.out.send(msg)
	}
}

// reported is the headers matching the profile's `report` globs, names in
// lower case; nil when there are none.
func reported(globs []string, hdr http.Header) map[string]string {
	if len(globs) == 0 {
		return nil
	}
	var out map[string]string
	for name, vals := range hdr {
		lower := strings.ToLower(name)
		if len(vals) == 0 || !matchesAny(globs, lower) {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[lower] = strings.Join(vals, ", ")
	}
	return out
}

func headerSig(h map[string]string) string {
	if len(h) == 0 {
		return ""
	}
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(h[k])
		b.WriteByte('\n')
	}
	return b.String()
}

// headBody copies the first limit bytes of a body as the client reads them,
// and reports once: at that many bytes, the end of the body, its close, or
// errorBodyWait after the headers (a stalled body still reports, with what
// has arrived).
type headBody struct {
	io.ReadCloser
	limit  int
	report func(head []byte)
	timer  *time.Timer

	mu   sync.Mutex
	buf  []byte
	done bool
}

func newHeadBody(rc io.ReadCloser, limit int, report func([]byte)) *headBody {
	b := &headBody{ReadCloser: rc, limit: limit, report: report}
	b.mu.Lock() // fire may run before AfterFunc returns: it reads timer under mu
	b.timer = time.AfterFunc(errorBodyWait, b.fire)
	b.mu.Unlock()
	return b
}

func (b *headBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.mu.Lock()
	full := false
	if !b.done {
		b.buf = append(b.buf, p[:min(n, b.limit-len(b.buf))]...)
		full = len(b.buf) >= b.limit
	}
	b.mu.Unlock()
	if full || err != nil {
		b.fire()
	}
	return n, err
}

func (b *headBody) Close() error {
	b.fire()
	return b.ReadCloser.Close()
}

// fire reports once, with the head kept so far.
func (b *headBody) fire() {
	b.mu.Lock()
	if b.done {
		b.mu.Unlock()
		return
	}
	b.done = true
	head, timer := b.buf, b.timer
	b.mu.Unlock()
	timer.Stop()
	b.report(head)
}
