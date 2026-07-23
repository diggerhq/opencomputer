package commands

import (
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/config"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// ── agent.toml manifest + deploy bundle ──

type manifest struct {
	Name  string `toml:"name"`
	Model string `toml:"model"`
	// Non-secret Flue Worker bindings. The manifest is authoritative: omitting
	// [vars] clears prior values on deploy. Secrets never belong in agent.toml.
	Vars    map[string]string `toml:"vars"`
	Runtime struct {
		Family string `toml:"family"`
		Type   string `toml:"type"`
	} `toml:"runtime"`
	Agent struct {
		ID string `toml:"id"`
	} `toml:"agent"`
	Limits    map[string]interface{} `toml:"limits"`
	Schedules []scheduleDecl         `toml:"schedules"` // cron for agents (015); synced on deploy-activate
}

// One agent.toml [[schedules]] entry. Rides the deployment input; the server syncs on activate.
type scheduleDecl struct {
	Name    string `toml:"name" json:"name"`
	Cron    string `toml:"cron" json:"cron"`
	TZ      string `toml:"tz,omitempty" json:"tz,omitempty"`
	Input   string `toml:"input" json:"input"`
	Overlap string `toml:"overlap,omitempty" json:"overlap,omitempty"`
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

// loadDeployHandoff fetches the public URL only for human-readable output. A
// successful deployment stays successful if this convenience read fails; the
// user can still retrieve the URL with `oc agent get`.
func loadDeployHandoff(cmd *cobra.Command, sc *client.Client, id string) Agent {
	agent := Agent{ID: id}
	if err := sc.Get(cmd.Context(), "/v3/agents/"+id, &agent); err != nil {
		return Agent{ID: id}
	}
	if agent.ID == "" {
		agent.ID = id
	}
	return agent
}

type deploySuccess struct {
	Agent    Agent
	Revision int
	Status   string
	Digest   string
}

type deployOutputStyle struct {
	color      bool
	hyperlinks bool
}

func deployStyleFor(w io.Writer) deployOutputStyle {
	file, ok := w.(*os.File)
	if !ok || !term.IsTerminal(int(file.Fd())) || os.Getenv("TERM") == "dumb" {
		return deployOutputStyle{}
	}
	return deployOutputStyle{
		color:      !noColor && os.Getenv("NO_COLOR") == "",
		hyperlinks: true,
	}
}

func ansiText(value, code string, enabled bool) string {
	if !enabled {
		return value
	}
	return "\x1b[" + code + "m" + value + "\x1b[0m"
}

func oneLine(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\x1b' || r == '\a' || r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
}

func terminalLink(rawURL string, style deployOutputStyle) string {
	visible := oneLine(rawURL)
	if visible != rawURL {
		return visible
	}
	parsed, err := url.ParseRequestURI(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return visible
	}
	visible = ansiText(visible, "4;36", style.color)
	if !style.hyperlinks {
		return visible
	}
	return "\x1b]8;;" + rawURL + "\x1b\\" + visible + "\x1b]8;;\x1b\\"
}

func renderDeploySuccess(w io.Writer, success deploySuccess, style deployOutputStyle) {
	agentID := oneLine(success.Agent.ID)
	name := oneLine(success.Agent.Name)
	if name == "" {
		name = agentID
	}
	if name == "" {
		name = "agent"
	}

	mark := ansiText("✓", "32", style.color)
	title := "Deployed " + ansiText(name, "1", style.color)
	fmt.Fprintf(w, "%s %s\n", mark, title)

	status := oneLine(success.Status)
	statusCode := "32"
	if status == "staged" {
		statusCode = "33"
	}
	status = ansiText(status, statusCode, style.color)
	var revisionParts []string
	if success.Revision > 0 {
		revisionParts = append(revisionParts, fmt.Sprintf("%d", success.Revision))
	}
	if status != "" {
		revisionParts = append(revisionParts, status)
	}
	if digest := oneLine(success.Digest); digest != "" {
		revisionParts = append(revisionParts, digest)
	}
	if success.Agent.InvokeURL != "" {
		fmt.Fprintf(w, "\n  %s\n", ansiText("Agent URL", "1", style.color))
		fmt.Fprintf(w, "  %s\n", terminalLink(success.Agent.InvokeURL, style))
	}
	if len(revisionParts) > 0 {
		fmt.Fprintf(w, "\n  %-11s %s\n", "Revision", strings.Join(revisionParts, " · "))
	}
	if agentID != "" {
		manageURL := strings.TrimRight(config.DefaultAPIURL, "/") + "/agents/" + url.PathEscape(agentID)
		fmt.Fprintf(w, "  %-11s %s\n", "Dashboard", terminalLink(manageURL, style))
		fmt.Fprintf(w, "\n  %s\n", ansiText("Try it", "1", style.color))
		fmt.Fprintf(w, "  %s oc agent invoke %s --data '{\"message\":\"Hello\"}'\n", ansiText("$", "2", style.color), agentID)
	}
}

func printDeploySuccess(w io.Writer, success deploySuccess) {
	renderDeploySuccess(w, success, deployStyleFor(w))
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
		if d.State != last {
			printDeployProgress(d.State)
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

func printDeployProgress(state string) {
	if stdinIsTTY() && !jsonOutput {
		fmt.Fprintf(os.Stderr, "  … %s\n", state)
	}
}

// ── deploy ──

var agentDeployCmd = &cobra.Command{
	Use:   "deploy [dir]",
	Short: "Deploy an agent from a local directory",
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
		// Flue agents deploy a built artifact, not prompt.md/skills/ (§11.7.8).
		if m.Runtime.Family == "flue" {
			noActivate, _ := cmd.Flags().GetBool("no-activate")
			return deployFlue(cmd, sc, dir, m, noActivate)
		}
		// LangGraph agents likewise deploy a built Worker artifact (its own runtime).
		if m.Runtime.Family == "langgraph" {
			noActivate, _ := cmd.Flags().GetBool("no-activate")
			return deployLangGraph(cmd, sc, dir, m, noActivate)
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
			a := Agent{ID: id}
			_ = sc.Get(cmd.Context(), "/v3/agents/"+id, &a)
			n := 0
			if a.ActiveRevision != nil {
				n = a.ActiveRevision.Number
			}
			printer.Print(map[string]interface{}{"agent_id": id, "revision": n, "state": "ready", "active": true}, func() {
				printDeploySuccess(printer.W, deploySuccess{Agent: a, Revision: n, Status: "active"})
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
		// [[schedules]] present in agent.toml → carry them so the server syncs on activate (015 §3).
		// Absent → omit the key entirely (no sync; existing schedules untouched).
		if len(m.Schedules) > 0 {
			input["schedules"] = m.Schedules
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
		handoff := Agent{}
		if !jsonOutput && d.State == "ready" {
			handoff = loadDeployHandoff(cmd, sc, id)
		}
		printer.Print(d, func() {
			if d.State == "ready" {
				n := revisionNumber(cmd, sc, id, d.RevisionID)
				status := "staged"
				if d.Active {
					status = "active"
				}
				printDeploySuccess(printer.W, deploySuccess{Agent: handoff, Revision: n, Status: status})
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
			// Fail fast on a runtime-family mismatch. The server rejects the
			// deployment anyway, but only after the build + artifact upload — a
			// flue deploy onto an existing claude agent would waste both.
			if runtime != "" && a.Runtime != "" && a.Runtime != runtime {
				return "", false, fmt.Errorf(
					"agent %q already exists with runtime %q, but this deploy is %q — rename the agent in agent.toml, or deploy the matching runtime",
					name, a.Runtime, runtime)
			}
			return a.ID, false, nil
		}
	}
	body := map[string]interface{}{"name": name, "model": model, "runtime": runtime}
	if prompt != "" {
		body["prompt"] = prompt // flue agents carry instructions in code — no prompt
	}
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
	agentCmd.AddCommand(agentBuildCmd)
	agentDeployCmd.Flags().String("agent", "", "Target agent id or name (else the manifest's [agent].id / name)")
	agentDeployCmd.Flags().Bool("no-activate", false, "Create the revision without activating it (stage)")
	agentDeployCmd.Flags().String("idempotency-key", "", "CI-safe key: a retry with the same key returns the same deployment")
	agentDeployCmd.Flags().Int("timeout", 180, "Seconds to wait for a Flue deploy to boot-verify (poll to terminal state)")
	agentDeployCmd.Flags().Bool("verbose", false, "Show full framework build output")

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
