package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"
)

// The golden files in testdata/control are one JSON object per message type,
// exactly as it goes over the control socket (minus the newline), so a
// binder's test can read the same files. Binder → proxy files must decode
// into the frame's struct and encode back to the same object; proxy → binder
// files must equal what the proxy's structs encode to.

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

func TestGoldenBinderToProxy(t *testing.T) {
	const caller, session = "abc123", "T0/C0/1700000000.000100"
	for name, want := range map[string]string{"bind": "bind", "bind-refuse": "bind", "release": "release", "request": "request", "synced": "synced"} {
		var head inHead
		decode(t, name, &head)
		if head.T != want {
			t.Fatalf("%s: t = %q", name, head.T)
		}
	}
	var b bindMsg
	decode(t, "bind", &b)
	if want := (bindMsg{ID: "b1", Caller: caller, SessionKey: session, Profile: "openai-key", Vars: map[string]string{"token": "sk-example"}, Key: "k1"}); !reflect.DeepEqual(b, want) {
		t.Fatalf("bind %+v", b)
	}
	sameJSON(t, "bind", struct {
		T string `json:"t"`
		bindMsg
	}{"bind", b})

	var br bindMsg
	decode(t, "bind-refuse", &br)
	if want := (bindMsg{Caller: caller, SessionKey: session, Mode: "refuse", Reason: "paused by its owner"}); !reflect.DeepEqual(br, want) {
		t.Fatalf("bind refuse %+v", br)
	}
	sameJSON(t, "bind-refuse", struct {
		T string `json:"t"`
		bindMsg
	}{"bind", br})

	var r releaseMsg
	decode(t, "release", &r)
	if r != (releaseMsg{Caller: caller}) {
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

func TestGoldenProxyToBinder(t *testing.T) {
	const caller, session, id = "abc123", "T0/C0/1700000000.000100", "3f0e2a1c-5b7d-4e8f-9a0b-1c2d3e4f5a6b"
	ps, err := compileProfiles(map[string]profileJSON{
		"openai-key": {Upstream: "https://api.example.com", Routes: map[string]routeJSON{"GET /v1/models": {}},
			Set: map[string]string{"Authorization": "Bearer {token}"}, Harness: map[string]any{"codex": map[string]any{}}},
		"plain": {Upstream: "https://api.example.com", Routes: map[string]routeJSON{"GET /v1/models": {}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := NewControl("3b8618e", testPlaceholder, ps)
	sameJSON(t, "hello", c.hello([]bindingInfo{
		{Caller: caller, SessionKey: session, Mode: modeProfile, Profile: "openai-key", Key: "k1"},
		{Caller: "def456", SessionKey: "T0/C0/1700000000.000200", Mode: modeRefuse},
	}))
	sameJSON(t, "bound", boundMsg{T: "bound", ID: "b1", Caller: caller, SessionKey: session, Key: "k1"})
	sameJSON(t, "refused", refusedMsg{T: "refused", ID: "b1", Caller: caller, Code: refuseCallerInUse, Message: "the caller is bound to another session"})
	sameJSON(t, "observed", observedMsg{T: "observed", SessionKey: session, Caller: caller, Key: "k1", Profile: "openai-key", Status: 429,
		Headers: map[string]string{"retry-after": "30"}, Body: `{"error":{"type":"rate_limit_exceeded"}}`})
	sameJSON(t, "observed-error", observedMsg{T: "observed", SessionKey: session, Caller: caller, Key: "k1", Profile: "openai-key", Error: "connect"})
	sameJSON(t, "response", responseMsg{T: "response", ID: id, Status: 200, Headers: map[string]string{"retry-after": "30"}, Body: `{"data":[]}`})
	sameJSON(t, "response-error", responseMsg{T: "response", ID: id, Error: responseUnreachable})
}

// keysOf is a frame's field names, with its `data` object's.
func keysOf(m map[string]any) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	if d, ok := m["data"].(map[string]any); ok {
		for k := range d {
			ks = append(ks, "data."+k)
		}
	}
	slices.Sort(ks)
	return ks
}

// Every event the proxy sends has a golden example with the same fields:
// each is taken here from a running proxy, not built by hand.
func TestGoldenEvents(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 2 * time.Second})
	k := h.dialControl()
	go func() {
		time.Sleep(100 * time.Millisecond)
		k.bind(testCaller, "s1", "tok", "fp1")
	}()
	for range 2 { // held then served; then one on the connection it left
		res := do(t, h, testCaller)
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
	req := h.messagesReq(context.Background())
	req.URL.Path = "/v1/nope"
	res, err := h.client(testCaller).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	h.srv.control.send(mainPool(h))

	got := map[string]map[string]any{}
	for len(got) < 6 {
		m := k.waitFor(isT("event"))
		name := m["name"].(string)
		if name == "model.request" && evData(m)["conn_reused"] != true {
			continue // the golden one found its connection in the pool
		}
		got[name] = m
	}
	for name, file := range map[string]string{"model.request": "event-request", "model.held": "event-held", "model.denied": "event-denied",
		"model.binding": "event-binding", "model.pool": "event-pool", "model.proxy_started": "event-proxy-started"} {
		want := canon(t, golden(t, file)).(map[string]any)
		if want["name"] != name {
			t.Fatalf("%s.json is a %v", file, want["name"])
		}
		if g, w := keysOf(got[name]), keysOf(want); !slices.Equal(g, w) {
			t.Errorf("%s:\n got %v\nwant %v", name, g, w)
		}
	}
}
