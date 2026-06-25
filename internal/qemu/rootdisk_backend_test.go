package qemu

import (
	"context"
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

func TestCloudDiskProviderPrepareCreatesMountsAndReturnsDevice(t *testing.T) {
	var commands []string
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
	provider.run = func(_ context.Context, cmd cloudDiskCommand) ([]byte, error) {
		commands = append(commands, cmd.String())
		if len(cmd.args) >= 4 && cmd.args[0] == "config" {
			return []byte("nbd-device = /dev/nbd7\n"), nil
		}
		return []byte("ok"), nil
	}

	disks, err := provider.PrepareSandboxDisks(t.Context(), PrepareSandboxDisksRequest{
		SandboxID: "sb-123",
		DiskMB:    1024,
	})
	if err != nil {
		t.Fatalf("PrepareSandboxDisks: %v", err)
	}
	if disks.RootfsPath != "/dev/nbd7" {
		t.Fatalf("rootfs path = %q, want /dev/nbd7", disks.RootfsPath)
	}
	if disks.WorkspacePath != "" {
		t.Fatalf("workspace path = %q, want empty single-disk mode", disks.WorkspacePath)
	}
	if len(commands) != 3 {
		t.Fatalf("commands = %#v, want create, mount, config show", commands)
	}
	for _, want := range []string{
		"cloud-disk create oc-root-sb-123",
		"cloud-disk mount oc-root-sb-123",
		"cloud-disk config oc-root-sb-123 show -all",
	} {
		found := false
		for _, cmd := range commands {
			if strings.Contains(cmd, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("commands %#v missing %q", commands, want)
		}
	}
}

func TestParseCloudDiskNBDDevice(t *testing.T) {
	for _, output := range []string{
		"nbd-device=/dev/nbd3\n",
		"nbd-device: /dev/nbd4\n",
		`"nbd-device": "/dev/nbd5"`,
	} {
		if got := parseCloudDiskNBDDevice(output); !strings.HasPrefix(got, "/dev/nbd") {
			t.Fatalf("parseCloudDiskNBDDevice(%q) = %q", output, got)
		}
	}
}

func TestQEMUDriveFormatAndSingleDiskArgs(t *testing.T) {
	if got := qemuDriveFormat("/dev/nbd7"); got != "raw" {
		t.Fatalf("qemuDriveFormat(/dev/nbd7) = %q, want raw", got)
	}
	if got := qemuDriveFormat("/tmp/rootfs.qcow2"); got != "qcow2" {
		t.Fatalf("qemuDriveFormat(qcow2) = %q, want qcow2", got)
	}

	m := &Manager{cfg: Config{KernelPath: "/kernel"}}
	args := m.buildQEMUArgs(1, 256, "/dev/nbd7", "", "tap0", "02:00:00:00:00:01", "/tmp/agent.sock", "/tmp/qmp.sock", "root=/dev/vda")
	driveCount := 0
	for _, arg := range args {
		if strings.HasPrefix(arg, "file=") {
			driveCount++
			if !strings.Contains(arg, "format=raw") {
				t.Fatalf("drive arg = %q, want raw", arg)
			}
		}
	}
	if driveCount != 1 {
		t.Fatalf("drive count = %d, want 1", driveCount)
	}
}
