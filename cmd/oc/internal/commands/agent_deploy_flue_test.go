package commands

// Contract-mock end-to-end for the Flue DO deploy flow (design 013 §6). A fake control
// plane implements the presigned-PUT bundle upload (POST /v3/agents/:id/artifacts + the
// signed PUT) and the deployment create + a verifying→ready poll. A throwaway
// `node_modules/.bin/flue` script stands in for the app's flue CLI, so the real
// runFlueBuild exec path runs and produces a dist/<app>/ with the entry module + an
// assets/ file. deployFlue is driven end to end; we assert the uploaded bytes are
// byte-exactly the canonical tar.gz of the whole build dir for the digest the CLI
// advertised (the content-address chain), and that the POSTed deployment body is the
// byte-free DO request: flue_bundle_digest + flue_wrangler + flue_agent_name, with no
// module bytes / no framework_artifact_digest.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/bundle"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
)

// The exact bytes the fake `flue build` emits into dist/e2e_flue/ (heredoc appends a
// trailing newline). The build is nested a directory deep, with an assets/ file, to
// exercise the dist/<app>/ discovery and prove the WHOLE tree is staged.
const (
	e2eModuleBody   = `export default { fetch() { return new Response("ok"); } };`
	e2eAssetBody    = `export const chunk = 1;`
	e2eWranglerBody = `{"name":"e2e-flue","main":"index.js","compatibility_date":"2026-04-01","compatibility_flags":["nodejs_compat"],"durable_objects":{"bindings":[{"name":"AGENT","class_name":"FlueE2EAgent"}]},"migrations":[{"tag":"v1","new_sqlite_classes":["FlueE2EAgent"]}]}`
)

type fakeCP struct {
	mu             sync.Mutex
	self           string
	createBody     map[string]any
	configGets     int
	configPutBody  map[string]any
	artifactDigest string
	artifactSize   float64
	uploaded       []byte
	deployBody     map[string]any
	getCount       int
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
	case r.Method == "GET" && r.URL.Path == "/v3/agents/agt_e2e/config":
		f.configGets++
		writeJSON(map[string]any{"vars": map[string]string{}, "egress_allowlist": []string{"api.example.com"}})
	case r.Method == "PUT" && r.URL.Path == "/v3/agents/agt_e2e/config":
		_ = json.NewDecoder(r.Body).Decode(&f.configPutBody)
		writeJSON(map[string]any{
			"vars": f.configPutBody["vars"], "egress_allowlist": f.configPutBody["egress_allowlist"],
			"deployment_required": true,
		})
	case r.Method == "POST" && r.URL.Path == "/v3/agents/agt_e2e/artifacts":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.artifactDigest, _ = body["digest"].(string)
		f.artifactSize, _ = body["size_bytes"].(float64)
		writeJSON(map[string]any{"url": f.self + "/upload/" + f.artifactDigest, "expires_at": "2099-01-01T00:00:00Z"})
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/upload/"):
		if ct := r.Header.Get("Content-Type"); ct != "application/gzip" {
			http.Error(w, "bad content-type: "+ct, http.StatusBadRequest)
			return
		}
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		f.uploaded = buf.Bytes()
		w.WriteHeader(http.StatusOK)
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
	// `build --target cloudflare` writes a deterministic dist/e2e_flue/ (entry + asset
	// + wrangler), a directory deep.
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "agent.toml"),
		"name  = \"e2e-flue\"\nmodel = \"anthropic/claude-sonnet-5\"\n\n[runtime]\nfamily = \"flue\"\n", 0o644)
	writeFile(t, filepath.Join(dir, "src", "opencomputer.ts"),
		"import { serveOC } from '@opencomputer/flue';\nexport default serveOC(agent);\n", 0o644)
	buildScript := "#!/bin/sh\nset -e\nmkdir -p dist/e2e_flue/assets\n" +
		"cat > dist/e2e_flue/index.js <<'JS'\n" + e2eModuleBody + "\nJS\n" +
		"cat > dist/e2e_flue/assets/chunk.js <<'JS'\n" + e2eAssetBody + "\nJS\n" +
		"cat > dist/e2e_flue/wrangler.json <<'JSON'\n" + e2eWranglerBody + "\nJSON\n"
	writeFile(t, filepath.Join(dir, "node_modules", ".bin", "flue"), buildScript, 0o755)

	// What the CLI must produce from that dist/e2e_flue/ (modes normalized to 0644,
	// rooted at the wrangler's dir so index.js/assets are at the tar root).
	expectedFiles := []bundle.File{
		{Path: "index.js", Mode: 0o644, Content: []byte(e2eModuleBody + "\n")},
		{Path: "assets/chunk.js", Mode: 0o644, Content: []byte(e2eAssetBody + "\n")},
		{Path: "wrangler.json", Mode: 0o644, Content: []byte(e2eWranglerBody + "\n")},
	}
	expectedTarGz, err := bundle.Pack(expectedFiles)
	if err != nil {
		t.Fatal(err)
	}
	expectedDigest := bundle.Digest(expectedTarGz)

	// Fake control plane.
	f := &fakeCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	f.self = srv.URL

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

	// The content address the CLI advertised == the digest of the whole-dir bundle, and
	// the PUT body is byte-exactly that canonical tar.gz — the full upload integrity chain.
	if f.artifactDigest != expectedDigest {
		t.Errorf("advertised digest = %s, want %s", f.artifactDigest, expectedDigest)
	}
	if int(f.artifactSize) != len(f.uploaded) {
		t.Errorf("size_bytes %d != uploaded len %d", int(f.artifactSize), len(f.uploaded))
	}
	if !bytes.Equal(f.uploaded, expectedTarGz) {
		t.Errorf("uploaded bytes are not the canonical bundle for the digest (len got %d want %d)", len(f.uploaded), len(expectedTarGz))
	}

	// The deployment body is the byte-free DO request.
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
	if input["flue_bundle_digest"] != expectedDigest {
		t.Errorf("flue_bundle_digest = %v, want %s", input["flue_bundle_digest"], expectedDigest)
	}
	if input["flue_agent_name"] != "e2e-flue" {
		t.Errorf("flue_agent_name = %v, want e2e-flue", input["flue_agent_name"])
	}
	// No module bytes, no pre-013 digest field.
	if _, ok := input["flue_module"]; ok {
		t.Errorf("byte-free contract violated: input carried flue_module: %v", input["flue_module"])
	}
	if _, ok := input["prompt"]; ok {
		t.Errorf("flue DO deploy carried a prompt: %v", input["prompt"])
	}
	if _, ok := input["framework_artifact_digest"]; ok {
		t.Errorf("flue DO deploy carried a framework_artifact_digest: %v", input["framework_artifact_digest"])
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
	if f.configGets != 0 || f.configPutBody != nil {
		t.Errorf("manifest without [vars] unexpectedly touched remote config: gets=%d put=%v", f.configGets, f.configPutBody)
	}
}

func TestSyncManifestVarsPreservesEgress(t *testing.T) {
	f := &fakeCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	f.self = srv.URL

	sc := client.NewSessionsAPI(srv.URL, "test-key")
	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())
	m := &manifest{Vars: map[string]string{"PUBLIC_MODE": "careful", "MAX_ITEMS": "12"}}
	if err := syncManifestVars(cmd, sc, "agt_e2e", m); err != nil {
		t.Fatalf("syncManifestVars: %v", err)
	}
	if f.configGets != 1 {
		t.Fatalf("config GETs = %d, want 1", f.configGets)
	}
	vars, _ := f.configPutBody["vars"].(map[string]any)
	if vars["PUBLIC_MODE"] != "careful" || vars["MAX_ITEMS"] != "12" {
		t.Errorf("vars PUT = %#v", f.configPutBody["vars"])
	}
	hosts, _ := f.configPutBody["egress_allowlist"].([]any)
	if len(hosts) != 1 || hosts[0] != "api.example.com" {
		t.Errorf("egress allowlist was not preserved: %#v", f.configPutBody["egress_allowlist"])
	}
}

func TestParseConfigVars(t *testing.T) {
	got, err := parseConfigVars([]string{"MODE=fast", "EMPTY="})
	if err != nil {
		t.Fatal(err)
	}
	if got["MODE"] != "fast" || got["EMPTY"] != "" {
		t.Fatalf("parsed = %#v", got)
	}
	if _, err := parseConfigVars([]string{"BROKEN"}); err == nil {
		t.Fatal("expected malformed --var to fail")
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
