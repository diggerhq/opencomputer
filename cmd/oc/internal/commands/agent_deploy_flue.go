package commands

// Flue deploy flow (design 012 §11.7.8, flue-slice.md W4 + contracts 3/4/5/10).
// When agent.toml declares `[runtime] family = "flue"`, `oc agent deploy` does
// NOT read prompt.md/skills/; instead it builds the app into a content-addressed
// artifact, uploads it via a presigned PUT, and references the digest in the
// deployment. The host boot-verifies the artifact (a ~30–60s scratch-sandbox
// probe) before activating the revision — the existing poll absorbs that latency.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/credscan"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/bundle"
	"github.com/spf13/cobra"
)

const (
	flueBuildOutputDir   = "dist-oc" // oc-flue-build's output (gitignored in the app)
	flueArtifactMaxBytes = 64 << 20  // contract 3: server caps at 64 MiB — fail early
)

// artifactUploadResponse is the reply from POST /v3/agents/:id/artifacts (contract 3).
// AlreadyUploaded is set (and URL omitted) when the content-addressed object already exists:
// R2 is write-once, so the server refuses to re-issue a PUT for a pinned digest (a re-issuable
// PUT would let scan-clean bytes be swapped for key-bearing ones post-verify). The CLI then
// skips the PUT and references the digest directly.
type artifactUploadResponse struct {
	URL             string `json:"url"`
	ExpiresAt       string `json:"expires_at"`
	AlreadyUploaded bool   `json:"already_uploaded"`
}

func deployFlue(cmd *cobra.Command, sc *client.Client, dir string, m *manifest, noActivate bool) error {
	// 1. Primary credential scan over the user's pre-bundle sources (§11.2.6):
	//    model keys come from the OC credential, never from committed code.
	findings, err := credscan.ScanDir(dir)
	if err != nil {
		return fmt.Errorf("credential scan: %w", err)
	}
	if len(findings) > 0 {
		fmt.Fprintln(os.Stderr, "Refusing to deploy — possible credential(s) in source (model keys come from the OC credential, never code):")
		for _, f := range findings {
			fmt.Fprintf(os.Stderr, "  %s:%d  %s  %s\n", f.Path, f.Line, f.Kind, f.Match)
		}
		return &ExitError{Code: 1}
	}

	// 2. Resolve the target agent (create with runtime=flue + no prompt if new).
	//    Done before the build so a runtime-family mismatch fails fast — ahead
	//    of the build and the artifact upload, not after a late server reject.
	id, err := resolveDeployAgent(cmd, sc, m)
	if err != nil {
		return err
	}

	// 3. Build the artifact with the app's own @opencomputer/flue devDependency.
	if err := runFlueBuild(cmd.Context(), dir); err != nil {
		return err
	}

	// 4. Pack dist-oc/ into the tar.gz and content-address it: the digest is
	//    sha256 of the blob the server and box will hash byte-for-byte.
	outDir := filepath.Join(dir, flueBuildOutputDir)
	files, err := readArtifactFiles(outDir)
	if err != nil {
		return err
	}
	tarGz, err := bundle.Pack(files)
	if err != nil {
		return fmt.Errorf("pack artifact: %w", err)
	}
	digest := bundle.Digest(tarGz)
	if len(tarGz) > flueArtifactMaxBytes {
		return fmt.Errorf("artifact is %d bytes, over the %d MiB limit", len(tarGz), flueArtifactMaxBytes>>20)
	}

	// 5. Upload: presigned PUT (contract 3).
	if err := uploadArtifact(cmd.Context(), sc, id, digest, tarGz); err != nil {
		return err
	}

	// 6. Deployment referencing the digest (contract 10 — no prompt/skills path).
	rt := m.Runtime.Type
	if rt == "" {
		rt = "default"
	}
	input := map[string]interface{}{
		"type":                      "inline",
		"model":                     m.Model,
		"runtime":                   map[string]string{"type": rt},
		"framework_artifact_digest": digest,
	}
	body := map[string]interface{}{"input": input, "activate": !noActivate}
	if idem, _ := cmd.Flags().GetString("idempotency-key"); idem != "" {
		body["idempotency_key"] = idem
	}
	var env DeploymentEnvelope
	if err := sc.Post(cmd.Context(), "/v3/agents/"+id+"/deployments", body, &env); err != nil {
		return err
	}
	d := env.Deployment

	// 7. Poll to terminal — deploy boots a verify sandbox before activating.
	if !terminalState(d.State) && d.State != "" {
		to, _ := cmd.Flags().GetInt("timeout")
		d, err = pollDeployment(cmd, sc, id, d.ID, time.Duration(to)*time.Second)
		if err != nil {
			return err
		}
	}
	if d.State == "failed" {
		printer.Print(d, func() { fmt.Printf("Deploy failed: %s\n", deployFailMsg(d)) })
		return &ExitError{Code: 1}
	}
	printer.Print(d, func() {
		n := revisionNumber(cmd, sc, id, d.RevisionID)
		status := "staged"
		if d.Active {
			status = "active"
		}
		fmt.Printf("Deployed revision %d — %s (%s)\n", n, status, shortDigest(digest))
	})
	return nil
}

// resolveDeployAgent picks the agent a flue deploy targets: --agent > manifest
// [agent].id > ensure-by-name (creating a flue agent with no prompt if absent).
func resolveDeployAgent(cmd *cobra.Command, sc *client.Client, m *manifest) (string, error) {
	if explicit, _ := cmd.Flags().GetString("agent"); explicit != "" {
		return resolveRef(cmd, sc, explicit)
	}
	if m.Agent.ID != "" {
		return m.Agent.ID, nil
	}
	id, _, err := ensureAgentByName(cmd, sc, m.Name, "", m.Model, "flue")
	return id, err
}

// runFlueBuild runs the app's oc-flue-build (its own devDependency). Prefers the
// locally-installed bin; falls back to `npx --no-install`, which runs the
// package only if it is already in node_modules and NEVER fetches a same-named
// package from the registry (a supply-chain hole). Build output goes to stderr
// so stdout stays clean for --json.
func runFlueBuild(ctx context.Context, dir string) error {
	bin := filepath.Join(dir, "node_modules", ".bin", "oc-flue-build")
	var c *exec.Cmd
	if _, err := os.Stat(bin); err == nil {
		c = exec.CommandContext(ctx, bin)
	} else {
		c = exec.CommandContext(ctx, "npx", "--no-install", "oc-flue-build")
	}
	c.Dir = dir
	c.Stdout = os.Stderr
	c.Stderr = os.Stderr
	// No stdin: oc-flue-build is a non-interactive bundler, and wiring the
	// terminal through let an npx install prompt hijack it.
	if err := c.Run(); err != nil {
		return fmt.Errorf("oc-flue-build failed: %w\n(run `npm install` so @opencomputer/flue is available, node >= 22)", err)
	}
	return nil
}

// readArtifactFiles walks the build output into a fileset with normalized modes,
// requiring artifact.json (the manifest the host validates + pins).
func readArtifactFiles(outDir string) ([]bundle.File, error) {
	if info, err := os.Stat(outDir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("build output %s not found — did oc-flue-build run?", outDir)
	}
	var files []bundle.File
	hasManifest := false
	err := filepath.WalkDir(outDir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(outDir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		content, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		if rel == "artifact.json" {
			hasManifest = true
		}
		files = append(files, bundle.File{
			Path:    rel,
			Mode:    bundle.NormalizeMode(int(st.Mode().Perm())),
			Content: content,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", outDir, err)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("build output %s is empty", outDir)
	}
	if !hasManifest {
		return nil, fmt.Errorf("%s/artifact.json missing — build did not produce a valid artifact", outDir)
	}
	return files, nil
}

// uploadArtifact requests a presigned PUT URL, then PUTs the bundle to it. The
// PUT carries no OC auth (the signature is in the URL); Content-Type must match
// what the server signed for the object (application/gzip).
func uploadArtifact(ctx context.Context, sc *client.Client, agentID, digest string, tarGz []byte) error {
	reqBody := map[string]interface{}{"digest": digest, "size_bytes": len(tarGz)}
	var resp artifactUploadResponse
	if err := sc.Post(ctx, "/v3/agents/"+agentID+"/artifacts", reqBody, &resp); err != nil {
		return fmt.Errorf("request artifact upload url: %w", err)
	}
	if resp.AlreadyUploaded {
		// The digest's bytes are already in R2 (write-once); nothing to PUT.
		return nil
	}
	if resp.URL == "" {
		return fmt.Errorf("artifact upload url response was empty")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, resp.URL, bytes.NewReader(tarGz))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/gzip")
	req.ContentLength = int64(len(tarGz))
	put, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload artifact: %w", err)
	}
	defer put.Body.Close()
	if put.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(put.Body, 512))
		return fmt.Errorf("artifact upload failed (HTTP %d): %s", put.StatusCode, string(snippet))
	}
	return nil
}
