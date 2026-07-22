package commands

// `oc session` — Durable Agent Sessions runtime verbs (/v3/sessions/*). A session
// is one run of an agent's active revision. Distinct from `oc agent`
// (which manages the behavior); sessions are addressed by id.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type Session struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	AgentID   string `json:"agent_id,omitempty"`
	CreatedAt string `json:"created_at"`
}

type SessionEnvelope struct {
	Session Session `json:"session"`
}

type SessionList struct {
	Data []Session `json:"data"`
}

type Event struct {
	Seq   int         `json:"seq"`
	Type  string      `json:"type"`
	Level string      `json:"level"`
	Body  interface{} `json:"body"`
	TS    string      `json:"ts"`
}

type EventList struct {
	Data []Event `json:"data"`
}

var sessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Run and inspect agent sessions",
}

var sessionCreateCmd = &cobra.Command{
	Use:     "create",
	Short:   "Start a session on an agent",
	Example: "  oc session create --agent issue-fixer --input \"triage issue #42\"",
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		ref, _ := cmd.Flags().GetString("agent")
		input, _ := cmd.Flags().GetString("input")
		if ref == "" {
			id, rerr := targetAgentID(cmd, sc, nil) // fall back to cwd agent.toml
			if rerr != nil {
				return fmt.Errorf("--agent is required (or run inside an agent directory)")
			}
			ref = id
		} else {
			ref, err = resolveRef(cmd, sc, ref)
			if err != nil {
				return err
			}
		}
		if input == "" {
			return fmt.Errorf("--input is required (the first message to the agent)")
		}
		body := map[string]interface{}{"agent": ref, "input": input}
		specs, _ := cmd.Flags().GetStringArray("source")
		sources, err := parseSources(specs)
		if err != nil {
			return err
		}
		if len(sources) > 0 {
			body["sources"] = sources
		}
		var env SessionEnvelope
		if err := sc.Post(cmd.Context(), "/v3/sessions", body, &env); err != nil {
			return err
		}
		printer.Print(env.Session, func() {
			fmt.Printf("Started session %s (status: %s)\n", env.Session.ID, env.Session.Status)
			fmt.Printf("Follow:  oc session logs %s\n", env.Session.ID)
		})
		return nil
	},
}

var sessionListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List sessions",
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		path := "/v3/sessions"
		if agent, _ := cmd.Flags().GetString("agent"); agent != "" {
			id, err := resolveRef(cmd, sc, agent)
			if err != nil {
				return err
			}
			path += "?agent=" + id
		}
		var resp SessionList
		if err := sc.Get(cmd.Context(), path, &resp); err != nil {
			return err
		}
		printer.Print(resp.Data, func() {
			if len(resp.Data) == 0 {
				fmt.Println("No sessions found.")
				return
			}
			headers := []string{"ID", "STATUS", "AGENT", "CREATED"}
			var rows [][]string
			for _, s := range resp.Data {
				rows = append(rows, []string{s.ID, s.Status, s.AgentID, formatAge(s.CreatedAt)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var sessionGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Show a session",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		var raw json.RawMessage
		var s Session
		if err := sc.Get(cmd.Context(), "/v3/sessions/"+args[0], &raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("decode session: %w", err)
		}
		// Keep the human view compact, but preserve the complete server response
		// for automation: usage, cursors, limits, and future additive fields.
		printer.Print(raw, func() {
			fmt.Printf("ID:      %s\n", s.ID)
			fmt.Printf("Status:  %s\n", s.Status)
			fmt.Printf("Agent:   %s\n", s.AgentID)
			fmt.Printf("Created: %s ago\n", formatAge(s.CreatedAt))
		})
		return nil
	},
}

var sessionResultCmd = &cobra.Command{
	Use:   "result <id>",
	Short: "Show a session's result",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		var res map[string]interface{}
		if err := sc.Get(cmd.Context(), "/v3/sessions/"+args[0]+"/result", &res); err != nil {
			return err
		}
		printer.Print(res, func() {
			for k, v := range res {
				fmt.Printf("%s: %v\n", k, v)
			}
		})
		return nil
	},
}

var sessionCancelCmd = &cobra.Command{
	Use:   "cancel <id>",
	Short: "Cancel a running session",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		if err := sc.Post(cmd.Context(), "/v3/sessions/"+args[0]+"/cancel", nil, nil); err != nil {
			return err
		}
		fmt.Printf("Cancelled %s\n", args[0])
		return nil
	},
}

var sessionLogsCmd = &cobra.Command{
	Use:   "logs <id>",
	Short: "Show a session's event log",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		var resp EventList
		if err := sc.Get(cmd.Context(), "/v3/sessions/"+args[0]+"/events", &resp); err != nil {
			return err
		}
		printer.Print(resp.Data, func() {
			if len(resp.Data) == 0 {
				fmt.Println("No events.")
				return
			}
			for _, e := range resp.Data {
				fmt.Printf("[%d] %s", e.Seq, e.Type)
				if txt, ok := bodyText(e.Body); ok {
					fmt.Printf("  %s", txt)
				}
				fmt.Println()
			}
		})
		return nil
	},
}

var sessionSteerCmd = &cobra.Command{
	Use:     "steer <id> <text>",
	Short:   "Send a message to a running session",
	Example: "  oc session steer ses_123 \"also check the changelog\"",
	Args:    cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		if err := sc.Post(cmd.Context(), "/v3/sessions/"+args[0]+"/messages", map[string]interface{}{"text": args[1]}, nil); err != nil {
			return err
		}
		fmt.Println("Sent.")
		return nil
	},
}

// parseSources turns --source "owner/repo[@ref]" specs into connection-backed
// source objects for POST /v3/sessions (validated server-side by sources/validate).
// A missing @ref defaults to HEAD — the repo's default branch, pinned to a sha at
// create by the control plane (needs the OpenComputer GitHub App connected).
func parseSources(specs []string) ([]map[string]interface{}, error) {
	var out []map[string]interface{}
	for _, raw := range specs {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		repo, ref := s, "HEAD"
		if at := strings.Index(s, "@"); at >= 0 {
			repo, ref = s[:at], s[at+1:]
		}
		if ref == "" {
			ref = "HEAD"
		}
		if strings.Count(repo, "/") != 1 || strings.HasPrefix(repo, "/") || strings.HasSuffix(repo, "/") {
			return nil, fmt.Errorf("--source %q must be owner/repo[@ref]", raw)
		}
		out = append(out, map[string]interface{}{"repo": repo, "ref": ref})
	}
	return out, nil
}

// bodyText pulls a short human string out of an event body for the log view.
func bodyText(body interface{}) (string, bool) {
	m, ok := body.(map[string]interface{})
	if !ok {
		return "", false
	}
	for _, k := range []string{"text", "message", "tool", "yield_reason"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v, true
		}
	}
	return "", false
}

func init() {
	sessionCreateCmd.Flags().String("agent", "", "Agent id or name to run (else the cwd agent.toml)")
	sessionCreateCmd.Flags().String("input", "", "First message to the agent (required)")
	sessionCreateCmd.Flags().StringArray("source", nil, "Attach a GitHub repo as a working source: owner/repo[@ref] (default ref: HEAD). Repeatable.")
	sessionListCmd.Flags().String("agent", "", "Filter by agent id or name")

	sessionCmd.AddCommand(sessionCreateCmd)
	sessionCmd.AddCommand(sessionListCmd)
	sessionCmd.AddCommand(sessionGetCmd)
	sessionCmd.AddCommand(sessionResultCmd)
	sessionCmd.AddCommand(sessionCancelCmd)
	sessionCmd.AddCommand(sessionLogsCmd)
	sessionCmd.AddCommand(sessionSteerCmd)
}
