package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	baseURL string
	apiKey  string
)

var rootCmd = &cobra.Command{
	Use:   "osb",
	Short: "OpenSandbox CLI - Manage sandboxes from the command line",
	Long: `OpenSandbox CLI (osb) is a command-line tool for managing OpenSandbox environments.

It provides commands to create, manage, and interact with sandboxes, execute commands,
manage files, and control sandbox lifecycle (hibernate/wake).`,
}

// Execute runs the root command.
func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.PersistentFlags().StringVar(&baseURL, "url", getEnvOrDefault("OPENCOMPUTER_API_URL", "http://localhost:8080"), "OpenSandbox API base URL")
	rootCmd.PersistentFlags().StringVar(&apiKey, "api-key", os.Getenv("OPENCOMPUTER_API_KEY"), "OpenSandbox API key")
}

func getEnvOrDefault(key, defaultValue string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultValue
}

func checkAPIKey() error {
	if apiKey == "" {
		return fmt.Errorf("API key is required. Set OPENCOMPUTER_API_KEY environment variable or use --api-key flag")
	}
	return nil
}
