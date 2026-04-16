package commands

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// sessionsClient returns the sessions-api client from context, or errors if not configured.
func sessionsClient(cmd *cobra.Command) (*client.Client, error) {
	c := client.SessionsFromContext(cmd.Context())
	if c == nil {
		return nil, fmt.Errorf("sessions-api URL not configured. Set SESSIONS_API_URL or use --sessions-api-url")
	}
	return c, nil
}

// ── Types for sessions-api responses ──

type agentResponse struct {
	ID          string      `json:"id"`
	DisplayName string      `json:"display_name"`
	Core        *string     `json:"core"`
	Channels    interface{} `json:"channels"`
	Packages    interface{} `json:"packages"`
	SecretStore *string     `json:"secret_store"`
	Config      interface{} `json:"config"`
	CreatedAt   string      `json:"created_at"`
	UpdatedAt   string      `json:"updated_at"`

	// Populated by GET /v1/agents/:id (enriched response); omitted by
	// POST /v1/agents and the list endpoint.
	Status     *string    `json:"status,omitempty"`
	InstanceID *string    `json:"instance_id,omitempty"`
	LastError  *LastError `json:"last_error,omitempty"`
}

type agentListResponse struct {
	Agents []agentResponse `json:"agents"`
}

type instanceResponse struct {
	ID        string `json:"id"`
	AgentID   string `json:"agent_id"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type instanceListResponse struct {
	Instances []instanceResponse `json:"instances"`
}

// ── Commands ──

var agentCmd = &cobra.Command{
	Use:   "agent",
	Short: "Manage agents",
	Long:  "Create and manage managed agents on OpenComputer.",
}

var agentCreateCmd = &cobra.Command{
	Use:   "create <id>",
	Short: "Create a new managed agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		id := args[0]
		core, _ := cmd.Flags().GetString("core")
		secretSlice, _ := cmd.Flags().GetStringSlice("secret")
		noWait, _ := cmd.Flags().GetBool("no-wait")

		body := map[string]interface{}{
			"id": id,
		}
		if core != "" {
			body["core"] = core
		}

		// Parse --secret KEY=VAL flags into secrets map
		if len(secretSlice) > 0 {
			secrets := make(map[string]string)
			for _, s := range secretSlice {
				parts := strings.SplitN(s, "=", 2)
				if len(parts) == 2 {
					secrets[parts[0]] = parts[1]
				}
			}
			body["secrets"] = secrets
		}

		var agent agentResponse
		if err := sc.Post(cmd.Context(), "/v1/agents", body, &agent); err != nil {
			return err
		}

		// Text-mode preamble (suppressed in --json mode — scripts only want
		// the final JSON object).
		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "Creating agent %s", agent.ID)
			if agent.Core != nil {
				fmt.Fprintf(os.Stderr, " (core: %s)", *agent.Core)
			}
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, "  ✓ Agent record created")
		}

		// No core means no instance to wait for — skip polling.
		if agent.Core == nil {
			printer.Print(agent, func() {})
			return nil
		}

		// --no-wait short-circuits into Mode 3 (async fallback). Scripts
		// that don't want to block use this path.
		if noWait {
			renderAsyncFallback(os.Stdout, jsonOutput, id, "Instance provisioning", "")
			return nil
		}

		return pollUntilTerminal(cmd, sc, id, "instance")
	},
}

var agentListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List agents",
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		var resp agentListResponse
		if err := sc.Get(cmd.Context(), "/v1/agents", &resp); err != nil {
			return err
		}

		printer.Print(resp.Agents, func() {
			if len(resp.Agents) == 0 {
				fmt.Println("No agents found.")
				return
			}
			headers := []string{"ID", "CORE", "CHANNELS", "PACKAGES", "CREATED"}
			var rows [][]string
			for _, a := range resp.Agents {
				coreStr := "-"
				if a.Core != nil {
					coreStr = *a.Core
				}
				channels := formatList(a.Channels)
				packages := formatList(a.Packages)
				created := formatAge(a.CreatedAt)
				rows = append(rows, []string{a.ID, coreStr, channels, packages, created})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var agentGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get agent details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		var agent agentResponse
		if err := sc.Get(cmd.Context(), "/v1/agents/"+args[0], &agent); err != nil {
			return err
		}

		// /v1/agents/:id now returns status + last_error inline, so we no
		// longer fetch /instances separately.
		printer.Print(agent, func() {
			fmt.Printf("ID:        %s\n", agent.ID)
			fmt.Printf("Name:      %s\n", agent.DisplayName)
			coreStr := "-"
			if agent.Core != nil {
				coreStr = *agent.Core
			}
			fmt.Printf("Core:      %s\n", coreStr)
			if agent.Status != nil {
				fmt.Printf("Status:    %s\n", *agent.Status)
			}
			fmt.Printf("Channels:  %s\n", formatList(agent.Channels))
			fmt.Printf("Packages:  %s\n", formatList(agent.Packages))
			fmt.Printf("Created:   %s\n", agent.CreatedAt)

			if agent.LastError != nil {
				fmt.Println()
				RenderLastError(os.Stdout, agent.LastError)
			}
		})

		return nil
	},
}

var agentDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete an agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		if err := sc.Delete(cmd.Context(), "/v1/agents/"+args[0]); err != nil {
			return err
		}

		fmt.Printf("Agent %s deleted.\n", args[0])
		return nil
	},
}

var agentConnectCmd = &cobra.Command{
	Use:   "connect <id> <channel>",
	Short: "Connect a channel to an agent",
	Long:  "Connect a messaging channel (e.g. telegram) to a managed agent.",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		agentID := args[0]
		channel := args[1]

		body := map[string]interface{}{}

		if channel == "telegram" {
			fmt.Println("To connect Telegram:")
			fmt.Println("  1. Open Telegram and message @BotFather")
			fmt.Println("  2. Send /newbot, choose a name and username")
			fmt.Println("  3. Copy the bot token")
			fmt.Println()
			fmt.Print("Paste bot token: ")

			reader := bufio.NewReader(os.Stdin)
			token, _ := reader.ReadString('\n')
			token = strings.TrimSpace(token)
			if token == "" {
				return fmt.Errorf("bot token is required")
			}
			body["bot_token"] = token
		}

		var result map[string]interface{}
		if err := sc.Post(cmd.Context(), "/v1/agents/"+agentID+"/channels/"+channel, body, &result); err != nil {
			return err
		}

		fmt.Printf("Telegram connected to %s.\n", agentID)
		if channel == "telegram" {
			fmt.Println("Message your bot on Telegram to start chatting.")
		}
		return nil
	},
}

var agentDisconnectCmd = &cobra.Command{
	Use:   "disconnect <id> <channel>",
	Short: "Disconnect a channel from an agent",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		if err := sc.Delete(cmd.Context(), "/v1/agents/"+args[0]+"/channels/"+args[1]); err != nil {
			return err
		}

		fmt.Printf("Channel %s disconnected from %s.\n", args[1], args[0])
		return nil
	},
}

var agentChannelsCmd = &cobra.Command{
	Use:   "channels <id>",
	Short: "List channels connected to an agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		var resp map[string]interface{}
		if err := sc.Get(cmd.Context(), "/v1/agents/"+args[0]+"/channels", &resp); err != nil {
			return err
		}

		printer.Print(resp, func() {
			channels := formatList(resp["channels"])
			if channels == "-" {
				fmt.Println("No channels connected.")
			} else {
				fmt.Printf("Channels: %s\n", channels)
			}
		})
		return nil
	},
}

var agentInstallCmd = &cobra.Command{
	Use:   "install <id> <package>",
	Short: "Install a package on an agent",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		agentID := args[0]
		pkg := args[1]
		noWait, _ := cmd.Flags().GetBool("no-wait")

		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "Installing %s on %s\n", pkg, agentID)
		}

		// sessions-api returns 500 when install orchestration fails
		// synchronously. A successful 200 means the whole flow completed.
		// The orchestrator writes per-phase events to agent_events; we
		// surface them by polling and rendering last_error on error.
		var result map[string]interface{}
		postErr := sc.Post(cmd.Context(), "/v1/agents/"+agentID+"/packages/"+pkg, nil, &result)

		if postErr == nil {
			if !jsonOutput {
				fmt.Fprintf(os.Stderr, "  ✓ %s installed\n", pkg)
			}
			if jsonOutput {
				_ = result // suppress unused warning when we don't render below
				printer.PrintJSON(result)
			}
			return nil
		}

		// 500 from the orchestrator — the event is already written. --no-wait
		// callers get the async fallback because they opted out of waiting;
		// otherwise fetch the latest state to render the error block.
		if noWait {
			renderAsyncFallback(os.Stdout, jsonOutput, agentID, "Package install", postErr.Error())
			return nil
		}
		return renderAgentError(cmd, sc, agentID, "install")
	},
}

var agentUninstallCmd = &cobra.Command{
	Use:   "uninstall <id> <package>",
	Short: "Uninstall a package from an agent",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		if err := sc.Delete(cmd.Context(), "/v1/agents/"+args[0]+"/packages/"+args[1]); err != nil {
			return err
		}

		fmt.Printf("Package %s uninstalled from %s.\n", args[1], args[0])
		return nil
	},
}

var agentPackagesCmd = &cobra.Command{
	Use:   "packages <id>",
	Short: "List packages installed on an agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		var resp map[string]interface{}
		if err := sc.Get(cmd.Context(), "/v1/agents/"+args[0]+"/packages", &resp); err != nil {
			return err
		}

		printer.Print(resp, func() {
			packages := formatList(resp["packages"])
			if packages == "-" {
				fmt.Println("No packages installed.")
			} else {
				fmt.Printf("Packages: %s\n", packages)
			}
		})
		return nil
	},
}

// ── Polling + error-state rendering ──

// Poll cadence for async operations. 2s is fast enough that humans don't
// notice, slow enough not to hammer the API. The 180s cap is a generous
// bound on "it's almost certainly still working" before falling back to
// the async message.
const (
	pollInterval = 2 * time.Second
	pollTimeout  = 180 * time.Second
)

// pollUntilTerminal polls GET /v1/agents/:id until status reaches a terminal
// state (running / error), the deadline hits, or a persistent network error
// occurs. One of three Mode outcomes results:
//   - Mode 1 (running):       success block, exit 0
//   - Mode 2 (error):         error block, ExitError with class-based code
//   - Mode 3 (timeout / err): async-fallback message, exit 0
//
// See ws-gstack/work/agent-error-visibility.md — "Three outcome modes".
func pollUntilTerminal(cmd *cobra.Command, sc *client.Client, agentID, op string) error {
	deadline := time.Now().Add(pollTimeout)

	// Print phase progress only in text mode. JSON mode suppresses stderr
	// progress so consumers get exactly one object on stdout.
	printProgress := func(phase string) {
		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "  ⋯ %s\n", phase)
		}
	}

	lastPhase := ""
	consecutiveErrors := 0
	const errorThreshold = 3 // tolerate transient blips before declaring the poll dead

	for time.Now().Before(deadline) {
		time.Sleep(pollInterval)

		var agent agentResponse
		if err := sc.Get(cmd.Context(), "/v1/agents/"+agentID, &agent); err != nil {
			consecutiveErrors++
			if consecutiveErrors >= errorThreshold {
				// Poll lost connection; Mode 3 fallback. Work may still be
				// running in sessions-api — the user just can't observe it
				// from here.
				renderAsyncFallback(os.Stdout, jsonOutput, agentID, capitalize(op)+" still in progress", "")
				return nil
			}
			continue
		}
		consecutiveErrors = 0

		status := ""
		if agent.Status != nil {
			status = *agent.Status
		}

		switch status {
		case "running":
			// Mode 1 — success.
			if !jsonOutput {
				fmt.Fprintln(os.Stderr, "  ✓ Ready")
			}
			printer.Print(agent, func() {})
			return nil

		case "error":
			// Mode 2 — failure. Render the error block and exit with the
			// class-mapped code.
			if !jsonOutput {
				fmt.Fprintln(os.Stderr, "  ✗ "+capitalize(op)+" failed")
				fmt.Fprintln(os.Stderr)
				RenderLastError(os.Stderr, agent.LastError)
			} else {
				printer.Print(agent, func() {})
			}
			return &ExitError{Code: ExitCodeFor(agent.LastError)}

		case "creating", "":
			// Still working. Report phase progress from packageStatus /
			// channelStatus in a future pass; for now the instance status
			// alone is enough to reassure the user something's happening.
			phase := "Provisioning instance"
			if phase != lastPhase {
				printProgress(phase)
				lastPhase = phase
			}
		}
	}

	// Mode 3 — poll hit the cap. Work is likely still running.
	renderAsyncFallback(os.Stdout, jsonOutput, agentID, capitalize(op)+" still in progress", "")
	return nil
}

// renderAgentError fetches the current agent state and renders the last_error
// block. Used by synchronous failure paths (install) where the POST returned
// 500 and the orchestrator has already persisted an error event. If the fetch
// itself fails we fall through to returning the original postErr so the user
// sees something rather than nothing.
func renderAgentError(cmd *cobra.Command, sc *client.Client, agentID, op string) error {
	var agent agentResponse
	if err := sc.Get(cmd.Context(), "/v1/agents/"+agentID, &agent); err != nil {
		return fmt.Errorf("%s failed (unable to fetch agent state: %w)", op, err)
	}
	if agent.LastError == nil {
		// 500 without an event row shouldn't happen post-migration, but guard
		// against it so the user isn't told "everything's fine" after a 500.
		return fmt.Errorf("%s failed (no error detail available — check server logs)", op)
	}
	if !jsonOutput {
		fmt.Fprintln(os.Stderr, "  ✗ "+capitalize(op)+" failed")
		fmt.Fprintln(os.Stderr)
		RenderLastError(os.Stderr, agent.LastError)
	} else {
		printer.Print(agent, func() {})
	}
	return &ExitError{Code: ExitCodeFor(agent.LastError)}
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// ── Helpers ──

func formatList(v interface{}) string {
	if v == nil {
		return "-"
	}
	switch items := v.(type) {
	case []interface{}:
		if len(items) == 0 {
			return "-"
		}
		strs := make([]string, len(items))
		for i, item := range items {
			strs[i] = fmt.Sprintf("%v", item)
		}
		return strings.Join(strs, ", ")
	case []string:
		if len(items) == 0 {
			return "-"
		}
		return strings.Join(items, ", ")
	default:
		return fmt.Sprintf("%v", v)
	}
}

func formatAge(isoTime string) string {
	t, err := time.Parse(time.RFC3339Nano, isoTime)
	if err != nil {
		return isoTime
	}
	return time.Since(t).Truncate(time.Second).String()
}

// agent events — show the time-ordered event history for an agent. Primarily
// surfaces error events today; as Design 003 adds recovered / health check
// events, they flow through the same table and command.
var agentEventsCmd = &cobra.Command{
	Use:   "events <id>",
	Short: "Show an agent's event history (errors, recoveries, etc.)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		limit, _ := cmd.Flags().GetInt("limit")
		before, _ := cmd.Flags().GetString("before")

		path := "/v1/agents/" + args[0] + "/events"
		q := []string{}
		if limit > 0 {
			q = append(q, fmt.Sprintf("limit=%d", limit))
		}
		if before != "" {
			q = append(q, "before="+before)
		}
		if len(q) > 0 {
			path += "?" + strings.Join(q, "&")
		}

		var resp agentEventsResponse
		if err := sc.Get(cmd.Context(), path, &resp); err != nil {
			return err
		}

		printer.Print(resp, func() {
			if len(resp.Events) == 0 {
				fmt.Println("No events.")
				return
			}
			headers := []string{"TIMESTAMP", "TYPE", "PHASE", "MESSAGE"}
			var rows [][]string
			for _, e := range resp.Events {
				rows = append(rows, []string{e.At, e.Type, valueOr(e.Phase, "-"), truncate(valueOr(e.Message, ""), 80)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

type agentEventRow struct {
	ID             int    `json:"id"`
	InstanceID     string `json:"instance_id"`
	Type           string `json:"type"`
	Phase          string `json:"phase"`
	Message        string `json:"message"`
	Code           string `json:"code"`
	UpstreamStatus int    `json:"upstream_status"`
	At             string `json:"at"`
}

type agentEventsResponse struct {
	Events     []agentEventRow `json:"events"`
	NextBefore *string         `json:"next_before"`
}

func valueOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n < 1 {
		return ""
	}
	return s[:n-1] + "…"
}

func init() {
	// agent create flags
	agentCreateCmd.Flags().String("core", "", "Managed core (e.g. hermes)")
	agentCreateCmd.Flags().StringSlice("secret", nil, "Secrets (KEY=VALUE)")
	agentCreateCmd.Flags().Bool("no-wait", false, "Don't wait for instance provisioning; exit after agent record is created")

	// agent install flags
	agentInstallCmd.Flags().Bool("no-wait", false, "Don't wait for install orchestration to finish")

	// agent events flags
	agentEventsCmd.Flags().Int("limit", 0, "Max events to return (1-200, default 50)")
	agentEventsCmd.Flags().String("before", "", "Return events before this ISO timestamp (for pagination)")

	agentCmd.AddCommand(agentCreateCmd)
	agentCmd.AddCommand(agentListCmd)
	agentCmd.AddCommand(agentGetCmd)
	agentCmd.AddCommand(agentDeleteCmd)
	agentCmd.AddCommand(agentConnectCmd)
	agentCmd.AddCommand(agentDisconnectCmd)
	agentCmd.AddCommand(agentChannelsCmd)
	agentCmd.AddCommand(agentInstallCmd)
	agentCmd.AddCommand(agentUninstallCmd)
	agentCmd.AddCommand(agentPackagesCmd)
	agentCmd.AddCommand(agentEventsCmd)
}
