package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/opensandbox/opensandbox/pkg/client"
	"github.com/spf13/cobra"
)

var execCmd = &cobra.Command{
	Use:   "exec <sandbox-id> <command> [args...]",
	Short: "Execute a command in a sandbox",
	Long: `Execute a command in a running sandbox and return the output.
Example: osb exec abc123 ls -la /workspace`,
	Args: cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		command := args[1:]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()

		result, err := c.RunCommand(ctx, sandboxID, command)
		if err != nil {
			return fmt.Errorf("failed to execute command: %w", err)
		}

		jsonOutput, _ := cmd.Flags().GetBool("json")
		if jsonOutput {
			data, _ := json.MarshalIndent(result, "", "  ")
			fmt.Println(string(data))
			return nil
		}

		// Print stdout
		if stdout, ok := result["stdout"].(string); ok && stdout != "" {
			fmt.Print(stdout)
		}

		// Print stderr to stderr
		if stderr, ok := result["stderr"].(string); ok && stderr != "" {
			fmt.Fprint(cmd.ErrOrStderr(), stderr)
		}

		// Print exit code if non-zero
		if exitCode, ok := result["exitCode"].(float64); ok && exitCode != 0 {
			return fmt.Errorf("command exited with code %d", int(exitCode))
		}

		return nil
	},
}

var shellCmd = &cobra.Command{
	Use:   "shell <sandbox-id> <command>",
	Short: "Execute a shell command in a sandbox",
	Long: `Execute a shell command (wrapped in /bin/sh -c) in a sandbox.
Example: osb shell abc123 "cd /workspace && ls -la"`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		shellCmd := args[1]

		command := []string{"/bin/sh", "-c", shellCmd}

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()

		result, err := c.RunCommand(ctx, sandboxID, command)
		if err != nil {
			return fmt.Errorf("failed to execute command: %w", err)
		}

		// Print stdout
		if stdout, ok := result["stdout"].(string); ok && stdout != "" {
			fmt.Print(stdout)
		}

		// Print stderr to stderr
		if stderr, ok := result["stderr"].(string); ok && stderr != "" {
			fmt.Fprint(cmd.ErrOrStderr(), stderr)
		}

		// Print exit code if non-zero
		if exitCode, ok := result["exitCode"].(float64); ok && exitCode != 0 {
			return fmt.Errorf("command exited with code %d", int(exitCode))
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(execCmd)
	rootCmd.AddCommand(shellCmd)

	execCmd.Flags().Bool("json", false, "Output as JSON")
	// Stop parsing flags after the first non-flag arg so that
	// arguments like --version are passed to the sandbox command,
	// not interpreted by Cobra.
	execCmd.Flags().SetInterspersed(false)
}
