package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds all configuration for the opensandbox server.
type Config struct {
	Port       int
	APIKey     string
	WorkerAddr string
	Mode       string // "server", "worker", "combined"
	LogLevel   string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	cfg := &Config{
		Port:       8080,
		APIKey:     os.Getenv("OPENSANDBOX_API_KEY"),
		WorkerAddr: envOrDefault("OPENSANDBOX_WORKER_ADDR", "localhost:9090"),
		Mode:       envOrDefault("OPENSANDBOX_MODE", "combined"),
		LogLevel:   envOrDefault("OPENSANDBOX_LOG_LEVEL", "info"),
	}

	if portStr := os.Getenv("OPENSANDBOX_PORT"); portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return nil, fmt.Errorf("invalid OPENSANDBOX_PORT %q: %w", portStr, err)
		}
		cfg.Port = port
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
