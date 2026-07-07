package commands

// Contract-mock end-to-end for the Flue DO deploy flow (design 013 §6). A fake
// control plane implements the deployment create + a verifying→ready poll. A throwaway
// `node_modules/.bin/flue` script stands in for the app's flue CLI, so the real
// runFlueBuild exec path runs and produces a dist/<app>/ (the entry module + the
// generated wrangler.json). deployFlue is driven end to end; we assert the POSTed
// deployment body is the well-formed DO-deploy request: input.type=inline, no prompt,
// no framework_artifact_digest, flue_module={filename,contentB64} carrying the base64
// of the built entry module, flue_wrangler=the generated wrangler object, and
// flue_agent_name=the agent.toml name — then that verifying→ready was actually polled.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
)

// The exact bytes the fake `flue build` emits into dist/e2e_flue/ (heredoc appends a
// trailing newline). The wrangler is nested a directory deep to also exercise the
// dist/<app>/ discovery.
const (
	e2eModuleBody   = `export default { fetch() { return new Response("ok"); } };`
	e2eWranglerBody = `{"name":"e2e-flue","main":"index.js","compatibility_date":"2026-04-01","compatibility_flags":["nodejs_compat"],"durable_objects":{"bindings":[{"name":"AGENT","class_name":"FlueE2EAgent"}]},"migrations":[{"tag":"v1","new_sqlite_classes":["FlueE2EAgent"]}]}`
)

type fakeCP struct {
	mu         sync.Mutex
	createBody map[string]any
	deployBody map[string]any
	getCount   int
}

func (f *fakeCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	writeJSON := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/v3/agents":
		writeJSON(map[string]any{"data": []any{}})
	case r.Method == "POST" && r.URL.Path == "/v3/agents":
		_ = json.NewDecoder(r.Body).Decode(&f.createBody)
		writeJSON(map[string]any{"id": "agt_e2e", "name": "e2e-flue", "model": "anthropic/claude-sonnet-5", "runtime": "flue"})
	case r.Method == "POST" && r.URL.Path == "/v3/agents/agt_e2e/deployments":
		_ = json.NewDecoder(r.Body).Decode(&f.deployBody)
		writeJSON(map[string]any{"deployment": map[string]any{"id": "dep_1", "state": "verifying"}})
	case r.Method == "GET" && r.URL.Path == "/v3/agents/agt_e2e/deployments/dep_1":
		f.getCount++
		if f.getCount < 2 {
			writeJSON(map[string]any{"id": "dep_1", "state": "verifying"}) // verifying → …
		} else {
			writeJSON(map[string]any{"id": "dep_1", "state": "ready", "active": true, "revision_id": "rev_1"}) // → terminal
		}
	case r.Method == "GET" && r.URL.Path == "/v3/agents/agt_e2e/revisions":
		writeJSON(map[string]any{"data": []any{}})
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusNotFound)
	}
}

func TestDeployFlueDoEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake flue build is a POSIX shell script")
	}

	// A Flue app dir: manifest + clean source + a stand-in `flue` bin whose
	// `build --target cloudflare` writes a deterministic dist/e2e_flue/.
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "agent.toml"),
		"name  = \"e2e-flue\"\nmodel = \"anthropic/claude-sonnet-5\"\n\n[runtime]\nfamily = \"flue\"\n", 0o644)
	writeFile(t, filepath.Join(dir, "src", "opencomputer.ts"),
		"import { serveOC } from '@opencomputer/flue';\nexport default serveOC(agent);\n", 0o644)
	buildScript := "#!/bin/sh\nset -e\nmkdir -p dist/e2e_flue\n" +
		"cat > dist/e2e_flue/index.js <<'JS'\n" + e2eModuleBody + "\nJS\n" +
		"cat > dist/e2e_flue/wrangler.json <<'JSON'\n" + e2eWranglerBody + "\nJSON\n"
	writeFile(t, filepath.Join(dir, "node_modules", ".bin", "flue"), buildScript, 0o755)

	// Fake control plane.
	f := &fakeCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()

	// Drive the real deployFlue.
	sc := client.NewSessionsAPI(srv.URL, "test-key")
	cmd := &cobra.Command{}
	cmd.Flags().String("agent", "", "")
	cmd.Flags().String("idempotency-key", "", "")
	cmd.Flags().Int("timeout", 30, "")
	cmd.SetContext(context.Background())
	m := &manifest{Name: "e2e-flue", Model: "anthropic/claude-sonnet-5"}
	m.Runtime.Family = "flue"

	prev := printer
	printer = output.New(false)
	defer func() { printer = prev }()

	if err := deployFlue(cmd, sc, dir, m, false); err != nil {
		t.Fatalf("deployFlue: %v", err)
	}

	// Agent created as flue, no prompt.
	if f.createBody["runtime"] != "flue" {
		t.Errorf("create runtime = %v, want flue", f.createBody["runtime"])
	}
	if _, ok := f.createBody["prompt"]; ok {
		t.Errorf("create body carried a prompt for a flue agent: %v", f.createBody["prompt"])
	}

	// The DO-deploy request body is well-formed.
	input, _ := f.deployBody["input"].(map[string]any)
	if input == nil {
		t.Fatalf("deployment body had no input: %v", f.deployBody)
	}
	if input["type"] != "inline" {
		t.Errorf("input.type = %v, want inline", input["type"])
	}
	if f.deployBody["activate"] != true {
		t.Errorf("activate = %v, want true (no --no-activate)", f.deployBody["activate"])
	}
	if input["flue_agent_name"] != "e2e-flue" {
		t.Errorf("flue_agent_name = %v, want e2e-flue", input["flue_agent_name"])
	}
	// The DO model must NOT carry the pre-013 fields.
	if _, ok := input["prompt"]; ok {
		t.Errorf("flue DO deploy carried a prompt: %v", input["prompt"])
	}
	if _, ok := input["framework_artifact_digest"]; ok {
		t.Errorf("flue DO deploy carried a framework_artifact_digest: %v", input["framework_artifact_digest"])
	}

	// flue_module: filename from wrangler.main, contentB64 = base64 of the built entry.
	mod, _ := input["flue_module"].(map[string]any)
	if mod == nil {
		t.Fatalf("input.flue_module missing: %v", input)
	}
	if mod["filename"] != "index.js" {
		t.Errorf("flue_module.filename = %v, want index.js (from wrangler.main)", mod["filename"])
	}
	wantB64 := base64.StdEncoding.EncodeToString([]byte(e2eModuleBody + "\n"))
	if mod["contentB64"] != wantB64 {
		t.Errorf("flue_module.contentB64 is not the base64 of the built entry module")
	}

	// flue_wrangler: the generated wrangler forwarded verbatim (DO bindings intact).
	wr, _ := input["flue_wrangler"].(map[string]any)
	if wr == nil {
		t.Fatalf("input.flue_wrangler missing: %v", input)
	}
	if wr["main"] != "index.js" {
		t.Errorf("flue_wrangler.main = %v, want index.js", wr["main"])
	}
	if wr["durable_objects"] == nil {
		t.Errorf("flue_wrangler lost durable_objects: %v", wr)
	}

	// The verifying→ready sequence was actually polled.
	if f.getCount < 2 {
		t.Errorf("expected the poll to observe verifying→ready (got %d GETs)", f.getCount)
	}
}

func TestDeployFlueBlocksOnLeakedKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "agent.toml"),
		"name = \"leaky\"\nmodel = \"anthropic/claude-sonnet-5\"\n[runtime]\nfamily = \"flue\"\n", 0o644)
	writeFile(t, filepath.Join(dir, "src", "leak.ts"),
		"const k = \"sk-ant-api03-AbCdEf0123456789AbCdEf0123456789_-xyzTUV\";\n", 0o644)

	sc := client.NewSessionsAPI("http://127.0.0.1:0", "k") // must never be hit
	cmd := &cobra.Command{}
	cmd.Flags().String("agent", "", "")
	cmd.Flags().String("idempotency-key", "", "")
	cmd.Flags().Int("timeout", 5, "")
	cmd.SetContext(context.Background())
	m := &manifest{Name: "leaky", Model: "anthropic/claude-sonnet-5"}
	m.Runtime.Family = "flue"

	prev := printer
	printer = output.New(false)
	defer func() { printer = prev }()

	err := deployFlue(cmd, sc, dir, m, false)
	if err == nil {
		t.Fatal("expected deploy to fail on a leaked key")
	}
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}
