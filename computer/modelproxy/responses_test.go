package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const responsesStream = "event: response.created\n" +
	`data: {"type":"response.created","response":{"id":"r1","service_tier":"auto"}}` + "\n\n" +
	"event: response.output_item.added\n" +
	`data: {"type":"response.output_item.added","item":{"type":"reasoning"}}` + "\n\n" +
	"event: response.output_text.delta\n" +
	`data: {"type":"response.output_text.delta","delta":"say \"type\":\"response.completed\" and \"service_tier\":\"flex\""}` + "\n\n" +
	"event: response.completed\n" +
	`data: {"type":"response.completed","response":{"id":"r1","service_tier":"priority"}}` + "\n\n"

// Every split of the stream into two reads finds the same facts; model text that names them does not count.
func TestResponsesFactsAcrossReads(t *testing.T) {
	for cut := 0; cut <= len(responsesStream); cut++ {
		st := &reqState{start: time.Now()}
		b := watchResponses(st, io.NopCloser(strings.NewReader(""))).(*responsesBody)
		b.see([]byte(responsesStream[:cut]))
		b.see([]byte(responsesStream[cut:]))
		if st.resp.firstOutput.Load() == 0 || !st.resp.completed.Load() || st.resp.serviceTier() != "priority" {
			t.Fatalf("cut %d: output %d completed %v tier %q", cut, st.resp.firstOutput.Load(), st.resp.completed.Load(), st.resp.serviceTier())
		}
	}
	st := &reqState{start: time.Now()}
	b := watchResponses(st, io.NopCloser(strings.NewReader(""))).(*responsesBody)
	b.see([]byte(responsesStream[:strings.Index(responsesStream, "event: response.output_item.added")]))
	if st.resp.firstOutput.Load() != 0 || st.resp.completed.Load() || st.resp.serviceTier() != "auto" {
		t.Fatalf("before output: output %d completed %v tier %q", st.resp.firstOutput.Load(), st.resp.completed.Load(), st.resp.serviceTier())
	}
	b.see([]byte(`data: {"type":"response.output_text.delta","delta":"\"type\":\"response.completed\""}`))
	if st.resp.completed.Load() {
		t.Fatal("model text counted as response.completed")
	}
}

// A client that reads up to response.completed and hangs up while the upstream is still open: a completed request
// with its first output and served tier, not a cancelled one.
func TestResponsesCompletedThenHangUp(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	up := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		io.WriteString(w, responsesStream)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	h := newHarness(t, http.NotFoundHandler(), harnessOpts{alt: up})
	k := h.dialControl()
	h.bindAltReady(k, altUnit, "s1", "tok", "fpC", altAccount)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, err := h.client(altUnit).Do(h.responsesReq(ctx))
	if err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() && !strings.Contains(sc.Text(), `"type":"response.completed"`) {
	}
	cancel()
	res.Body.Close()
	e := k.waitFor(isEvent("model.request"))
	d := e["data"].(map[string]any)
	if e["outcome"] != "completed" || d["service_tier"] != "priority" {
		t.Fatalf("event %v", e)
	}
	if _, ok := d["first_output_ms"].(float64); !ok {
		t.Fatalf("no first_output_ms in %v", d)
	}
}
