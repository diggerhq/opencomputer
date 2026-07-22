package commands

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

func TestResolveHookIDPrefersCurrentHookAcrossPages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "osb_test" {
			t.Errorf("missing sessions API key")
		}
		if r.URL.Query().Get("include_revoked") != "true" || r.URL.Query().Get("limit") != "100" {
			t.Errorf("query = %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("cursor") == "" {
			_, _ = io.WriteString(w, `{"data":[{"id":"hk_aaaaaaaaaaaaaaaaaaaaaaaa","agent_id":"agt_0123456789abcdef01234567","name":"grafana","status":"revoked","secret_last4":"old1","revoked_reason":"manual","expires_at":null,"created_at":"2026-07-20T00:00:00Z"}],"next_cursor":"next"}`)
			return
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"hk_bbbbbbbbbbbbbbbbbbbbbbbb","agent_id":"agt_0123456789abcdef01234567","name":"grafana","status":"active","secret_last4":"new1","revoked_reason":null,"expires_at":null,"created_at":"2026-07-21T00:00:00Z"}],"next_cursor":null}`)
	}))
	defer server.Close()

	command := &cobra.Command{}
	command.SetContext(context.Background())
	hookID, err := resolveHookID(
		command,
		client.NewSessionsAPI(server.URL, "osb_test"),
		"agt_0123456789abcdef01234567",
		"grafana",
	)
	if err != nil {
		t.Fatal(err)
	}
	if hookID != "hk_bbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("hook id = %q", hookID)
	}
}

func TestResolveHookIDRejectsAmbiguousRevokedNames(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"hk_aaaaaaaaaaaaaaaaaaaaaaaa","name":"grafana","status":"revoked"},{"id":"hk_bbbbbbbbbbbbbbbbbbbbbbbb","name":"grafana","status":"revoked"}],"next_cursor":null}`)
	}))
	defer server.Close()

	command := &cobra.Command{}
	command.SetContext(context.Background())
	_, err := resolveHookID(
		command,
		client.NewSessionsAPI(server.URL, "osb_test"),
		"agt_0123456789abcdef01234567",
		"grafana",
	)
	if err == nil || !strings.Contains(err.Error(), "multiple revoked Hooks") {
		t.Fatalf("error = %v", err)
	}
}

func TestAgentHookPublicMetadataCannotCarryTheSecretURL(t *testing.T) {
	response := AgentHookCreateResponse{
		Hook: AgentHook{
			ID:          "hk_aaaaaaaaaaaaaaaaaaaaaaaa",
			AgentID:     "agt_0123456789abcdef01234567",
			Name:        "grafana",
			Status:      "active",
			SecretLast4: "last",
		},
		HookURL: "https://example.test/hooks/ochk_v1_secret",
	}
	encoded, err := json.Marshal(response.Hook)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "ochk_v1_") || strings.Contains(string(encoded), "hook_url") {
		t.Fatalf("Hook metadata leaked credential material: %s", encoded)
	}
	if !strings.Contains(response.HookURL, "ochk_v1_") {
		t.Fatal("create response should retain its copy-once URL")
	}
}

func TestAgentHookCommandShape(t *testing.T) {
	if agentHooksCmd.Use != "hooks" {
		t.Fatalf("list command use = %q", agentHooksCmd.Use)
	}
	if agentHookCreateCmd.Flags().Lookup("expires-at") == nil {
		t.Fatal("hook create must expose --expires-at")
	}
	if agentHookRevokeCmd.Flags().Lookup("yes") == nil {
		t.Fatal("hook revoke must require or accept explicit confirmation")
	}
}
