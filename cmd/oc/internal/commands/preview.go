package commands

import (
	"fmt"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// PreviewURL matches the API response for preview URLs.
type PreviewURL struct {
	ID             string         `json:"id"`
	SandboxID      string         `json:"sandboxId"`
	OrgID          string         `json:"orgId"`
	Hostname       string         `json:"hostname"`
	CustomHostname string         `json:"customHostname,omitempty"`
	Port           int            `json:"port"`
	CfHostnameID   string         `json:"cfHostnameId,omitempty"`
	SSLStatus      string         `json:"sslStatus"`
	AuthConfig     map[string]any `json:"authConfig,omitempty"`
	CreatedAt      time.Time      `json:"createdAt"`
}

var previewCmd = &cobra.Command{
	Use:   "preview",
	Short: "Manage sandbox preview URLs",
}

var previewCreateCmd = &cobra.Command{
	Use:   "create <sandbox-id>",
	Short: "Create a preview URL for a sandbox port",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		port, _ := cmd.Flags().GetInt("port")
		domain, _ := cmd.Flags().GetString("domain")

		req := map[string]any{
			"port":       port,
			"authConfig": map[string]any{},
		}
		if domain != "" {
			req["domain"] = domain
		}

		var preview PreviewURL
		if err := c.Post(cmd.Context(), fmt.Sprintf("/sandboxes/%s/preview", args[0]), req, &preview); err != nil {
			return err
		}

		printer.Print(preview, func() {
			fmt.Printf("Preview URL created:\n")
			fmt.Printf("  Hostname:   %s\n", preview.Hostname)
			fmt.Printf("  Port:       %d\n", preview.Port)
			fmt.Printf("  SSL:        %s\n", preview.SSLStatus)
			if preview.CustomHostname != "" {
				fmt.Printf("  Custom:     %s\n", preview.CustomHostname)
			}
		})
		return nil
	},
}

var previewListCmd = &cobra.Command{
	Use:   "list <sandbox-id>",
	Short: "List preview URLs for a sandbox",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		var previews []PreviewURL
		if err := c.Get(cmd.Context(), fmt.Sprintf("/sandboxes/%s/preview", args[0]), &previews); err != nil {
			return err
		}

		printer.Print(previews, func() {
			if len(previews) == 0 {
				fmt.Println("No preview URLs found.")
				return
			}
			headers := []string{"PORT", "HOSTNAME", "SSL", "CREATED"}
			var rows [][]string
			for _, p := range previews {
				hostname := p.Hostname
				if p.CustomHostname != "" {
					hostname = p.CustomHostname
				}
				rows = append(rows, []string{
					fmt.Sprintf("%d", p.Port),
					hostname,
					p.SSLStatus,
					p.CreatedAt.Format(time.RFC3339),
				})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var previewDeleteCmd = &cobra.Command{
	Use:   "delete <sandbox-id> <port>",
	Short: "Delete a preview URL",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		if err := c.DeleteIgnoreNotFound(cmd.Context(), fmt.Sprintf("/sandboxes/%s/preview/%s", args[0], args[1])); err != nil {
			return err
		}
		fmt.Printf("Preview URL for port %s deleted.\n", args[1])
		return nil
	},
}

func init() {
	previewCreateCmd.Flags().Int("port", 0, "Container port to expose (required)")
	previewCreateCmd.Flags().String("domain", "", "Custom domain")
	previewCreateCmd.MarkFlagRequired("port")

	previewCmd.AddCommand(previewCreateCmd)
	previewCmd.AddCommand(previewListCmd)
	previewCmd.AddCommand(previewDeleteCmd)
}
