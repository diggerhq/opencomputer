// The binder ↔ proxy wire contract: JSON lines on the control socket, every
// frame type in the order of its golden example in testdata/control/. The
// binder is whoever holds the control socket: on a computer, the host.
//
//	binder → proxy   bind, release, synced, request
//	proxy → binder   hello, bound, refused, observed, response, event
//
// Invariants: unknown `t` values and unknown fields are ignored; nothing
// here carries a binding's variables proxy → binder; every binder → proxy
// frame is an idempotent operation on a named thing (put a binding, delete a
// binding, make a request).
package main

import "time"

// controlProtocol is `hello.protocol`: it changes when a frame's meaning does.
const controlProtocol = 1

// inHead: `t` is read first, then the line is decoded into the frame's own
// struct; `synced` has no fields.
type inHead struct {
	T string `json:"t"`
}

// helloMsg is the proxy's first line on a control connection: what it
// serves, and the bindings it holds, so the binder re-sends their binds.
type helloMsg struct {
	T           string         `json:"t"`
	Version     string         `json:"version"`
	Protocol    int            `json:"protocol"`
	Placeholder string         `json:"placeholder"`
	Profiles    []helloProfile `json:"profiles"`
	Bindings    []bindingInfo  `json:"bindings"`
}

// helloProfile: Vars are the names a bind to it must give; Harness is the
// profile's `harness` object as written (the proxy does not read it).
type helloProfile struct {
	Name    string         `json:"name"`
	Vars    []string       `json:"vars"`
	Harness map[string]any `json:"harness"`
}

// bindingInfo is a binding without its variables: as listed in `hello` and
// as written to the bindings file (persist.go).
type bindingInfo struct {
	Caller     string `json:"caller"`
	SessionKey string `json:"sessionKey"`
	Mode       string `json:"mode"` // profile | refuse
	Profile    string `json:"profile,omitempty"`
	Key        string `json:"key,omitempty"`
}

// bindMsg puts a binding: the caller's requests go to Profile with Vars, or
// (Mode "refuse") are answered 401 with Reason. ID, if set, is echoed on the
// answer.
type bindMsg struct {
	ID         string            `json:"id,omitempty"`
	Caller     string            `json:"caller"`
	SessionKey string            `json:"sessionKey"`
	Profile    string            `json:"profile,omitempty"`
	Vars       map[string]string `json:"vars,omitempty"`
	Key        string            `json:"key,omitempty"`
	Mode       string            `json:"mode,omitempty"` // "refuse", or absent
	Reason     string            `json:"reason,omitempty"`
}

// boundMsg: the bind is in effect for the caller's next request.
type boundMsg struct {
	T          string `json:"t"`
	ID         string `json:"id,omitempty"`
	Caller     string `json:"caller"`
	SessionKey string `json:"sessionKey"`
	Key        string `json:"key,omitempty"`
}

// refusedMsg: the bind was not applied. Code is one of the refuse* constants.
type refusedMsg struct {
	T       string `json:"t"`
	ID      string `json:"id,omitempty"`
	Caller  string `json:"caller"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

const (
	refuseUnknownProfile = "unknown_profile"
	refuseMissingVar     = "missing_var"
	refuseBadKey         = "bad_key"
	refuseCallerInUse    = "caller_in_use"
	refuseBadFrame       = "bad_frame"
)

// releaseMsg deletes a binding; an unknown caller is not an error.
type releaseMsg struct {
	Caller string `json:"caller"`
}

// requestMsg asks the proxy to make one request on a profile with the given
// variables, which are not stored (request.go); responseMsg is its answer.
type requestMsg struct {
	ID      string            `json:"id"`
	Profile string            `json:"profile"`
	Vars    map[string]string `json:"vars,omitempty"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// responseMsg: Error, when set, is one of the response* constants.
type responseMsg struct {
	T       string            `json:"t"`
	ID      string            `json:"id"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Error   string            `json:"error,omitempty"`
}

const (
	responseUnknownProfile = "unknown_profile"
	responseUnknownRoute   = "unknown_route"
	responseMissingVar     = "missing_var"
	responseBadRequest     = "bad_request"
	responseBusy           = "busy"
	responseTimeout        = "timeout"
	responseUnreachable    = "unreachable"
)

// observedMsg is what an upstream answered a credential (observed.go): the
// status, the response headers the profile's `report` names (names in lower
// case, repeated values joined with ", "), the start of an error's body, or
// the class of a transport error. What it means is the binder's to decide.
type observedMsg struct {
	T          string            `json:"t"`
	SessionKey string            `json:"sessionKey"`
	Caller     string            `json:"caller"`
	Key        string            `json:"key"`
	Profile    string            `json:"profile"`
	Status     int               `json:"status,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body,omitempty"`
	Error      string            `json:"error,omitempty"`
}

// eventMsg is a telemetry event for the binder to relay (README.md lists
// every one with its `data`; testdata/control/event-*.json has an example of
// each). `data` values are scalars; never variables, placeholders, bodies or
// upstream text. Profile is the request's or binding's, once it is known.
type eventMsg struct {
	T          string         `json:"t"`
	Name       string         `json:"name"`
	At         int64          `json:"at"`
	Outcome    string         `json:"outcome,omitempty"`
	DurationMs *float64       `json:"duration_ms,omitempty"`
	ErrorType  string         `json:"error_type,omitempty"`
	SessionKey string         `json:"session_key,omitempty"`
	Profile    string         `json:"profile,omitempty"`
	Data       map[string]any `json:"data,omitempty"`
}

func newEvent(at time.Time, name string) eventMsg {
	return eventMsg{T: "event", Name: name, At: at.UnixMilli()}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func msPtr(d time.Duration) *float64 { v := ms(d); return &v }
