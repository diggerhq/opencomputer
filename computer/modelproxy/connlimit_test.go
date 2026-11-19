package main

import (
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// dialAs opens a raw API connection the proxy sees as caller.
func (h *harness) dialAs(caller string) net.Conn {
	h.t.Helper()
	c, err := net.Dial("tcp", strings.TrimPrefix(h.apiURL, "http://"))
	if err != nil {
		h.t.Fatal(err)
	}
	h.callers.Store(c.LocalAddr().String(), caller)
	h.t.Cleanup(func() { c.Close() })
	return c
}

// closedByProxy: the proxy closes c without answering.
func closedByProxy(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, err := c.Read(make([]byte, 1)); n != 0 || err == nil || strings.Contains(err.Error(), "timeout") {
		t.Fatalf("connection past the cap: read %d %v", n, err)
	}
}

// A caller's connections past -max-conns-per-caller are closed as accepted;
// another caller's are not, and a closed one frees its place.
func TestConnsPerCaller(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{conns: 2})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	a, _ := h.dialAs("hog"), h.dialAs("hog")
	closedByProxy(t, h.dialAs("hog"))
	if res := do(t, h, testCaller); res.StatusCode != 200 || hits.Load() != 1 {
		t.Fatalf("another caller: %d", res.StatusCode)
	}
	a.Close()
	for deadline := time.Now().Add(3 * time.Second); ; { // the proxy sees the close in its own time
		c := h.dialAs("hog")
		c.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		if n, _ := c.Read(make([]byte, 12)); n == 12 {
			return
		}
		c.Close()
		if time.Now().After(deadline) {
			t.Fatal("a closed connection did not free its place")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Headers past maxHeaderBytes are refused before the request is admitted.
func TestHeaderLimit(t *testing.T) {
	var hits atomic.Int64
	h := newHarness(t, recordingUpstream(&hits, nil), harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	req := h.messagesReq(t.Context())
	req.Header.Set("X-Pad", strings.Repeat("a", 2*maxHeaderBytes))
	res, err := h.client(testCaller).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestHeaderFieldsTooLarge || hits.Load() != 0 {
		t.Fatalf("%d, upstream hits %d", res.StatusCode, hits.Load())
	}
}
