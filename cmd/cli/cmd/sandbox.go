package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/opensandbox/opensandbox/pkg/client"
	"github.com/opensandbox/opensandbox/pkg/types"
	"github.com/spf13/cobra"
)

var sandboxCmd = &cobra.Command{
	Use:     "sandbox",
	Aliases: []string{"sb"},
	Short:   "Manage sandboxes",
	Long:    `Create, list, inspect, and delete sandboxes.`,
}

var createCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sandbox",
	Long:  `Create a new sandbox with specified configuration.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		template, _ := cmd.Flags().GetString("template")
		cpus, _ := cmd.Flags().GetInt("cpus")
		memory, _ := cmd.Flags().GetInt("memory")
		timeout, _ := cmd.Flags().GetInt("timeout")
		metadata, _ := cmd.Flags().GetStringToString("metadata")

		cfg := types.SandboxConfig{
			Template: template,
			CpuCount: cpus,
			MemoryMB: memory,
			Timeout:  timeout,
			Metadata: metadata,
		}

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		sandbox, err := c.CreateSandbox(ctx, cfg)
		if err != nil {
			return fmt.Errorf("failed to create sandbox: %w", err)
		}

		fmt.Printf("✓ Sandbox created: %s\n", sandbox.ID)
		fmt.Printf("  Template: %s\n", sandbox.Template)
		fmt.Printf("  Status: %s\n", sandbox.Status)
		fmt.Printf("  Port: %d\n", sandbox.HostPort)
		if sandbox.ConnectURL != "" {
			fmt.Printf("  Connect URL: %s\n", sandbox.ConnectURL)
		}
		if sandbox.Domain != "" {
			fmt.Printf("  Domain: %s\n", sandbox.Domain)
		}

		return nil
	},
}

var listCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all sandboxes",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		sandboxes, err := c.ListSandboxes(ctx)
		if err != nil {
			return fmt.Errorf("failed to list sandboxes: %w", err)
		}

		if len(sandboxes) == 0 {
			fmt.Println("No sandboxes found")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tTEMPLATE\tSTATUS\tPORT\tSTARTED")
		for _, sb := range sandboxes {
			startTime := ""
			if !sb.StartedAt.IsZero() {
				startTime = sb.StartedAt.Format("15:04:05")
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%s\n",
				sb.ID, sb.Template, sb.Status, sb.HostPort, startTime)
		}
		w.Flush()

		return nil
	},
}

var getCmd = &cobra.Command{
	Use:   "get <sandbox-id>",
	Short: "Get sandbox details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		sandbox, err := c.GetSandbox(ctx, sandboxID)
		if err != nil {
			return fmt.Errorf("failed to get sandbox: %w", err)
		}

		jsonOutput, _ := cmd.Flags().GetBool("json")
		if jsonOutput {
			data, _ := json.MarshalIndent(sandbox, "", "  ")
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Sandbox: %s\n", sandbox.ID)
		fmt.Printf("  Template: %s\n", sandbox.Template)
		fmt.Printf("  Status: %s\n", sandbox.Status)
		fmt.Printf("  Port: %d\n", sandbox.HostPort)
		fmt.Printf("  CPUs: %d\n", sandbox.CpuCount)
		fmt.Printf("  Memory: %d MB\n", sandbox.MemoryMB)
		if !sandbox.StartedAt.IsZero() {
			fmt.Printf("  Started: %s\n", sandbox.StartedAt.Format(time.RFC3339))
		}
		if !sandbox.EndAt.IsZero() {
			fmt.Printf("  Timeout: %s\n", sandbox.EndAt.Format(time.RFC3339))
		}
		if sandbox.ConnectURL != "" {
			fmt.Printf("  Connect URL: %s\n", sandbox.ConnectURL)
		}
		if sandbox.Domain != "" {
			fmt.Printf("  Domain: %s\n", sandbox.Domain)
		}

		return nil
	},
}

var killCmd = &cobra.Command{
	Use:     "kill <sandbox-id>",
	Aliases: []string{"delete", "rm"},
	Short:   "Kill (delete) a sandbox",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := c.KillSandbox(ctx, sandboxID); err != nil {
			return fmt.Errorf("failed to kill sandbox: %w", err)
		}

		fmt.Printf("✓ Sandbox %s killed\n", sandboxID)
		return nil
	},
}

var hibernateCmd = &cobra.Command{
	Use:   "hibernate <sandbox-id>",
	Short: "Hibernate a sandbox (snapshot to S3)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()

		result, err := c.HibernateSandbox(ctx, sandboxID)
		if err != nil {
			return fmt.Errorf("failed to hibernate sandbox: %w", err)
		}

		fmt.Printf("✓ Sandbox %s hibernated\n", sandboxID)
		if checkpointKey, ok := result["checkpointKey"].(string); ok {
			fmt.Printf("  Checkpoint: %s\n", checkpointKey)
		}

		return nil
	},
}

var wakeCmd = &cobra.Command{
	Use:   "wake <sandbox-id>",
	Short: "Wake a hibernated sandbox",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()

		sandbox, err := c.WakeSandbox(ctx, sandboxID)
		if err != nil {
			return fmt.Errorf("failed to wake sandbox: %w", err)
		}

		fmt.Printf("✓ Sandbox %s woken\n", sandboxID)
		fmt.Printf("  Status: %s\n", sandbox.Status)
		fmt.Printf("  Port: %d\n", sandbox.HostPort)

		return nil
	},
}

var timeoutCmd = &cobra.Command{
	Use:   "timeout <sandbox-id> <seconds>",
	Short: "Set sandbox timeout",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		var timeoutSecs int
		fmt.Sscanf(args[1], "%d", &timeoutSecs)

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := c.SetTimeout(ctx, sandboxID, timeoutSecs); err != nil {
			return fmt.Errorf("failed to set timeout: %w", err)
		}

		fmt.Printf("✓ Timeout set to %d seconds for sandbox %s\n", timeoutSecs, sandboxID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(sandboxCmd)

	sandboxCmd.AddCommand(createCmd)
	sandboxCmd.AddCommand(listCmd)
	sandboxCmd.AddCommand(getCmd)
	sandboxCmd.AddCommand(killCmd)
	sandboxCmd.AddCommand(hibernateCmd)
	sandboxCmd.AddCommand(wakeCmd)
	sandboxCmd.AddCommand(timeoutCmd)

	// Create command flags
	createCmd.Flags().String("template", "ubuntu", "Sandbox template (ubuntu, python, node)")
	createCmd.Flags().Int("cpus", 1, "Number of vCPUs")
	createCmd.Flags().Int("memory", 1024, "Memory in MB")
	createCmd.Flags().Int("timeout", 300, "Timeout in seconds")
	createCmd.Flags().StringToString("metadata", nil, "Metadata key-value pairs")

	// Get command flags
	getCmd.Flags().Bool("json", false, "Output as JSON")
}
