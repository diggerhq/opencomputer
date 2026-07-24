package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

const (
	DefaultAPIURL         = "https://app.opencomputer.dev"
	DefaultSessionsAPIURL = "https://api.opencomputer.dev"
	configDir             = ".oc"
	configFile            = "config.json"
)

type LoginMetadata struct {
	CredentialID string `json:"credential_id"`
	KeyPrefix    string `json:"key_prefix"`
	Name         string `json:"name"`
	APIURL       string `json:"api_url"`
}

// Config holds the resolved CLI configuration.
type Config struct {
	APIURL         string         `json:"api_url,omitempty"`
	APIKey         string         `json:"api_key,omitempty"`
	SessionsAPIURL string         `json:"sessions_api_url,omitempty"`
	Login          *LoginMetadata `json:"login,omitempty"`
}

type CredentialSource string

const (
	CredentialSourceNone        CredentialSource = ""
	CredentialSourceFile        CredentialSource = "config file"
	CredentialSourceEnvironment CredentialSource = "OPENCOMPUTER_API_KEY"
	CredentialSourceFlag        CredentialSource = "--api-key"
)

// Load resolves configuration from flags > env > config file > defaults.
func Load(cmd *cobra.Command) Config {
	cfg := LoadFile()

	// Apply defaults
	if cfg.APIURL == "" {
		cfg.APIURL = DefaultAPIURL
	}

	// Env overrides file
	if v := os.Getenv("OPENCOMPUTER_API_URL"); v != "" {
		cfg.APIURL = v
	}
	if v := os.Getenv("OPENCOMPUTER_API_KEY"); v != "" {
		cfg.APIKey = v
	}
	if cfg.SessionsAPIURL == "" {
		cfg.SessionsAPIURL = DefaultSessionsAPIURL
	}
	if v := os.Getenv("SESSIONS_API_URL"); v != "" {
		cfg.SessionsAPIURL = v
	}

	// Flags override env
	if cmd != nil {
		if v, _ := cmd.Flags().GetString("api-url"); v != "" {
			cfg.APIURL = v
		}
		if v, _ := cmd.Flags().GetString("api-key"); v != "" {
			cfg.APIKey = v
		}
		if v, _ := cmd.Flags().GetString("sessions-api-url"); v != "" {
			cfg.SessionsAPIURL = v
		}
	}

	return cfg
}

// EffectiveCredentialSource reports which layer currently controls API-key
// authentication. Login uses it to avoid claiming it replaced an env/flag
// override when the saved file would remain ineffective.
func EffectiveCredentialSource(cmd *cobra.Command) CredentialSource {
	if cmd != nil {
		if v, _ := cmd.Flags().GetString("api-key"); v != "" {
			return CredentialSourceFlag
		}
	}
	if os.Getenv("OPENCOMPUTER_API_KEY") != "" {
		return CredentialSourceEnvironment
	}
	if LoadFile().APIKey != "" {
		return CredentialSourceFile
	}
	return CredentialSourceNone
}

// ConfigPath returns the path to the config file.
func ConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, configDir, configFile)
}

// LoadFile reads only the persisted configuration, without defaults, env, or
// flag overrides.
func LoadFile() Config {
	var cfg Config
	data, err := os.ReadFile(ConfigPath())
	if err != nil {
		return cfg
	}
	json.Unmarshal(data, &cfg)
	return cfg
}

// Save atomically replaces the config with mode 0600 in a mode-0700 directory.
func Save(cfg Config) error {
	dir := filepath.Dir(ConfigPath())
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, ConfigPath()); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}
