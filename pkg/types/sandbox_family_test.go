package types

import (
	"strings"
	"testing"
)

func TestApplySandboxFamilyDefaultsAndValidateSpotMarksResumable(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: SandboxFamilySpot}

	if err := ApplySandboxFamilyDefaultsAndValidate(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.Resumable {
		t.Fatalf("expected internal spot family to mark sandbox resumable")
	}
}

func TestApplySandboxFamilyDefaultsAndValidateResumableFlagMapsToSpot(t *testing.T) {
	cfg := SandboxConfig{Resumable: true}

	if err := ApplySandboxFamilyDefaultsAndValidate(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.SandboxFamily != SandboxFamilySpot {
		t.Fatalf("expected resumable to map to internal spot family, got %q", cfg.SandboxFamily)
	}
	if cfg.CpuCount != 0 || cfg.MemoryMB != 0 {
		t.Fatalf("expected resumable not to force resources, got cpu=%d memory=%d", cfg.CpuCount, cfg.MemoryMB)
	}
}

func TestApplySandboxFamilyDefaultsAndValidateResumableFamilyAlias(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: "resumable"}

	if err := ApplySandboxFamilyDefaultsAndValidate(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.SandboxFamily != SandboxFamilySpot || !cfg.Resumable {
		t.Fatalf("expected resumable alias to map to internal spot family, got family=%q resumable=%v", cfg.SandboxFamily, cfg.Resumable)
	}
}

func TestApplySandboxFamilyDefaultsAndValidateResumableAllowsLargerTier(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: SandboxFamilySpot, CpuCount: 1, MemoryMB: 4096}

	if err := ApplySandboxFamilyDefaultsAndValidate(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidateResourceTier(&cfg); err != nil {
		t.Fatalf("expected larger resumable tier to validate normally: %v", err)
	}
}

func TestApplySandboxFamilyDefaultsAndValidateRejectsUnknownFamily(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: "gpu"}

	err := ApplySandboxFamilyDefaultsAndValidate(&cfg)
	if err == nil || !strings.Contains(err.Error(), "unsupported sandboxFamily") {
		t.Fatalf("expected unsupported family rejection, got %v", err)
	}
}
