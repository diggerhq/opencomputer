package qemu

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClassifyGuestBoot(t *testing.T) {
	readyLine := "init: cgroup sandbox ready (pids=4096, mem=846261043, cpu=80000/100000)\n"

	cases := []struct {
		name       string
		log        string
		wantBooted bool
		wantSig    bool // whether an explicit failure signature is expected
	}{
		{
			name:       "healthy boot → booted, no failure",
			log:        "Run /sbin/init as init process\ninit: workspace mounted\n" + readyLine,
			wantBooted: true,
			wantSig:    false,
		},
		{
			// Regression guard: a guest that BOOTED but logged a survivable
			// kernel message must NOT be flagged — else we'd suppress the
			// legitimate agent-flake retry.
			name:       "booted despite an earlier survived EXT4-fs error → not flagged",
			log:        "EXT4-fs error (device vda): ext4_lookup: deleted inode referenced\n[recovered]\n" + readyLine,
			wantBooted: true,
			wantSig:    false,
		},
		{
			name:       "rootfs mount failure, never booted → explicit signature",
			log:        "VFS: Cannot open root device or unknown-block\nunable to read superblock\n",
			wantBooted: false,
			wantSig:    true,
		},
		{
			name:       "init-exec kernel panic, never booted → explicit signature",
			log:        "Run /sbin/init as init process\nKernel panic - not syncing: Attempted to kill init!\n",
			wantBooted: false,
			wantSig:    true,
		},
		{
			// Ambiguous: didn't reach the marker but no panic (e.g. a slow cold
			// boot). Must stay retriable (sig empty) — no misleading fail-fast.
			name:       "slow boot, no marker, no panic → ambiguous, retriable",
			log:        "Booting the kernel\nEXT4-fs (vda): mounted filesystem\nRun /sbin/init as init process\n",
			wantBooted: false,
			wantSig:    false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "qemu.log"), []byte(tc.log), 0o644); err != nil {
				t.Fatal(err)
			}
			booted, sig, tail := classifyGuestBoot(dir)
			if booted != tc.wantBooted {
				t.Fatalf("booted=%v want %v (sig=%q)", booted, tc.wantBooted, sig)
			}
			if (sig != "") != tc.wantSig {
				t.Fatalf("sig=%q, wanted signature present=%v", sig, tc.wantSig)
			}
			if tail == "" {
				t.Fatalf("expected a non-empty serial tail")
			}
		})
	}

	// Missing log: no failure, no panic (nothing to diagnose).
	if booted, sig, _ := classifyGuestBoot(t.TempDir()); booted || sig != "" {
		t.Fatalf("expected booted=false, sig=empty for absent qemu.log; got booted=%v sig=%q", booted, sig)
	}
}
