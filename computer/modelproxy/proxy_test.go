package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

type seen struct {
	header http.Header
	host   string
	uri    string
	tls    bool
	body   string
}

func recordingUpstream(hits *atomic.Int64, got chan<- seen) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		b, _ := io.ReadAll(r.Body)
		select {
		case got <- seen{header: r.Header.Clone(), host: r.Host, uri: r.RequestURI, tls: r.TLS != nil, body: string(b)}:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Request-Id", "req_1")
		w.Write([]byte(`{"ok":true}`))
	})
}

func TestRewrite(t *testing.T) {
	var hits atomic.Int64
	got := make(chan seen, 1)
	h := newHarness(t, recordingUpstream(&hits, got), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "secret-token", "fp1")

	req := h.messagesReq(context.Background())
	req.Header.Set("X-Forwarded-For", "10.0.0.9")
	req.Header.Set("X-Forwarded-Host", "evil")
	req.Header.Set("X-Forwarded-Proto", "http")
	req.Header.Set("Forwarded", "for=10.0.0.9")
	req.Header.Set("Connection", "X-Hop")
	req.Header.Set("X-Hop", "1")
	req.Header.Set("Keep-Alive", "timeout=5")
	req.Header.Set("Proxy-Authorization", "x")
	req.Header.Set("X-Api-Key", testPlaceholder)
	req.Header.Set("Accept-Encoding", "gzip, br")
	req.Header.Set("Anthropic-Dangerous-Direct-Browser-Access", "true")
	req.Header.Set("X-Stainless-Retry-Count", "0")
	res, err := h.client(testUnit).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Request-Id") != "req_1" {
		t.Fatalf("status %d", res.StatusCode)
	}
	s := <-got
	if !s.tls {
		t.Fatal("upstream request was not https")
	}
	if a := s.header.Values("Authorization"); len(a) != 1 || a[0] != "Bearer secret-token" {
		t.Fatalf("authorization %q", a)
	}
	if s.host != strings.TrimPrefix(h.upstream.URL, "https://") {
		t.Fatalf("host %q", s.host)
	}
	if s.uri != "/v1/messages?beta=true" {
		t.Fatalf("uri %q", s.uri)
	}
	for _, k := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "X-Hop", "Keep-Alive", "Proxy-Authorization", "X-Api-Key"} {
		if v := s.header.Values(k); len(v) != 0 {
			t.Errorf("%s forwarded: %q", k, v)
		}
	}
	want := map[string]string{
		"Anthropic-Beta":                            "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
		"Anthropic-Version":                         "2023-06-01",
		"Anthropic-Dangerous-Direct-Browser-Access": "true",
		"Accept-Encoding":                           "gzip, br",
		"User-Agent":                                "claude-cli/2.1.301 (external, sdk-cli)",
		"X-App":                                     "cli",
		"X-Stainless-Retry-Count":                   "0",
		"Content-Type":                              "application/json",
	}
	for k, v := range want {
		if got := s.header.Values(k); len(got) != 1 || got[0] != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if s.body != `{"model":"x"}` {
		t.Fatalf("body %q", s.body)
	}
	ev := k.waitFor(isEvent("model.request"))
	if ev["outcome"] != "completed" || ev["session_key"] != "s1" {
		t.Fatalf("event %v", ev)
	}
	d := ev["data"].(map[string]any)
	if ev["provider"] != mainProfile || d["route"] != "messages" || d["status"] != float64(200) || d["fingerprint"] != "fp1" || d["swapped"] != false {
		t.Fatalf("event data %v", d)
	}
	if _, ok := d["overhead_us"]; !ok {
		t.Fatalf("no overhead_us in %v", d)
	}
	for _, v := range d {
		if s, ok := v.(string); ok && (strings.Contains(s, "secret-token") || strings.Contains(s, "placeholder")) {
			t.Fatalf("secret in event: %v", d)
		}
	}
}

func TestPolicyLimitsForwardedWithToken(t *testing.T) {
	var hits atomic.Int64
	got := make(chan seen, 1)
	h := newHarness(t, recordingUpstream(&hits, got), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	req, _ := http.NewRequest(http.MethodGet, h.apiURL+"/api/claude_code/policy_limits", nil)
	req.Host = "localhost"
	req.Header.Set("User-Agent", "claude-code/2.1.301")
	res, err := h.client(testUnit).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	s := <-got
	if s.header.Get("Authorization") != "Bearer tok" || s.header.Get("Anthropic-Beta") != "oauth-2025-04-20" || s.header.Get("User-Agent") != "claude-code/2.1.301" {
		t.Fatalf("headers %v", s.header)
	}
}

func TestDenials(t *testing.T) {
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, make(chan seen, 1)), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	c := h.client(testUnit)

	cases := []struct {
		name    string
		mutate  func(*http.Request)
		status  int
		errType string
		reason  string
	}{
		{"models not allowlisted", func(r *http.Request) {
			r.Method = http.MethodGet
			r.URL.Path = "/v1/models"
			r.Body = nil
			r.ContentLength = 0
		}, 404, "not_found_error", "route"},
		{"bootstrap not allowlisted", func(r *http.Request) {
			r.Method = http.MethodGet
			r.URL.Path = "/api/claude_cli/bootstrap"
			r.ContentLength = 0
			r.Body = nil
		}, 404, "not_found_error", "route"},
		{"GET messages", func(r *http.Request) { r.Method = http.MethodGet; r.Body = nil; r.ContentLength = 0 }, 404, "not_found_error", "route"},
		{"path trick", func(r *http.Request) { r.URL.Path = "/v1/messages/../models" }, 404, "not_found_error", "route"},
		{"curl user-agent", func(r *http.Request) { r.Header.Set("User-Agent", "curl/8") }, 403, "permission_error", "shape"},
		{"no x-app", func(r *http.Request) { r.Header.Del("X-App") }, 403, "permission_error", "shape"},
		{"no oauth beta", func(r *http.Request) { r.Header.Set("Anthropic-Beta", "claude-code-20250219") }, 403, "permission_error", "shape"},
		{"count_tokens shape", func(r *http.Request) { r.URL.Path = "/v1/messages/count_tokens"; r.Header.Del("X-App") }, 403, "permission_error", "shape"},
		{"other bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer its-own") }, 401, "authentication_error", "refused"},
		{"other x-api-key", func(r *http.Request) { r.Header.Set("X-Api-Key", "its-own") }, 401, "authentication_error", "refused"},
		{"two bearers", func(r *http.Request) { r.Header.Add("Authorization", placeholderAuth) }, 401, "authentication_error", "refused"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := h.messagesReq(context.Background())
			tc.mutate(req)
			res, err := c.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.status {
				t.Fatalf("status %d, want %d", res.StatusCode, tc.status)
			}
			if e := decodeAPIError(t, res); e.Error.Type != tc.errType {
				t.Fatalf("error type %q", e.Error.Type)
			}
			ev := k.waitFor(isEvent("model.denied"))
			if ev["data"].(map[string]any)["reason"] != tc.reason || ev["outcome"] != "failed" {
				t.Fatalf("event %v", ev)
			}
		})
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("upstream contacted %d times", n)
	}

	// A caller that is no runner unit: 401 at once, upstream untouched.
	res, err := h.client("").Do(h.messagesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 401 || decodeAPIError(t, res).Error.Type != "authentication_error" || hits.Load() != 0 {
		t.Fatalf("no-unit status %d", res.StatusCode)
	}
	res.Body.Close()
}

func TestUpstreamUnreachable502(t *testing.T) {
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, make(chan seen, 1)), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	h.upstream.Close()
	res, err := h.client(testUnit).Do(h.messagesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 502 || decodeAPIError(t, res).Error.Type != "api_error" {
		t.Fatalf("status %d", res.StatusCode)
	}
	// The host hears of it (before the request event).
	om := k.waitFor(isT("observed"))
	if om["error"] != "connect" || om["key"] != "fp1" || om["profile"] != mainProfile || om["unit"] != testUnit || om["sessionKey"] != "s1" || om["status"] != nil {
		t.Fatalf("observed %v", om)
	}
	ev := k.waitFor(isEvent("model.request"))
	if ev["outcome"] != "failed" || ev["error_type"] != "socket" {
		t.Fatalf("event %v", ev)
	}
}

func TestIsEventStream(t *testing.T) {
	for ct, want := range map[string]bool{
		"text/event-stream":                true,
		"text/event-stream; charset=utf-8": true,
		"Text/Event-Stream":                true,
		"text/event-streams":               false,
		"application/json":                 false,
		"":                                 false,
	} {
		if got := isEventStream(ct); got != want {
			t.Errorf("%q: %v", ct, got)
		}
	}
}
