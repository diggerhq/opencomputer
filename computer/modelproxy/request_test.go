package main

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func (k *ctl) request(m map[string]any) map[string]any {
	k.t.Helper()
	m["t"] = "request"
	k.send(m)
	return k.waitFor(func(r map[string]any) bool { return r["t"] == "response" && r["id"] == m["id"] })
}

// A binder `request` is made on the profile with the variables it carries:
// the route's `to`, `set` and `default` apply, `require` does not, and the
// answer has the status, the reported headers and the body. Nothing is bound.
func TestRequest(t *testing.T) {
	got := make(chan seen, 1)
	alt := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- seen{header: r.Header.Clone(), host: r.Host, uri: r.RequestURI}
		w.Header().Set("X-Quota-Used", "40")
		w.Header().Set("X-Other", "no")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(strings.Repeat("m", maxResponseBody+100)))
	})
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: alt})
	k := h.dialControl()
	r := k.request(map[string]any{"id": "r1", "profile": altProfile, "method": "GET", "path": "/v1/models", "query": "v=1",
		"vars": map[string]string{"token": "tok", "accountId": altAccount}, "headers": map[string]string{"X-Extra": "1", "Authorization": "Bearer mine"}})
	s := <-got
	if s.uri != "/base/x/models?v=1" || s.host != h.alt.Listener.Addr().String() || s.header.Get("Authorization") != "Bearer tok" ||
		s.header.Get("X-Account") != altAccount || s.header.Get("Accept") != "application/json" || s.header.Get("X-Extra") != "1" {
		t.Fatalf("upstream saw %s %v", s.uri, s.header)
	}
	hd, _ := r["headers"].(map[string]any)
	if r["status"] != float64(202) || len(hd) != 1 || hd["x-quota-used"] != "40" || len(r["body"].(string)) != maxResponseBody || r["error"] != nil {
		t.Fatalf("response status %v headers %v body %d error %v", r["status"], hd, len(r["body"].(string)), r["error"])
	}
	if h.srv.bindings.Len() != 0 || hits.Load() != 0 {
		t.Fatalf("bindings %d, other upstream hits %d", h.srv.bindings.Len(), hits.Load())
	}

	// `require` is a check on sessions: the binder's request passes without it.
	r = k.request(map[string]any{"id": "r2", "profile": altProfile, "method": "POST", "path": "/v1/responses", "body": "{}",
		"vars": map[string]string{"token": "tok", "accountId": altAccount}})
	if s := <-got; r["status"] != float64(202) || s.uri != "/base/x/responses" {
		t.Fatalf("response %v, uri %s", r["status"], s.uri)
	}
}

func TestRequestErrors(t *testing.T) {
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{alt: recordingUpstream(&hits, nil)})
	k := h.dialControl()
	vars := map[string]string{"token": "tok", "accountId": altAccount}
	for i, c := range []struct {
		want string
		m    map[string]any
	}{
		{responseUnknownProfile, map[string]any{"profile": "nope", "method": "GET", "path": "/v1/models", "vars": vars}},
		{responseUnknownRoute, map[string]any{"profile": altProfile, "method": "GET", "path": "/v1/other", "vars": vars}},
		{responseUnknownRoute, map[string]any{"profile": altProfile, "method": "DELETE", "path": "/v1/models", "vars": vars}},
		{responseUnknownRoute, map[string]any{"profile": altProfile, "method": "WS", "path": "/v1/responses", "vars": vars}},
		{responseMissingVar, map[string]any{"profile": altProfile, "method": "GET", "path": "/v1/models", "vars": map[string]string{"token": "tok"}}},
		{responseMissingVar, map[string]any{"profile": altProfile, "method": "GET", "path": "/v1/models", "vars": map[string]string{"token": "a\r\nX: y", "accountId": "a"}}},
		{responseBadRequest, map[string]any{"profile": altProfile, "method": "GET", "path": "/v1/models", "vars": vars, "headers": map[string]string{"Bad Name": "v"}}},
		{responseBadRequest, map[string]any{"profile": altProfile, "method": "GET", "path": "/v1/models", "vars": vars, "headers": map[string]string{"X-A": "v\nw"}}},
	} {
		c.m["id"] = string(rune('a' + i))
		if r := k.request(c.m); r["error"] != c.want || r["status"] != nil {
			t.Errorf("%v: response %v, want error %s", c.m, r, c.want)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream contacted %d times", hits.Load())
	}
	h.alt.Close()
	if r := k.request(map[string]any{"id": "z", "profile": altProfile, "method": "GET", "path": "/v1/models", "vars": vars}); r["error"] != responseUnreachable {
		t.Fatalf("response %v", r)
	}
}
