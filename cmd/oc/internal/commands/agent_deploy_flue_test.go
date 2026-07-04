package commands

// Contract-mock end-to-end for the Flue deploy flow. A fake control plane
// implements contract 3 (POST /v3/agents/:id/artifacts + the presigned PUT) and
// contract 10 (deployment create + a verifying→ready poll). A throwaway
// `node_modules/.bin/oc-flue-build` script stands in for @opencomputer/flue, so
// the real runFlueBuild exec path runs and produces a dist-oc/. deployFlue is
// driven end to end; we assert the uploaded bytes are byte-exactly the canonical
// bundle for the digest the CLI advertised — the whole content-address chain.

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

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/filesetdigest"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
)

// The exact bytes the fake build emits into dist-oc/ (heredoc appends a newline).
const (
	e2eArtifactBody = `{"entry":"oc.js","profile_version":1,"model":"anthropic/claude-sonnet-5"}`
	e2eOcBody       = `export const agent = "e2e";`
)

type fakeCP struct {
	mu             sync.Mutex
	self           string
	createBody     map[string]any
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

func TestDeployFlueEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake oc-flue-build is a POSIX shell script")
	}

	// A Flue app dir: manifest + clean source + a stand-in build bin.
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "agent.toml"),
		"name  = \"e2e-flue\"\nmodel = \"anthropic/claude-sonnet-5\"\n\n[runtime]\nfamily = \"flue\"\n", 0o644)
	writeFile(t, filepath.Join(dir, "src", "opencomputer.ts"),
		"import { serveOC } from '@opencomputer/flue';\nexport default serveOC(agent);\n", 0o644)
	// The build emits a deterministic dist-oc/ (mirrors what oc-flue-build would).
	buildScript := "#!/bin/sh\nset -e\nmkdir -p dist-oc\n" +
		"cat > dist-oc/artifact.json <<'JSON'\n" + e2eArtifactBody + "\nJSON\n" +
		"cat > dist-oc/oc.js <<'JS'\n" + e2eOcBody + "\nJS\n"
	writeFile(t, filepath.Join(dir, "node_modules", ".bin", "oc-flue-build"), buildScript, 0o755)

	// What the CLI must produce from that dist-oc/ (mode normalized to 0644).
	expectedFiles := []filesetdigest.File{
		{Path: "artifact.json", Mode: 0o644, Content: []byte(e2eArtifactBody + "\n")},
		{Path: "oc.js", Mode: 0o644, Content: []byte(e2eOcBody + "\n")},
	}
	expectedDigest := filesetdigest.Digest(expectedFiles)
	expectedTarGz, err := filesetdigest.TarGz(expectedFiles)
	if err != nil {
		t.Fatal(err)
	}

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

	// Content address the CLI advertised == the digest of the known fileset.
	if f.artifactDigest != expectedDigest {
		t.Errorf("advertised digest = %s, want %s", f.artifactDigest, expectedDigest)
	}
	// size_bytes is honest, and the PUT body is byte-exactly the canonical bundle
	// for that digest — the full upload integrity chain.
	if int(f.artifactSize) != len(f.uploaded) {
		t.Errorf("size_bytes %d != uploaded len %d", int(f.artifactSize), len(f.uploaded))
	}
	if !bytes.Equal(f.uploaded, expectedTarGz) {
		t.Errorf("uploaded bytes are not the canonical bundle for the digest (len got %d want %d)", len(f.uploaded), len(expectedTarGz))
	}

	// Deployment referenced the same digest, via input.framework_artifact_digest.
	input, _ := f.deployBody["input"].(map[string]any)
	if input == nil {
		t.Fatalf("deployment body had no input: %v", f.deployBody)
	}
	if input["framework_artifact_digest"] != expectedDigest {
		t.Errorf("deployment digest = %v, want %s", input["framework_artifact_digest"], expectedDigest)
	}
	if _, ok := input["prompt"]; ok {
		t.Errorf("deployment input carried a prompt: %v", input["prompt"])
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
