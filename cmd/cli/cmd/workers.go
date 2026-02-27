package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/opensandbox/opensandbox/pkg/client"
	"github.com/spf13/cobra"
)

var workersCmd = &cobra.Command{
	Use:   "workers",
	Short: "List registered workers (server mode only)",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		workers, err := c.ListWorkers(ctx)
		if err != nil {
			return fmt.Errorf("failed to list workers: %w", err)
		}

		if len(workers) == 0 {
			fmt.Println("No workers found")
			return nil
		}

		jsonOutput, _ := cmd.Flags().GetBool("json")
		if jsonOutput {
			data, _ := json.MarshalIndent(workers, "", "  ")
			fmt.Println(string(data))
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tREGION\tLOAD\tSTATUS")
		for _, worker := range workers {
			id := worker["id"].(string)
			region := ""
			if r, ok := worker["region"].(string); ok {
				region = r
			}
			load := float64(0)
			if l, ok := worker["load"].(float64); ok {
				load = l
			}
			status := "online"
			if s, ok := worker["status"].(string); ok {
				status = s
			}

			fmt.Fprintf(w, "%s\t%s\t%.1f%%\t%s\n", id, region, load*100, status)
		}
		w.Flush()

		return nil
	},
}

func init() {
	rootCmd.AddCommand(workersCmd)
	workersCmd.Flags().Bool("json", false, "Output as JSON")
}
