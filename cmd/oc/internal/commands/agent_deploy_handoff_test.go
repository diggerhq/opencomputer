package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
)

func TestAgentDeployFreshAgentPrintsPublicHandoff(t *testing.T) {
	const agentID = "agt_abcdef0123456789abcdef01"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v3/agents":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/v3/agents":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": agentID, "name": "triage", "model": "anthropic/claude-sonnet-4", "runtime": "claude",
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v3/agents/"+agentID:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": agentID, "name": "triage", "model": "anthropic/claude-sonnet-4", "runtime": "claude",
				"invoke_url":      "https://agt-abcdef0123456789abcdef01.agents.opencomputer.dev",
				"active_revision": map[string]any{"id": "rev_1", "number": 1, "digest": "sha256:test"},
			})
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent.toml"), []byte("name = \"triage\"\nmodel = \"anthropic/claude-sonnet-4\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "prompt.md"), []byte("Be concise.\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := &cobra.Command{}
	cmd.Flags().String("agent", "", "")
	cmd.Flags().Bool("no-activate", false, "")
	sc := client.NewSessionsAPI(server.URL, "test-key")
	cmd.SetContext(client.WithSessionsClient(context.Background(), sc))

	previousPrinter, previousJSON := printer, jsonOutput
	var humanOutput bytes.Buffer
	printer = output.New(false)
	printer.W = &humanOutput
	jsonOutput = false
	defer func() {
		printer = previousPrinter
		jsonOutput = previousJSON
	}()

	if err := agentDeployCmd.RunE(cmd, []string{dir}); err != nil {
		t.Fatalf("agent deploy: %v", err)
	}

	got := humanOutput.String()
	for _, want := range []string{
		"Agent URL: https://agt-abcdef0123456789abcdef01.agents.opencomputer.dev",
		"Invoke:    oc agent invoke " + agentID + " --data '{\"message\":\"Hello\"}'",
		"Manage:    https://app.opencomputer.dev/agents/" + agentID,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("human deploy output missing %q:\n%s", want, got)
		}
	}
}

func TestPrintDeployHandoffOmitsIncompleteAgent(t *testing.T) {
	var output bytes.Buffer
	printDeployHandoff(&output, Agent{ID: "agt_abcdef0123456789abcdef01"})
	if output.Len() != 0 {
		t.Fatalf("unexpected output without invoke URL: %q", output.String())
	}
}
