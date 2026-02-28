package config

import (
	"os"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	// Clear env to test defaults
	os.Unsetenv("OPENCOMPUTER_PORT")
	os.Unsetenv("OPENCOMPUTER_API_KEY")
	os.Unsetenv("OPENCOMPUTER_WORKER_ADDR")
	os.Unsetenv("OPENCOMPUTER_MODE")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if cfg.Port != 8080 {
		t.Errorf("expected port 8080, got %d", cfg.Port)
	}
	if cfg.Mode != "combined" {
		t.Errorf("expected mode combined, got %s", cfg.Mode)
	}
	if cfg.WorkerAddr != "localhost:9090" {
		t.Errorf("expected worker addr localhost:9090, got %s", cfg.WorkerAddr)
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("OPENCOMPUTER_PORT", "9999")
	os.Setenv("OPENCOMPUTER_API_KEY", "test-key")
	os.Setenv("OPENCOMPUTER_MODE", "server")
	defer func() {
		os.Unsetenv("OPENCOMPUTER_PORT")
		os.Unsetenv("OPENCOMPUTER_API_KEY")
		os.Unsetenv("OPENCOMPUTER_MODE")
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if cfg.Port != 9999 {
		t.Errorf("expected port 9999, got %d", cfg.Port)
	}
	if cfg.APIKey != "test-key" {
		t.Errorf("expected API key test-key, got %s", cfg.APIKey)
	}
	if cfg.Mode != "server" {
		t.Errorf("expected mode server, got %s", cfg.Mode)
	}
}

func TestLoadInvalidPort(t *testing.T) {
	os.Setenv("OPENCOMPUTER_PORT", "not-a-number")
	defer os.Unsetenv("OPENCOMPUTER_PORT")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid port, got nil")
	}
}
