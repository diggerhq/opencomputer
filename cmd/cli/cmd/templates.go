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

var templatesCmd = &cobra.Command{
	Use:     "templates",
	Aliases: []string{"template", "tpl"},
	Short:   "Manage sandbox templates",
}

var listTemplatesCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all templates",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		templates, err := c.ListTemplates(ctx)
		if err != nil {
			return fmt.Errorf("failed to list templates: %w", err)
		}

		if len(templates) == 0 {
			fmt.Println("No templates found")
			return nil
		}

		jsonOutput, _ := cmd.Flags().GetBool("json")
		if jsonOutput {
			data, _ := json.MarshalIndent(templates, "", "  ")
			fmt.Println(string(data))
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tTYPE\tCREATED")
		for _, tpl := range templates {
			name := tpl["name"].(string)
			tplType := "unknown"
			if t, ok := tpl["template_type"].(string); ok {
				tplType = t
			}
			created := ""
			if c, ok := tpl["created_at"].(string); ok {
				if t, err := time.Parse(time.RFC3339, c); err == nil {
					created = t.Format("2006-01-02")
				}
			}
			fmt.Fprintf(w, "%s\t%s\t%s\n", name, tplType, created)
		}
		w.Flush()

		return nil
	},
}

func init() {
	rootCmd.AddCommand(templatesCmd)
	templatesCmd.AddCommand(listTemplatesCmd)

	listTemplatesCmd.Flags().Bool("json", false, "Output as JSON")
}
