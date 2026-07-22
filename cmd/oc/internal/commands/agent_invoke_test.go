package commands

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func noInvokeWait(context.Context, time.Duration) error { return nil }

func TestInvokeAgentURLUsesExactRootBearerAndStableIdempotencyKey(t *testing.T) {
	var requests int
	var firstKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/" || r.URL.RawQuery != "" {
			t.Errorf("request target = %q, want exact root", r.URL.RequestURI())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer osb_test" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("X-API-Key"); got != "" {
			t.Errorf("X-API-Key must be absent, got %q", got)
		}
		key := r.Header.Get("Idempotency-Key")
		if requests == 1 {
			firstKey = key
		} else if key != firstKey {
			t.Errorf("retry key = %q, want %q", key, firstKey)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"task":"triage"}` {
			t.Errorf("body = %q", body)
		}
		if requests == 1 {
			http.Error(w, "temporary", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"request_id":"req_1","session":{"id":"ses_1","status":"running","head":1},"replayed":false}`)
	}))
	defer server.Close()

	receipt, err := invokeAgentURL(
		context.Background(),
		server.Client(),
		"osb_test",
		server.URL,
		[]byte(`{"task":"triage"}`),
		"stable-key",
		2,
		noInvokeWait,
	)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	if receipt.Session.ID != "ses_1" || receipt.Session.Status != "running" {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestAgentInvokeInputValidatesJSONAndExclusiveSources(t *testing.T) {
	command := &cobra.Command{}
	command.Flags().String("data", "{}", "")
	command.Flags().String("file", "", "")
	command.Flags().Bool("stdin", false, "")

	if err := command.Flags().Set("data", `{"ok":true}`); err != nil {
		t.Fatal(err)
	}
	body, err := agentInvokeInput(command)
	if err != nil || string(body) != `{"ok":true}` {
		t.Fatalf("body = %q, err = %v", body, err)
	}

	if err := command.Flags().Set("stdin", "true"); err != nil {
		t.Fatal(err)
	}
	if _, err := agentInvokeInput(command); err == nil || !strings.Contains(err.Error(), "only one") {
		t.Fatalf("exclusive source error = %v", err)
	}

	invalid := &cobra.Command{}
	invalid.Flags().String("data", "{}", "")
	invalid.Flags().String("file", "", "")
	invalid.Flags().Bool("stdin", false, "")
	if err := invalid.Flags().Set("data", "not-json"); err != nil {
		t.Fatal(err)
	}
	if _, err := agentInvokeInput(invalid); err == nil || !strings.Contains(err.Error(), "valid JSON") {
		t.Fatalf("JSON validation error = %v", err)
	}
}

func TestGeneratedInvokeKeyHasStablePublicShape(t *testing.T) {
	key, err := generatedInvokeKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != len("oc-cli-")+32 || !strings.HasPrefix(key, "oc-cli-") {
		t.Fatalf("generated key = %q", key)
	}
}
