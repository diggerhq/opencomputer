package types

import (
	"strings"
	"testing"
)

func TestValidateResourceTier_InfersMissingAxis(t *testing.T) {
	cfg := SandboxConfig{MemoryMB: 8192}
	if err := ValidateResourceTier(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.CpuCount != 2 {
		t.Fatalf("cpuCount = %d, want 2", cfg.CpuCount)
	}

	cfg = SandboxConfig{CpuCount: 4}
	if err := ValidateResourceTier(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.MemoryMB != 16384 {
		t.Fatalf("memoryMB = %d, want 16384", cfg.MemoryMB)
	}
}

func TestValidateResourceTier_AcceptsEveryTier(t *testing.T) {
	for _, tier := range AllowedResourceTiers {
		cfg := SandboxConfig{MemoryMB: tier.MemoryMB, CpuCount: tier.VCPUs}
		if err := ValidateResourceTier(&cfg); err != nil {
			t.Errorf("tier %d/%d rejected: %v", tier.VCPUs, tier.MemoryMB, err)
		}
	}
}

func TestValidateResourceTier_MismatchListsOnlyRealTiers(t *testing.T) {
	cfg := SandboxConfig{MemoryMB: 8192, CpuCount: 1}
	err := ValidateResourceTier(&cfg)
	if err == nil {
		t.Fatal("expected an error for 1 vCPU / 8192 MB")
	}
	msg := err.Error()
	if !strings.Contains(msg, "1/1024, 1/4096, 2/8192, 4/16384") {
		t.Errorf("error should list the self-serve tiers, got %q", msg)
	}
	for _, stale := range []string{"32768", "65536"} {
		if strings.Contains(msg, stale) {
			t.Errorf("error advertises unavailable tier %s: %q", stale, msg)
		}
	}
}

func TestValidateResourceTier_EnterpriseSizeGetsContactUs(t *testing.T) {
	for _, cfg := range []SandboxConfig{
		{MemoryMB: 32768, CpuCount: 8},
		{MemoryMB: 65536, CpuCount: 16},
		{MemoryMB: 4096, CpuCount: 8},
	} {
		err := ValidateResourceTier(&cfg)
		if err == nil {
			t.Fatalf("expected an error for %d vCPU / %d MB", cfg.CpuCount, cfg.MemoryMB)
		}
		if !strings.Contains(err.Error(), "Contact us for enterprise sizing") {
			t.Errorf("%d/%d: want contact-us error, got %q", cfg.CpuCount, cfg.MemoryMB, err)
		}
	}
}

func TestValidateCPUCount_MessageDerivesFromTiers(t *testing.T) {
	_, err := ValidateCPUCount(3)
	if err == nil || !strings.Contains(err.Error(), "1, 2, 4") {
		t.Fatalf("want list of self-serve vCPU counts, got %v", err)
	}
	_, err = ValidateCPUCount(5)
	if err == nil || !strings.Contains(err.Error(), "(4 vCPU)") {
		t.Fatalf("want ceiling from the tier table, got %v", err)
	}
}
