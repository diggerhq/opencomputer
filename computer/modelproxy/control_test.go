package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func do(t *testing.T, h *harness, caller string) *http.Response {
	t.Helper()
	res, err := h.client(caller).Do(h.messagesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func okUpstream() (http.Handler, *atomic.Int64) {
	var hits atomic.Int64
	return recordingUpstream(&hits, make(chan seen, 1)), &hits
}

func TestHelloFirst(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{restore: []bindingInfo{{Caller: testCaller, SessionKey: "s1", Mode: modeProfile, Profile: mainProfile, Key: "fp1"}}})
	k := h.dialControl()
	m := <-k.msgs
	if m["t"] != "hello" || m["version"] == nil {
		t.Fatalf("first line %v", m)
	}
	if m["protocol"] != float64(controlProtocol) || m["placeholder"] != testPlaceholder {
		t.Fatalf("hello %v", m)
	}
	if toJSON(m["bindings"]) != `[{"caller":"abc123","key":"fp1","mode":"profile","profile":"claude-oauth","sessionKey":"s1"}]` {
		t.Fatalf("hello bindings %v", m["bindings"])
	}
	// The profiles by name, each with the variables a bind must give and
	// its `harness` as written.
	ps := m["profiles"].([]any)
	var names []string
	for _, p := range ps {
		names = append(names, p.(map[string]any)["name"].(string))
	}
	if toJSON(names) != `["alt","anthropic-key","claude-oauth","openai-key","openrouter"]` {
		t.Fatalf("hello profiles %v", names)
	}
	if toJSON(ps[0]) != `{"harness":{"codex":{"cache":"1h"}},"name":"alt","vars":["accountId","token"]}` ||
		toJSON(ps[2]) != `{"harness":{"claude":{"promptCacheTtl":"1h","tokenEnv":"CLAUDE_CODE_OAUTH_TOKEN"}},"name":"claude-oauth","vars":["token"]}` {
		t.Fatalf("hello profiles %v", ps)
	}
	// model.proxy_started, sent before any binder connected, is kept for the first.
	ev := k.waitFor(isEvent("model.proxy_started"))
	if ev["data"].(map[string]any)["bindings"] != float64(1) {
		t.Fatalf("event %v", ev)
	}
}

func TestBindStateMachine(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 300 * time.Millisecond})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("bound: %d", res.StatusCode)
	}
	bindingEvent := func(action string) map[string]any {
		t.Helper()
		ev := k.waitFor(func(m map[string]any) bool {
			return m["name"] == "model.binding" && m["data"].(map[string]any)["action"] == action
		})
		d := ev["data"].(map[string]any)
		if d["caller"] != testCaller || d["token"] != nil || ev["session_key"] == nil {
			t.Fatalf("binding event %v", ev)
		}
		return d
	}
	if d := bindingEvent("bind"); d["key"] != "fp1" || d["mode"] != "profile" {
		t.Fatalf("bind event %v", d)
	}

	// The same bind again changes nothing: `bound`, no event.
	k.send(map[string]any{"t": "bind", "id": "again", "caller": testCaller, "sessionKey": "s1", "profile": mainProfile, "vars": map[string]string{"token": "tok"}, "key": "fp1"})
	if m := k.waitFor(func(m map[string]any) bool { return m["t"] == "bound" || m["name"] == "model.binding" }); m["t"] != "bound" || m["id"] != "again" {
		t.Fatalf("the same bind again: %v", m)
	}

	// Another session for the same caller: refused, the binding stays.
	k.send(map[string]any{"t": "bind", "id": "b2", "caller": testCaller, "sessionKey": "s2", "profile": mainProfile, "vars": map[string]string{"token": "tok2"}, "key": "fp2"})
	m := k.waitFor(isT("refused"))
	if m["caller"] != testCaller || m["id"] != "b2" || m["code"] != refuseCallerInUse || m["message"] == "" {
		t.Fatalf("refused %v", m)
	}
	bindingEvent("refused")
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("after refused bind: %d", res.StatusCode)
	}
	// Malformed binds are refused too, each with its code.
	tok := map[string]string{"token": "x"}
	for _, c := range []struct {
		code string
		bad  map[string]any
	}{
		{refuseBadFrame, map[string]any{"caller": "sp-runner-x.service/y", "sessionKey": "s3", "profile": mainProfile, "vars": tok, "key": "k"}},
		{refuseBadFrame, map[string]any{"caller": "x", "profile": mainProfile, "vars": tok, "key": "k"}},
		{refuseBadFrame, map[string]any{"caller": "x", "sessionKey": "s3", "profile": mainProfile, "mode": "other", "vars": tok, "key": "k"}},
		{refuseBadFrame, map[string]any{"caller": "x", "sessionKey": "s3", "profile": mainProfile, "vars": "token", "key": "k"}},
		{refuseMissingVar, map[string]any{"caller": "x", "sessionKey": "s3", "profile": mainProfile, "key": "k"}},
		{refuseMissingVar, map[string]any{"caller": "x", "sessionKey": "s3", "profile": mainProfile, "vars": map[string]string{"token": "x\r\ny: z"}, "key": "k"}},
		{refuseUnknownProfile, map[string]any{"caller": "x", "sessionKey": "s3", "profile": "nope", "vars": tok, "key": "k"}},
		{refuseUnknownProfile, map[string]any{"caller": "x", "sessionKey": "s3", "vars": tok, "key": "k"}},
		{refuseBadKey, map[string]any{"caller": "x", "sessionKey": "s3", "profile": mainProfile, "vars": tok}},
		{refuseBadKey, map[string]any{"caller": "x", "sessionKey": "s3", "profile": mainProfile, "vars": tok, "key": "a key"}},
	} {
		c.bad["t"] = "bind"
		k.send(c.bad)
		if m := k.waitFor(isT("refused")); m["code"] != c.code || m["message"] == "" || strings.Contains(toJSON(m), "y: z") {
			t.Fatalf("refused %v, want %q for %v", m, c.code, c.bad)
		}
	}

	// Unknown t values and fields are ignored.
	k.send(map[string]any{"t": "future", "x": 1})

	// Mode refuse: 401 with the reason, upstream untouched.
	before := hits.Load()
	k.send(map[string]any{"t": "bind", "caller": testCaller, "sessionKey": "s1", "mode": "refuse", "reason": "paused by its owner"})
	k.waitFor(func(m map[string]any) bool { return m["t"] == "bound" && m["key"] == nil })
	res := do(t, h, testCaller)
	if res.StatusCode != 401 {
		t.Fatalf("refuse: %d", res.StatusCode)
	}
	if e := decodeAPIError(t, res); e.Error.Type != "authentication_error" || !strings.Contains(e.Error.Message, "paused by its owner") {
		t.Fatalf("refuse error %+v", e)
	}
	if ev := k.waitFor(isEvent("model.denied")); ev["data"].(map[string]any)["reason"] != "refused" {
		t.Fatalf("event %v", ev)
	}
	if hits.Load() != before {
		t.Fatal("refuse reached upstream")
	}

	// Release: the caller is unknown again; held, then 401, since the
	// binder has said it sent every bind.
	k.send(map[string]any{"t": "synced"})
	k.send(map[string]any{"t": "release", "caller": testCaller})
	if d := bindingEvent("release"); d["mode"] != "refuse" {
		t.Fatalf("release event %v", d)
	}
	start := time.Now()
	res = do(t, h, testCaller)
	if res.StatusCode != 401 || time.Since(start) < 250*time.Millisecond {
		t.Fatalf("released: %d after %v", res.StatusCode, time.Since(start))
	}
	ev := k.waitFor(isEvent("model.held"))
	if ev["outcome"] != "timed_out" || ev["data"].(map[string]any)["released"] != "timeout" {
		t.Fatalf("held event %v", ev)
	}
	// After release the caller may serve a new session.
	h.bindReady(k, testCaller, "s9", "tok9", "fp9")
}

func TestHoldThenServeWhenBindArrivesLate(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 3 * time.Second})
	k := h.dialControl()
	go func() {
		time.Sleep(200 * time.Millisecond)
		k.bind(testCaller, "s1", "tok", "fp1")
	}()
	start := time.Now()
	res := do(t, h, testCaller)
	if res.StatusCode != 200 || time.Since(start) < 150*time.Millisecond {
		t.Fatalf("status %d after %v", res.StatusCode, time.Since(start))
	}
	ev := k.waitFor(isEvent("model.held"))
	d := ev["data"].(map[string]any)
	if d["released"] != "bound" || d["held_ms"].(float64) < 150 || ev["session_key"] != "s1" {
		t.Fatalf("held event %v", ev)
	}
}

func TestHoldTimeout503ForKnownCaller(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 300 * time.Millisecond,
		restore: []bindingInfo{{Caller: testCaller, SessionKey: "s1", Mode: modeProfile, Profile: mainProfile, Key: "fp1"}}})
	res := do(t, h, testCaller)
	if res.StatusCode != 503 || res.Header.Get("Retry-After") != "1" {
		t.Fatalf("status %d retry-after %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
	if e := decodeAPIError(t, res); e.Error.Type != "api_error" {
		t.Fatalf("error %+v", e)
	}
	if hits.Load() != 0 {
		t.Fatal("upstream contacted")
	}
}

// After a restart: persisted callers are held; `synced` does not end the hold
// or drop them; a bind after `synced` still serves the held request; a caller
// never re-bound gets 503 at the cap.
func TestPersistedBindingsAndSynced(t *testing.T) {
	const other = "other"
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 1500 * time.Millisecond, restore: []bindingInfo{
		{Caller: testCaller, SessionKey: "s1", Mode: modeProfile, Profile: mainProfile, Key: "fp1"},
		{Caller: other, SessionKey: "s2", Mode: modeProfile, Profile: mainProfile, Key: "fp2"},
	}})
	k := h.dialControl()
	k.waitFor(isT("hello"))

	type result struct {
		status int
		took   time.Duration
	}
	run := func(caller string) chan result {
		ch := make(chan result, 1)
		go func() {
			start := time.Now()
			res, err := h.client(caller).Do(h.messagesReq(context.Background()))
			if err != nil {
				t.Error(err)
				ch <- result{}
				return
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			ch <- result{res.StatusCode, time.Since(start)}
		}()
		return ch
	}
	a, b := run(testCaller), run(other)
	time.Sleep(100 * time.Millisecond)
	k.send(map[string]any{"t": "synced"})
	time.Sleep(200 * time.Millisecond)
	k.bind(testCaller, "s1", "tok", "fp1")
	ra, rb := <-a, <-b
	if ra.status != 200 || ra.took < 250*time.Millisecond {
		t.Fatalf("re-bound caller: %+v", ra)
	}
	if rb.status != 503 || rb.took < 1400*time.Millisecond {
		t.Fatalf("never re-bound caller: %+v", rb)
	}
	// Still known: only `release` removes it.
	if h.srv.bindings.Len() != 2 {
		t.Fatalf("bindings %d", h.srv.bindings.Len())
	}

	// The file has the bindings and never a variable.
	h.srv.persist.flush()
	raw, err := os.ReadFile(h.srv.cfg.bindingsFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "tok") || !strings.Contains(string(raw), testCaller) {
		t.Fatalf("bindings file %s", raw)
	}
	st, _ := os.Stat(h.srv.cfg.bindingsFile)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
}

// The binder restarting (control connection closed) keeps every binding and
// variable; serving continues; the next `hello` lists them.
func TestControlDisconnectKeepsBindings(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 300 * time.Millisecond})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	k.c.Close()
	time.Sleep(50 * time.Millisecond)
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("after the binder disconnected: %d", res.StatusCode)
	}
	k2 := h.dialControl()
	m := k2.waitFor(isT("hello"))
	bs := m["bindings"].([]any)
	if len(bs) != 1 || bs[0].(map[string]any)["key"] != "fp1" {
		t.Fatalf("hello %v", m)
	}
}

// A new control connection replaces the old one.
func TestControlReplaced(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{})
	k1 := h.dialControl()
	k1.waitFor(isT("hello"))
	k2 := h.dialControl()
	k2.waitFor(isT("hello"))
	select {
	case _, ok := <-k1.msgs:
		for ok {
			_, ok = <-k1.msgs
		}
	case <-time.After(2 * time.Second):
		t.Fatal("old connection not closed")
	}
	h.bindReady(k2, testCaller, "s1", "tok", "fp1")
}

// Until the binder says `synced`, a caller without a binding may be one whose
// bind is on its way: 503, retryable. After it, such a caller is unknown: 401.
func TestUnboundBeforeAndAfterSynced(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 50 * time.Millisecond})
	k := h.dialControl()
	k.waitFor(isT("hello"))
	res := do(t, h, testCaller)
	if e := decodeAPIError(t, res); res.StatusCode != 503 || res.Header.Get("Retry-After") != "1" || e.Error.Type != "api_error" {
		t.Fatalf("before synced: %d %+v", res.StatusCode, e)
	}
	k.send(map[string]any{"t": "synced"})
	k.send(map[string]any{"t": "release", "caller": "nobody"}) // processed after synced
	h.bindReady(k, altCaller, "s2", "tok", "fp2")
	res = do(t, h, testCaller)
	if e := decodeAPIError(t, res); res.StatusCode != 401 || e.Error.Type != "authentication_error" {
		t.Fatalf("after synced: %d %+v", res.StatusCode, e)
	}
	if ev := k.waitFor(isEvent("model.denied")); evData(ev)["reason"] != "unbound" {
		t.Fatalf("event %v", ev)
	}
	if hits.Load() != 0 {
		t.Fatal("upstream contacted")
	}
}

// A binder that connects again gets every binding in its `hello`, and the
// callers kept serving meanwhile.
func TestReconnectingBinderGetsBindings(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	k.c.Close()
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("without a binder: %d", res.StatusCode)
	}
	m := h.dialControl().waitFor(isT("hello"))
	if toJSON(m["bindings"]) != `[{"caller":"abc123","key":"fp1","mode":"profile","profile":"claude-oauth","sessionKey":"s1"}]` {
		t.Fatalf("hello bindings %v", m["bindings"])
	}
}

// flakyListener fails its first accepts.
type flakyListener struct {
	net.Listener
	fails atomic.Int64
}

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.fails.Add(-1) >= 0 {
		return nil, errors.New("accept: too many open files")
	}
	return l.Listener.Accept()
}

// A failed accept does not end the control socket.
func TestControlAcceptRetried(t *testing.T) {
	ps, err := loadProfiles("profiles")
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fl := &flakyListener{Listener: l}
	fl.fails.Store(3)
	c := NewControl("test", testPlaceholder, ps)
	c.bindings = NewBindings(ps, c, nil)
	go c.Serve(fl)
	defer c.Close()
	defer l.Close()
	conn, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(line, `"t":"hello"`) {
		t.Fatalf("after failed accepts: %q %v", line, err)
	}
}
