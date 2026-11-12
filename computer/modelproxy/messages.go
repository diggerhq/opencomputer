// The host ↔ proxy wire contract, JSON lines on the control socket. Unknown
// `t` values and unknown fields are ignored. Nothing here ever carries a
// binding's variables proxy → host.
//
//	host → proxy   bind, release, synced, request
//	proxy → host   hello, bound, refused, observed, response, event
//
// Golden examples of every message: testdata/control/<t>.json.
package main

import "time"

// host → proxy: `t` is read first (inHead), then the line is decoded into the
// message's own struct: bindMsg (bindings.go), releaseMsg, requestMsg
// (request.go); `synced` has no fields.
type inHead struct {
	T string `json:"t"`
}

type releaseMsg struct {
	Unit string `json:"unit"`
}

// helloMsg is the proxy's first line on a control connection: the profiles
// it loaded, each with what its `client` and `runner` fields say (for the
// host; the proxy does not read them), and the bindings it knows, so the
// host re-sends their binds. Providers is the profile names again, for a
// host from before profiles.
type helloMsg struct {
	T         string                  `json:"t"`
	Version   string                  `json:"version"`
	Profiles  map[string]helloProfile `json:"profiles"`
	Providers []string                `json:"providers"`
	Bindings  []helloBinding          `json:"bindings"`
}

type helloProfile struct {
	Client map[string]string `json:"client,omitempty"`
	Runner map[string]any    `json:"runner,omitempty"`
}

// helloBinding: Fingerprint and Provider repeat Key and Profile under their
// pre-profile names, only when -default-profile is set (Provider absent for
// that profile, as such a host expects).
type helloBinding struct {
	Unit        string `json:"unit"`
	SessionKey  string `json:"sessionKey"`
	Profile     string `json:"profile,omitempty"`
	Key         string `json:"key,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Provider    string `json:"provider,omitempty"`
}

// boundMsg: a bind took effect. Mode is "refuse" or absent. To a bind in the
// pre-profile terms the answer also has them: Mode ("subscription" for a
// credential), Fingerprint and the bind's own Provider.
type boundMsg struct {
	T           string `json:"t"`
	Unit        string `json:"unit"`
	SessionKey  string `json:"sessionKey"`
	Profile     string `json:"profile,omitempty"`
	Key         string `json:"key,omitempty"`
	Mode        string `json:"mode,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Provider    string `json:"provider,omitempty"`
}

type refusedMsg struct {
	T          string `json:"t"`
	Unit       string `json:"unit"`
	SessionKey string `json:"sessionKey"`
	Reason     string `json:"reason"`
}

// observedMsg is what an upstream answered a binding (observed.go): the
// status, the response headers the profile's `report` names, the start of an
// error's body, or the class of a transport error. What it means is the
// host's to decide.
type observedMsg struct {
	T          string            `json:"t"`
	SessionKey string            `json:"sessionKey"`
	Unit       string            `json:"unit"`
	Key        string            `json:"key"`
	Profile    string            `json:"profile"`
	Status     int               `json:"status,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body,omitempty"`
	Error      string            `json:"error,omitempty"`
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

type responseMsg struct {
	T       string            `json:"t"`
	ID      string            `json:"id"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Error   string            `json:"error,omitempty"`
}

// eventMsg is a telemetry event for the host to relay (the names and keys
// are in computer/src/telemetry/catalog.ts). The proxy emits exactly:
// model.request, model.held, model.denied, model.proxy_started,
// model.binding, model.pool. `data` values are scalars; never variables,
// placeholders, bodies or upstream text. Provider is the envelope's
// `provider` dimension: the profile's name, wherever the request's or
// binding's profile is known.
type eventMsg struct {
	T          string         `json:"t"`
	Name       string         `json:"name"`
	At         int64          `json:"at"`
	Outcome    string         `json:"outcome,omitempty"`
	DurationMs *float64       `json:"duration_ms,omitempty"`
	ErrorType  string         `json:"error_type,omitempty"`
	SessionKey string         `json:"session_key,omitempty"`
	Provider   string         `json:"provider,omitempty"`
	Data       map[string]any `json:"data,omitempty"`
}

func newEvent(at time.Time, name string) eventMsg {
	return eventMsg{T: "event", Name: name, At: at.UnixMilli()}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func msPtr(d time.Duration) *float64 { v := ms(d); return &v }
