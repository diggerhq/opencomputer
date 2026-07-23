package commands

// Contract-mock end-to-end for the Flue DO deploy flow (design 013 §6). A fake control
// plane implements the presigned-PUT bundle upload (POST /v3/agents/:id/artifacts + the
// signed PUT) and the deployment create + a verifying→ready poll. A throwaway
// `node_modules/.bin/flue` script stands in for the app's flue CLI, so the real
// runFlueBuild exec path runs and produces a deliberately noisy dist/<app>/. deployFlue
// is driven end to end; we assert the uploaded bytes are byte-exactly the canonical
// module-only tar.gz for the digest the CLI
// advertised (the content-address chain), and that the POSTed deployment body is the
// byte-free DO request: flue_bundle_digest + the canonical flue_wrangler descriptor +
// flue_agent_name, with no raw Wrangler dump, module bytes, or framework_artifact_digest.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/bundle"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/fluebuild"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
)

// The exact bytes the fake `flue build` emits into dist/e2e_flue/ (heredoc appends a
// trailing newline). The build is nested a directory deep, with an assets/ file, to
// exercise the dist/<app>/ discovery and prove the WHOLE tree is staged.
const (
	fakeAgentID     = "agt_0123456789abcdef01234567"
	e2eModuleBody   = `export default { fetch() { return new Response("ok"); } };`
	e2eAssetBody    = `export const chunk = 1;`
	e2eRuntimeBody  = `export const runtime = "flue";`
	e2eWranglerBody = `{"$schema":"../../node_modules/wrangler/config-schema.json","name":"e2e-flue","main":"index.js","compatibility_date":"2026-04-01","compatibility_flags":["nodejs_compat"],"no_bundle":true,"configPath":"/Users/developer/project/flue.config.ts","userConfigPath":"/Users/developer/project/wrangler.json","durable_objects":{"bindings":[{"name":"AGENT","class_name":"FlueE2EAgent"},{"name":"FLUE_REGISTRY","class_name":"FlueRegistry"}]},"vars":{"MUST_NOT_LEAVE":"raw-wrangler"},"migrations":[{"tag":"attacker-owned","new_sqlite_classes":["Wrong"]}],"routes":["example.com/*"],"services":[{"binding":"OTHER","service":"victim"}]}`
)

type fakeCP struct {
	mu             sync.Mutex
	self           string
	createBody     map[string]any
	configPutBody  map[string]any
	artifactDigest string
	artifactSize   float64
	uploaded       []byte
	sourceBody     map[string]any
	sourceUploaded []byte
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
		writeJSON(map[string]any{"id": fakeAgentID, "name": "e2e-flue", "model": "anthropic/claude-sonnet-5", "runtime": "flue"})
	case r.Method == "GET" && r.URL.Path == "/v3/agents/"+fakeAgentID:
		writeJSON(map[string]any{
			"id": fakeAgentID, "name": "e2e-flue", "model": "anthropic/claude-sonnet-5", "runtime": "flue",
			"invoke_url": "https://agt-0123456789abcdef01234567.agents.opencomputer.dev",
		})
	case r.Method == "PUT" && r.URL.Path == "/v3/agents/"+fakeAgentID+"/config":
		_ = json.NewDecoder(r.Body).Decode(&f.configPutBody)
		writeJSON(map[string]any{
			"vars": f.configPutBody["vars"], "deployment_required": true,
		})
	case r.Method == "POST" && r.URL.Path == "/v3/agents/"+fakeAgentID+"/artifacts":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.artifactDigest, _ = body["digest"].(string)
		f.artifactSize, _ = body["size_bytes"].(float64)
		writeJSON(map[string]any{"url": f.self + "/upload/" + f.artifactDigest, "expires_at": "2099-01-01T00:00:00Z"})
	case r.Method == "POST" && r.URL.Path == "/v3/agents/"+fakeAgentID+"/source-artifacts":
		_ = json.NewDecoder(r.Body).Decode(&f.sourceBody)
		uploadID, _ := f.sourceBody["upload_id"].(string)
		writeJSON(map[string]any{"url": f.self + "/source-upload/" + uploadID, "expires_at": "2099-01-01T00:00:00Z"})
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/upload/"):
		if ct := r.Header.Get("Content-Type"); ct != "application/gzip" {
			http.Error(w, "bad content-type: "+ct, http.StatusBadRequest)
			return
		}
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		f.uploaded = buf.Bytes()
		w.WriteHeader(http.StatusOK)
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/source-upload/"):
		if ct := r.Header.Get("Content-Type"); ct != "application/gzip" {
			http.Error(w, "bad content-type: "+ct, http.StatusBadRequest)
			return
		}
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		f.sourceUploaded = buf.Bytes()
		w.WriteHeader(http.StatusOK)
	case r.Method == "POST" && r.URL.Path == "/v3/agents/"+fakeAgentID+"/deployments":
		_ = json.NewDecoder(r.Body).Decode(&f.deployBody)
		writeJSON(map[string]any{"deployment": map[string]any{"id": "dep_1", "state": "verifying"}})
	case r.Method == "GET" && r.URL.Path == "/v3/agents/"+fakeAgentID+"/deployments/dep_1":
		f.getCount++
		if f.getCount < 2 {
			writeJSON(map[string]any{"id": "dep_1", "state": "verifying"}) // verifying → …
		} else {
			writeJSON(map[string]any{"id": "dep_1", "state": "ready", "active": true, "revision_id": "rev_1"}) // → terminal
		}
	case r.Method == "GET" && r.URL.Path == "/v3/agents/"+fakeAgentID+"/revisions":
		writeJSON(map[string]any{"data": []any{}})
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusNotFound)
	}
}

func TestDeployFlueDoEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake flue build is a POSIX shell script")
	}
	t.Setenv("WRANGLER_LOG", "")

	// A Flue app dir: manifest + clean source + a stand-in `flue` bin whose
	// `build --target cloudflare` writes a deterministic but noisy dist/e2e_flue/.
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "agent.toml"),
		"name  = \"e2e-flue\"\nmodel = \"anthropic/claude-sonnet-5\"\n\n[runtime]\nfamily = \"flue\"\n", 0o644)
	writeFile(t, filepath.Join(dir, "package.json"),
		`{"engines":{"node":">=18"},"devDependencies":{"@flue/cli":"1.0.0"}}`, 0o644)
	writeFile(t, filepath.Join(dir, "package-lock.json"),
		`{"lockfileVersion":3}`, 0o644)
	writeFile(t, filepath.Join(dir, "src", "opencomputer.ts"),
		"import { serveOC } from '@opencomputer/flue';\nexport default serveOC(agent);\n", 0o644)
	buildScript := "#!/bin/sh\nset -e\ntest \"${WRANGLER_LOG:-}\" = error\necho 'FLUE BUILD BANNER'\necho 'FLUE BUILD DETAIL' >&2\nmkdir -p dist/e2e_flue/assets dist/e2e_flue/.vite dist/e2e_flue/.flue-vite\n" +
		"cat > dist/e2e_flue/index.js <<'JS'\n" + e2eModuleBody + "\nJS\n" +
		"cat > dist/e2e_flue/assets/chunk.js <<'JS'\n" + e2eAssetBody + "\nJS\n" +
		"cat > dist/e2e_flue/.flue-vite/runtime.mjs <<'JS'\n" + e2eRuntimeBody + "\nJS\n" +
		"printf '%s' '{\"version\":3}' > dist/e2e_flue/.vite/manifest.json\n" +
		"printf '%s' '{\"version\":3}' > dist/e2e_flue/index.js.map\n" +
		"cat > dist/e2e_flue/wrangler.json <<'JSON'\n" + e2eWranglerBody + "\nJSON\n"
	writeFile(t, filepath.Join(dir, "node_modules", ".bin", "flue"), buildScript, 0o755)

	// Only regular modules leave the machine. Raw Wrangler metadata, .vite state and
	// source maps are absent; .flue-vite is a legitimate module path.
	expectedFiles := []bundle.File{
		{Path: "index.js", Mode: 0o644, Content: []byte(e2eModuleBody + "\n")},
		{Path: "assets/chunk.js", Mode: 0o644, Content: []byte(e2eAssetBody + "\n")},
		{Path: ".flue-vite/runtime.mjs", Mode: 0o644, Content: []byte(e2eRuntimeBody + "\n")},
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
	var humanOutput bytes.Buffer
	printer.W = &humanOutput
	defer func() { printer = prev }()

	if err := deployFlue(cmd, sc, dir, m, false); err != nil {
		t.Fatalf("deployFlue: %v", err)
	}
	for _, want := range []string{
		"✓ Deployed e2e-flue\n",
		"Agent URL\n  https://agt-0123456789abcdef01234567.agents.opencomputer.dev\n",
		"Revision    active · " + shortDigest(expectedDigest) + "\n",
		"Dashboard   https://app.opencomputer.dev/agents/" + fakeAgentID + "\n",
		"$ oc agent invoke " + fakeAgentID + " --data '{\"message\":\"Hello\"}'\n",
	} {
		if !strings.Contains(humanOutput.String(), want) {
			t.Errorf("human deploy output missing %q:\n%s", want, humanOutput.String())
		}
	}
	if strings.Contains(humanOutput.String(), "FLUE BUILD") {
		t.Fatalf("framework build chatter leaked into the deploy result:\n%s", humanOutput.String())
	}

	// Agent created as flue, no prompt.
	if f.createBody["runtime"] != "flue" {
		t.Errorf("create runtime = %v, want flue", f.createBody["runtime"])
	}
	if _, ok := f.createBody["prompt"]; ok {
		t.Errorf("create body carried a prompt for a flue agent: %v", f.createBody["prompt"])
	}

	// The content address the CLI advertised == the digest of the module-only bundle, and
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

	// flue_wrangler is the exact canonical descriptor, not the generated resolution dump.
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
	wantKeys := map[string]bool{
		"main": true, "compatibility_date": true, "compatibility_flags": true,
		"no_bundle": true, "durable_objects": true,
	}
	if len(wr) != len(wantKeys) {
		t.Errorf("flue_wrangler keys = %v, want only canonical descriptor", wr)
	}
	for key := range wr {
		if !wantKeys[key] {
			t.Errorf("raw Wrangler capability %q escaped into deployment: %v", key, wr[key])
		}
	}
	if wr["compatibility_date"] != "2026-04-01" || wr["no_bundle"] != true {
		t.Errorf("flue_wrangler profile changed: %v", wr)
	}
	encodedWrangler, _ := json.Marshal(wr)
	for _, leaked := range []string{"/Users/developer", "MUST_NOT_LEAVE", "attacker-owned", "example.com", "victim"} {
		if strings.Contains(string(encodedWrangler), leaked) {
			t.Errorf("raw Wrangler value %q escaped into deployment: %s", leaked, encodedWrangler)
		}
	}

	// The verifying→ready sequence was actually polled.
	if f.getCount < 2 {
		t.Errorf("expected the poll to observe verifying→ready (got %d GETs)", f.getCount)
	}
	if vars, ok := f.configPutBody["vars"].(map[string]any); !ok || len(vars) != 0 {
		t.Errorf("manifest without [vars] should clear desired vars, got %#v", f.configPutBody)
	}
}

func TestFlueBuildEnvPreservesExplicitWranglerLog(t *testing.T) {
	t.Setenv("WRANGLER_LOG", "debug")
	for _, value := range fluebuild.BuildEnv() {
		if value == "WRANGLER_LOG=debug" {
			return
		}
	}
	t.Fatal("flueBuildEnv did not preserve explicit WRANGLER_LOG=debug")
}

func TestExtractFlueWranglerDescriptorRejectsUnsafeInput(t *testing.T) {
	valid := func() map[string]any {
		var value map[string]any
		if err := json.Unmarshal([]byte(e2eWranglerBody), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "unsafe main", mutate: func(value map[string]any) { value["main"] = "../index.js" }},
		{name: "invalid compatibility date", mutate: func(value map[string]any) { value["compatibility_date"] = "2026-02-30" }},
		{name: "invalid compatibility flag", mutate: func(value map[string]any) {
			value["compatibility_flags"] = []any{"nodejs_compat", "unsafe flag"}
		}},
		{name: "duplicate compatibility flag", mutate: func(value map[string]any) {
			value["compatibility_flags"] = []any{"nodejs_compat", "nodejs_compat"}
		}},
		{name: "bundling enabled", mutate: func(value map[string]any) { value["no_bundle"] = false }},
		{name: "foreign script binding", mutate: func(value map[string]any) {
			bindings := value["durable_objects"].(map[string]any)["bindings"].([]any)
			bindings[0].(map[string]any)["script_name"] = "victim-worker"
		}},
		{name: "missing durable objects", mutate: func(value map[string]any) {
			value["durable_objects"].(map[string]any)["bindings"] = []any{}
		}},
		{name: "duplicate binding name", mutate: func(value map[string]any) {
			value["durable_objects"].(map[string]any)["bindings"] = []any{
				map[string]any{"name": "FLUE_REGISTRY", "class_name": "FlueE2EAgent"},
				map[string]any{"name": "FLUE_REGISTRY", "class_name": "FlueRegistry"},
			}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			value := valid()
			tc.mutate(value)
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fluebuild.ExtractWranglerDescriptor(raw); err == nil {
				t.Fatalf("expected %s to be rejected", tc.name)
			}
		})
	}
}

func TestExtractFlueWranglerDescriptorPreservesBuildProfile(t *testing.T) {
	var value map[string]any
	if err := json.Unmarshal([]byte(e2eWranglerBody), &value); err != nil {
		t.Fatal(err)
	}
	value["compatibility_date"] = "2026-07-01"
	value["compatibility_flags"] = []any{"nodejs_compat", "nodejs_als"}
	bindings := value["durable_objects"].(map[string]any)["bindings"].([]any)
	bindings[1] = map[string]any{"name": "FLUE_STATE", "class_name": "FlueState"}

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := fluebuild.ExtractWranglerDescriptor(raw)
	if err != nil {
		t.Fatalf("extract descriptor: %v", err)
	}
	if descriptor.CompatibilityDate != "2026-07-01" {
		t.Fatalf("compatibility date = %q", descriptor.CompatibilityDate)
	}
	if strings.Join(descriptor.CompatibilityFlags, ",") != "nodejs_compat,nodejs_als" {
		t.Fatalf("compatibility flags = %v", descriptor.CompatibilityFlags)
	}
	if descriptor.DurableObjects.Bindings[1].Name != "FLUE_STATE" || descriptor.DurableObjects.Bindings[1].ClassName != "FlueState" {
		t.Fatalf("renamed Flue internal binding was not preserved: %v", descriptor.DurableObjects.Bindings)
	}
}

func TestReadBundleModulesRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.js")
	writeFile(t, outside, "export const secret = true;", 0o644)
	writeFile(t, filepath.Join(root, "index.js"), "export {};", 0o644)
	if err := os.Symlink(outside, filepath.Join(root, "leak.js")); err != nil {
		t.Fatal(err)
	}
	if _, err := fluebuild.ReadBundleModules(root); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink rejection, got %v", err)
	}
}

func TestReadBundleModulesRejectsUnexpectedRegularFile(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "index.js"), "export {};", 0o644)
	writeFile(t, filepath.Join(root, "runtime.wasm"), "not really wasm", 0o644)
	if _, err := fluebuild.ReadBundleModules(root); err == nil || !strings.Contains(err.Error(), "unsupported file") {
		t.Fatalf("expected unsupported-file rejection, got %v", err)
	}
}

func TestSyncManifestVarsReplacesDesiredVars(t *testing.T) {
	f := &fakeCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	f.self = srv.URL

	sc := client.NewSessionsAPI(srv.URL, "test-key")
	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())
	m := &manifest{Vars: map[string]string{"PUBLIC_MODE": "careful", "MAX_ITEMS": "12"}}
	if err := syncManifestVars(cmd, sc, fakeAgentID, m); err != nil {
		t.Fatalf("syncManifestVars: %v", err)
	}
	vars, _ := f.configPutBody["vars"].(map[string]any)
	if vars["PUBLIC_MODE"] != "careful" || vars["MAX_ITEMS"] != "12" {
		t.Errorf("vars PUT = %#v", f.configPutBody["vars"])
	}
}

func TestDeployFlueBlocksOnLeakedKey(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "agent.toml"),
		"name = \"leaky\"\nmodel = \"anthropic/claude-sonnet-5\"\n[runtime]\nfamily = \"flue\"\n", 0o644)
	writeFile(t, filepath.Join(dir, "package.json"),
		`{"engines":{"node":">=18"},"devDependencies":{"@flue/cli":"1.0.0"}}`, 0o644)
	writeFile(t, filepath.Join(dir, "package-lock.json"),
		`{"lockfileVersion":3}`, 0o644)
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

func TestDeployPromptDefinedFlueEndToEnd(t *testing.T) {
	dir := t.TempDir()
	manifestBytes := []byte(
		"name = \"e2e-flue\"\nmodel = \"anthropic/claude-sonnet-5\"\n" +
			"[runtime]\nfamily = \"flue\"\ntype = \"default\"\n",
	)
	promptBytes := []byte("Help the user with `quotes`, ${expressions}, and care.\n")
	skillBytes := []byte("# Review\n\nInspect the diff before publishing.\n")
	writeFile(t, filepath.Join(dir, "agent.toml"), string(manifestBytes), 0o644)
	writeFile(t, filepath.Join(dir, "prompt.md"), string(promptBytes), 0o644)
	writeFile(t, filepath.Join(dir, "skills", "review", "SKILL.md"), string(skillBytes), 0o644)
	writeFile(t, filepath.Join(dir, "README.md"), "not part of the build source\n", 0o644)
	if !isPromptDefinedFlueRoot(dir) {
		t.Fatal("expected prompt-defined root")
	}

	expected, err := bundle.Pack([]bundle.File{
		{Path: "agent.toml", Mode: 0o644, Content: manifestBytes},
		{Path: "prompt.md", Mode: 0o644, Content: promptBytes},
		{Path: "skills/review/SKILL.md", Mode: 0o644, Content: skillBytes},
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedDigest := bundle.Digest(expected)

	f := &fakeCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	f.self = srv.URL

	cmd := &cobra.Command{}
	cmd.Flags().String("agent", "", "")
	cmd.Flags().String("idempotency-key", "local-e2e", "")
	cmd.Flags().Int("timeout", 30, "")
	cmd.SetContext(context.Background())
	m := &manifest{Name: "e2e-flue", Model: "anthropic/claude-sonnet-5"}
	m.Runtime.Family = "flue"
	m.Runtime.Type = "default"

	prev := printer
	printer = output.New(false)
	var humanOutput bytes.Buffer
	printer.W = &humanOutput
	defer func() { printer = prev }()

	err = deployFlue(
		cmd,
		client.NewSessionsAPI(srv.URL, "test-key"),
		dir,
		m,
		false,
	)
	if err != nil {
		t.Fatalf("deployFlue: %v", err)
	}
	if !bytes.Equal(f.sourceUploaded, expected) {
		t.Fatalf("uploaded source differs from bounded canonical source (got %d bytes, want %d)", len(f.sourceUploaded), len(expected))
	}
	if f.sourceBody["digest"] != expectedDigest {
		t.Errorf("source digest = %v, want %s", f.sourceBody["digest"], expectedDigest)
	}
	if f.sourceBody["size_bytes"] != float64(len(expected)) {
		t.Errorf("source size = %v, want %d", f.sourceBody["size_bytes"], len(expected))
	}
	uploadID, _ := f.sourceBody["upload_id"].(string)
	if !regexp.MustCompile(`^src_[0-9a-f]{32}$`).MatchString(uploadID) {
		t.Errorf("upload id = %q", uploadID)
	}

	input, _ := f.deployBody["input"].(map[string]any)
	if input["type"] != "source" || input["entrypoint"] != "e2e-flue" ||
		input["model"] != "anthropic/claude-sonnet-5" {
		t.Errorf("source deployment input = %#v", input)
	}
	source, _ := input["source"].(map[string]any)
	if source["upload_id"] != uploadID || source["digest"] != expectedDigest ||
		source["size_bytes"] != float64(len(expected)) {
		t.Errorf("deployment source ref = %#v", source)
	}
	if runtimeInput, _ := input["runtime"].(map[string]any); runtimeInput["type"] != "default" {
		t.Errorf("runtime input = %#v", input["runtime"])
	}
	if f.deployBody["activate"] != true || f.deployBody["idempotency_key"] != "local-e2e" {
		t.Errorf("deployment envelope = %#v", f.deployBody)
	}
	encoded, _ := json.Marshal(f.deployBody)
	for _, forbidden := range []string{
		string(promptBytes),
		string(skillBytes),
		"README.md",
		"source.tgz",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("byte-free deployment request leaked %q: %s", forbidden, encoded)
		}
	}
	if !strings.Contains(humanOutput.String(), "✓ Deployed e2e-flue") ||
		!strings.Contains(humanOutput.String(), "Agent URL") {
		t.Errorf("deploy handoff missing:\n%s", humanOutput.String())
	}

	writeFile(t, filepath.Join(dir, "package.json"), "{}\n", 0o644)
	if isPromptDefinedFlueRoot(dir) {
		t.Fatal("a package marker must select the complete-app path")
	}
}

func TestReadPromptDefinedFlueSourceRejectsUnsafeShapes(t *testing.T) {
	base := func(t *testing.T) string {
		t.Helper()
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "agent.toml"), "name='a'\n", 0o644)
		writeFile(t, filepath.Join(dir, "prompt.md"), "Help.\n", 0o644)
		return dir
	}
	t.Run("mcp", func(t *testing.T) {
		dir := base(t)
		writeFile(t, filepath.Join(dir, "mcp.json"), "{}\n", 0o644)
		if _, err := readPromptDefinedFlueSource(dir); err == nil || !strings.Contains(err.Error(), "mcp.json") {
			t.Fatalf("expected mcp rejection, got %v", err)
		}
	})
	t.Run("invalid skill name", func(t *testing.T) {
		dir := base(t)
		writeFile(t, filepath.Join(dir, "skills", "Review_Skill", "SKILL.md"), "# Review\n", 0o644)
		if _, err := readPromptDefinedFlueSource(dir); err == nil || !strings.Contains(err.Error(), "invalid name") {
			t.Fatalf("expected skill-name rejection, got %v", err)
		}
	})
	t.Run("prompt symlink", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlink semantics differ on Windows")
		}
		dir := base(t)
		if err := os.Remove(filepath.Join(dir, "prompt.md")); err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "prompt.md")
		writeFile(t, outside, "secret\n", 0o644)
		if err := os.Symlink(outside, filepath.Join(dir, "prompt.md")); err != nil {
			t.Fatal(err)
		}
		if _, err := readPromptDefinedFlueSource(dir); err == nil || !strings.Contains(err.Error(), "regular file") {
			t.Fatalf("expected symlink rejection, got %v", err)
		}
	})
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
