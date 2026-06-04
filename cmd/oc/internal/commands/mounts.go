package commands

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

// MountInfo mirrors internal/mounts.MountRecord — copied here to avoid an
// internal-package import from the CLI binary.
type MountInfo struct {
	Path          string `json:"path"`
	Remote        string `json:"remote"`
	Backend       string `json:"backend,omitempty"`
	ReadOnly      bool   `json:"readOnly"`
	RcloneVersion string `json:"rcloneVersion,omitempty"`
}

var mountsCmd = &cobra.Command{
	Use:     "mounts",
	Aliases: []string{"mount"},
	Short:   "Manage FUSE-backed remote filesystem mounts inside a sandbox",
	Long: `Mount remote filesystems (S3, GCS, Azure Blob, SFTP, WebDAV, Dropbox)
inside a running sandbox via rclone+FUSE. Credentials are passed inline and
never persisted on the worker. Mounts are torn down on hibernate; v1 does NOT
auto-restore on wake — re-run "oc mounts add" after waking the sandbox.`,
}

var mountsAddCmd = &cobra.Command{
	Use:   "add <sandbox-id>",
	Short: "Add a mount",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		path, _ := cmd.Flags().GetString("path")
		remote, _ := cmd.Flags().GetString("remote")
		backend, _ := cmd.Flags().GetString("backend")
		credsFlag, _ := cmd.Flags().GetStringArray("cred")
		configFile, _ := cmd.Flags().GetString("config-file")
		readWrite, _ := cmd.Flags().GetBool("read-write")
		extraOpts, _ := cmd.Flags().GetStringArray("opt")

		creds := map[string]string{}
		for _, kv := range credsFlag {
			i := strings.Index(kv, "=")
			if i <= 0 {
				return fmt.Errorf("--cred must be key=value (got %q)", kv)
			}
			creds[kv[:i]] = kv[i+1:]
		}

		body := map[string]any{
			"path":     path,
			"remote":   remote,
			"readOnly": !readWrite,
		}
		if backend != "" {
			body["backend"] = backend
		}
		if len(creds) > 0 {
			body["creds"] = creds
		}
		if configFile != "" {
			raw, err := os.ReadFile(configFile)
			if err != nil {
				return fmt.Errorf("read --config-file: %w", err)
			}
			body["rcloneConfig"] = string(raw)
		}
		if len(extraOpts) > 0 {
			body["mountOptions"] = extraOpts
		}

		var info MountInfo
		if err := c.Post(cmd.Context(), fmt.Sprintf("/sandboxes/%s/mounts", args[0]), body, &info); err != nil {
			return err
		}

		printer.Print(info, func() {
			ro := "rw"
			if info.ReadOnly {
				ro = "ro"
			}
			fmt.Printf("Mounted %s → %s (%s)\n", info.Remote, info.Path, ro)
		})
		return nil
	},
}

var mountsListCmd = &cobra.Command{
	Use:   "list <sandbox-id>",
	Short: "List mounts for a sandbox",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		var mounts []MountInfo
		if err := c.Get(cmd.Context(), fmt.Sprintf("/sandboxes/%s/mounts", args[0]), &mounts); err != nil {
			return err
		}

		printer.Print(mounts, func() {
			if len(mounts) == 0 {
				fmt.Println("No mounts.")
				return
			}
			headers := []string{"PATH", "REMOTE", "BACKEND", "MODE", "RCLONE"}
			var rows [][]string
			for _, m := range mounts {
				mode := "rw"
				if m.ReadOnly {
					mode = "ro"
				}
				rows = append(rows, []string{m.Path, m.Remote, m.Backend, mode, m.RcloneVersion})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var mountsRemoveCmd = &cobra.Command{
	Use:     "rm <sandbox-id> <path>",
	Aliases: []string{"remove"},
	Short:   "Unmount a path in a sandbox",
	Args:    cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		target := args[1]
		ep := fmt.Sprintf("/sandboxes/%s/mounts?path=%s", args[0], url.QueryEscape(target))
		if err := c.DeleteIgnoreNotFound(cmd.Context(), ep); err != nil {
			return err
		}
		fmt.Printf("Unmounted %s.\n", target)
		return nil
	},
}

func init() {
	mountsAddCmd.Flags().String("path", "", "Absolute path inside the sandbox to mount at (required)")
	mountsAddCmd.Flags().String("remote", "", "rclone remote spec, e.g. s3:my-bucket (required)")
	mountsAddCmd.Flags().String("backend", "", "Backend type: s3, gcs, azureblob, sftp, webdav, dropbox")
	mountsAddCmd.Flags().StringArray("cred", nil, "Backend credential as key=value (repeatable; e.g. --cred access_key_id=AKIA...)")
	mountsAddCmd.Flags().String("config-file", "", "Path to a raw rclone config file (overrides --backend/--cred)")
	mountsAddCmd.Flags().Bool("read-write", false, "Mount read-write (default is read-only)")
	mountsAddCmd.Flags().StringArray("opt", nil, "Extra args appended to `rclone mount` (repeatable)")
	_ = mountsAddCmd.MarkFlagRequired("path")
	_ = mountsAddCmd.MarkFlagRequired("remote")

	mountsCmd.AddCommand(mountsAddCmd)
	mountsCmd.AddCommand(mountsListCmd)
	mountsCmd.AddCommand(mountsRemoveCmd)
}
