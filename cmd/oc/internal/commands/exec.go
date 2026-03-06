package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/pkg/types"
	"github.com/spf13/cobra"
)

var execCmd = &cobra.Command{
	Use:   "exec <sandbox-id> -- <command> [args...]",
	Short: "Execute a command in a sandbox",
	Long: `Execute a command in a running sandbox and stream the output in real time.

Use --background to start a long-running process (server, watcher) that keeps
running in the sandbox. Returns the PTY session ID for later management.

Examples:
  oc exec abc123 -- echo hello
  oc exec abc123 --cwd /app -- ls -la
  oc exec abc123 --timeout 120 -- npm install
  oc exec abc123 --background -- python manage.py runserver 0.0.0.0:8000`,
	Args:               cobra.MinimumNArgs(1),
	DisableFlagParsing: false,
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		sandboxID := args[0]

		if len(args) < 2 {
			return fmt.Errorf("no command specified. Usage: oc exec <sandbox-id> -- <command>")
		}
		command := args[1]
		cmdArgs := args[2:]

		cwd, _ := cmd.Flags().GetString("cwd")
		timeout, _ := cmd.Flags().GetInt("timeout")
		envSlice, _ := cmd.Flags().GetStringSlice("env")
		background, _ := cmd.Flags().GetBool("background")

		if background {
			return execBackground(cmd, c, sandboxID, command, cmdArgs, cwd, envSlice)
		}

		return execStreaming(cmd, c, sandboxID, command, cmdArgs, cwd, timeout, envSlice)
	},
}

func execStreaming(cmd *cobra.Command, c *client.Client, sandboxID, command string, cmdArgs []string, cwd string, timeout int, envSlice []string) error {
	// Build the full command string for the SSE exec endpoint
	fullCmd := command
	if len(cmdArgs) > 0 {
		fullCmd = command + " " + strings.Join(cmdArgs, " ")
	}

	req := types.ProcessConfig{
		Command: fullCmd,
		Cwd:     cwd,
		Timeout: timeout,
		Env:     parseKVSlice(envSlice),
		Tty:     true,
	}

	exitCode, err := c.PostSSE(cmd.Context(), "/sandboxes/"+sandboxID+"/exec", req, func(eventType string, data json.RawMessage) {
		switch eventType {
		case "stdout", "stderr":
			var chunk struct {
				Data string `json:"data"`
			}
			if json.Unmarshal(data, &chunk) == nil {
				if eventType == "stderr" {
					fmt.Fprint(os.Stderr, chunk.Data)
				} else {
					fmt.Fprint(os.Stdout, chunk.Data)
				}
			}
		case "error":
			var errData struct {
				Error string `json:"error"`
			}
			if json.Unmarshal(data, &errData) == nil {
				fmt.Fprintf(os.Stderr, "Error: %s\n", errData.Error)
			}
		}
	})
	if err != nil {
		return err
	}

	if exitCode != 0 {
		os.Exit(exitCode)
	}
	return nil
}

func execBackground(cmd *cobra.Command, c *client.Client, sandboxID, command string, cmdArgs []string, cwd string, envSlice []string) error {
	// Create a PTY session
	sessionID, err := c.CreatePTYSession(cmd.Context(), sandboxID)
	if err != nil {
		return fmt.Errorf("failed to create PTY session: %w", err)
	}

	// Connect WebSocket
	ws, err := c.DialWebSocket(cmd.Context(), "/sandboxes/"+sandboxID+"/pty/"+sessionID)
	if err != nil {
		return fmt.Errorf("failed to connect to PTY: %w", err)
	}
	defer ws.Close()

	// Build command with env/cwd prefixes
	var parts []string
	env := parseKVSlice(envSlice)
	for k, v := range env {
		parts = append(parts, fmt.Sprintf("export %s='%s'", k, strings.ReplaceAll(v, "'", "'\\''")))
	}
	if cwd != "" {
		parts = append(parts, fmt.Sprintf("cd '%s'", strings.ReplaceAll(cwd, "'", "'\\''")))
	}
	fullCmd := command
	if len(cmdArgs) > 0 {
		fullCmd = command + " " + strings.Join(cmdArgs, " ")
	}
	parts = append(parts, fullCmd)

	// Send command
	if err := ws.WriteMessage(1, []byte(strings.Join(parts, " && ")+"\n")); err != nil {
		return fmt.Errorf("failed to send command: %w", err)
	}

	if jsonOutput {
		printer.PrintJSON(map[string]string{
			"sessionID": sessionID,
			"sandboxID": sandboxID,
			"status":    "running",
		})
	} else {
		fmt.Printf("Background process started (session: %s)\n", sessionID)
		fmt.Printf("Kill with: oc exec %s --kill-session %s\n", sandboxID, sessionID)
	}

	// If --follow, stream output until Ctrl+C
	follow, _ := cmd.Flags().GetBool("follow")
	if follow {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				_, msg, err := ws.ReadMessage()
				if err != nil {
					return
				}
				os.Stdout.Write(msg)
			}
		}()

		select {
		case <-sigCh:
			fmt.Fprintf(os.Stderr, "\nDetached. Process continues running (session: %s)\n", sessionID)
		case <-done:
		}
	}

	return nil
}

func init() {
	execCmd.Flags().String("cwd", "", "Working directory")
	execCmd.Flags().Int("timeout", 60, "Timeout in seconds")
	execCmd.Flags().StringSlice("env", nil, "Environment variables (KEY=VALUE)")
	execCmd.Flags().Bool("background", false, "Run in background, return session ID")
	execCmd.Flags().Bool("follow", false, "Follow output after starting background process (Ctrl+C to detach)")
}
