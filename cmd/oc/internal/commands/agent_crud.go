package commands

import (
	"fmt"

	"github.com/spf13/cobra"
)

var agentCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create an agent",
	Example: "  oc agent create issue-fixer --prompt \"You fix issues.\" --model anthropic/claude-sonnet-5\n" +
		"  (tip: `oc agent init` + `oc agent deploy` is the usual flow — create is for quick one-offs)",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		prompt, _ := cmd.Flags().GetString("prompt")
		model, _ := cmd.Flags().GetString("model")
		runtime, _ := cmd.Flags().GetString("runtime")
		credential, _ := cmd.Flags().GetString("credential")
		// Flue agents carry their instructions in code, so --prompt is optional
		// for them (required for every other runtime).
		if prompt == "" && runtime != "flue" {
			return fmt.Errorf("--prompt is required")
		}
		if model == "" {
			return fmt.Errorf("--model is required")
		}
		body := map[string]interface{}{"name": args[0], "model": model}
		if prompt != "" {
			body["prompt"] = prompt
		}
		if runtime != "" {
			body["runtime"] = runtime
		}
		if credential != "" {
			body["credential"] = credential
		}
		var a Agent
		if err := sc.Post(cmd.Context(), "/v3/agents", body, &a); err != nil {
			return err
		}
		printer.Print(a, func() {
			fmt.Printf("Created agent %s (%s)\n", a.Name, a.ID)
			if a.ActiveRevision != nil {
				fmt.Printf("Active revision: %d\n", a.ActiveRevision.Number)
			}
		})
		return nil
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
		var resp AgentList
		if err := sc.Get(cmd.Context(), "/v3/agents", &resp); err != nil {
			return err
		}
		printer.Print(resp.Data, func() {
			if len(resp.Data) == 0 {
				fmt.Println("No agents found.")
				return
			}
			headers := []string{"ID", "NAME", "MODEL", "RUNTIME", "ACTIVE_REV", "CREATED"}
			var rows [][]string
			for _, a := range resp.Data {
				rev := "-"
				if a.ActiveRevision != nil {
					rev = fmt.Sprintf("%d", a.ActiveRevision.Number)
				}
				rows = append(rows, []string{a.ID, a.Name, a.Model, a.Runtime, rev, formatAge(a.CreatedAt)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var agentGetCmd = &cobra.Command{
	Use:   "get [id|name]",
	Short: "Show an agent (defaults to the agent.toml in the current directory)",
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
		printer.Print(a, func() {
			fmt.Printf("ID:       %s\n", a.ID)
			fmt.Printf("Name:     %s\n", a.Name)
			fmt.Printf("Model:    %s\n", a.Model)
			fmt.Printf("Runtime:  %s\n", a.Runtime)
			if a.ActiveRevision != nil {
				fmt.Printf("Active:   revision %d (%s)\n", a.ActiveRevision.Number, a.ActiveRevision.Digest)
			}
			fmt.Printf("Created:  %s ago\n", formatAge(a.CreatedAt))
		})
		return nil
	},
}

func registerAgentCrud() {
	agentCreateCmd.Flags().String("prompt", "", "System prompt (required, except --runtime flue)")
	agentCreateCmd.Flags().String("model", "", "Model, e.g. anthropic/claude-sonnet-5 (required)")
	agentCreateCmd.Flags().String("runtime", "claude", "Runtime family (claude|codex|pi|flue)")
	agentCreateCmd.Flags().String("credential", "", "Credential id (optional)")
	agentGetCmd.Flags().String("agent", "", "Agent id or name (else the cwd agent.toml)")

	agentCmd.AddCommand(agentCreateCmd)
	agentCmd.AddCommand(agentListCmd)
	agentCmd.AddCommand(agentGetCmd)
}
