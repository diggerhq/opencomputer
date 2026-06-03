package types

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestApplySandboxFamilyDefaultsAndValidateSpotDefaultsToSmallestTier(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: SandboxFamilySpot}

	if err := ApplySandboxFamilyDefaultsAndValidate(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.CpuCount != 1 || cfg.MemoryMB != 1024 {
		t.Fatalf("expected spot defaults 1 cpu / 1024MB, got cpu=%d memory=%d", cfg.CpuCount, cfg.MemoryMB)
	}
	if err := ValidateResourceTier(&cfg); err != nil {
		t.Fatalf("spot defaults should be a valid tier: %v", err)
	}
}

func TestApplySandboxFamilyDefaultsAndValidateSpotRejectsLargerTier(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: SandboxFamilySpot, CpuCount: 1, MemoryMB: 4096}

	err := ApplySandboxFamilyDefaultsAndValidate(&cfg)
	if err == nil || !strings.Contains(err.Error(), "limited to 1 vCPU and 1024 MB") {
		t.Fatalf("expected spot size rejection, got %v", err)
	}
}

func TestApplySandboxFamilyDefaultsAndValidateSpotRejectsSnapshotAndImage(t *testing.T) {
	for name, cfg := range map[string]SandboxConfig{
		"snapshot": {SandboxFamily: SandboxFamilySpot, Snapshot: "snap"},
		"image":    {SandboxFamily: SandboxFamilySpot, ImageManifest: json.RawMessage(`{"steps":[]}`)},
	} {
		t.Run(name, func(t *testing.T) {
			err := ApplySandboxFamilyDefaultsAndValidate(&cfg)
			if err == nil || !strings.Contains(err.Error(), "does not support image or snapshot") {
				t.Fatalf("expected image/snapshot rejection, got %v", err)
			}
		})
	}
}

func TestApplySandboxFamilyDefaultsAndValidateRejectsUnknownFamily(t *testing.T) {
	cfg := SandboxConfig{SandboxFamily: "gpu"}

	err := ApplySandboxFamilyDefaultsAndValidate(&cfg)
	if err == nil || !strings.Contains(err.Error(), "unsupported sandboxFamily") {
		t.Fatalf("expected unsupported family rejection, got %v", err)
	}
}
