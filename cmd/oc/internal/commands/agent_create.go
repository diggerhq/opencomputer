package commands

import (
	"fmt"
	"github.com/spf13/cobra"
	"os"
	"strings"
)

var agentCreateCmd = &cobra.Command{
	Use:   "create <id>",
	Short: "Create a new managed agent",
	Long: "Create a new managed agent. A core (e.g. --core hermes) is required:\n" +
		"without one, the agent has no runtime and cannot connect channels\n" +
		"or install packages.",
	Args: cobra.ExactArgs(1),
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
			"id":   id,
			"core": core,
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

		// --no-wait short-circuits into Mode 3 (async fallback). Scripts
		// that don't want to block use this path.
		if noWait {
			note := ""
			if agent.CurrentOperation != nil {
				note = "Operation: " + agent.CurrentOperation.ID
			}
			renderAsyncFallback(os.Stdout, jsonOutput, id, "Instance provisioning", note)
			return nil
		}

		if agent.CurrentOperation == nil {
			printer.Print(agent, func() {})
			return nil
		}

		finalAgent, err := waitForOperation(cmd, sc, id, agent.CurrentOperation, "Instance creation")
		if err != nil {
			return err
		}
		if finalAgent == nil {
			return nil
		}

		printer.Print(finalAgent, func() {})
		return nil
	},
}
