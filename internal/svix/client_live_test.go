package svix

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLive exercises the client against the real Svix API. It is skipped unless
// SVIX_API_TOKEN is set, so normal `go test` is unaffected:
//
//	SVIX_API_TOKEN=$(cat /tmp/svix_token) go test ./internal/svix/ -run TestLive -v
func TestLive(t *testing.T) {
	token := os.Getenv("SVIX_API_TOKEN")
	if token == "" {
		t.Skip("SVIX_API_TOKEN not set; skipping live Svix test")
	}
	c := NewClient(token)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Region resolution from the token suffix.
	t.Logf("baseURL=%s", c.baseURL)

	// Ensure the example event type exists (idempotent).
	_ = c.do(ctx, "register_event_type", http.MethodPost, "/api/v1/event-type/",
		map[string]any{"name": "sandbox.created", "description": "OC live test"}, nil, nil)

	uid := "oc-livetest-" + strings.ReplaceAll(time.Now().UTC().Format("20060102T150405.000"), ".", "-")

	// EnsureApplication is idempotent on uid.
	app1, err := c.EnsureApplication(ctx, uid, "OC live test")
	if err != nil {
		t.Fatalf("EnsureApplication #1: %v", err)
	}
	app2, err := c.EnsureApplication(ctx, uid, "OC live test")
	if err != nil {
		t.Fatalf("EnsureApplication #2: %v", err)
	}
	if app1.ID != app2.ID {
		t.Fatalf("EnsureApplication not idempotent: %s != %s", app1.ID, app2.ID)
	}
	t.Logf("app=%s (idempotent)", app1.ID)

	// Cleanup the whole app (and its endpoints) at the end.
	defer func() {
		if err := c.do(context.Background(), "delete_app", http.MethodDelete,
			"/api/v1/app/"+app1.ID+"/", nil, nil, nil); err != nil {
			t.Logf("cleanup delete app: %v", err)
		}
	}()

	// Create an endpoint scoped to one event type.
	ep, err := c.CreateEndpoint(ctx, app1.ID, EndpointParams{
		URL:         "https://httpbingo.org/post",
		Description: "oc live test",
		FilterTypes: []string{"sandbox.created"},
	})
	if err != nil {
		t.Fatalf("CreateEndpoint: %v", err)
	}
	t.Logf("endpoint=%s", ep.ID)

	// Secret should be a whsec_ key.
	secret, err := c.GetEndpointSecret(ctx, app1.ID, ep.ID)
	if err != nil {
		t.Fatalf("GetEndpointSecret: %v", err)
	}
	if !strings.HasPrefix(secret, "whsec_") {
		t.Fatalf("unexpected secret prefix: %q", firstN(secret, 8))
	}
	t.Logf("secret prefix ok (whsec_…)")

	// Per-destination metadata as custom headers (delivered on every event).
	if err := c.SetEndpointHeaders(ctx, app1.ID, ep.ID, map[string]string{"X-OC-Tenant": "t1"}); err != nil {
		t.Fatalf("SetEndpointHeaders: %v", err)
	}
	t.Logf("custom headers set")

	// List shows the endpoint.
	eps, err := c.ListEndpoints(ctx, app1.ID)
	if err != nil {
		t.Fatalf("ListEndpoints: %v", err)
	}
	if len(eps) != 1 || eps[0].ID != ep.ID {
		t.Fatalf("ListEndpoints = %d eps, want our 1", len(eps))
	}
	t.Logf("list ok (%d endpoint)", len(eps))

	// Test send (backs /api/webhooks/:id/test) — a real message with a synthetic
	// payload (no event-type schema dependency). Colon id sanitized; raw id is
	// the idempotency key.
	msg, err := c.CreateMessage(ctx, app1.ID, MessageParams{
		EventType:      "sandbox.created",
		EventID:        "sb-livetest:sandbox.created",
		Payload:        map[string]any{"type": "sandbox.created", "sandboxId": "sb-livetest"},
		IdempotencyKey: "sb-livetest:sandbox.created",
	})
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if msg.EventID != "sb-livetest.sandbox.created" {
		t.Fatalf("eventId not sanitized: %q", msg.EventID)
	}
	t.Logf("create-message ok (msg=%s eventId=%s)", msg.ID, msg.EventID)

	// Delete endpoint.
	if err := c.DeleteEndpoint(ctx, app1.ID, ep.ID); err != nil {
		t.Fatalf("DeleteEndpoint: %v", err)
	}
	t.Logf("endpoint deleted; live test passed")
}

func firstN(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}
