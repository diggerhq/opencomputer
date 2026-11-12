// Refusals: the responses the proxy writes itself, their texts, and the log
// line each leaves.
//
// The body is `{"type":"error","error":{"type","message"}}` on every route:
// Anthropic's error shape, which also has the `error.type` and
// `error.message` an OpenAI client reads, so one body serves both families
// and a refusal made before the route is known needs no other.
//
// Texts are neutral by default; a profile may replace those in `texts` with
// its `errors` map (profile.go).
//
// Invariants: a request to upgrade gets every refusal as a 426 (a client
// that tried a WebSocket then goes on over HTTP at once, where the same
// refusal is served with its own status, websocket.go); a refusal is logged
// at most once per caller and reason in refusalLogEvery, so one session
// cannot flood the journal. Every refusal is still an event (telemetry.go).
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Texts of refusals made before, or without, a profile.
const (
	textNotFound      = "Not found: this endpoint is not served by the model proxy."
	textCredentials   = "Unexpected credentials: the model proxy injects them."
	textUnknownCaller = "This process is not a session bound to a model credential."
	textUnbound       = "This session is not bound to a model credential."
	textCallerCap     = "Too many concurrent requests from this session; retry."
	textBusy          = "The upstream has no free connection for this request; retry."
	textNoWebSocket   = "WebSocket upgrades are not served on this endpoint."
	textWSRefused     = "The upstream refused the WebSocket (%d)."
)

// texts are the refusals a profile may word itself; the JSON keys of its
// `errors` map are the field names.
type texts struct {
	require, notReady, refused, refusedPrefix, unreachable, concurrency string
}

var defaultTexts = texts{
	require:       "This request is not allowed for this session's model credential.",
	notReady:      "The model credential for this session is not ready yet; retry.",
	refused:       "Model access is unavailable for this session.",
	refusedPrefix: "Model access unavailable: ",
	unreachable:   "The model proxy could not reach the upstream.",
	concurrency:   "Too many concurrent requests on this credential; retry.",
}

func (t *texts) override(m map[string]string) error {
	for k, v := range m {
		switch k {
		case "require":
			t.require = v
		case "notReady":
			t.notReady = v
		case "refused":
			t.refused = v
		case "refusedPrefix":
			t.refusedPrefix = v
		case "unreachable":
			t.unreachable = v
		case "concurrency":
			t.concurrency = v
		default:
			return fmt.Errorf("errors: unknown key %q", k)
		}
	}
	return nil
}

// deny refuses the request.
func (s *reqState) deny(w http.ResponseWriter, reason string, status int, typ, msg string) {
	s.denyReason, s.status, s.ownErrType = reason, status, typ
	if s.upgrade {
		status, typ, msg = http.StatusUpgradeRequired, "invalid_request_error", wsUseHTTP+msg
	}
	writeAPIError(w, status, typ, msg)
}

// denyAs is deny with an envelope error_type (telemetry.go has the closed set).
func (s *reqState) denyAs(w http.ResponseWriter, reason, errType string, status int, typ, msg string) {
	s.denyErr = errType
	s.deny(w, reason, status, typ, msg)
}

// text is the profile's refusal texts, the defaults without one.
func (s *reqState) text() *texts {
	if s.prof == nil {
		return &defaultTexts
	}
	return &s.prof.text
}

type apiError struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeAPIError(w http.ResponseWriter, status int, typ, msg string) {
	b := apiErrorHeaders(w.Header(), status, typ, msg)
	w.WriteHeader(status)
	w.Write(b)
}

// apiErrorHeaders sets an API error's headers on h and returns its body.
func apiErrorHeaders(h http.Header, status int, typ, msg string) []byte {
	var e apiError
	e.Type = "error"
	e.Error.Type, e.Error.Message = typ, msg
	b, _ := json.Marshal(e)
	h.Set("Content-Type", "application/json")
	switch status {
	case http.StatusServiceUnavailable, http.StatusTooManyRequests:
		h.Set("Retry-After", "1")
		h.Set("X-Should-Retry", "true")
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUpgradeRequired:
		h.Set("X-Should-Retry", "false") // retrying cannot help; fail the turn now
	}
	return b
}

const (
	refusalLogEvery = 10 * time.Second
	refusalLogKeys  = 1024 // past it the table starts over
)

// refusalLog decides which refusals are logged.
type refusalLog struct {
	mu   sync.Mutex
	seen map[string]*refusalSeen
}

type refusalSeen struct {
	at      time.Time
	skipped int
}

// allow: whether to log this refusal, and how many like it went unlogged
// since the last one that was.
func (l *refusalLog) allow(now time.Time, caller, reason string) (ok bool, skipped int) {
	key := caller + "\x00" + reason
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.seen[key]
	switch {
	case e == nil:
		if l.seen == nil || len(l.seen) >= refusalLogKeys {
			l.seen = map[string]*refusalSeen{}
		}
		l.seen[key] = &refusalSeen{at: now}
		return true, 0
	case now.Sub(e.at) < refusalLogEvery:
		e.skipped++
		return false, 0
	}
	skipped, e.at, e.skipped = e.skipped, now, 0
	return true, skipped
}
