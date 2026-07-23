package commands

// Flue deploy flow (design 013 §6 — the Worker-for-Platforms Durable-Object model).
// A prompt-defined root stages only agent.toml, prompt.md, and exact SKILL.md files;
// the isolated managed builder owns synthesis and the framework build. A complete app
// runs its own local `flue build --target cloudflare` and stages only the resulting
// regular .js/.mjs modules. Both paths keep source/module bytes out of API JSON and
// converge on the same off-host deploy runner and verifying → ready|failed poll.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/bundle"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/fluebuild"
	"github.com/spf13/cobra"
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

type localSourceUploadResponse struct {
	URL             string `json:"url"`
	ExpiresAt       string `json:"expires_at"`
	AlreadyUploaded bool   `json:"already_uploaded"`
}

const (
	fluePromptMaxBytes       = 256 * 1024
	fluePromptMaxSkills      = 32
	fluePromptMaxSkillBytes  = 256 * 1024
	fluePromptMaxSkillsBytes = 2 * 1024 * 1024
	fluePromptMaxArchive     = 4 * 1024 * 1024
)

var fluePromptSkillName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func deployFlue(cmd *cobra.Command, sc *client.Client, dir string, m *manifest, noActivate bool) error {
	if isPromptDefinedFlueRoot(dir) {
		return deployPromptDefinedFlue(cmd, sc, dir, m, noActivate)
	}
	// 1. Run the same credential, manifest, engine, and lockfile projection as
	//    the managed builder before any authenticated API call. --check-only
	//    never executes repository code and never needs installed dependencies.
	if _, err := fluebuild.Build(cmd.Context(), fluebuild.Options{
		Dir:            dir,
		Target:         fluebuild.TargetCloudflare,
		BuilderVersion: Version,
		CheckOnly:      true,
	}); err != nil {
		return presentFlueBuildError(err)
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

	// 3–4. Build through the shared credential-free package. It extracts only
	// strict WfP metadata + regular modules and credential-scans the final bytes.
	verbose, _ := cmd.Flags().GetBool("verbose")
	var buildLog bytes.Buffer
	buildStdout, buildStderr := io.Writer(&buildLog), io.Writer(&buildLog)
	if verbose {
		buildStdout, buildStderr = os.Stderr, os.Stderr
	} else {
		printDeployProgress("building")
	}
	artifact, err := fluebuild.Build(cmd.Context(), fluebuild.Options{
		Dir:            dir,
		Target:         fluebuild.TargetCloudflare,
		BuilderVersion: Version,
		BuildStdout:    buildStdout,
		BuildStderr:    buildStderr,
	})
	if err != nil {
		if !verbose && buildLog.Len() > 0 {
			endsWithNewline := buildLog.Bytes()[buildLog.Len()-1] == '\n'
			fmt.Fprintln(os.Stderr, "Framework build output:")
			_, _ = io.Copy(os.Stderr, &buildLog)
			if !endsWithNewline {
				fmt.Fprintln(os.Stderr)
			}
		}
		return presentFlueBuildError(err)
	}
	digest := artifact.Deployment.Bundle.Digest
	wrangler := artifact.Deployment.Flue.Wrangler

	// 5. Upload: presigned PUT to R2 (the API host never sees the bytes).
	if !verbose {
		printDeployProgress("uploading")
	}
	if err := uploadArtifact(cmd.Context(), sc, id, digest, artifact.Bundle); err != nil {
		return err
	}

	// 6. Deployment referencing the R2 bundle digest + the canonical descriptor (no
	//    module bytes in the JSON). The CP keys the flue-DO path off the agent's
	//    runtime="flue" + the presence of flue_bundle_digest/flue_wrangler, then hands
	//    off to the off-host runner (fetch → compose → mint → WfP-upload) → verifying.
	rt := artifact.Deployment.Runtime.Type
	input := map[string]interface{}{
		"type":               "inline",
		"model":              artifact.Deployment.Model,
		"runtime":            map[string]string{"type": rt},
		"flue_bundle_digest": digest,   // sha256: of the tar.gz staged in R2
		"flue_wrangler":      wrangler, // strict adapter descriptor; never raw wrangler.json
		"flue_agent_name":    artifact.Deployment.Flue.Entrypoint,
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
	handoff := Agent{}
	if !jsonOutput && d.State == "ready" {
		handoff = loadDeployHandoff(cmd, sc, id)
	}
	printer.Print(d, func() {
		n := revisionNumber(cmd, sc, id, d.RevisionID)
		status := "staged"
		if d.Active {
			status = "active"
		}
		printDeploySuccess(printer.W, deploySuccess{
			Agent: handoff, Revision: n, Status: status, Digest: shortDigest(digest),
		})
	})
	return nil
}

func isPromptDefinedFlueRoot(dir string) bool {
	exists := func(name string) bool {
		_, err := os.Lstat(name)
		return err == nil
	}
	if !exists(filepath.Join(dir, "prompt.md")) {
		return false
	}
	for _, marker := range []string{
		"package.json",
		"flue.config.ts",
		"flue.config.js",
		"flue.config.mjs",
		"flue.config.cjs",
	} {
		if _, err := os.Lstat(filepath.Join(dir, marker)); err == nil {
			return false
		}
	}
	return true
}

// deployPromptDefinedFlue stages the bounded behavior source directly into the
// transient source bucket, then asks the existing isolated managed-build plane
// to synthesize and build it. The API sees only the source reference.
func deployPromptDefinedFlue(
	cmd *cobra.Command,
	sc *client.Client,
	dir string,
	m *manifest,
	noActivate bool,
) error {
	if m.Name == "" {
		return fmt.Errorf("prompt-defined Flue deployments require `name` in agent.toml")
	}
	if m.Runtime.Type != "" && m.Runtime.Type != "default" {
		return fmt.Errorf("prompt-defined Flue deployments require runtime.type = \"default\"")
	}
	files, err := readPromptDefinedFlueSource(dir)
	if err != nil {
		return err
	}
	sourceTarGz, err := bundle.Pack(files)
	if err != nil {
		return fmt.Errorf("pack prompt-defined Flue source: %w", err)
	}
	if len(sourceTarGz) > fluePromptMaxArchive {
		return fmt.Errorf(
			"prompt-defined Flue source archive exceeds %d bytes",
			fluePromptMaxArchive,
		)
	}
	uploadID, err := newLocalSourceUploadID()
	if err != nil {
		return fmt.Errorf("create source upload id: %w", err)
	}
	digest := bundle.Digest(sourceTarGz)

	id, err := resolveDeployAgent(cmd, sc, m)
	if err != nil {
		return err
	}
	if err := syncManifestVars(cmd, sc, id, m); err != nil {
		return err
	}
	if !jsonOutput {
		printDeployProgress("uploading source")
	}
	if err := uploadLocalBuildSource(
		cmd.Context(),
		sc,
		id,
		uploadID,
		digest,
		sourceTarGz,
	); err != nil {
		return err
	}

	rt := m.Runtime.Type
	if rt == "" {
		rt = "default"
	}
	input := map[string]interface{}{
		"type":       "source",
		"source":     map[string]interface{}{"upload_id": uploadID, "digest": digest, "size_bytes": len(sourceTarGz)},
		"entrypoint": m.Name,
		"model":      m.Model,
		"runtime":    map[string]string{"type": rt},
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
	handoff := Agent{}
	if !jsonOutput && d.State == "ready" {
		handoff = loadDeployHandoff(cmd, sc, id)
	}
	printer.Print(d, func() {
		n := revisionNumber(cmd, sc, id, d.RevisionID)
		status := "staged"
		if d.Active {
			status = "active"
		}
		printDeploySuccess(printer.W, deploySuccess{
			Agent: handoff, Revision: n, Status: status,
		})
	})
	return nil
}

func readPromptDefinedFlueSource(dir string) ([]bundle.File, error) {
	readRegular := func(rel string, maxBytes int) ([]byte, error) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		info, err := os.Lstat(path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, fmt.Errorf("%s is missing", rel)
			}
			return nil, fmt.Errorf("inspect %s: %w", rel, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("%s must be a regular file", rel)
		}
		if info.Size() > int64(maxBytes) {
			return nil, fmt.Errorf("%s exceeds %d bytes", rel, maxBytes)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", rel, err)
		}
		if !utf8.Valid(content) {
			return nil, fmt.Errorf("%s must be valid UTF-8", rel)
		}
		return content, nil
	}

	manifestBytes, err := readRegular("agent.toml", fluePromptMaxArchive)
	if err != nil {
		return nil, err
	}
	promptBytes, err := readRegular("prompt.md", fluePromptMaxBytes)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(promptBytes)) == "" {
		return nil, fmt.Errorf("prompt.md must not be empty")
	}
	if _, err := os.Lstat(filepath.Join(dir, "mcp.json")); err == nil {
		return nil, fmt.Errorf("mcp.json is not supported by prompt-defined Flue agents")
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect mcp.json: %w", err)
	}

	files := []bundle.File{
		{Path: "agent.toml", Mode: 0o644, Content: manifestBytes},
		{Path: "prompt.md", Mode: 0o644, Content: promptBytes},
	}
	skillsRoot := filepath.Join(dir, "skills")
	entries, err := os.ReadDir(skillsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return files, nil
		}
		return nil, fmt.Errorf("read skills/: %w", err)
	}
	rootInfo, err := os.Lstat(skillsRoot)
	if err != nil {
		return nil, fmt.Errorf("inspect skills/: %w", err)
	}
	if !rootInfo.IsDir() {
		return nil, fmt.Errorf("skills must be a directory")
	}

	totalSkillBytes := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		rel := "skills/" + entry.Name() + "/SKILL.md"
		if _, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("inspect %s: %w", rel, err)
		}
		if !fluePromptSkillName.MatchString(entry.Name()) {
			return nil, fmt.Errorf("skill directory %q has an invalid name", entry.Name())
		}
		content, err := readRegular(rel, fluePromptMaxSkillBytes)
		if err != nil {
			return nil, err
		}
		totalSkillBytes += len(content)
		if totalSkillBytes > fluePromptMaxSkillsBytes {
			return nil, fmt.Errorf(
				"prompt-defined Flue skill files exceed %d bytes",
				fluePromptMaxSkillsBytes,
			)
		}
		files = append(files, bundle.File{Path: rel, Mode: 0o644, Content: content})
		if len(files)-2 > fluePromptMaxSkills {
			return nil, fmt.Errorf(
				"prompt-defined Flue agents support at most %d skills",
				fluePromptMaxSkills,
			)
		}
	}
	return files, nil
}

func newLocalSourceUploadID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "src_" + hex.EncodeToString(raw[:]), nil
}

func uploadLocalBuildSource(
	ctx context.Context,
	sc *client.Client,
	agentID string,
	uploadID string,
	digest string,
	tarGz []byte,
) error {
	body := map[string]interface{}{
		"upload_id":  uploadID,
		"digest":     digest,
		"size_bytes": len(tarGz),
	}
	var response localSourceUploadResponse
	if err := sc.Post(
		ctx,
		"/v3/agents/"+agentID+"/source-artifacts",
		body,
		&response,
	); err != nil {
		return fmt.Errorf("request source upload url: %w", err)
	}
	if response.AlreadyUploaded {
		return nil
	}
	if response.URL == "" {
		return fmt.Errorf("source upload url response was empty")
	}
	return putGzip(ctx, response.URL, tarGz, "source")
}

func presentFlueBuildError(err error) error {
	var credentialErr *fluebuild.CredentialError
	if !errors.As(err, &credentialErr) {
		return err
	}
	fmt.Fprintln(os.Stderr, "Refusing to deploy — possible credential(s) found (model keys come from the OpenComputer credential, never code):")
	for _, finding := range credentialErr.Findings {
		fmt.Fprintf(os.Stderr, "  %s:%d  %s  %s\n", finding.Path, finding.Line, finding.Kind, finding.Match)
	}
	return &ExitError{Code: 1}
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
	return putGzip(ctx, resp.URL, tarGz, "bundle")
}

func putGzip(ctx context.Context, url string, tarGz []byte, label string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(tarGz))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/gzip")
	req.ContentLength = int64(len(tarGz))
	put, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload %s: %w", label, err)
	}
	defer put.Body.Close()
	if put.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(put.Body, 512))
		return fmt.Errorf("%s upload failed (HTTP %d): %s", label, put.StatusCode, string(snippet))
	}
	return nil
}
