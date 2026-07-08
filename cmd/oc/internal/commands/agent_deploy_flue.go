package commands

// Flue deploy flow (design 013 §6 — the Worker-for-Platforms Durable-Object model).
// When agent.toml declares `[runtime] family = "flue"`, `oc agent deploy` does NOT
// read prompt.md/skills/; it runs the app's own `flue build --target cloudflare`, then
// stages the WHOLE built dir (the entry module + the no_bundle assets/ tree) as one
// tar.gz in R2 via a presigned PUT, and POSTs the deployment referencing only the R2
// bundle digest + the (small, strict-JSON) generated wrangler + the entrypoint agent
// name — NO module bytes in the JSON, so the API host stays byte-free. The CP records
// a `verifying` deploy; an off-host runner fetches the bundle, composes, mints the
// per-deploy token, WfP-uploads, and canary-verifies before activating. The existing
// deployment poll absorbs the verify latency (verifying → ready|failed).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/bundle"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/credscan"
	"github.com/spf13/cobra"
)

const (
	// flueBuildOutputDir is `flue build --target cloudflare`'s output root; the tool
	// writes the Cloudflare build under dist/<app>/ (wrangler.json + the entry module +
	// assets/), so we discover the wrangler beneath it rather than assume a flat layout.
	flueBuildOutputDir = "dist"
	flueBundleMaxBytes = 64 << 20 // server caps the staged bundle at 64 MiB — fail early
)

// artifactUploadResponse is the reply from POST /v3/agents/:id/artifacts. AlreadyUploaded
// is set (and URL omitted) when the content-addressed object already exists: R2 is
// write-once, so the server refuses to re-issue a PUT for a pinned digest (a re-issuable
// PUT would let scan-clean bytes be swapped for key-bearing ones post-verify). The CLI
// then skips the PUT and references the digest directly.
type artifactUploadResponse struct {
	URL             string `json:"url"`
	ExpiresAt       string `json:"expires_at"`
	AlreadyUploaded bool   `json:"already_uploaded"`
}

func deployFlue(cmd *cobra.Command, sc *client.Client, dir string, m *manifest, noActivate bool) error {
	// 1. Primary credential scan over the user's source (§11.2.6): model keys come
	//    from the OC credential, never from committed code. Stays client-side.
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
	//    Done before the build so a runtime-family mismatch fails fast — ahead of the
	//    build and the upload, not after.
	id, err := resolveDeployAgent(cmd, sc, m)
	if err != nil {
		return err
	}

	// 3. Build the app with its own `flue` CLI (a devDependency).
	if err := runFlueBuild(cmd.Context(), dir); err != nil {
		return err
	}

	// 4. Stage the whole built dir as one content-addressed tar.gz + read the wrangler.
	//    The digest is sha256 of the blob the server and box will hash byte-for-byte.
	files, wrangler, err := readFlueBundle(filepath.Join(dir, flueBuildOutputDir))
	if err != nil {
		return err
	}
	tarGz, err := bundle.Pack(files)
	if err != nil {
		return fmt.Errorf("pack bundle: %w", err)
	}
	digest := bundle.Digest(tarGz)
	if len(tarGz) > flueBundleMaxBytes {
		return fmt.Errorf("bundle is %d bytes, over the %d MiB limit", len(tarGz), flueBundleMaxBytes>>20)
	}

	// 5. Upload: presigned PUT to R2 (the API host never sees the bytes).
	if err := uploadArtifact(cmd.Context(), sc, id, digest, tarGz); err != nil {
		return err
	}

	// 6. Deployment referencing the R2 bundle digest + the generated wrangler (no
	//    module bytes in the JSON). The CP keys the flue-DO path off the agent's
	//    runtime="flue" + the presence of flue_bundle_digest/flue_wrangler, then hands
	//    off to the off-host runner (fetch → compose → mint → WfP-upload) → verifying.
	rt := m.Runtime.Type
	if rt == "" {
		rt = "default"
	}
	input := map[string]interface{}{
		"type":               "inline",
		"model":              m.Model,
		"runtime":            map[string]string{"type": rt},
		"flue_bundle_digest": digest,   // sha256: of the tar.gz staged in R2
		"flue_wrangler":      wrangler, // the generated wrangler.json object, verbatim
		"flue_agent_name":    m.Name,   // entrypoint agent (agent.toml name → DO admit address)
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

	// 7. Poll to terminal — the CP canary boots the tenant DO before activating.
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

// runFlueBuild runs the app's own `flue` CLI: `flue build --target cloudflare`.
// Prefers the locally-installed bin; falls back to `npx --no-install`, which runs the
// package only if it is already in node_modules and NEVER fetches a same-named package
// from the registry (a supply-chain hole). Build output goes to stderr so stdout stays
// clean for --json.
func runFlueBuild(ctx context.Context, dir string) error {
	args := []string{"build", "--target", "cloudflare"}
	bin := filepath.Join(dir, "node_modules", ".bin", "flue")
	var c *exec.Cmd
	if _, err := os.Stat(bin); err == nil {
		c = exec.CommandContext(ctx, bin, args...)
	} else {
		c = exec.CommandContext(ctx, "npx", append([]string{"--no-install", "flue"}, args...)...)
	}
	c.Dir = dir
	c.Stdout = os.Stderr
	c.Stderr = os.Stderr
	// No stdin: `flue build` is a non-interactive bundler, and wiring the terminal
	// through would let an npx install prompt hijack it.
	if err := c.Run(); err != nil {
		return fmt.Errorf("flue build failed: %w\n(run `npm install` so the flue CLI is available, node >= 22.19)", err)
	}
	return nil
}

// readFlueBundle locates the generated wrangler under the `flue build` output, parses
// it, and reads the whole build dir into a fileset (the entry module + the assets/
// tree). `flue build --target cloudflare` writes dist/<app>/{wrangler.json, <main>,
// assets/…}; a flat dist/ is also accepted. The fileset is rooted at the wrangler's dir
// so wrangler.main resolves at the bundle root. Returns the fileset + the wrangler
// object (forwarded to the CP verbatim as flue_wrangler).
func readFlueBundle(distDir string) ([]bundle.File, map[string]interface{}, error) {
	wranglerPath, err := findGeneratedWrangler(distDir)
	if err != nil {
		return nil, nil, err
	}
	raw, err := os.ReadFile(wranglerPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", wranglerPath, err)
	}
	var wrangler map[string]interface{}
	if err := json.Unmarshal(raw, &wrangler); err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", wranglerPath, err)
	}
	main, _ := wrangler["main"].(string)
	if main == "" {
		return nil, nil, fmt.Errorf("%s has no `main` — the flue build did not produce a Worker entry module", wranglerPath)
	}

	bundleRoot := filepath.Dir(wranglerPath)
	files, err := readBundleFiles(bundleRoot)
	if err != nil {
		return nil, nil, err
	}
	// The entry module wrangler.main names MUST be in the bundle (the runner uploads it
	// to WfP as metadata.main_module).
	mainRel := filepath.ToSlash(main)
	found := false
	for _, f := range files {
		if f.Path == mainRel {
			found = true
			break
		}
	}
	if !found {
		return nil, nil, fmt.Errorf("entry module %q (wrangler.main) is not in the build output %s", mainRel, bundleRoot)
	}
	return files, wrangler, nil
}

// findGeneratedWrangler returns the generated wrangler.json path — dist/wrangler.json
// (flat) or the single dist/<app>/wrangler.json `flue build` writes. Zero or more than
// one candidate is an error (nothing built / ambiguous output).
func findGeneratedWrangler(distDir string) (string, error) {
	if info, err := os.Stat(distDir); err != nil || !info.IsDir() {
		return "", fmt.Errorf("build output %s not found — did `flue build --target cloudflare` run?", distDir)
	}
	flat := filepath.Join(distDir, "wrangler.json")
	if _, err := os.Stat(flat); err == nil {
		return flat, nil
	}
	matches, _ := filepath.Glob(filepath.Join(distDir, "*", "wrangler.json"))
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no wrangler.json under %s — `flue build --target cloudflare` produced no Cloudflare build", distDir)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("multiple wrangler.json under %s (%v) — ambiguous flue build output", distDir, matches)
	}
}

// readBundleFiles walks the build output into a fileset with normalized modes and
// forward-slash, root-relative paths (the tar the CP fetches + unpacks off-host).
func readBundleFiles(root string) ([]bundle.File, error) {
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("build output %s not found — did `flue build --target cloudflare` run?", root)
	}
	var files []bundle.File
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		files = append(files, bundle.File{
			Path:    filepath.ToSlash(rel),
			Mode:    bundle.NormalizeMode(int(st.Mode().Perm())),
			Content: content,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", root, err)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("build output %s is empty", root)
	}
	return files, nil
}

// uploadArtifact requests a presigned PUT URL, then PUTs the bundle to it. The PUT
// carries no OC auth (the signature is in the URL); Content-Type must match what the
// server signed for the object (application/gzip).
func uploadArtifact(ctx context.Context, sc *client.Client, agentID, digest string, tarGz []byte) error {
	reqBody := map[string]interface{}{"digest": digest, "size_bytes": len(tarGz)}
	var resp artifactUploadResponse
	if err := sc.Post(ctx, "/v3/agents/"+agentID+"/artifacts", reqBody, &resp); err != nil {
		return fmt.Errorf("request bundle upload url: %w", err)
	}
	if resp.AlreadyUploaded {
		// The digest's bytes are already in R2 (write-once); nothing to PUT.
		return nil
	}
	if resp.URL == "" {
		return fmt.Errorf("bundle upload url response was empty")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, resp.URL, bytes.NewReader(tarGz))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/gzip")
	req.ContentLength = int64(len(tarGz))
	put, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload bundle: %w", err)
	}
	defer put.Body.Close()
	if put.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(put.Body, 512))
		return fmt.Errorf("bundle upload failed (HTTP %d): %s", put.StatusCode, string(snippet))
	}
	return nil
}
