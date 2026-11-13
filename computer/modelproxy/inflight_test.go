package main

import (
	"context"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

// One caller at its in-flight cap gets 429 with Retry-After: 1 (never
// touching upstream or the hold); when a stream ends the slot is free again,
// and another caller is unaffected.
func TestInflightCapPerCaller(t *testing.T) {
	const other = "other"
	g := &gatedUpstream{started: make(chan string, 8), release: make(chan struct{})}
	h := newHarness(t, g, harnessOpts{perCaller: 2})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tokA", "fpA")
	h.bindReady(k, other, "s2", "tokB", "fpB")
	c := h.client(testCaller)

	var wg sync.WaitGroup
	stream := func(c *http.Client) {
		defer wg.Done()
		res, err := c.Do(h.messagesReq(context.Background()))
		if err != nil {
			t.Error(err)
			return
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Errorf("stream: %d %s", res.StatusCode, b)
		}
	}
	wg.Add(2)
	go stream(c)
	go stream(c)
	<-g.started
	<-g.started

	res := do(t, h, testCaller)
	if res.StatusCode != 429 || res.Header.Get("Retry-After") != "1" || res.Header.Get("X-Should-Retry") != "true" {
		t.Fatalf("status %d retry-after %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
	if e := decodeAPIError(t, res); e.Error.Type != "rate_limit_error" {
		t.Fatalf("error %+v", e)
	}
	if ev := k.waitFor(isEvent("model.denied")); ev["data"].(map[string]any)["reason"] != "caller_cap" {
		t.Fatalf("event %v", ev)
	}
	// Another caller has its own cap.
	wg.Add(1)
	go stream(h.client(other))
	if b := <-g.started; b != "Bearer tokB" {
		t.Fatalf("other caller %q", b)
	}

	close(g.release)
	wg.Wait()
	g.release = make(chan struct{})
	close(g.release)
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("after the streams ended: %d", res.StatusCode)
	}
}

// Held requests count toward the cap: a caller with no credential yet cannot
// queue more than the cap waiting for its bind; the extra one gets 429 at
// once, not after the hold.
func TestInflightCapCountsHeld(t *testing.T) {
	up, hits := okUpstream()
	h := newHarness(t, up, harnessOpts{perCaller: 2, hold: time.Second,
		restore: []bindingInfo{{Caller: testCaller, SessionKey: "s1", Mode: modeProfile, Profile: mainProfile, Key: "fp1"}}})
	k := h.dialControl()
	k.waitFor(isT("hello"))
	c := h.client(testCaller)

	results := make(chan int, 2)
	for range 2 {
		go func() {
			res, err := c.Do(h.messagesReq(context.Background()))
			if err != nil {
				t.Error(err)
				results <- 0
				return
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			results <- res.StatusCode
		}()
	}
	time.Sleep(100 * time.Millisecond) // both held
	start := time.Now()
	res := do(t, h, testCaller)
	if res.StatusCode != 429 || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("third: %d after %v", res.StatusCode, time.Since(start))
	}
	if hits.Load() != 0 {
		t.Fatal("upstream contacted")
	}
	// The bind arrives: the two held ones are served.
	k.bind(testCaller, "s1", "tok", "fp1")
	for range 2 {
		if s := <-results; s != 200 {
			t.Fatalf("held request: %d", s)
		}
	}
	if res := do(t, h, testCaller); res.StatusCode != 200 {
		t.Fatalf("after the hold: %d", res.StatusCode)
	}
}
