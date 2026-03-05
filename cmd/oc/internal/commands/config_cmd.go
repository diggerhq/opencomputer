package commands

import (
	"fmt"
	"strings"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/config"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage CLI configuration",
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a configuration value",
	Long: `Set a configuration value. Supported keys:
  api-key    Your OpenComputer API key
  api-url    API base URL`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.Load(nil)

		switch args[0] {
		case "api-key":
			cfg.APIKey = args[1]
		case "api-url":
			cfg.APIURL = args[1]
		default:
			return fmt.Errorf("unknown config key: %s (valid: api-key, api-url)", args[0])
		}

		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("saving config: %w", err)
		}

		fmt.Printf("Config %s updated.\n", args[0])
		return nil
	},
}

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show current configuration",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.Load(cmd)

		maskedKey := cfg.APIKey
		if len(maskedKey) > 8 {
			maskedKey = maskedKey[:4] + strings.Repeat("*", len(maskedKey)-8) + maskedKey[len(maskedKey)-4:]
		}

		fmt.Printf("API URL:     %s\n", cfg.APIURL)
		fmt.Printf("API Key:     %s\n", maskedKey)
		fmt.Printf("Config file: %s\n", config.ConfigPath())
		return nil
	},
}

func init() {
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configShowCmd)
}
