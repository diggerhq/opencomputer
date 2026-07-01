package commands

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// ── agent.toml manifest + deploy bundle ──

type manifest struct {
	Name    string `toml:"name"`
	Model   string `toml:"model"`
	Runtime struct {
		Family string `toml:"family"`
		Type   string `toml:"type"`
	} `toml:"runtime"`
	Agent struct {
		ID string `toml:"id"`
	} `toml:"agent"`
	Limits map[string]interface{} `toml:"limits"`
}

type skillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode,omitempty"`
}

func readManifest(dir string) (*manifest, error) {
	var m manifest
	if _, err := toml.DecodeFile(filepath.Join(dir, "agent.toml"), &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func readPrompt(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "prompt.md"))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// readSkills walks <dir>/skills/** into skill-root-relative SkillFiles (e.g.
// "hello/SKILL.md"), matching the inline-deploy + worker convention. Returns
// nil (not an error) when there is no skills/ directory.
func readSkills(dir string) ([]skillFile, error) {
	root := filepath.Join(dir, "skills")
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, nil
	}
	var out []skillFile
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		mode := 0o644
		if st, err := d.Info(); err == nil && st.Mode()&0o111 != 0 {
			mode = 0o755
		}
		out = append(out, skillFile{Path: filepath.ToSlash(rel), Content: string(b), Mode: mode})
		return nil
	})
	return out, err
}

// ── Agent resolution (§4.2) ──

// targetAgentID resolves the agent a verb acts on: explicit arg > --agent flag >
// the cwd agent.toml ([agent].id, else name). Errors if none apply.
func targetAgentID(cmd *cobra.Command, sc *client.Client, args []string) (string, error) {
	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		return resolveRef(cmd, sc, args[0])
	}
	if explicit, _ := cmd.Flags().GetString("agent"); explicit != "" {
		return resolveRef(cmd, sc, explicit)
	}
	if m, err := readManifest("."); err == nil {
		if m.Agent.ID != "" {
			return m.Agent.ID, nil
		}
		if m.Name != "" {
			return resolveRef(cmd, sc, m.Name)
		}
	}
	return "", fmt.Errorf("no agent — pass <id|name>, --agent, or run inside an agent directory with agent.toml")
}

// resolveRef maps an "agt_…" id (used as-is) or a name (looked up) to an id.
func resolveRef(cmd *cobra.Command, sc *client.Client, ref string) (string, error) {
	if strings.HasPrefix(ref, "agt_") {
		return ref, nil
	}
	var list AgentList
	if err := sc.Get(cmd.Context(), "/v3/agents", &list); err != nil {
		return "", err
	}
	for _, a := range list.Data {
		if a.Name == ref {
			return a.ID, nil
		}
	}
	return "", fmt.Errorf("no agent named %q", ref)
}

func revisionNumber(cmd *cobra.Command, sc *client.Client, id, revisionID string) int {
	if revisionID == "" {
		return 0
	}
	var revs RevisionList
	if err := sc.Get(cmd.Context(), "/v3/agents/"+id+"/revisions", &revs); err != nil {
		return 0
	}
	for _, r := range revs.Data {
		if r.ID == revisionID {
			return r.Number
		}
	}
	return 0
}

// ── async deployment polling ──

func terminalState(s string) bool {
	switch s {
	case "ready", "failed", "skipped", "superseded":
		return true
	}
	return false
}

func deployFailMsg(d Deployment) string {
	if m, ok := d.Error["message"].(string); ok && m != "" {
		return m
	}
	if d.ErrorClass != "" {
		return d.ErrorClass
	}
	return "unknown error"
}

// pollDeployment polls a deployment until it reaches a terminal state or the
// timeout elapses, printing each state transition to stderr on a TTY.
func pollDeployment(cmd *cobra.Command, sc *client.Client, agentID, depID string, timeout time.Duration) (Deployment, error) {
	deadline := time.Now().Add(timeout)
	last := ""
	for {
		var d Deployment
		if err := sc.Get(cmd.Context(), "/v3/agents/"+agentID+"/deployments/"+depID, &d); err != nil {
			return d, err
		}
		if d.State != last && stdinIsTTY() && !jsonOutput {
			fmt.Fprintf(os.Stderr, "  … %s\n", d.State)
		}
		last = d.State
		if terminalState(d.State) {
			return d, nil
		}
		if time.Now().After(deadline) {
			return d, fmt.Errorf("timed out after %s waiting for deployment %s (last state: %s)", timeout, depID, d.State)
		}
		time.Sleep(2 * time.Second)
	}
}

// ── deploy ──

var agentDeployCmd = &cobra.Command{
	Use:   "deploy [dir]",
	Short: "Deploy an agent from a directory (agent.toml + prompt.md + skills/)",
	Example: "  oc agent deploy                 # deploy the agent.toml in the current directory\n" +
		"  oc agent deploy ./agents/triage # deploy a specific directory\n" +
		"  oc agent deploy --no-activate   # stage a revision without making it active\n" +
		"  oc agent deploy --idempotency-key $GITHUB_SHA   # CI-safe (retries return the same deploy)",
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		dir := "."
		if len(args) > 0 {
			dir = args[0]
		}
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		m, err := readManifest(dir)
		if err != nil {
			return fmt.Errorf("read agent.toml: %w", err)
		}
		if m.Name == "" && m.Agent.ID == "" {
			return fmt.Errorf("agent.toml needs a `name` (or [agent].id)")
		}
		if m.Model == "" {
			return fmt.Errorf("agent.toml needs a `model`")
		}
		prompt, err := readPrompt(dir)
		if err != nil {
			return fmt.Errorf("read prompt.md: %w", err)
		}
		skills, err := readSkills(dir)
		if err != nil {
			return fmt.Errorf("read skills/: %w", err)
		}
		runtime := m.Runtime.Family
		if runtime == "" {
			runtime = "claude"
		}

		explicit, _ := cmd.Flags().GetString("agent")
		var id string
		created := false
		switch {
		case explicit != "":
			id, err = resolveRef(cmd, sc, explicit)
		case m.Agent.ID != "":
			id = m.Agent.ID
		default:
			id, created, err = ensureAgentByName(cmd, sc, m.Name, prompt, m.Model, runtime)
		}
		if err != nil {
			return err
		}

		noActivate, _ := cmd.Flags().GetBool("no-activate")

		// A fresh agent with no skills: `create` already produced the first
		// revision (the deploy) — don't append a redundant identical one.
		if created && len(skills) == 0 {
			var a Agent
			_ = sc.Get(cmd.Context(), "/v3/agents/"+id, &a)
			n := 0
			if a.ActiveRevision != nil {
				n = a.ActiveRevision.Number
			}
			printer.Print(map[string]interface{}{"agent_id": id, "revision": n, "state": "ready", "active": true}, func() {
				fmt.Printf("Deployed %s — revision %d (active)\n", a.Name, n)
			})
			return nil
		}

		rt := m.Runtime.Type
		if rt == "" {
			rt = "default"
		}
		input := map[string]interface{}{"type": "inline", "prompt": prompt, "model": m.Model, "runtime": map[string]string{"type": rt}}
		if len(skills) > 0 {
			input["skills"] = skills
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
		if d.State == "failed" {
			printer.Print(d, func() { fmt.Printf("Deploy failed: %s\n", deployFailMsg(d)) })
			return &ExitError{Code: 1}
		}
		printer.Print(d, func() {
			if d.State == "ready" {
				n := revisionNumber(cmd, sc, id, d.RevisionID)
				status := "staged"
				if d.Active {
					status = "active"
				}
				fmt.Printf("Deployed revision %d — %s\n", n, status)
			} else {
				fmt.Printf("Deployment %s: %s\n", d.ID, d.State)
			}
		})
		return nil
	},
}

func ensureAgentByName(cmd *cobra.Command, sc *client.Client, name, prompt, model, runtime string) (string, bool, error) {
	var list AgentList
	if err := sc.Get(cmd.Context(), "/v3/agents", &list); err != nil {
		return "", false, err
	}
	for _, a := range list.Data {
		if a.Name == name {
			return a.ID, false, nil
		}
	}
	body := map[string]interface{}{"name": name, "prompt": prompt, "model": model, "runtime": runtime}
	var a Agent
	if err := sc.Post(cmd.Context(), "/v3/agents", body, &a); err != nil {
		return "", false, err
	}
	return a.ID, true, nil
}

// ── revisions / rollback / status ──

var agentRevisionsCmd = &cobra.Command{
	Use:     "revisions [id|name]",
	Short:   "List an agent's revisions",
	Example: "  oc agent revisions issue-fixer\n  oc agent revisions            # uses the cwd agent.toml",
	Args:    cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, args)
		if err != nil {
			return err
		}
		var revs RevisionList
		if err := sc.Get(cmd.Context(), "/v3/agents/"+id+"/revisions", &revs); err != nil {
			return err
		}
		printer.Print(revs.Data, func() {
			if len(revs.Data) == 0 {
				fmt.Println("No revisions.")
				return
			}
			headers := []string{"REV", "ACTIVE", "DIGEST", "CREATED"}
			var rows [][]string
			for _, r := range revs.Data {
				active := ""
				if r.Active {
					active = "✓"
				}
				rows = append(rows, []string{fmt.Sprintf("%d", r.Number), active, shortDigest(r.Digest), formatAge(r.CreatedAt)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var agentRollbackCmd = &cobra.Command{
	Use:     "rollback <revision>",
	Short:   "Activate an earlier revision (by number or rev_ id)",
	Example: "  oc agent rollback 3 --agent issue-fixer\n  oc agent rollback 3            # uses the cwd agent.toml",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		var res struct {
			ActiveRevisionID string `json:"active_revision_id"`
		}
		if err := sc.Post(cmd.Context(), "/v3/agents/"+id+"/revisions/"+args[0]+"/activate", nil, &res); err != nil {
			return err
		}
		printer.Print(res, func() {
			fmt.Printf("Activated revision %s (active_revision_id=%s)\n", args[0], res.ActiveRevisionID)
		})
		return nil
	},
}

var agentStatusCmd = &cobra.Command{
	Use:   "status [id|name]",
	Short: "Show an agent's active revision + deployment-source status",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, args)
		if err != nil {
			return err
		}
		var a Agent
		if err := sc.Get(cmd.Context(), "/v3/agents/"+id, &a); err != nil {
			return err
		}
		var src SourceEnvelope
		hasLink := sc.Get(cmd.Context(), "/v3/agents/"+id+"/deployment-source", &src) == nil && src.Source.AgentID != ""
		printer.Print(map[string]interface{}{"agent": a, "linked": hasLink, "source": src.Source}, func() {
			fmt.Printf("%s (%s)\n", a.Name, a.ID)
			if a.ActiveRevision != nil {
				fmt.Printf("  active revision: %d (%s)\n", a.ActiveRevision.Number, shortDigest(a.ActiveRevision.Digest))
			} else {
				fmt.Println("  active revision: none")
			}
			if hasLink {
				fmt.Printf("  deploy source:   %s @ %s [%s]\n", src.Source.Path, src.Source.ProductionRef, src.Source.Status)
				if src.Source.ActiveDeployedSha != "" {
					fmt.Printf("  deployed sha:    %s\n", shortSha(src.Source.ActiveDeployedSha))
				}
			} else {
				fmt.Println("  deploy source:   (not linked)")
			}
		})
		return nil
	},
}

// ── link / unlink / deployments ──

var agentLinkCmd = &cobra.Command{
	Use:   "link <owner/repo>",
	Short: "Link a GitHub repo directory for push-to-deploy",
	Example: "  oc agent link acme/agents --path agents/issue-fixer --agent issue-fixer\n" +
		"  oc agent link acme/agents --path agents/issue-fixer --branch main --wait",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		path, _ := cmd.Flags().GetString("path")
		branch, _ := cmd.Flags().GetString("branch")
		noDeploy, _ := cmd.Flags().GetBool("no-deploy")
		body := map[string]interface{}{"repo": args[0], "path": path, "production_ref": branch, "deploy_now": !noDeploy}
		var res SourceEnvelope
		if err := sc.Post(cmd.Context(), "/v3/agents/"+id+"/deployment-source", body, &res); err != nil {
			return err
		}
		printer.Print(res, func() {
			fmt.Printf("Linked %s:%s @ %s [%s]\n", args[0], res.Source.Path, res.Source.ProductionRef, res.Source.Status)
			if res.DeployError != nil {
				fmt.Printf("  (initial deploy could not start: %s)\n", res.DeployError.Message)
			} else if res.DeploymentID != "" {
				fmt.Printf("  deploying %s — poll: oc agent deployments\n", res.DeploymentID)
			}
		})
		if wait, _ := cmd.Flags().GetBool("wait"); wait && res.DeploymentID != "" {
			to, _ := cmd.Flags().GetInt("timeout")
			d, perr := pollDeployment(cmd, sc, id, res.DeploymentID, time.Duration(to)*time.Second)
			if perr != nil {
				return perr
			}
			if d.State == "failed" {
				fmt.Fprintf(os.Stderr, "Deploy failed: %s\n", deployFailMsg(d))
				return &ExitError{Code: 1}
			}
			fmt.Printf("Deploy %s: %s\n", res.DeploymentID, d.State)
		}
		return nil
	},
}

var agentDeploymentCmd = &cobra.Command{
	Use:   "deployment <deployment-id>",
	Short: "Show one deployment (use --wait to poll to a terminal state)",
	Example: "  oc agent deployment dep_123 --agent issue-fixer\n" +
		"  oc agent deployment dep_123 --wait   # block until ready|failed (exit non-zero on failure)",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		var d Deployment
		if wait, _ := cmd.Flags().GetBool("wait"); wait {
			to, _ := cmd.Flags().GetInt("timeout")
			d, err = pollDeployment(cmd, sc, id, args[0], time.Duration(to)*time.Second)
		} else {
			err = sc.Get(cmd.Context(), "/v3/agents/"+id+"/deployments/"+args[0], &d)
		}
		if err != nil {
			return err
		}
		printer.Print(d, func() {
			fmt.Printf("%s  %s", d.ID, d.State)
			if d.Result != "" {
				fmt.Printf(" (%s)", d.Result)
			}
			fmt.Println()
			if d.State == "failed" {
				fmt.Printf("  error: %s\n", deployFailMsg(d))
			}
		})
		if d.State == "failed" {
			return &ExitError{Code: 1}
		}
		return nil
	},
}

var agentUnlinkCmd = &cobra.Command{
	Use:   "unlink",
	Short: "Remove the agent's deployment-source link",
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		if err := confirmDestructive(cmd, "unlink the deployment source"); err != nil {
			return err
		}
		if err := sc.Delete(cmd.Context(), "/v3/agents/"+id+"/deployment-source"); err != nil {
			return err
		}
		fmt.Println("Unlinked. Existing revisions are unchanged.")
		return nil
	},
}

var agentDeploymentsCmd = &cobra.Command{
	Use:   "deployments [id|name]",
	Short: "List an agent's deployments",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, args)
		if err != nil {
			return err
		}
		var resp DeploymentList
		if err := sc.Get(cmd.Context(), "/v3/agents/"+id+"/deployments", &resp); err != nil {
			return err
		}
		printer.Print(resp.Data, func() {
			if len(resp.Data) == 0 {
				fmt.Println("No deployments.")
				return
			}
			headers := []string{"ID", "INPUT", "STATE", "RESULT", "REF", "SHA", "CREATED"}
			var rows [][]string
			for _, d := range resp.Data {
				via := d.InputType
				if v, ok := d.Source["via"].(string); ok && via == "" {
					via = v
				}
				rows = append(rows, []string{d.ID, via, d.State, d.Result, d.Ref, shortSha(d.Sha), formatAge(d.CreatedAt)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

func shortDigest(d string) string {
	d = strings.TrimPrefix(d, "sha256:")
	if len(d) > 12 {
		return d[:12]
	}
	return d
}

func registerAgentDeploy() {
	agentDeployCmd.Flags().String("agent", "", "Target agent id or name (else the manifest's [agent].id / name)")
	agentDeployCmd.Flags().Bool("no-activate", false, "Create the revision without activating it (stage)")
	agentDeployCmd.Flags().String("idempotency-key", "", "CI-safe key: a retry with the same key returns the same deployment")

	for _, c := range []*cobra.Command{agentRevisionsCmd, agentRollbackCmd, agentStatusCmd, agentLinkCmd, agentUnlinkCmd, agentDeploymentsCmd, agentDeploymentCmd} {
		c.Flags().String("agent", "", "Target agent id or name (else the cwd agent.toml)")
	}
	agentLinkCmd.Flags().String("path", "", "Agent directory within the repo (e.g. agents/issue-fixer)")
	agentLinkCmd.Flags().String("branch", "main", "Production branch that auto-activates on push")
	agentLinkCmd.Flags().Bool("no-deploy", false, "Link only; don't deploy the current HEAD now")
	agentLinkCmd.Flags().Bool("wait", false, "Wait for the initial deploy to reach a terminal state (exit non-zero on failure)")
	agentLinkCmd.Flags().Int("timeout", 180, "Seconds to wait with --wait")
	agentUnlinkCmd.Flags().Bool("yes", false, "Skip confirmation (required for non-interactive callers)")
	agentDeploymentCmd.Flags().Bool("wait", false, "Poll until the deployment reaches a terminal state (exit non-zero on failure)")
	agentDeploymentCmd.Flags().Int("timeout", 180, "Seconds to wait with --wait")

	agentCmd.AddCommand(agentInitCmd)
	agentCmd.AddCommand(agentDeployCmd)
	agentCmd.AddCommand(agentRevisionsCmd)
	agentCmd.AddCommand(agentRollbackCmd)
	agentCmd.AddCommand(agentStatusCmd)
	agentCmd.AddCommand(agentLinkCmd)
	agentCmd.AddCommand(agentUnlinkCmd)
	agentCmd.AddCommand(agentDeploymentsCmd)
	agentCmd.AddCommand(agentDeploymentCmd)
}
