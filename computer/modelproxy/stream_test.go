package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestStreamingChunkByChunk: the upstream sends chunk i only after the client
// has read chunk i-1, so any buffering in the proxy deadlocks the test.
func TestStreamingChunkByChunk(t *testing.T) {
	const chunks = 5
	ack := make(chan int)
	up := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		for i := range chunks {
			fmt.Fprintf(w, "event: content_block_delta\ndata: {\"i\":%d}\n\n", i)
			w.(http.Flusher).Flush()
			select {
			case got := <-ack:
				if got != i {
					t.Errorf("ack %d for chunk %d", got, i)
				}
			case <-time.After(2 * time.Second):
				t.Errorf("chunk %d never reached the client", i)
				return
			}
		}
	})
	h := newHarness(t, up, harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tok", "fp1")
	res, err := h.client(testCaller).Do(h.messagesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content-type %q", res.Header.Get("Content-Type"))
	}
	br := bufio.NewReader(res.Body)
	for i := range chunks {
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				t.Fatalf("chunk %d: %v", i, err)
			}
			if strings.HasPrefix(line, "data: ") {
				if want := fmt.Sprintf("data: {\"i\":%d}\n", i); line != want {
					t.Fatalf("got %q want %q", line, want)
				}
				break
			}
		}
		ack <- i
	}
	io.Copy(io.Discard, br)
	ev := k.waitFor(isEvent("model.request"))
	if d := ev["data"].(map[string]any); d["stream"] != true || ev["outcome"] != "completed" {
		t.Fatalf("event %v", ev)
	}
}

// gatedUpstream records each request's bearer and holds its response open
// until released.
type gatedUpstream struct {
	mu      sync.Mutex
	bearers []string
	started chan string
	release chan struct{}
}

func (g *gatedUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b := r.Header.Get("Authorization")
	g.mu.Lock()
	g.bearers = append(g.bearers, b)
	g.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	w.(http.Flusher).Flush()
	g.started <- b
	<-g.release
	io.WriteString(w, "event: message_stop\ndata: {}\n\n")
}

// TestRebindUnderStream: a new token for a caller with a stream in flight
// applies at once. The stream ends on the token it started with; the next
// request uses the new one and is marked swapped. A refuse bind does the
// same: the stream ends, the next request is refused.
func TestRebindUnderStream(t *testing.T) {
	g := &gatedUpstream{started: make(chan string, 4), release: make(chan struct{})}
	h := newHarness(t, g, harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tokA", "fpA")
	c := h.client(testCaller)

	var wg sync.WaitGroup
	stream := func() {
		defer wg.Done()
		res, err := c.Do(h.messagesReq(context.Background()))
		if err != nil {
			t.Error(err)
			return
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Errorf("stream: %d", res.StatusCode)
		}
	}
	wg.Add(1)
	go stream()
	if b := <-g.started; b != "Bearer tokA" {
		t.Fatalf("first stream %q", b)
	}
	k.bind(testCaller, "s1", "tokB", "fpB")
	if m := k.waitFor(isT("bound")); m["key"] != "fpB" || m["sessionKey"] != "s1" {
		t.Fatalf("bound %v", m)
	}
	if ev := k.waitFor(isEvent("model.binding")); evData(ev)["action"] != "swap" || evData(ev)["key"] != "fpB" {
		t.Fatalf("binding event %v", ev)
	}

	wg.Add(1)
	go stream() // starts while the first is in flight: tokB already
	if b := <-g.started; b != "Bearer tokB" {
		t.Fatalf("concurrent stream %q, want the new token", b)
	}
	k.send(map[string]any{"t": "bind", "caller": testCaller, "sessionKey": "s1", "mode": "refuse", "reason": "paused"})
	k.waitFor(func(m map[string]any) bool { return m["t"] == "bound" && m["key"] == nil })
	res, err := c.Do(h.messagesReq(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after a refuse bind under live streams: %d", res.StatusCode)
	}
	close(g.release)
	wg.Wait() // both streams end 200
	ev := k.waitFor(func(m map[string]any) bool { return m["name"] == "model.request" && evData(m)["key"] == "fpB" })
	if evData(ev)["swapped"] != true {
		t.Fatalf("event %v", ev)
	}
}

// TestClientAbortMidStream: the client goes away; the event says cancelled
// and the caller's in-flight count returns to zero.
func TestClientAbortMidStream(t *testing.T) {
	g := &gatedUpstream{started: make(chan string, 4), release: make(chan struct{})}
	defer close(g.release)
	h := newHarness(t, g, harnessOpts{})
	k := h.dialControl()
	h.bindReady(k, testCaller, "s1", "tokA", "fpA")
	ctx, cancel := context.WithCancel(context.Background())
	res, err := h.client(testCaller).Do(h.messagesReq(ctx))
	if err != nil {
		t.Fatal(err)
	}
	<-g.started
	cancel()
	res.Body.Close()
	ev := k.waitFor(isEvent("model.request"))
	if ev["outcome"] != "cancelled" {
		t.Fatalf("event %v", ev)
	}
	h.bindReady(k, testCaller, "s1", "tokB", "fpB")
}
