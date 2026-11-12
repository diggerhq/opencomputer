package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseFlags(t *testing.T) {
	cfg, mode, err := parseFlags(nil)
	if err != nil || mode != modeServe || cfg.identity != "cgroup" || cfg.maxInflightPerCaller != 32 {
		t.Fatalf("defaults: %+v %v %v", cfg, mode, err)
	}
	if _, mode, err := parseFlags([]string{"-version"}); err != nil || mode != modeVersion {
		t.Fatalf("-version: %v %v", mode, err)
	}
	cfg, mode, err = parseFlags([]string{"-check", "-profiles", "profiles"})
	if err != nil || mode != modeCheck {
		t.Fatalf("-check: %v %v", mode, err)
	}
	if err := checkProfiles(cfg); err != nil {
		t.Fatalf("the shipped profiles: %v", err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.json"), []byte(`{"p":{"upstream":"http://a.example"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.profilesDir = dir
	if err := checkProfiles(cfg); err == nil {
		t.Fatal("a bad profile passed -check")
	}
}
