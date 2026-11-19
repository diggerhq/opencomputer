package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A profile with a base path, `to`, a second variable, `remove` and fixed
// headers: the request reaches its own upstream so shaped, the body and
// every other header untouched, and no other profile's upstream is contacted.
func TestAltRewrite(t *testing.T) {
	var mHits, aHits atomic.Int64
	got := make(chan seen, 1)
	h := newHarness(t, recordingUpstream(&mHits, make(chan seen, 1)), harnessOpts{alt: recordingUpstream(&aHits, got)})
	k := h.dialControl()
	b := h.bindAltReady(k, altCaller, "s1", "secret-token", "fpC", altAccount)
	if b["caller"] != altCaller || b["sessionKey"] != "s1" || b["key"] != "fpC" || b["profile"] != nil || b["vars"] != nil {
		t.Fatalf("bound %v", b)
	}

	req := h.responsesReq(context.Background())
	for _, kv := range [][2]string{
		{"X-Forwarded-For", "10.0.0.9"}, {"X-Forwarded-Host", "evil"}, {"X-Forwarded-Port", "8080"},
		{"X-Forwarded-Client-Cert", "x"}, {"Forwarded", "for=10.0.0.9"}, {"X-Real-Ip", "10.0.0.9"}, {"Cookie", "a=b"},
		{"X-Private-Session", "s1"}, {"X-Api-Key", testPlaceholder}, {"X-Account", "someone-else"}, {"Originator", "its-own"},
		{"X-Turn-Metadata", `{"turn":1}`},
	} {
		req.Header.Set(kv[0], kv[1])
	}
	res, err := h.client(altCaller).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	s := <-got
	if s.uri != "/base/x/responses" || !s.tls || s.host != h.alt.Listener.Addr().String() {
		t.Fatalf("upstream saw uri=%q host=%q tls=%v", s.uri, s.host, s.tls)
	}
	want := map[string]string{
		"Authorization": "Bearer secret-token", "X-Account": altAccount, "Originator": "fixed",
		"User-Agent": "test-client/1.0", "Accept": "text/event-stream", "Session-Id": "sess-1", "X-Turn-Metadata": `{"turn":1}`,
	}
	for k, v := range want {
		if got := s.header.Values(k); len(got) != 1 || got[0] != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	for name := range s.header {
		if strings.HasPrefix(name, "X-Forwarded-") || strings.HasPrefix(name, "X-Private-") {
			t.Errorf("%s leaked upstream", name)
		}
	}
	for _, name := range []string{"Forwarded", "X-Real-Ip", "Cookie", "X-Api-Key"} {
		if v := s.header.Values(name); len(v) != 0 {
			t.Errorf("%s leaked upstream: %q", name, v)
		}
	}
	if s.body != `{"model":"m","stream":true,"input":[]}` {
		t.Fatalf("body %q", s.body)
	}
	if mHits.Load() != 0 {
		t.Fatalf("another profile's upstream contacted %d times", mHits.Load())
	}
	e := k.waitFor(isEvent("model.request"))
	d := evData(e)
	if e["profile"] != altProfile || d["route"] != "responses" || d["status"] != float64(200) || d["key"] != "fpC" {
		t.Fatalf("event %v", e)
	}
	if strings.Contains(toJSON(e), "secret-token") || strings.Contains(toJSON(e), altAccount) {
		t.Fatalf("a variable in an event: %v", e)
	}
}

// `to` keeps the query; a route's `default` applies only when the header is absent.
func TestAltQueryAndDefault(t *testing.T) {
	var hits atomic.Int64
	got := make(chan seen, 1)
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: recordingUpstream(&hits, got)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	for _, accept := range []string{"", "text/plain"} {
		req, _ := http.NewRequest(http.MethodGet, h.apiURL+"/v1/models?client_version=1.2.3", nil)
		req.Header.Set("Authorization", placeholderAuth)
		want := "application/json"
		if accept != "" {
			req.Header.Set("Accept", accept)
			want = accept
		}
		res, err := h.client(altCaller).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if s := <-got; res.StatusCode != 200 || s.uri != "/base/x/models?client_version=1.2.3" || s.header.Get("Accept") != want {
			t.Fatalf("status %d uri %q accept %q", res.StatusCode, s.uri, s.header.Get("Accept"))
		}
	}
}

// A binding only reaches its own profile's routes: another profile's is a
// 404 like any path off the allowlist, and no upstream is contacted.
func TestOtherProfilesRoute(t *testing.T) {
	var mHits, aHits atomic.Int64
	h := newHarness(t, recordingUpstream(&mHits, nil), harnessOpts{alt: recordingUpstream(&aHits, nil)})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fpA")
	h.bindAltReady(k, altCaller, "s2", "tok", "fpC", altAccount)
	for _, c := range []struct {
		caller, prof string
		req          *http.Request
	}{
		{testCaller, mainProfile, h.responsesReq(context.Background())},
		{altCaller, altProfile, h.messagesReq(context.Background())},
	} {
		res, err := h.client(c.caller).Do(c.req)
		if err != nil {
			t.Fatal(err)
		}
		e := decodeAPIError(t, res)
		res.Body.Close()
		if res.StatusCode != 404 || e.Error.Type != "not_found_error" {
			t.Fatalf("%s: %d %+v", c.caller, res.StatusCode, e)
		}
		ev := k.waitFor(isEvent("model.denied"))
		if d := evData(ev); ev["profile"] != c.prof || d["reason"] != "route" || d["route"] != "other" || ev["session_key"] == nil || ev["error_type"] != nil {
			t.Fatalf("%s: event %v", c.caller, ev)
		}
	}
	if mHits.Load() != 0 || aHits.Load() != 0 {
		t.Fatalf("upstream contacted: %d, %d", mHits.Load(), aHits.Load())
	}
}

// `require`: every header must match, as a whole value or as one item of a
// list, parameters ignored; else 403 with the profile's own text.
func TestAltRequire(t *testing.T) {
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: recordingUpstream(&hits, nil)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	for _, mut := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("Accept") },
		func(r *http.Request) { r.Header.Set("Accept", "application/json") },
		func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") },
	} {
		req := h.responsesReq(context.Background())
		mut(req)
		res, err := h.client(altCaller).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		e := decodeAPIError(t, res)
		res.Body.Close()
		if res.StatusCode != 403 || e.Error.Message != altShape {
			t.Fatalf("%d %+v", res.StatusCode, e)
		}
		if ev := k.waitFor(isEvent("model.denied")); ev["profile"] != altProfile || evData(ev)["reason"] != "require" {
			t.Fatalf("event %v", ev)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream contacted %d times", hits.Load())
	}
	req := h.responsesReq(context.Background())
	req.Header.Set("Accept", "application/json, Text/Event-Stream;q=0.9")
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	res, err := h.client(altCaller).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("list item with parameters: %d", res.StatusCode)
	}
}

// A protocol upgrade is 426 anywhere but a profile's WS route, whatever the
// method, with model.denied error_type websocket; it never reaches upstream.
// A handshake on the WS route that fails its `require` is a 426 too (reason
// shape): the client goes on over HTTP.
func TestUpgradeRefused(t *testing.T) {
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: recordingUpstream(&hits, nil)})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tok", "fpC", altAccount)
	h.bindReady(k, testCaller, "s2", "tokA", "fpA")
	upgrade := func(r *http.Request, conn string) *http.Request {
		r.Header.Set("Connection", conn)
		r.Header.Set("Upgrade", "websocket")
		return r
	}
	get, _ := http.NewRequest(http.MethodGet, h.apiURL+"/v1/responses", nil)
	get.Header.Set("Sec-Websocket-Version", "13")
	get.Header.Set("Sec-Websocket-Key", wsNonce)
	for _, c := range []struct {
		caller  string
		req     *http.Request
		prof    string
		status  int
		reason  string
		errType any
	}{
		{altCaller, upgrade(h.responsesReq(context.Background()), "keep-alive, Upgrade"), altProfile, 426, "websocket", "websocket"},
		{altCaller, upgrade(get, "Upgrade"), altProfile, 426, "require", nil},
		{testCaller, upgrade(h.messagesReq(context.Background()), "Upgrade"), mainProfile, 426, "websocket", "websocket"},
	} {
		res, err := h.client(c.caller).Do(c.req)
		if err != nil {
			t.Fatal(err)
		}
		e := decodeAPIError(t, res)
		res.Body.Close()
		if res.StatusCode != c.status || res.Header.Get("X-Should-Retry") != "false" || !strings.HasPrefix(e.Error.Message, wsUseHTTP) {
			t.Fatalf("%s %s: %d %v %+v", c.req.Method, c.req.URL.Path, res.StatusCode, res.Header, e)
		}
		ev := k.waitFor(isEvent("model.denied"))
		if ev["error_type"] != c.errType || ev["profile"] != c.prof || evData(ev)["reason"] != c.reason {
			t.Fatalf("%s: event %v", c.req.URL.Path, ev)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream contacted %d times", hits.Load())
	}
}

// A bare Upgrade header, without Connection: upgrade, asks for no switch
// (RFC 9110 §7.8): the request is served and the header never reaches upstream.
func TestBareUpgradeHeader(t *testing.T) {
	got := make(chan seen, 1)
	h := newHarness(t, recordingUpstream(new(atomic.Int64), got), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tokA", "fpA")
	req := h.messagesReq(context.Background())
	req.Header.Set("Upgrade", "websocket")
	res, err := h.client(testCaller).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if s := <-got; res.StatusCode != 200 || s.header.Get("Upgrade") != "" {
		t.Fatalf("%d, upstream saw Upgrade %q", res.StatusCode, s.header.Get("Upgrade"))
	}
}

// `concurrency` is shared by every caller whose binding expands the key
// alike; another value, and other profiles, are not counted against it.
func TestConcurrencyCap(t *testing.T) {
	const caller2, caller3 = "alt002", "alt003"
	g := &gatedUpstream{started: make(chan string, 8), release: make(chan struct{})}
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{alt: g, perKey: 1})
	k := h.dialControl()
	h.bindAltReady(k, altCaller, "s1", "tokA", "fpA", altAccount)
	h.bindAltReady(k, caller2, "s2", "tokA", "fpA", altAccount)
	h.bindAltReady(k, caller3, "s3", "tokB", "fpB", "acct-other")

	done := make(chan int, 2)
	stream := func(caller string) {
		res, err := h.client(caller).Do(h.responsesReq(context.Background()))
		if err != nil {
			t.Error(err)
			done <- 0
			return
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		done <- res.StatusCode
	}
	go stream(altCaller)
	<-g.started
	res, err := h.client(caller2).Do(h.responsesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	e := decodeAPIError(t, res)
	res.Body.Close()
	if res.StatusCode != 429 || res.Header.Get("Retry-After") != "1" || e.Error.Type != "rate_limit_error" {
		t.Fatalf("second stream on the key: %d %+v", res.StatusCode, e)
	}
	ev := k.waitFor(isEvent("model.denied"))
	if ev["error_type"] != "concurrency" || ev["profile"] != altProfile || evData(ev)["reason"] != "concurrency_cap" {
		t.Fatalf("event %v", ev)
	}
	if strings.Contains(toJSON(ev), altAccount) {
		t.Fatalf("a variable in an event: %v", ev)
	}
	go stream(caller3) // another value of the key: not counted
	<-g.started
	close(g.release)
	for range 2 {
		if st := <-done; st != 200 {
			t.Fatalf("status %d", st)
		}
	}
	// The slot is free again once the stream ended.
	go stream(caller2)
	if st := <-done; st != 200 {
		t.Fatalf("after release: %d", st)
	}
}

// A bind must carry every variable its profile uses.
func TestBindNeedsEveryVariable(t *testing.T) {
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{})
	k := h.dialControl()
	k.bindAlt(altCaller, "s1", "tok", "fp", "")
	if m := k.waitFor(isT("refused")); m["code"] != refuseMissingVar || m["message"] != "missing accountId" {
		t.Fatalf("refused %v", m)
	}
	if ev := k.waitFor(isEvent("model.binding")); ev["outcome"] != "failed" || evData(ev)["code"] != refuseMissingVar || ev["profile"] != nil {
		t.Fatalf("event %v", ev)
	}
	k.send(map[string]any{"t": "bind", "caller": altCaller, "sessionKey": "s1", "profile": "nope", "vars": map[string]string{"token": "t"}, "key": "f"})
	if m := k.waitFor(isT("refused")); m["code"] != refuseUnknownProfile {
		t.Fatalf("refused %v", m)
	}
	if ev := k.waitFor(isEvent("model.binding")); ev["profile"] != nil || evData(ev)["code"] != refuseUnknownProfile {
		t.Fatalf("event %v", ev)
	}
}

// A rebind to another profile applies at once: the stream in flight ends
// on the upstream and credential it started with, and the caller's next
// request reaches the new profile's upstream.
func TestRebindToAnotherProfile(t *testing.T) {
	g := &gatedUpstream{started: make(chan string, 4), release: make(chan struct{})}
	var aHits atomic.Int64
	h := newHarness(t, g, harnessOpts{alt: recordingUpstream(&aHits, nil)})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fpA")

	done := make(chan int, 1)
	go func() {
		res, err := h.client(testCaller).Do(h.messagesReq(context.Background()))
		if err != nil {
			t.Error(err)
			done <- 0
			return
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		done <- res.StatusCode
	}()
	<-g.started
	h.bindAltReady(k, testCaller, "s1", "tokC", "fpC", altAccount) // `bound` under the live stream

	res, err := h.client(testCaller).Do(h.responsesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || aHits.Load() != 1 {
		t.Fatalf("after the rebind: %d, alt hits %d", res.StatusCode, aHits.Load())
	}
	close(g.release)
	if code := <-done; code != 200 || len(g.bearers) != 1 {
		t.Fatalf("the stream in flight: %d, main hits %d", code, len(g.bearers))
	}
}

// A known caller whose bind has not arrived gets the not-ready text of the
// profile it waits for (the restored one).
func TestNotReadyNamesBoundProfile(t *testing.T) {
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{hold: 50 * time.Millisecond,
		restore: []bindingInfo{{Caller: altCaller, SessionKey: "s1", Mode: modeProfile, Profile: altProfile, Key: "fpC"}}})
	res, err := h.client(altCaller).Do(h.messagesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	e := decodeAPIError(t, res)
	res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable || e.Error.Message != altNotReady {
		t.Fatalf("%d %+v", res.StatusCode, e)
	}
}
