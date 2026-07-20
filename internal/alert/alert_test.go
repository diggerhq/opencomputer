package alert

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// captureServer records the JSON bodies POSTed to it.
func captureServer(t *testing.T) (*httptest.Server, *[]string, *sync.Mutex) {
	t.Helper()
	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		mu.Unlock()
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies, &mu
}

func TestNew_NopWhenNoURL(t *testing.T) {
	if _, ok := New("", "prod").(Nop); !ok {
		t.Fatal("empty webhook URL must yield a Nop alerter")
	}
	// Nop.Send must not panic.
	New("", "").Send(context.Background(), Alert{Title: "x"})
}

func TestSend_PostsFormattedMessage(t *testing.T) {
	srv, bodies, mu := captureServer(t)
	a := New(srv.URL, "prod-eastus2")
	a.Send(context.Background(), Alert{Severity: Critical, Title: "roll stuck", Detail: "3/5 workers stale"})

	mu.Lock()
	defer mu.Unlock()
	if len(*bodies) != 1 {
		t.Fatalf("want 1 POST, got %d", len(*bodies))
	}
	var payload map[string]string
	if err := json.Unmarshal([]byte((*bodies)[0]), &payload); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	text := payload["text"]
	for _, want := range []string{"[prod-eastus2]", "roll stuck", "3/5 workers stale"} {
		if !contains(text, want) {
			t.Errorf("message %q missing %q", text, want)
		}
	}
}

func TestSend_CooldownDedup(t *testing.T) {
	srv, bodies, mu := captureServer(t)
	s := New(srv.URL, "").(*slackAlerter)
	base := time.Unix(1_000_000, 0)
	var nowNs atomic.Int64
	nowNs.Store(base.UnixNano())
	s.now = func() time.Time { return time.Unix(0, nowNs.Load()) }

	fire := func() { s.Send(context.Background(), Alert{Title: "t", DedupKey: "roll:eastus2"}) }

	fire()                                                 // first: allowed
	fire()                                                 // within cooldown: suppressed
	nowNs.Store(base.Add(DefaultCooldown - time.Minute).UnixNano())
	fire()                                                 // still within cooldown: suppressed
	nowNs.Store(base.Add(DefaultCooldown + time.Minute).UnixNano())
	fire()                                                 // past cooldown: allowed

	mu.Lock()
	defer mu.Unlock()
	if len(*bodies) != 2 {
		t.Fatalf("cooldown: want 2 sends, got %d", len(*bodies))
	}
}

func TestSend_DistinctKeysNotSuppressed(t *testing.T) {
	srv, bodies, mu := captureServer(t)
	a := New(srv.URL, "")
	a.Send(context.Background(), Alert{Title: "a", DedupKey: "k1"})
	a.Send(context.Background(), Alert{Title: "b", DedupKey: "k2"})
	mu.Lock()
	defer mu.Unlock()
	if len(*bodies) != 2 {
		t.Fatalf("distinct keys: want 2 sends, got %d", len(*bodies))
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
