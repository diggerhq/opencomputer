package commands

// `oc agent schedule[s]` — cron for agents (design 015). A schedule fires an agent on a cron; each
// firing starts one session on the active revision. Agent addressing follows the house convention:
// --agent <id|name> on every verb, else the cwd agent.toml. Schedules are referenced by NAME (or a
// sch_… id); the name is resolved to an id against the agent.

import (
	"fmt"
	"strings"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// ── Response types (mirror the sessions-api JSON, snake_case) ──

type Schedule struct {
	ID                  string  `json:"id"`
	AgentID             string  `json:"agent_id"`
	Name                string  `json:"name"`
	Cron                string  `json:"cron"`
	TZ                  *string `json:"tz"`
	Input               string  `json:"input"`
	Overlap             string  `json:"overlap"`
	State               string  `json:"state"`
	NextFireAt          string  `json:"next_fire_at"`
	LastFiredAt         *string `json:"last_fired_at"`
	ConsecutiveFailures int     `json:"consecutive_failures"`
	LastError           *string `json:"last_error"`
	CreatedAt           string  `json:"created_at"`
}

type scheduleEnvelope struct {
	Schedule Schedule `json:"schedule"`
}
type scheduleListResp struct {
	Schedules []Schedule `json:"schedules"`
}

type ScheduleRun struct {
	ID           string  `json:"id"`
	ScheduleID   string  `json:"schedule_id"`
	ScheduledFor *string `json:"scheduled_for"`
	FiredAt      string  `json:"fired_at"`
	Outcome      string  `json:"outcome"`
	SessionID    *string `json:"session_id"`
	Error        *string `json:"error"`
}
type runEnvelope struct {
	Run ScheduleRun `json:"run"`
}
type runListResp struct {
	Runs       []ScheduleRun `json:"runs"`
	NextCursor *string       `json:"next_cursor"`
}

// schedStr renders a nullable/empty string field as "-".
func schedStr(p *string) string {
	if p == nil || *p == "" {
		return "-"
	}
	return *p
}

// resolveScheduleID maps a "sch_…" id (used as-is) or a schedule NAME (looked up on the agent) to id.
func resolveScheduleID(cmd *cobra.Command, sc *client.Client, agentID, ref string) (string, error) {
	if strings.HasPrefix(ref, "sch_") {
		return ref, nil
	}
	var list scheduleListResp
	if err := sc.Get(cmd.Context(), "/v3/agents/"+agentID+"/schedules", &list); err != nil {
		return "", err
	}
	for _, s := range list.Schedules {
		if s.Name == ref {
			return s.ID, nil
		}
	}
	return "", fmt.Errorf("no schedule named %q on this agent", ref)
}

var agentSchedulesCmd = &cobra.Command{
	Use:   "schedules",
	Short: "List an agent's schedules (cron for agents)",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		var resp scheduleListResp
		if err := sc.Get(cmd.Context(), "/v3/agents/"+agentID+"/schedules", &resp); err != nil {
			return err
		}
		printer.Print(resp.Schedules, func() {
			if len(resp.Schedules) == 0 {
				fmt.Println("No schedules.")
				return
			}
			headers := []string{"NAME", "CRON", "TZ", "STATE", "NEXT_FIRE", "FAILS"}
			var rows [][]string
			for _, s := range resp.Schedules {
				rows = append(rows, []string{s.Name, s.Cron, schedStr(s.TZ), s.State, s.NextFireAt, fmt.Sprintf("%d", s.ConsecutiveFailures)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var agentScheduleCmd = &cobra.Command{
	Use:   "schedule",
	Short: "Manage an agent's schedules (create/get/pause/resume/delete/fire/runs)",
}

var agentScheduleCreateCmd = &cobra.Command{
	Use:     "create <name>",
	Short:   "Create a schedule on an agent",
	Example: "  oc agent schedule create morning-sweep --cron \"0 9 * * 1-5\" --input \"Reconcile docs; open a draft PR if anything drifted.\"",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		cron, _ := cmd.Flags().GetString("cron")
		input, _ := cmd.Flags().GetString("input")
		tz, _ := cmd.Flags().GetString("tz")
		overlap, _ := cmd.Flags().GetString("overlap")
		if cron == "" {
			return fmt.Errorf("--cron is required")
		}
		if input == "" {
			return fmt.Errorf("--input is required")
		}
		body := map[string]interface{}{"name": args[0], "cron": cron, "input": input}
		if tz != "" {
			body["tz"] = tz
		}
		if overlap != "" {
			body["overlap"] = overlap
		}
		var env scheduleEnvelope
		if err := sc.Post(cmd.Context(), "/v3/agents/"+agentID+"/schedules", body, &env); err != nil {
			return err
		}
		printer.Print(env.Schedule, func() {
			fmt.Printf("Created schedule %s (%s) — next fire %s\n", env.Schedule.Name, env.Schedule.ID, env.Schedule.NextFireAt)
		})
		return nil
	},
}

var agentScheduleGetCmd = &cobra.Command{
	Use:   "get <name>",
	Short: "Show a schedule",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		sid, err := resolveScheduleID(cmd, sc, agentID, args[0])
		if err != nil {
			return err
		}
		var env scheduleEnvelope
		if err := sc.Get(cmd.Context(), "/v3/agents/"+agentID+"/schedules/"+sid, &env); err != nil {
			return err
		}
		printer.Print(env.Schedule, func() {
			s := env.Schedule
			fmt.Printf("Name:       %s\n", s.Name)
			fmt.Printf("ID:         %s\n", s.ID)
			fmt.Printf("Cron:       %s (%s)\n", s.Cron, schedStr(s.TZ))
			fmt.Printf("State:      %s\n", s.State)
			fmt.Printf("Next fire:  %s\n", s.NextFireAt)
			fmt.Printf("Last fired: %s\n", schedStr(s.LastFiredAt))
			fmt.Printf("Overlap:    %s\n", s.Overlap)
			if s.LastError != nil && *s.LastError != "" {
				fmt.Printf("Last error: %s (failures: %d)\n", *s.LastError, s.ConsecutiveFailures)
			}
			fmt.Printf("Input:      %s\n", s.Input)
		})
		return nil
	},
}

// patchPaused PATCHes {paused} and reports the resulting state (pause / resume share this).
func patchPaused(cmd *cobra.Command, args []string, paused bool, verb string) error {
	sc, err := sessionsClient(cmd)
	if err != nil {
		return err
	}
	agentID, err := targetAgentID(cmd, sc, nil)
	if err != nil {
		return err
	}
	sid, err := resolveScheduleID(cmd, sc, agentID, args[0])
	if err != nil {
		return err
	}
	var env scheduleEnvelope
	if err := sc.Patch(cmd.Context(), "/v3/agents/"+agentID+"/schedules/"+sid, map[string]interface{}{"paused": paused}, &env); err != nil {
		return err
	}
	printer.Print(env.Schedule, func() {
		fmt.Printf("%s %s — state %s, next fire %s\n", verb, env.Schedule.Name, env.Schedule.State, env.Schedule.NextFireAt)
	})
	return nil
}

var agentSchedulePauseCmd = &cobra.Command{
	Use: "pause <name>", Short: "Pause a schedule", Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error { return patchPaused(cmd, args, true, "Paused") },
}
var agentScheduleResumeCmd = &cobra.Command{
	Use: "resume <name>", Short: "Resume a schedule", Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error { return patchPaused(cmd, args, false, "Resumed") },
}

var agentScheduleDeleteCmd = &cobra.Command{
	Use: "delete <name>", Aliases: []string{"rm"}, Short: "Delete a schedule (run history is kept)", Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		sid, err := resolveScheduleID(cmd, sc, agentID, args[0])
		if err != nil {
			return err
		}
		if err := sc.Delete(cmd.Context(), "/v3/agents/"+agentID+"/schedules/"+sid); err != nil {
			return err
		}
		printer.Print(map[string]interface{}{"deleted": args[0]}, func() { fmt.Printf("Deleted schedule %s\n", args[0]) })
		return nil
	},
}

var agentScheduleFireCmd = &cobra.Command{
	Use: "fire <name>", Short: "Test-fire a schedule now (prints the created session)", Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		sid, err := resolveScheduleID(cmd, sc, agentID, args[0])
		if err != nil {
			return err
		}
		var env runEnvelope
		if err := sc.Post(cmd.Context(), "/v3/agents/"+agentID+"/schedules/"+sid+"/fire", nil, &env); err != nil {
			return err
		}
		printer.Print(env.Run, func() {
			r := env.Run
			if r.Outcome == "enacted" && r.SessionID != nil {
				fmt.Printf("Fired — session %s\n", *r.SessionID)
				fmt.Printf("  tail it: oc session logs %s\n", *r.SessionID)
			} else {
				fmt.Printf("Fired — outcome %s\n", r.Outcome)
				if r.Error != nil && *r.Error != "" {
					fmt.Printf("  error: %s\n", *r.Error)
				}
			}
		})
		return nil
	},
}

var agentScheduleRunsCmd = &cobra.Command{
	Use: "runs <name>", Short: "Show a schedule's run history (newest first)", Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		sid, err := resolveScheduleID(cmd, sc, agentID, args[0])
		if err != nil {
			return err
		}
		limit, _ := cmd.Flags().GetInt("limit")
		path := fmt.Sprintf("/v3/agents/%s/schedules/%s/runs", agentID, sid)
		if limit > 0 {
			path += fmt.Sprintf("?limit=%d", limit)
		}
		var resp runListResp
		if err := sc.Get(cmd.Context(), path, &resp); err != nil {
			return err
		}
		printer.Print(resp.Runs, func() {
			if len(resp.Runs) == 0 {
				fmt.Println("No runs yet.")
				return
			}
			headers := []string{"OUTCOME", "SCHEDULED_FOR", "FIRED", "SESSION", "ERROR"}
			var rows [][]string
			for _, r := range resp.Runs {
				rows = append(rows, []string{r.Outcome, schedStr(r.ScheduledFor), r.FiredAt, schedStr(r.SessionID), schedStr(r.Error)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

func registerAgentSchedules() {
	// Agent addressing: --agent on every verb, else the cwd agent.toml.
	for _, c := range []*cobra.Command{
		agentSchedulesCmd, agentScheduleCreateCmd, agentScheduleGetCmd,
		agentSchedulePauseCmd, agentScheduleResumeCmd, agentScheduleDeleteCmd,
		agentScheduleFireCmd, agentScheduleRunsCmd,
	} {
		c.Flags().String("agent", "", "Agent id or name (else the cwd agent.toml)")
	}
	agentScheduleCreateCmd.Flags().String("cron", "", "5-field cron, e.g. \"0 9 * * 1-5\" (required)")
	agentScheduleCreateCmd.Flags().String("tz", "", "IANA time zone, e.g. Europe/London (optional; UTC if omitted)")
	agentScheduleCreateCmd.Flags().String("input", "", "First user message of every run (required)")
	agentScheduleCreateCmd.Flags().String("overlap", "", "skip (default) | allow")
	agentScheduleRunsCmd.Flags().Int("limit", 0, "Max runs to show")

	agentScheduleCmd.AddCommand(
		agentScheduleCreateCmd, agentScheduleGetCmd, agentSchedulePauseCmd, agentScheduleResumeCmd,
		agentScheduleDeleteCmd, agentScheduleFireCmd, agentScheduleRunsCmd,
	)
	agentCmd.AddCommand(agentSchedulesCmd)
	agentCmd.AddCommand(agentScheduleCmd)
}
