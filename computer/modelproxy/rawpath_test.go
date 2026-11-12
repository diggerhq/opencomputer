package main

import (
	"net/http"
	"testing"
)

// The upstream gets the path the route matched, not the caller's encoding of
// it; and never the caller's cookies (the shipped profiles' `remove`).
func TestPathAsMatched(t *testing.T) {
	paths := make(chan string, 1)
	cookies := make(chan string, 1)
	h := newHarness(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.RequestURI
		cookies <- r.Header.Get("Cookie")
	}), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	req, _ := http.NewRequest(http.MethodGet, h.apiURL+"/api/claude_code/policy_limits", nil)
	req.Host = "localhost"
	req.URL.RawPath = "/api/claude_code/policy%5Flimits"
	req.Header.Set("Cookie", "a=b")
	res, err := h.client(testUnit).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if p := <-paths; p != "/api/claude_code/policy_limits" {
		t.Fatalf("path %q", p)
	}
	if c := <-cookies; c != "" {
		t.Fatalf("cookie %q", c)
	}
}
