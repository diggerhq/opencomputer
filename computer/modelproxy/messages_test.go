package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The golden files in testdata/control are one JSON object per message type,
// exactly as it goes over the control socket (minus the newline), so a host
// test can read the same files. Host → proxy files must decode into the
// message's struct and encode back to the same object; proxy → host files
// must equal what the proxy's structs encode to.

func golden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "control", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func canon(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return v
}

func sameJSON(t *testing.T, name string, got any) {
	t.Helper()
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if want := golden(t, name); !reflect.DeepEqual(canon(t, b), canon(t, want)) {
		t.Fatalf("%s.json:\n got %s\nwant %s", name, b, want)
	}
}

func f64(v float64) *float64 { return &v }
func decode(t *testing.T, name string, into any) {
	t.Helper()
	if err := json.Unmarshal(golden(t, name), into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func TestGoldenHostToProxy(t *testing.T) {
	const unit, session = "sp-runner-abc123.service", "T0/C0/1700000000.000100"
	for name, want := range map[string]string{"bind": "bind", "bind-refuse": "bind", "release": "release", "request": "request", "synced": "synced"} {
		var head inHead
		decode(t, name, &head)
		if head.T != want {
			t.Fatalf("%s: t = %q", name, head.T)
		}
	}
	var b bindMsg
	decode(t, "bind", &b)
	if want := (bindMsg{Unit: unit, SessionKey: session, Profile: "openai-key", Vars: map[string]string{"token": "sk-example"}, Key: "k1"}); !reflect.DeepEqual(b, want) {
		t.Fatalf("bind %+v", b)
	}
	sameJSON(t, "bind", struct {
		T string `json:"t"`
		bindMsg
	}{"bind", b})

	var br bindMsg
	decode(t, "bind-refuse", &br)
	if want := (bindMsg{Unit: unit, SessionKey: session, Mode: "refuse", Reason: "paused by its owner"}); !reflect.DeepEqual(br, want) {
		t.Fatalf("bind refuse %+v", br)
	}
	sameJSON(t, "bind-refuse", struct {
		T string `json:"t"`
		bindMsg
	}{"bind", br})

	var r releaseMsg
	decode(t, "release", &r)
	if r != (releaseMsg{Unit: unit}) {
		t.Fatalf("release %+v", r)
	}
	sameJSON(t, "release", struct {
		T string `json:"t"`
		releaseMsg
	}{"release", r})

	var q requestMsg
	decode(t, "request", &q)
	if want := (requestMsg{ID: "3f0e2a1c-5b7d-4e8f-9a0b-1c2d3e4f5a6b", Profile: "openai-key", Vars: map[string]string{"token": "sk-example"},
		Method: "GET", Path: "/v1/models", Query: "limit=1", Headers: map[string]string{"Accept": "application/json"}}); !reflect.DeepEqual(q, want) {
		t.Fatalf("request %+v", q)
	}
	sameJSON(t, "request", struct {
		T string `json:"t"`
		requestMsg
	}{"request", q})
}

func TestGoldenProxyToHost(t *testing.T) {
	const unit, session, id = "sp-runner-abc123.service", "T0/C0/1700000000.000100", "3f0e2a1c-5b7d-4e8f-9a0b-1c2d3e4f5a6b"
	ps, err := compileProfiles(map[string]profileJSON{
		"openai-key": {Upstream: "https://api.example.com", Routes: map[string]routeJSON{"GET /v1/models": {}}, Client: map[string]string{"codex": "api-key"}},
		"plain":      {Upstream: "https://api.example.com", Routes: map[string]routeJSON{"GET /v1/models": {}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := NewControl("3b8618e", ps)
	c.bindings = NewBindings(ps, "", c, func() {})
	sameJSON(t, "hello", c.hello([]persisted{
		{Unit: unit, SessionKey: session, Profile: "openai-key", Key: "k1"},
		{Unit: "sp-runner-def456.service", SessionKey: "T0/C0/1700000000.000200"},
	}))
	sameJSON(t, "bound", boundMsg{T: "bound", Unit: unit, SessionKey: session, Profile: "openai-key", Key: "k1"})
	sameJSON(t, "bound-refuse", boundMsg{T: "bound", Unit: unit, SessionKey: session, Mode: "refuse"})
	sameJSON(t, "refused", refusedMsg{T: "refused", Unit: unit, SessionKey: "T0/C0/1700000000.000200", Reason: "unit bound to another session"})
	sameJSON(t, "observed", observedMsg{T: "observed", SessionKey: session, Unit: unit, Key: "k1", Profile: "openai-key", Status: 429,
		Headers: map[string]string{"retry-after": "30"}, Body: `{"error":{"type":"rate_limit_exceeded"}}`})
	sameJSON(t, "observed-error", observedMsg{T: "observed", SessionKey: session, Unit: unit, Key: "k1", Profile: "openai-key", Error: "connect"})
	sameJSON(t, "response", responseMsg{T: "response", ID: id, Status: 200, Headers: map[string]string{"retry-after": "30"}, Body: `{"data":[]}`})
	sameJSON(t, "response-error", responseMsg{T: "response", ID: id, Error: "connect"})
	sameJSON(t, "event", eventMsg{T: "event", Name: "model.request", At: 1792520091000, Outcome: "completed", DurationMs: f64(1234.5), SessionKey: session, Provider: "openai-key",
		Data: map[string]any{"route": "responses", "stream": true, "swapped": false, "status": 200, "fingerprint": "k1", "overhead_us": 180, "ttfb_ms": 812.4}})
}
