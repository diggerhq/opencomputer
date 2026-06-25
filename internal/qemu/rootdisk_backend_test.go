package qemu

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRootDiskConfigDefaultIsLocal(t *testing.T) {
	got, err := (RootDiskConfig{}).validate()
	if err != nil {
		t.Fatalf("validate default root disk config: %v", err)
	}
	if got.Backend != RootDiskBackendLocal {
		t.Fatalf("backend = %q, want %q", got.Backend, RootDiskBackendLocal)
	}
	if got.CloudDisk.CLIPath != "cloud-disk" {
		t.Fatalf("cloud disk CLI path = %q, want cloud-disk", got.CloudDisk.CLIPath)
	}
}

func TestRootDiskConfigRejectsUnknownBackend(t *testing.T) {
	_, err := (RootDiskConfig{Backend: "bogus"}).validate()
	if err == nil || !strings.Contains(err.Error(), "unsupported root disk backend") {
		t.Fatalf("validate unknown backend error = %v, want unsupported backend", err)
	}
}

func TestRootDiskConfigCloudDiskValidates(t *testing.T) {
	got, err := (RootDiskConfig{
		Backend: RootDiskBackendCloudDisk,
		CloudDisk: CloudDiskConfig{
			CachePath:         "/var/lib/cloud-disk",
			DefaultSizeMB:     20480,
			GoldenDisk:        "oc-golden-root",
			GoldenSnapshot:    "1782353013352357154",
			S3Endpoint:        "https://t3.storage.dev",
			S3AccessKeyID:     "access",
			S3SecretAccessKey: "secret",
		},
	}).validate()
	if err != nil {
		t.Fatalf("validate cloud-disk backend: %v", err)
	}
	if got.Backend != RootDiskBackendCloudDisk {
		t.Fatalf("backend = %q, want cloud-disk", got.Backend)
	}
}

func TestLocalRootDiskProviderMaterializeCheckpointDisks(t *testing.T) {
	tmp := t.TempDir()
	cacheDir := filepath.Join(tmp, "cache")
	sandboxDir := filepath.Join(tmp, "sandbox")
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sandboxDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "rootfs.qcow2"), []byte("root"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "workspace.qcow2"), []byte("workspace"), 0644); err != nil {
		t.Fatal(err)
	}

	provider := localRootDiskProvider{copyFile: testCopyFile}
	disks, err := provider.MaterializeCheckpointDisks(t.Context(), MaterializeCheckpointDisksRequest{
		CheckpointID: "cp-test",
		CacheDir:     cacheDir,
		SandboxID:    "sb-test",
		SandboxDir:   sandboxDir,
	})
	if err != nil {
		t.Fatalf("materialize checkpoint disks: %v", err)
	}
	if disks.RootfsPath != filepath.Join(sandboxDir, "rootfs.qcow2") {
		t.Fatalf("rootfs path = %q", disks.RootfsPath)
	}
	if got, err := os.ReadFile(disks.WorkspacePath); err != nil || string(got) != "workspace" {
		t.Fatalf("workspace contents = %q, %v; want workspace", got, err)
	}
}

func TestLocalRootDiskProviderMaterializeCheckpointDisksReplace(t *testing.T) {
	tmp := t.TempDir()
	cacheDir := filepath.Join(tmp, "cache")
	sandboxDir := filepath.Join(tmp, "sandbox")
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sandboxDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "rootfs.qcow2"), []byte("new-root"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "workspace.qcow2"), []byte("new-workspace"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxDir, "rootfs.qcow2"), []byte("old-root"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxDir, "workspace.qcow2"), []byte("old-workspace"), 0644); err != nil {
		t.Fatal(err)
	}

	provider := localRootDiskProvider{copyFile: testCopyFile}
	disks, err := provider.MaterializeCheckpointDisks(t.Context(), MaterializeCheckpointDisksRequest{
		CheckpointID: "cp-test",
		CacheDir:     cacheDir,
		SandboxID:    "sb-test",
		SandboxDir:   sandboxDir,
		Replace:      true,
	})
	if err != nil {
		t.Fatalf("materialize replacement checkpoint disks: %v", err)
	}
	if got, err := os.ReadFile(disks.RootfsPath); err != nil || string(got) != "new-root" {
		t.Fatalf("rootfs contents = %q, %v; want new-root", got, err)
	}
}

func testCopyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}

func TestCloudDiskNameSanitizesAndTruncates(t *testing.T) {
	got := cloudDiskName("OC Root", "SB_ABC/123", strings.Repeat("x", 80))
	if strings.ContainsAny(got, "_/ ") {
		t.Fatalf("name = %q, contains unsanitized characters", got)
	}
	if len(got) > 63 {
		t.Fatalf("name length = %d, want <= 63", len(got))
	}
	if !strings.HasPrefix(got, "oc-root-sb-abc-123") {
		t.Fatalf("name = %q, want oc-root-sb-abc-123 prefix", got)
	}
}

func TestCloudDiskProviderCommandShapes(t *testing.T) {
	provider := cloudDiskRootDiskProvider{cfg: CloudDiskConfig{
		CLIPath:           "/usr/local/bin/cloud-disk",
		CachePath:         "/var/lib/cloud-disk",
		DefaultSizeMB:     20480,
		GoldenDisk:        "oc-golden-root",
		GoldenSnapshot:    "snap-1",
		S3Endpoint:        "https://t3.storage.dev",
		S3Region:          "auto",
		S3AccessKeyID:     "access",
		S3SecretAccessKey: "secret",
	}}

	create := provider.createForkCommand("oc-root-sb-123", "oc-golden-root", "snap-1", 2050)
	got := create.String()
	for _, want := range []string{
		"/usr/local/bin/cloud-disk create oc-root-sb-123",
		"-size 3G",
		"-no-mount",
		"-parent oc-golden-root",
		"-snapshot snap-1",
		"--set no-fs=true",
		"--set block-size=512",
		"--set disk-cache-path=/var/lib/cloud-disk",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("command %q missing %q", got, want)
		}
	}
	if len(create.env) != 4 {
		t.Fatalf("env length = %d, want 4", len(create.env))
	}
}

func TestCloudDiskProviderPrepareFailsBeforeExecuting(t *testing.T) {
	provider := cloudDiskRootDiskProvider{cfg: CloudDiskConfig{
		CLIPath:           "cloud-disk",
		CachePath:         "/var/lib/cloud-disk",
		DefaultSizeMB:     20480,
		GoldenDisk:        "oc-golden-root",
		GoldenSnapshot:    "snap-1",
		S3Endpoint:        "https://t3.storage.dev",
		S3Region:          "auto",
		S3AccessKeyID:     "access",
		S3SecretAccessKey: "secret",
	}}
	_, err := provider.PrepareSandboxDisks(t.Context(), PrepareSandboxDisksRequest{
		SandboxID: "sb-123",
		DiskMB:    1024,
	})
	if err == nil || !strings.Contains(err.Error(), "not implemented yet") {
		t.Fatalf("PrepareSandboxDisks error = %v, want not implemented", err)
	}
	if !strings.Contains(err.Error(), "cloud-disk create oc-root-sb-123") {
		t.Fatalf("PrepareSandboxDisks error = %v, want planned create command", err)
	}
}
