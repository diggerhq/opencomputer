package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func do(t *testing.T, h *harness, unit string) *http.Response {
	t.Helper()
	res, err := h.client(unit).Do(h.messagesReq(context.Background()))
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
	h := newHarness(t, up, harnessOpts{restore: []persisted{{Unit: testUnit, SessionKey: "s1", Profile: mainProfile, Key: "fp1"}}})
	k := h.dialControl()
	m := <-k.msgs
	if m["t"] != "hello" || m["version"] == nil {
		t.Fatalf("first line %v", m)
	}
	bs := m["bindings"].([]any)
	if b := bs[0].(map[string]any); len(bs) != 1 || b["unit"] != testUnit || b["sessionKey"] != "s1" || b["profile"] != mainProfile || b["key"] != "fp1" ||
		b["fingerprint"] != nil || b["provider"] != nil {
		t.Fatalf("hello bindings %v", bs)
	}
	// The profiles, with what each says for the host.
	ps := m["profiles"].(map[string]any)
	if len(ps) != 5 || toJSON(ps[altProfile]) != `{"client":{"codex":"api-key"},"runner":{"promptCacheTtl":"1h"}}` ||
		toJSON(ps[mainProfile]) != `{"client":{"claude":"CLAUDE_CODE_OAUTH_TOKEN"}}` {
		t.Fatalf("hello profiles %v", ps)
	}
	if toJSON(m["providers"]) != `["alt","anthropic-key","claude-oauth","openai-key","openrouter"]` {
		t.Fatalf("hello providers %v", m["providers"])
	}
	// model.proxy_started, sent before any host connected, is kept for the first.
	ev := k.waitFor(isEvent("model.proxy_started"))
	if ev["data"].(map[string]any)["bindings"] != float64(1) {
		t.Fatalf("event %v", ev)
	}
}

func TestBindStateMachine(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 300 * time.Millisecond})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	if res := do(t, h, testUnit); res.StatusCode != 200 {
		t.Fatalf("bound: %d", res.StatusCode)
	}
	bindingEvent := func(action string) map[string]any {
		t.Helper()
		ev := k.waitFor(func(m map[string]any) bool {
			return m["name"] == "model.binding" && m["data"].(map[string]any)["action"] == action
		})
		d := ev["data"].(map[string]any)
		if d["unit"] != testUnit || d["token"] != nil || ev["session_key"] == nil {
			t.Fatalf("binding event %v", ev)
		}
		return d
	}
	if d := bindingEvent("bind"); d["fingerprint"] != "fp1" || d["mode"] != nil {
		t.Fatalf("bind event %v", d)
	}

	// Another session for the same unit: refused, the binding stays.
	k.bind(testUnit, "s2", "tok2", "fp2")
	m := k.waitFor(isT("refused"))
	if m["unit"] != testUnit || m["sessionKey"] != "s2" || m["reason"] == "" {
		t.Fatalf("refused %v", m)
	}
	bindingEvent("refused")
	if res := do(t, h, testUnit); res.StatusCode != 200 {
		t.Fatalf("after refused bind: %d", res.StatusCode)
	}
	// Malformed binds are refused too.
	for reason, bad := range map[string]map[string]any{
		"invalid unit":       {"unit": "evil.service", "sessionKey": "s3", "profile": mainProfile, "vars": map[string]string{"token": "x"}},
		"missing sessionKey": {"unit": "sp-runner-x.service", "profile": mainProfile, "vars": map[string]string{"token": "x"}},
		"missing token":      {"unit": "sp-runner-x.service", "sessionKey": "s3", "profile": mainProfile},
		"invalid token":      {"unit": "sp-runner-x.service", "sessionKey": "s3", "profile": mainProfile, "vars": map[string]string{"token": "x\r\ny: z"}},
		"unknown profile":    {"unit": "sp-runner-x.service", "sessionKey": "s3", "profile": "nope", "vars": map[string]string{"token": "x"}},
		"unknown mode":       {"unit": "sp-runner-x.service", "sessionKey": "s3", "profile": mainProfile, "mode": "other", "vars": map[string]string{"token": "x"}},
	} {
		bad["t"] = "bind"
		k.send(bad)
		if m := k.waitFor(isT("refused")); m["reason"] != reason {
			t.Fatalf("refused %v, want %q", m, reason)
		}
	}
	// No profile and no -default-profile: there is nothing to bind to.
	k.send(map[string]any{"t": "bind", "unit": "sp-runner-x.service", "sessionKey": "s3", "token": "x"})
	if m := k.waitFor(isT("refused")); m["reason"] != "unknown profile" {
		t.Fatalf("refused %v", m)
	}

	// Unknown t values and fields are ignored.
	k.send(map[string]any{"t": "future", "x": 1})

	// Mode refuse: 401 with the reason, upstream untouched.
	before := hits.Load()
	k.send(map[string]any{"t": "bind", "unit": testUnit, "sessionKey": "s1", "mode": "refuse", "reason": "paused by its owner"})
	k.waitFor(func(m map[string]any) bool { return m["t"] == "bound" && m["mode"] == "refuse" })
	res := do(t, h, testUnit)
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

	// Release: the unit is unknown again; held, then 401.
	k.send(map[string]any{"t": "release", "unit": testUnit})
	if d := bindingEvent("release"); d["mode"] != "refuse" {
		t.Fatalf("release event %v", d)
	}
	start := time.Now()
	res = do(t, h, testUnit)
	if res.StatusCode != 401 || time.Since(start) < 250*time.Millisecond {
		t.Fatalf("released: %d after %v", res.StatusCode, time.Since(start))
	}
	ev := k.waitFor(isEvent("model.held"))
	if ev["outcome"] != "timed_out" || ev["data"].(map[string]any)["released"] != "timeout" {
		t.Fatalf("held event %v", ev)
	}
	// After release the unit may serve a new session.
	h.bindReady(k, testUnit, "s9", "tok9", "fp9")
}

func TestHoldThenServeWhenBindArrivesLate(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 3 * time.Second})
	k := h.dialControl()
	go func() {
		time.Sleep(200 * time.Millisecond)
		k.bind(testUnit, "s1", "tok", "fp1")
	}()
	start := time.Now()
	res := do(t, h, testUnit)
	if res.StatusCode != 200 || time.Since(start) < 150*time.Millisecond {
		t.Fatalf("status %d after %v", res.StatusCode, time.Since(start))
	}
	ev := k.waitFor(isEvent("model.held"))
	d := ev["data"].(map[string]any)
	if d["released"] != "bound" || d["held_ms"].(float64) < 150 || ev["session_key"] != "s1" {
		t.Fatalf("held event %v", ev)
	}
}

func TestHoldTimeout503ForKnownUnit(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 300 * time.Millisecond,
		restore: []persisted{{Unit: testUnit, SessionKey: "s1", Profile: mainProfile, Key: "fp1"}}})
	res := do(t, h, testUnit)
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

// After a restart: persisted units are held; `synced` does not end the hold
// or drop them; a bind after `synced` still serves the held request; a unit
// never re-bound gets 503 at the cap.
func TestPersistedBindingsAndSynced(t *testing.T) {
	const other = "sp-runner-other.service"
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 1500 * time.Millisecond, restore: []persisted{
		{Unit: testUnit, SessionKey: "s1", Profile: mainProfile, Key: "fp1"},
		{Unit: other, SessionKey: "s2", Profile: mainProfile, Key: "fp2"},
	}})
	k := h.dialControl()
	k.waitFor(isT("hello"))

	type result struct {
		status int
		took   time.Duration
	}
	run := func(unit string) chan result {
		ch := make(chan result, 1)
		go func() {
			start := time.Now()
			res, err := h.client(unit).Do(h.messagesReq(context.Background()))
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
	a, b := run(testUnit), run(other)
	time.Sleep(100 * time.Millisecond)
	k.send(map[string]any{"t": "synced"})
	time.Sleep(200 * time.Millisecond)
	k.bind(testUnit, "s1", "tok", "fp1")
	ra, rb := <-a, <-b
	if ra.status != 200 || ra.took < 250*time.Millisecond {
		t.Fatalf("re-bound unit: %+v", ra)
	}
	if rb.status != 503 || rb.took < 1400*time.Millisecond {
		t.Fatalf("never re-bound unit: %+v", rb)
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
	if strings.Contains(string(raw), "tok") || !strings.Contains(string(raw), testUnit) {
		t.Fatalf("bindings file %s", raw)
	}
	st, _ := os.Stat(h.srv.cfg.bindingsFile)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
}

// The host restarting (control connection closed) keeps every binding and
// variable; serving continues; the next `hello` lists them.
func TestControlDisconnectKeepsBindings(t *testing.T) {
	up, _ := okUpstream()
	h := newHarness(t, up, harnessOpts{hold: 300 * time.Millisecond})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	k.c.Close()
	time.Sleep(50 * time.Millisecond)
	if res := do(t, h, testUnit); res.StatusCode != 200 {
		t.Fatalf("after host disconnect: %d", res.StatusCode)
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
	h.bindReady(k2, testUnit, "s1", "tok", "fp1")
}
