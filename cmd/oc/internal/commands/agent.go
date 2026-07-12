package commands

// The `oc agent` command family, rebuilt on the v3 Durable Agent Sessions API
// (/v3/agents/*). The legacy v1 managed-agents verbs (channels/packages/chat)
// were removed wholesale — agents are prompt+model+skills behaviors deployed
// as immutable revisions, a different model entirely.
//
// Verbs (each in its own file):
//   agent.go         — parent command, shared response types, helpers, registration
//   agent_crud.go    — create / list / get
//   agent_deploy.go  — deploy / revisions / rollback / status / link / unlink / deployments
// Sessions live under `oc session` (session.go).

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// ── Shared response types (mirror the sessions-api JSON, snake_case) ──

type RevisionRef struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Digest string `json:"digest"`
}

type Agent struct {
	ID               string       `json:"id"`
	Name             string       `json:"name"`
	Prompt           string       `json:"prompt,omitempty"`
	Model            string       `json:"model"`
	Runtime          string       `json:"runtime"`
	CredentialID     *string      `json:"credential_id,omitempty"`
	ActiveRevisionID string       `json:"active_revision_id,omitempty"`
	ActiveRevision   *RevisionRef `json:"active_revision,omitempty"`
	CreatedAt        string       `json:"created_at"`
}

type AgentList struct {
	Data       []Agent `json:"data"`
	NextCursor *string `json:"next_cursor,omitempty"`
}

type Revision struct {
	ID        string `json:"id"`
	Number    int    `json:"number"`
	Digest    string `json:"digest"`
	CreatedAt string `json:"created_at"`
	Active    bool   `json:"active"`
}

type RevisionList struct {
	Data []Revision `json:"data"`
}

type Deployment struct {
	ID         string                 `json:"id"`
	State      string                 `json:"state"`
	Result     string                 `json:"result,omitempty"`
	RevisionID string                 `json:"revision_id,omitempty"`
	InputType  string                 `json:"input_type,omitempty"`
	Ref        string                 `json:"ref,omitempty"`
	Sha        string                 `json:"sha,omitempty"`
	Active     bool                   `json:"active,omitempty"`
	ErrorClass string                 `json:"error_class,omitempty"`
	Error      map[string]interface{} `json:"error,omitempty"`
	Source     map[string]interface{} `json:"source,omitempty"`
	CreatedAt  string                 `json:"created_at,omitempty"`
}

type DeploymentEnvelope struct {
	Deployment Deployment `json:"deployment"`
}

type DeploymentList struct {
	Data []Deployment `json:"data"`
}

type DeploymentSource struct {
	AgentID           string `json:"agent_id"`
	RepoID            string `json:"repo_id"`
	Path              string `json:"path"`
	ProductionRef     string `json:"production_ref"`
	Status            string `json:"status"`
	LatestSeenSha     string `json:"latest_seen_sha,omitempty"`
	ActiveDeployedSha string `json:"active_deployed_sha,omitempty"`
}

type SourceEnvelope struct {
	Source       DeploymentSource `json:"source"`
	DeploymentID string           `json:"deployment_id,omitempty"`
	DeployError  *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"deploy_error,omitempty"`
}

// ── Helpers ──

// sessionsClient returns the sessions-api (/v3) client from context, or errors.
func sessionsClient(cmd *cobra.Command) (*client.Client, error) {
	c := client.SessionsFromContext(cmd.Context())
	if c == nil {
		return nil, fmt.Errorf("sessions-api URL not configured. Set SESSIONS_API_URL or use --sessions-api-url")
	}
	return c, nil
}

func formatAge(isoTime string) string {
	if isoTime == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339Nano, isoTime)
	if err != nil {
		return isoTime
	}
	return time.Since(t).Truncate(time.Second).String()
}

func shortSha(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// stdinIsTTY reports whether stdin is attached to a terminal.
func stdinIsTTY() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

// confirmDestructive gates destructive verbs on explicit consent: --yes proceeds;
// a TTY prompts; a non-TTY without --yes refuses (scripts must pass --yes).
func confirmDestructive(cmd *cobra.Command, action string) error {
	if yes, _ := cmd.Flags().GetBool("yes"); yes {
		return nil
	}
	if !stdinIsTTY() {
		return fmt.Errorf("refusing to %s without --yes (stdin is not a terminal)", action)
	}
	fmt.Fprintf(os.Stderr, "%s? [y/N] ", action)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return nil
	default:
		return fmt.Errorf("aborted")
	}
}

// ── Parent command ──

var agentCmd = &cobra.Command{
	Use:   "agent",
	Short: "Create, deploy, and manage agents",
	Long: "Manage Durable Agent Sessions agents on OpenComputer.\n\n" +
		"An agent is a prompt + model + skills behavior. Deploying it produces an\n" +
		"immutable, numbered revision; the active revision is what new sessions run.\n" +
		"Deploy from a local directory (`oc agent deploy`) or link a GitHub repo for\n" +
		"push-to-deploy (`oc agent link`).",
}

func init() {
	registerAgentCrud()
	registerAgentDeploy()
	registerAgentConfig()
	registerAgentSchedules()
	rootCmd.AddCommand(sessionCmd)
}
