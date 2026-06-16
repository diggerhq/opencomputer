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
	Path          string            `json:"path"`
	Driver        string            `json:"driver"`
	ReadOnly      bool              `json:"readOnly"`
	Remote        string            `json:"remote,omitempty"`
	Backend       string            `json:"backend,omitempty"`
	RcloneVersion string            `json:"rcloneVersion,omitempty"`
	Command       []string          `json:"command,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
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
		command, _ := cmd.Flags().GetStringArray("command")
		envFlag, _ := cmd.Flags().GetStringArray("env")
		secretFlag, _ := cmd.Flags().GetStringArray("secret")

		body := map[string]any{
			"path":     path,
			"readOnly": !readWrite,
		}

		if len(command) > 0 {
			// command driver — bring your own FUSE daemon / mount command.
			body["driver"] = "command"
			body["command"] = command
			env, err := parseKV(envFlag, "--env")
			if err != nil {
				return err
			}
			if len(env) > 0 {
				body["env"] = env
			}
			secrets, err := parseKV(secretFlag, "--secret")
			if err != nil {
				return err
			}
			if len(secrets) > 0 {
				body["secrets"] = secrets
			}
		} else {
			// rclone driver (default).
			if remote == "" {
				return fmt.Errorf("--remote is required (or pass --command to run your own FUSE daemon)")
			}
			body["remote"] = remote
			creds, err := parseKV(credsFlag, "--cred")
			if err != nil {
				return err
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
			src := info.Remote
			if info.Driver == "command" {
				src = strings.Join(info.Command, " ")
			}
			fmt.Printf("Mounted %s → %s (%s)\n", src, info.Path, ro)
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
			headers := []string{"PATH", "DRIVER", "SOURCE", "MODE"}
			var rows [][]string
			for _, m := range mounts {
				mode := "rw"
				if m.ReadOnly {
					mode = "ro"
				}
				driver := m.Driver
				if driver == "" {
					driver = "rclone"
				}
				source := m.Remote
				if m.Driver == "command" {
					source = strings.Join(m.Command, " ")
				}
				rows = append(rows, []string{m.Path, driver, source, mode})
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

// parseKV turns repeated "key=value" flag values into a map.
func parseKV(pairs []string, flag string) (map[string]string, error) {
	out := map[string]string{}
	for _, kv := range pairs {
		i := strings.Index(kv, "=")
		if i <= 0 {
			return nil, fmt.Errorf("%s must be key=value (got %q)", flag, kv)
		}
		out[kv[:i]] = kv[i+1:]
	}
	return out, nil
}

func init() {
	mountsAddCmd.Flags().String("path", "", "Absolute path inside the sandbox to mount at (required)")
	// rclone driver (default)
	mountsAddCmd.Flags().String("remote", "", "rclone remote spec, e.g. s3:my-bucket (rclone driver)")
	mountsAddCmd.Flags().String("backend", "", "Backend type: s3, gcs, azureblob, sftp, webdav, dropbox")
	mountsAddCmd.Flags().StringArray("cred", nil, "Backend credential as key=value (repeatable; e.g. --cred access_key_id=AKIA...)")
	mountsAddCmd.Flags().String("config-file", "", "Path to a raw rclone config file (overrides --backend/--cred)")
	mountsAddCmd.Flags().StringArray("opt", nil, "Extra args appended to `rclone mount` (repeatable)")
	// command driver (bring your own FUSE)
	mountsAddCmd.Flags().StringArray("command", nil, "FUSE daemon/mount argv (repeatable; switches to the command driver). {mountpoint} is replaced with --path")
	mountsAddCmd.Flags().StringArray("env", nil, "Env var for the command as key=value (repeatable)")
	mountsAddCmd.Flags().StringArray("secret", nil, "Secret env var as key=value (repeatable; injected into the daemon env, never recorded)")
	mountsAddCmd.Flags().Bool("read-write", false, "Mount read-write (default is read-only)")
	_ = mountsAddCmd.MarkFlagRequired("path")

	mountsCmd.AddCommand(mountsAddCmd)
	mountsCmd.AddCommand(mountsListCmd)
	mountsCmd.AddCommand(mountsRemoveCmd)
}
