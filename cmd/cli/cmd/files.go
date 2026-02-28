package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"text/tabwriter"
	"time"

	"github.com/opensandbox/opensandbox/pkg/client"
	"github.com/spf13/cobra"
)

var filesCmd = &cobra.Command{
	Use:   "files",
	Short: "Manage files in a sandbox",
	Long:  `Read, write, list, and delete files in a sandbox.`,
}

var catCmd = &cobra.Command{
	Use:   "cat <sandbox-id> <path>",
	Short: "Read a file from a sandbox",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		path := args[1]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		content, err := c.ReadFile(ctx, sandboxID, path)
		if err != nil {
			return fmt.Errorf("failed to read file: %w", err)
		}

		fmt.Print(content)
		return nil
	},
}

var writeCmd = &cobra.Command{
	Use:   "write <sandbox-id> <path> <content>",
	Short: "Write content to a file in a sandbox",
	Long: `Write content to a file. Use - to read from stdin.
Example: osb files write abc123 /workspace/test.txt "hello world"
         echo "hello" | osb files write abc123 /workspace/test.txt -`,
	Args: cobra.ExactArgs(3),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		path := args[1]
		content := args[2]

		// Read from stdin if content is "-"
		if content == "-" {
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("failed to read from stdin: %w", err)
			}
			content = string(data)
		}

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := c.WriteFile(ctx, sandboxID, path, content); err != nil {
			return fmt.Errorf("failed to write file: %w", err)
		}

		fmt.Printf("✓ File written: %s\n", path)
		return nil
	},
}

var lsCmd = &cobra.Command{
	Use:   "ls <sandbox-id> <path>",
	Short: "List files in a directory",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		path := args[1]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		files, err := c.ListDir(ctx, sandboxID, path)
		if err != nil {
			return fmt.Errorf("failed to list directory: %w", err)
		}

		if len(files) == 0 {
			fmt.Println("(empty directory)")
			return nil
		}

		longFormat, _ := cmd.Flags().GetBool("long")
		if longFormat {
			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			for _, f := range files {
				typ := "-"
				if f.IsDir {
					typ = "d"
				}

				fmt.Fprintf(w, "%s\t%d\t%s\n", typ, f.Size, f.Name)
			}
			w.Flush()
		} else {
			for _, f := range files {
				if f.IsDir {
					fmt.Printf("%s/\n", f.Name)
				} else {
					fmt.Println(f.Name)
				}
			}
		}

		return nil
	},
}

var mkdirCmd = &cobra.Command{
	Use:   "mkdir <sandbox-id> <path>",
	Short: "Create a directory in a sandbox",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		path := args[1]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := c.MakeDir(ctx, sandboxID, path); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}

		fmt.Printf("✓ Directory created: %s\n", path)
		return nil
	},
}

var rmCmd = &cobra.Command{
	Use:   "rm <sandbox-id> <path>",
	Short: "Remove a file or directory from a sandbox",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkAPIKey(); err != nil {
			return err
		}

		sandboxID := args[0]
		path := args[1]

		c := client.NewClient(baseURL, apiKey)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := c.RemoveFile(ctx, sandboxID, path); err != nil {
			return fmt.Errorf("failed to remove file: %w", err)
		}

		fmt.Printf("✓ Removed: %s\n", path)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(filesCmd)

	filesCmd.AddCommand(catCmd)
	filesCmd.AddCommand(writeCmd)
	filesCmd.AddCommand(lsCmd)
	filesCmd.AddCommand(mkdirCmd)
	filesCmd.AddCommand(rmCmd)

	lsCmd.Flags().BoolP("long", "l", false, "Use long listing format")
}
