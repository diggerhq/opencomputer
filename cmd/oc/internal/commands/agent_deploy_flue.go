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
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

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

func deployFlue(cmd *cobra.Command, sc *client.Client, dir string, m *manifest, noActivate bool) error {
	if isPromptDefinedFlueRoot(dir) {
		return fmt.Errorf(
			"prompt-defined Flue agents currently deploy from GitHub: push this directory, then choose Agents → Create agent → Import from GitHub",
		)
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
	regular := func(name string) bool {
		info, err := os.Lstat(name)
		return err == nil && info.Mode().IsRegular()
	}
	if !regular(filepath.Join(dir, "prompt.md")) {
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
