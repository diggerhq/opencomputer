package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// scripted answers each request with the next status (the last one again),
// alt's quota headers, one header no profile reports, and a JSON body.
func scripted(statuses ...int) http.Handler {
	var n atomic.Int64
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		i := min(int(n.Add(1))-1, len(statuses)-1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Quota-Used", "97")
		w.Header().Set("Retry-After", "30")
		w.Header().Set("X-Other", "no")
		w.WriteHeader(statuses[i])
		io.WriteString(w, `{"error":{"type":"quota","message":"spent"}}`)
	})
}

func doReq(t *testing.T, h *harness, unit string, req *http.Request) int {
	t.Helper()
	res, err := h.client(unit).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res.StatusCode
}

// The host hears what the upstream answered: the status, only the headers
// the profile's `report` names, and the start of an error's body; the client
// gets the response unchanged.
func TestObserved(t *testing.T) {
	h := newHarness(t, scripted(429), harnessOpts{alt: scripted(200, 429, 401, 401, 200)})
	k := h.dialControl()
	h.bindAltReady(k, altUnit, "s1", "tok", "fpC", altAccount)
	h.bindReady(k, testUnit, "s2", "tok", "fpA")

	for i, want := range []struct {
		status int
		body   string
	}{{200, ""}, {429, `{"error":{"type":"quota","message":"spent"}}`}, {401, `{"error":{"type":"quota","message":"spent"}}`}, {401, `{"error":{"type":"quota","message":"spent"}}`}, {200, ""}} {
		if st := doReq(t, h, altUnit, h.responsesReq(context.Background())); st != want.status {
			t.Fatalf("%d: status %d", i, st)
		}
		m := k.waitFor(isT("observed"))
		hd, _ := m["headers"].(map[string]any)
		if m["status"] != float64(want.status) || m["profile"] != altProfile || m["key"] != "fpC" || m["unit"] != altUnit || m["sessionKey"] != "s1" ||
			len(hd) != 2 || hd["x-quota-used"] != "97" || hd["retry-after"] != "30" || m["error"] != nil {
			t.Fatalf("%d: observed %v", i, m)
		}
		if body, _ := m["body"].(string); body != want.body {
			t.Fatalf("%d: body %q", i, body)
		}
		if strings.Contains(toJSON(m), "tok") || strings.Contains(toJSON(m), altAccount) {
			t.Fatalf("a variable in observed: %v", m)
		}
	}

	// The shipped profile reports the headers its `report` names, no other.
	if st := doReq(t, h, testUnit, h.messagesReq(context.Background())); st != 429 {
		t.Fatalf("status %d", st)
	}
	if m := k.waitFor(isT("observed")); m["status"] != float64(429) || m["profile"] != mainProfile || toJSON(m["headers"]) != `{"retry-after":"30"}` || m["body"] == nil {
		t.Fatalf("observed %v", m)
	}
}

// A binding without a key has nothing the host could attribute an answer to.
func TestObservedNeedsKey(t *testing.T) {
	h := newHarness(t, scripted(429), harnessOpts{})
	k := h.dialControl()
	k.bind(testUnit, "s1", "tok", "")
	k.waitFor(isT("bound"))
	if st := doReq(t, h, testUnit, h.messagesReq(context.Background())); st != 429 {
		t.Fatalf("status %d", st)
	}
	k.waitFor(isEvent("model.request"))
	k.noMessage(isT("observed"), 50*time.Millisecond)
}

type sink struct {
	mu   sync.Mutex
	msgs []observedMsg
}

func (s *sink) send(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m, ok := v.(observedMsg); ok {
		s.msgs = append(s.msgs, m)
	}
}

func (s *sink) take() []observedMsg {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.msgs
	s.msgs = nil
	return out
}

// What is sent of a steady state: never one message per request.
func TestObserverDedupe(t *testing.T) {
	out := &sink{}
	o := NewObserver(out)
	now := time.Unix(1_800_000_000, 0)
	o.now = func() time.Time { return now }
	prof := &profile{name: "p", report: []string{"x-quota-*"}}
	a, b := subject{prof: prof, sessionKey: "s1", unit: testUnit, key: "A"}, subject{prof: prof, sessionKey: "s2", unit: altUnit, key: "B"}
	hdr := func(v string) http.Header { return http.Header{"X-Quota-Used": {v}, "X-Other": {v + "!"}} }
	step := func(what string, want int, f func()) {
		t.Helper()
		f()
		if got := out.take(); len(got) != want {
			t.Fatalf("%s: %d messages, want %d: %+v", what, len(got), want, got)
		}
	}
	step("first ok", 1, func() { o.response(a, 200, hdr("1"), nil) })
	step("ok again, other figures", 0, func() { o.response(a, 200, hdr("2"), nil) })
	step("another key", 1, func() { o.response(b, 200, hdr("1"), nil) })
	now = now.Add(observedEvery)
	step("ok a minute on", 1, func() { o.response(a, 200, hdr("3"), nil) })
	step("a failure", 1, func() { o.response(a, 429, hdr("100"), []byte("x")) })
	step("the same failure", 0, func() { o.response(a, 429, hdr("100"), nil) })
	step("other headers within the burst", 0, func() { o.response(a, 429, hdr("101"), nil) })
	now = now.Add(observedBurst)
	step("other headers after it", 1, func() { o.response(a, 429, hdr("101"), nil) })
	step("an unreported header differs", 0, func() { o.response(a, 429, http.Header{"X-Quota-Used": {"101"}, "X-Other": {"z"}}, nil) })
	now = now.Add(observedEvery)
	step("the same failure a minute on", 1, func() { o.response(a, 429, hdr("101"), nil) })
	step("another status", 1, func() { o.response(a, 500, nil, nil) })
	step("a transport error", 1, func() { o.transport(a, "connect") })
	step("the same error", 0, func() { o.transport(a, "connect") })
	step("a cancelled request", 0, func() { o.transport(a, "canceled") })
	step("ok after a failure", 1, func() { o.response(a, 200, nil, nil) })
	step("alternating answers", 1, func() {
		for range 20 {
			o.response(a, 429, nil, nil)
			o.response(a, 200, nil, nil)
		}
	})
	now = now.Add(observedBurst)
	step("the change back, a second on", 1, func() { o.response(a, 200, nil, nil) })
	step("every 401", 3, func() {
		for range 3 {
			o.response(a, 401, nil, nil)
		}
	})
	step("no key", 0, func() { o.response(subject{prof: prof}, 500, nil, nil); o.transport(subject{prof: prof}, "connect") })

	o.response(a, 400, hdr("1"), []byte(strings.Repeat("b", observedBody+100)))
	if got := out.take(); len(got) != 1 || len(got[0].Body) != observedBody || len(got[0].Headers) != 1 || got[0].Headers["x-quota-used"] != "1" {
		t.Fatalf("message %+v", got)
	}
}

type slowBody struct {
	chunks chan []byte
	closed chan struct{}
	once   sync.Once
}

func (b *slowBody) Read(p []byte) (int, error) {
	select {
	case c, ok := <-b.chunks:
		if !ok {
			return 0, io.EOF
		}
		return copy(p, c), nil
	case <-b.closed:
		return 0, io.ErrClosedPipe
	}
}

func (b *slowBody) Close() error { b.once.Do(func() { close(b.closed) }); return nil }

// headBody reports once, with at most its limit: at the limit, at the end,
// at close, or after errorBodyWait when the body stalls. It reads nothing
// itself and passes every byte on.
func TestHeadBody(t *testing.T) {
	old := errorBodyWait
	errorBodyWait = 50 * time.Millisecond
	defer func() { errorBodyWait = old }()
	newBody := func() (*slowBody, *headBody, chan string) {
		got := make(chan string, 4)
		src := &slowBody{chunks: make(chan []byte, 4), closed: make(chan struct{})}
		return src, newHeadBody(src, 8, func(b []byte) { got <- string(b) }), got
	}
	one := func(got chan string) string {
		t.Helper()
		select {
		case s := <-got:
			return s
		case <-time.After(2 * time.Second):
			t.Fatal("no report")
			return ""
		}
	}
	buf := make([]byte, 64)

	src, hb, got := newBody() // larger than the limit
	src.chunks <- []byte("0123456789abcdef")
	if n, _ := hb.Read(buf); string(buf[:n]) != "0123456789abcdef" {
		t.Fatalf("read %q", buf[:n])
	}
	if s := one(got); s != "01234567" {
		t.Fatalf("head %q", s)
	}
	hb.Close()

	src, hb, got = newBody() // shorter: reported at its end
	src.chunks <- []byte("abc")
	close(src.chunks)
	hb.Read(buf)
	hb.Read(buf)
	if s := one(got); s != "abc" {
		t.Fatalf("head %q", s)
	}
	hb.Close()

	src, hb, got = newBody() // stalled after a start: reported with what arrived
	src.chunks <- []byte("ab")
	hb.Read(buf)
	if s := one(got); s != "ab" {
		t.Fatalf("head %q", s)
	}
	hb.Close()

	_, hb, got = newBody() // closed unread
	hb.Close()
	if s := one(got); s != "" {
		t.Fatalf("head %q", s)
	}
	select {
	case s := <-got:
		t.Fatalf("reported twice: %q", s)
	case <-time.After(100 * time.Millisecond):
	}
}
