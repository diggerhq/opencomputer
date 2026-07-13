package commands

// Flue deploy flow (design 013 §6 — the Worker-for-Platforms Durable-Object model).
// When agent.toml declares `[runtime] family = "flue"`, `oc agent deploy` does NOT
// read prompt.md/skills/; it runs the app's own `flue build --target cloudflare`, then
// stages only regular .js/.mjs modules as one tar.gz in R2 via a presigned PUT, and
// POSTs the deployment referencing only the R2 bundle digest + a small canonical
// Flue descriptor + the entrypoint agent name — NO module bytes in the JSON, so the
// API host stays byte-free. The CP records
// a `verifying` deploy; an off-host runner fetches the bundle, composes, mints the
// per-deploy token, WfP-uploads, and finalizes. The existing deployment poll absorbs
// the runner latency (verifying → ready|failed).

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
	pathpkg "path"
	"path/filepath"
	"regexp"
	"strings"
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
	flueBuildOutputDir    = "dist"
	flueBundleMaxBytes    = 64 << 20 // server caps the staged bundle at 64 MiB — fail early
	flueCompatibilityDate = "2026-04-01"
)

var flueBindingIdentifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

type flueDOBinding struct {
	Name      string `json:"name"`
	ClassName string `json:"class_name"`
}

type flueWranglerDescriptor struct {
	Main               string   `json:"main"`
	CompatibilityDate  string   `json:"compatibility_date"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	NoBundle           bool     `json:"no_bundle"`
	DurableObjects     struct {
		Bindings []flueDOBinding `json:"bindings"`
	} `json:"durable_objects"`
}

type generatedFlueWrangler struct {
	Main               string   `json:"main"`
	CompatibilityDate  string   `json:"compatibility_date"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	NoBundle           bool     `json:"no_bundle"`
	DurableObjects     struct {
		Bindings []json.RawMessage `json:"bindings"`
	} `json:"durable_objects"`
}

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
	// [vars] is part of the deployment input even though the values live in the
	// agent config resource. Persist it before enqueueing so the off-host runner
	// cannot race ahead and compose the Worker with stale bindings. Secrets are
	// intentionally CLI/API only and are resolved by that same runner.
	if err := syncManifestVars(cmd, sc, id, m); err != nil {
		return err
	}

	// 3. Build the app with its own `flue` CLI (a devDependency).
	if err := runFlueBuild(cmd.Context(), dir); err != nil {
		return err
	}

	// 4. Extract the strict descriptor and stage only regular module files. Raw
	//    wrangler.json contains build-local paths and never leaves this machine.
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

	// 6. Deployment referencing the R2 bundle digest + the canonical descriptor (no
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
		"flue_wrangler":      wrangler, // strict adapter descriptor; never raw wrangler.json
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

	// 7. Poll to terminal while the off-host runner uploads and finalizes the deployment.
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

// readFlueBundle locates the generated wrangler, extracts the exact Flue descriptor,
// and reads only regular .js/.mjs modules rooted at the wrangler's directory. The raw
// wrangler resolution dump, .vite state and source maps are known control artifacts and
// are never archived; any other non-module fails loudly instead of producing a broken deploy.
func readFlueBundle(distDir string) ([]bundle.File, flueWranglerDescriptor, error) {
	wranglerPath, err := findGeneratedWrangler(distDir)
	if err != nil {
		return nil, flueWranglerDescriptor{}, err
	}
	raw, err := os.ReadFile(wranglerPath)
	if err != nil {
		return nil, flueWranglerDescriptor{}, fmt.Errorf("read %s: %w", wranglerPath, err)
	}
	wrangler, err := extractFlueWranglerDescriptor(raw)
	if err != nil {
		return nil, flueWranglerDescriptor{}, fmt.Errorf("parse %s: %w", wranglerPath, err)
	}

	bundleRoot := filepath.Dir(wranglerPath)
	files, err := readBundleModules(bundleRoot)
	if err != nil {
		return nil, flueWranglerDescriptor{}, err
	}
	// The entry module wrangler.main names MUST be in the bundle (the runner uploads it
	// to WfP as metadata.main_module).
	mainRel := wrangler.Main
	found := false
	for _, f := range files {
		if f.Path == mainRel {
			found = true
			break
		}
	}
	if !found {
		return nil, flueWranglerDescriptor{}, fmt.Errorf("entry module %q (wrangler.main) is not in the module output %s", mainRel, bundleRoot)
	}
	return files, wrangler, nil
}

func safeFlueModulePath(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, `\`) {
		return false
	}
	if ext := pathpkg.Ext(value); ext != ".js" && ext != ".mjs" {
		return false
	}
	if pathpkg.Clean(value) != value {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func extractFlueWranglerDescriptor(raw []byte) (flueWranglerDescriptor, error) {
	var generated generatedFlueWrangler
	if err := json.Unmarshal(raw, &generated); err != nil {
		return flueWranglerDescriptor{}, err
	}
	if !safeFlueModulePath(generated.Main) {
		return flueWranglerDescriptor{}, fmt.Errorf("main must be a safe relative .js/.mjs module path")
	}
	if generated.CompatibilityDate != flueCompatibilityDate {
		return flueWranglerDescriptor{}, fmt.Errorf("compatibility_date must be %s", flueCompatibilityDate)
	}
	if len(generated.CompatibilityFlags) != 1 || generated.CompatibilityFlags[0] != "nodejs_compat" {
		return flueWranglerDescriptor{}, fmt.Errorf(`compatibility_flags must be exactly ["nodejs_compat"]`)
	}
	if !generated.NoBundle {
		return flueWranglerDescriptor{}, fmt.Errorf("no_bundle must be true")
	}

	bindings := make([]flueDOBinding, 0, len(generated.DurableObjects.Bindings))
	names := map[string]bool{}
	classes := map[string]bool{}
	registryCount := 0
	for _, rawBinding := range generated.DurableObjects.Bindings {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(rawBinding, &fields); err != nil {
			return flueWranglerDescriptor{}, fmt.Errorf("invalid durable-object binding: %w", err)
		}
		if len(fields) != 2 || fields["name"] == nil || fields["class_name"] == nil {
			return flueWranglerDescriptor{}, fmt.Errorf("durable-object bindings may contain only name and class_name")
		}
		var binding flueDOBinding
		if err := json.Unmarshal(rawBinding, &binding); err != nil {
			return flueWranglerDescriptor{}, fmt.Errorf("invalid durable-object binding: %w", err)
		}
		if !flueBindingIdentifier.MatchString(binding.Name) || !flueBindingIdentifier.MatchString(binding.ClassName) {
			return flueWranglerDescriptor{}, fmt.Errorf("durable-object binding names and class names must be non-empty JavaScript identifiers")
		}
		if names[binding.Name] || classes[binding.ClassName] {
			return flueWranglerDescriptor{}, fmt.Errorf("durable-object binding names and class names must be unique")
		}
		names[binding.Name] = true
		classes[binding.ClassName] = true
		if binding.Name == "FLUE_REGISTRY" && binding.ClassName == "FlueRegistry" {
			registryCount++
		}
		bindings = append(bindings, binding)
	}
	if registryCount != 1 {
		return flueWranglerDescriptor{}, fmt.Errorf("FLUE_REGISTRY must bind FlueRegistry exactly once")
	}

	var descriptor flueWranglerDescriptor
	descriptor.Main = generated.Main
	descriptor.CompatibilityDate = flueCompatibilityDate
	descriptor.CompatibilityFlags = []string{"nodejs_compat"}
	descriptor.NoBundle = true
	descriptor.DurableObjects.Bindings = bindings
	return descriptor, nil
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

// readBundleModules walks the output into a module-only fileset with normalized modes
// and forward-slash, root-relative paths. Symlinks, special files and unexpected regular
// files fail closed. Only the generated wrangler, source maps and .vite state are ignored.
func readBundleModules(root string) ([]bundle.File, error) {
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("build output %s not found — did `flue build --target cloudflare` run?", root)
	}
	var files []bundle.File
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if p != root && d.Name() == ".vite" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("build output contains symlink %s; only regular modules are allowed", p)
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		st, err := d.Info()
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() {
			return fmt.Errorf("build output contains non-regular file %s", p)
		}
		if rel == "wrangler.json" || strings.HasSuffix(rel, ".map") {
			return nil
		}
		if !safeFlueModulePath(rel) {
			return fmt.Errorf("build output contains unsupported file %q; expected only .js/.mjs modules", rel)
		}
		content, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		files = append(files, bundle.File{
			Path:    rel,
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
