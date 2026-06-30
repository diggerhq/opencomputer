package commands

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// TemplateInfo matches the API response for named snapshots.
type TemplateInfo struct {
	ID           string          `json:"id"`
	OrgID        string          `json:"orgId"`
	ContentHash  string          `json:"contentHash"`
	CheckpointID string          `json:"checkpointId,omitempty"`
	Name         string          `json:"name,omitempty"`
	Manifest     json.RawMessage `json:"manifest"`
	Status       string          `json:"status"`
	CreatedAt    time.Time       `json:"createdAt"`
	LastUsedAt   time.Time       `json:"lastUsedAt"`
}

var templateCmd = &cobra.Command{
	Use:     "template",
	Aliases: []string{"templates", "snapshot", "snapshots"},
	Short:   "Manage declarative sandbox templates",
}

var templateListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List templates",
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		var templates []TemplateInfo
		if err := c.Get(cmd.Context(), "/snapshots", &templates); err != nil {
			return err
		}

		printer.Print(templates, func() {
			if len(templates) == 0 {
				fmt.Println("No templates found.")
				return
			}
			headers := []string{"NAME", "STATUS", "CHECKPOINT", "LAST USED", "CREATED"}
			var rows [][]string
			for _, tmpl := range templates {
				checkpointID := tmpl.CheckpointID
				if checkpointID == "" {
					checkpointID = "-"
				}
				rows = append(rows, []string{
					tmpl.Name,
					tmpl.Status,
					checkpointID,
					formatTemplateTime(tmpl.LastUsedAt),
					formatTemplateTime(tmpl.CreatedAt),
				})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var templateGetCmd = &cobra.Command{
	Use:   "get <name>",
	Short: "Get template details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		name := args[0]

		var tmpl TemplateInfo
		if err := c.Get(cmd.Context(), "/snapshots/"+url.PathEscape(name), &tmpl); err != nil {
			return err
		}

		printer.Print(tmpl, func() {
			fmt.Printf("Name:       %s\n", tmpl.Name)
			fmt.Printf("Status:     %s\n", tmpl.Status)
			fmt.Printf("ID:         %s\n", tmpl.ID)
			fmt.Printf("Checkpoint: %s\n", valueOrDash(tmpl.CheckpointID))
			fmt.Printf("Created:    %s\n", formatTemplateTime(tmpl.CreatedAt))
			fmt.Printf("Last used:  %s\n", formatTemplateTime(tmpl.LastUsedAt))
		})
		return nil
	},
}

var templateDeleteCmd = &cobra.Command{
	Use:   "delete <name>",
	Short: "Delete a template",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		name := args[0]
		if err := c.DeleteIgnoreNotFound(cmd.Context(), "/snapshots/"+url.PathEscape(name)); err != nil {
			return err
		}
		fmt.Printf("Template %s deleted.\n", name)
		return nil
	},
}

func formatTemplateTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Format(time.RFC3339)
}

func valueOrDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

func init() {
	templateCmd.AddCommand(templateListCmd)
	templateCmd.AddCommand(templateGetCmd)
	templateCmd.AddCommand(templateDeleteCmd)
}
