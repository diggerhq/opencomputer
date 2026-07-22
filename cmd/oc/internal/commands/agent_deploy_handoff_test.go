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
	want := "✓ Deployed triage\n\n" +
		"  Revision   1 · active\n" +
		"  Agent URL  https://agt-abcdef0123456789abcdef01.agents.opencomputer.dev\n" +
		"  Manage     https://app.opencomputer.dev/agents/" + agentID + "\n\n" +
		"  Run\n" +
		"    oc agent invoke " + agentID + " --data '{\"message\":\"Hello\"}'\n"
	if got != want {
		t.Fatalf("human deploy output mismatch:\n--- got ---\n%s--- want ---\n%s", got, want)
	}
	if strings.Contains(got, "\x1b") {
		t.Fatalf("redirected output contained a terminal control sequence: %q", got)
	}

	var machineOutput bytes.Buffer
	printer = output.New(true)
	printer.W = &machineOutput
	jsonOutput = true
	if err := agentDeployCmd.RunE(cmd, []string{dir}); err != nil {
		t.Fatalf("agent deploy --json: %v", err)
	}
	var machine map[string]any
	if err := json.Unmarshal(machineOutput.Bytes(), &machine); err != nil {
		t.Fatalf("machine output is not one JSON object: %v\n%s", err, machineOutput.String())
	}
	if machine["agent_id"] != agentID || machine["state"] != "ready" || machine["active"] != true || machine["revision"] != float64(1) {
		t.Fatalf("machine deploy schema changed: %#v", machine)
	}
	if strings.Contains(machineOutput.String(), "Deployed") || strings.Contains(machineOutput.String(), "\x1b") {
		t.Fatalf("machine output contained presentation text: %q", machineOutput.String())
	}
}

func TestDeploySuccessWithoutConvenienceReadStaysUseful(t *testing.T) {
	var out bytes.Buffer
	renderDeploySuccess(&out, deploySuccess{
		Agent: Agent{ID: "agt_abcdef0123456789abcdef01"}, Revision: 2, Status: "active",
	}, deployOutputStyle{})
	got := out.String()
	for _, want := range []string{
		"✓ Deployed agt_abcdef0123456789abcdef01",
		"Revision   2 · active",
		"Manage     https://app.opencomputer.dev/agents/agt_abcdef0123456789abcdef01",
		"oc agent invoke agt_abcdef0123456789abcdef01",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("fallback output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "Agent URL") {
		t.Fatalf("fallback invented an Agent URL: %s", got)
	}
}

func TestDeploySuccessTTYStyleIsRestrainedAndLinked(t *testing.T) {
	const invokeURL = "https://agt-abcdef0123456789abcdef01.agents.opencomputer.dev"
	var out bytes.Buffer
	renderDeploySuccess(&out, deploySuccess{
		Agent: Agent{
			ID: "agt_abcdef0123456789abcdef01", Name: "triage", InvokeURL: invokeURL,
		},
		Revision: 3, Status: "staged", Digest: "f42ea75bad3e",
	}, deployOutputStyle{color: true, hyperlinks: true})
	got := out.String()
	for _, want := range []string{
		"\x1b[32m✓\x1b[0m",
		"\x1b[1mDeployed triage\x1b[0m",
		"3 · \x1b[33mstaged\x1b[0m · f42ea75bad3e",
		"\x1b]8;;" + invokeURL + "\x1b\\" + invokeURL + "\x1b]8;;\x1b\\",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("styled output missing %q:\n%q", want, got)
		}
	}
}

func TestTerminalLinkRejectsControlSequenceInjection(t *testing.T) {
	got := terminalLink("https://example.com/ok\x1b]8;;https://evil.example", true)
	if strings.Contains(got, "\x1b") || !strings.Contains(got, "https://example.com/ok") {
		t.Fatalf("unsafe terminal link projection: %q", got)
	}
}
