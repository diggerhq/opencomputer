package commands

// Flue deploy flow (design 013 §6 — the Worker-for-Platforms Durable-Object model).
// When agent.toml declares `[runtime] family = "flue"`, `oc agent deploy` does NOT
// read prompt.md/skills/; it runs the app's own `flue build --target cloudflare` and
// POSTs the built Worker module + the generated wrangler to the control plane. The CP
// owns compose (synthesize the migration ledger) + per-deploy token mint + WfP upload
// + canary-verify + activate — because the CF creds and the signing key live
// server-side and the CLI must not hold them. The existing deployment poll absorbs the
// verify latency (verifying → ready|failed).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/credscan"
	"github.com/spf13/cobra"
)

// flueBuildOutputDir is `flue build --target cloudflare`'s output root; the tool
// writes the Cloudflare build under dist/<app>/ (wrangler.json + the entry module +
// assets/), so we discover the wrangler beneath it rather than assume a flat layout.
const flueBuildOutputDir = "dist"

// flueModule is the built Worker entry module, forwarded to the CP verbatim (the CP
// uploads it to WfP as metadata.main_module — its filename must equal wrangler.main).
type flueModule struct {
	Filename   string `json:"filename"`
	ContentB64 string `json:"contentB64"`
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
	//    build, not after it.
	id, err := resolveDeployAgent(cmd, sc, m)
	if err != nil {
		return err
	}

	// 3. Build the app with its own `flue` CLI (a devDependency).
	if err := runFlueBuild(cmd.Context(), dir); err != nil {
		return err
	}

	// 4. Read the generated wrangler + the entry module the CP needs.
	module, wrangler, err := readFlueBuildOutput(filepath.Join(dir, flueBuildOutputDir))
	if err != nil {
		return err
	}

	// 5. Deployment carrying the module + wrangler (no prompt/skills path). The CP
	//    keys the flue-DO path off the agent's runtime="flue" + the presence of
	//    flue_module/flue_wrangler, then composes + mints + WfP-uploads → verifying.
	rt := m.Runtime.Type
	if rt == "" {
		rt = "default"
	}
	input := map[string]interface{}{
		"type":            "inline",
		"model":           m.Model,
		"runtime":         map[string]string{"type": rt},
		"flue_module":     module,   // { filename, contentB64 }
		"flue_wrangler":   wrangler, // the generated wrangler.json object, verbatim
		"flue_agent_name": m.Name,   // entrypoint agent (agent.toml name → DO admit address)
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

	// 6. Poll to terminal — the CP canary boots the tenant DO before activating.
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
		fmt.Printf("Deployed revision %d — %s\n", n, status)
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

// readFlueBuildOutput locates the generated wrangler under the `flue build` output and
// reads the entry module it names. `flue build --target cloudflare` writes
// dist/<app>/{wrangler.json, <main>, assets/…}; a flat dist/ is also accepted. The
// wrangler's `main` names the entry module (its filename MUST equal the CP's
// metadata.main_module), so we read `main` rather than hardcode a name.
func readFlueBuildOutput(distDir string) (flueModule, map[string]interface{}, error) {
	wranglerPath, err := findGeneratedWrangler(distDir)
	if err != nil {
		return flueModule{}, nil, err
	}
	raw, err := os.ReadFile(wranglerPath)
	if err != nil {
		return flueModule{}, nil, fmt.Errorf("read %s: %w", wranglerPath, err)
	}
	var wrangler map[string]interface{}
	if err := json.Unmarshal(raw, &wrangler); err != nil {
		return flueModule{}, nil, fmt.Errorf("parse %s: %w", wranglerPath, err)
	}
	main, _ := wrangler["main"].(string)
	if main == "" {
		return flueModule{}, nil, fmt.Errorf("%s has no `main` — the flue build did not produce a Worker entry module", wranglerPath)
	}
	modPath := filepath.Join(filepath.Dir(wranglerPath), filepath.FromSlash(main))
	modBytes, err := os.ReadFile(modPath)
	if err != nil {
		return flueModule{}, nil, fmt.Errorf("read entry module %s: %w", modPath, err)
	}
	return flueModule{
		Filename:   filepath.ToSlash(main),
		ContentB64: base64.StdEncoding.EncodeToString(modBytes),
	}, wrangler, nil
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
