package commands

import (
	"fmt"
	"io"
	"os"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// PatchInfo matches the API response for checkpoint patches.
type PatchInfo struct {
	ID           string    `json:"id"`
	CheckpointID string    `json:"checkpointId"`
	Sequence     int       `json:"sequence"`
	Script       string    `json:"script"`
	Description  string    `json:"description"`
	Strategy     string    `json:"strategy"`
	CreatedAt    time.Time `json:"createdAt"`
}

// PatchResult wraps the create response.
type PatchResult struct {
	Patch PatchInfo `json:"patch"`
}

var patchCmd = &cobra.Command{
	Use:   "patch",
	Short: "Manage checkpoint patches",
}

var patchCreateCmd = &cobra.Command{
	Use:   "create <checkpoint-id>",
	Short: "Create a patch for a checkpoint",
	Long: `Create a patch script that will be applied when sandboxes are spawned from this checkpoint.

Examples:
  oc patch create <cp-id> --script=./setup.sh --description="Install deps"
  echo "apt install -y curl" | oc patch create <cp-id> --script=-`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		scriptPath, _ := cmd.Flags().GetString("script")
		description, _ := cmd.Flags().GetString("description")

		var script string
		if scriptPath == "-" {
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("reading stdin: %w", err)
			}
			script = string(data)
		} else {
			data, err := os.ReadFile(scriptPath)
			if err != nil {
				return fmt.Errorf("reading script file: %w", err)
			}
			script = string(data)
		}

		req := map[string]string{
			"script":      script,
			"description": description,
		}
		var result PatchResult
		if err := c.Post(cmd.Context(), fmt.Sprintf("/sandboxes/checkpoints/%s/patches", args[0]), req, &result); err != nil {
			return err
		}

		printer.Print(result, func() {
			fmt.Printf("Patch created: %s (sequence: %d)\n", result.Patch.ID, result.Patch.Sequence)
		})
		return nil
	},
}

var patchListCmd = &cobra.Command{
	Use:   "list <checkpoint-id>",
	Short: "List patches for a checkpoint",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		var patches []PatchInfo
		if err := c.Get(cmd.Context(), fmt.Sprintf("/sandboxes/checkpoints/%s/patches", args[0]), &patches); err != nil {
			return err
		}

		printer.Print(patches, func() {
			if len(patches) == 0 {
				fmt.Println("No patches found.")
				return
			}
			headers := []string{"ID", "SEQ", "DESCRIPTION", "STRATEGY", "CREATED"}
			var rows [][]string
			for _, p := range patches {
				rows = append(rows, []string{
					p.ID,
					fmt.Sprintf("%d", p.Sequence),
					p.Description,
					p.Strategy,
					p.CreatedAt.Format(time.RFC3339),
				})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var patchDeleteCmd = &cobra.Command{
	Use:   "delete <checkpoint-id> <patch-id>",
	Short: "Delete a patch",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		if err := c.DeleteIgnoreNotFound(cmd.Context(), fmt.Sprintf("/sandboxes/checkpoints/%s/patches/%s", args[0], args[1])); err != nil {
			return err
		}
		fmt.Printf("Patch %s deleted.\n", args[1])
		return nil
	},
}

func init() {
	patchCreateCmd.Flags().String("script", "", "Path to script file, or '-' for stdin (required)")
	patchCreateCmd.Flags().String("description", "", "Description of the patch")
	patchCreateCmd.MarkFlagRequired("script")

	patchCmd.AddCommand(patchCreateCmd)
	patchCmd.AddCommand(patchListCmd)
	patchCmd.AddCommand(patchDeleteCmd)
}
