package qemu

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	RootDiskBackendLocal     = "local"
	RootDiskBackendCloudDisk = "cloud-disk"
)

// RootDiskConfig selects how QEMU root/workspace disks are provisioned.
//
// The local backend is the existing rootfs.qcow2 + workspace.qcow2 behavior.
// The cloud-disk backend is intentionally fail-fast until the lifecycle paths
// are wired to provision, fence, snapshot, fork, and attach a single root disk.
type RootDiskConfig struct {
	Backend string

	CloudDisk CloudDiskConfig
}

type CloudDiskConfig struct {
	CLIPath        string
	CachePath      string
	DefaultSizeMB  int
	GoldenDisk     string
	GoldenSnapshot string

	S3Endpoint        string
	S3Region          string
	S3AccessKeyID     string
	S3SecretAccessKey string
}

type RootDiskSet struct {
	RootfsPath    string
	WorkspacePath string
}

type PrepareSandboxDisksRequest struct {
	SandboxID  string
	SandboxDir string

	Template string
	DiskMB   int

	TemplateRootfsKey    string
	TemplateWorkspaceKey string
}

type MaterializeCheckpointDisksRequest struct {
	CheckpointID string
	CacheDir     string
	SandboxID    string
	SandboxDir   string
	Replace      bool
}

type RootDiskProvider interface {
	PrepareSandboxDisks(ctx context.Context, req PrepareSandboxDisksRequest) (RootDiskSet, error)
	MaterializeCheckpointDisks(ctx context.Context, req MaterializeCheckpointDisksRequest) (RootDiskSet, error)
}

func (c RootDiskConfig) normalized() RootDiskConfig {
	if c.Backend == "" {
		c.Backend = RootDiskBackendLocal
	}
	if c.CloudDisk.CLIPath == "" {
		c.CloudDisk.CLIPath = "cloud-disk"
	}
	return c
}

func (c RootDiskConfig) validate() (RootDiskConfig, error) {
	c = c.normalized()
	switch c.Backend {
	case RootDiskBackendLocal:
		return c, nil
	case RootDiskBackendCloudDisk:
		if c.CloudDisk.CachePath == "" {
			return c, fmt.Errorf("cloud-disk root backend requires CloudDisk.CachePath")
		}
		if c.CloudDisk.DefaultSizeMB <= 0 {
			return c, fmt.Errorf("cloud-disk root backend requires CloudDisk.DefaultSizeMB > 0")
		}
		if c.CloudDisk.S3Endpoint == "" {
			return c, fmt.Errorf("cloud-disk root backend requires CloudDisk.S3Endpoint")
		}
		if c.CloudDisk.S3AccessKeyID == "" || c.CloudDisk.S3SecretAccessKey == "" {
			return c, fmt.Errorf("cloud-disk root backend requires CloudDisk S3 credentials")
		}
		if c.CloudDisk.GoldenDisk == "" || c.CloudDisk.GoldenSnapshot == "" {
			return c, fmt.Errorf("cloud-disk root backend requires CloudDisk.GoldenDisk and CloudDisk.GoldenSnapshot")
		}
		return c, nil
	default:
		return c, fmt.Errorf("unsupported root disk backend %q", c.Backend)
	}
}

func newRootDiskProvider(cfg Config) (RootDiskProvider, error) {
	switch cfg.RootDisk.Backend {
	case RootDiskBackendLocal:
		return localRootDiskProvider{
			imagesDir:     cfg.ImagesDir,
			defaultDiskMB: cfg.DefaultDiskMB,
		}, nil
	case RootDiskBackendCloudDisk:
		return cloudDiskRootDiskProvider{cfg: cfg.RootDisk.CloudDisk}, nil
	default:
		return nil, fmt.Errorf("unsupported root disk backend %q", cfg.RootDisk.Backend)
	}
}

type localRootDiskProvider struct {
	imagesDir     string
	defaultDiskMB int
	copyFile      func(src, dst string) error
}

func (p localRootDiskProvider) PrepareSandboxDisks(ctx context.Context, req PrepareSandboxDisksRequest) (RootDiskSet, error) {
	_ = ctx

	disks := RootDiskSet{
		RootfsPath:    filepath.Join(req.SandboxDir, "rootfs.qcow2"),
		WorkspacePath: filepath.Join(req.SandboxDir, "workspace.qcow2"),
	}

	if req.TemplateRootfsKey != "" {
		srcRootfs := strings.TrimPrefix(req.TemplateRootfsKey, "local://")
		srcWorkspace := strings.TrimPrefix(req.TemplateWorkspaceKey, "local://")
		if srcWorkspace == "" {
			return RootDiskSet{}, fmt.Errorf("template workspace key is required when template rootfs key is set")
		}
		if err := p.copy(srcRootfs, disks.RootfsPath); err != nil {
			return RootDiskSet{}, fmt.Errorf("copy template rootfs: %w", err)
		}
		if err := p.copy(srcWorkspace, disks.WorkspacePath); err != nil {
			return RootDiskSet{}, fmt.Errorf("copy template workspace: %w", err)
		}
		return disks, nil
	}

	baseImage, err := ResolveBaseImage(p.imagesDir, req.Template)
	if err != nil {
		return RootDiskSet{}, fmt.Errorf("resolve base image: %w", err)
	}
	if err := PrepareRootfs(baseImage, disks.RootfsPath); err != nil {
		return RootDiskSet{}, fmt.Errorf("prepare rootfs: %w", err)
	}

	diskMB := req.DiskMB
	if diskMB <= 0 {
		diskMB = p.defaultDiskMB
	}
	if err := CreateWorkspace(disks.WorkspacePath, diskMB); err != nil {
		return RootDiskSet{}, fmt.Errorf("create workspace: %w", err)
	}

	return disks, nil
}

func (p localRootDiskProvider) MaterializeCheckpointDisks(ctx context.Context, req MaterializeCheckpointDisksRequest) (RootDiskSet, error) {
	_ = ctx

	cachedRootfs := filepath.Join(req.CacheDir, "rootfs.qcow2")
	cachedWorkspace := filepath.Join(req.CacheDir, "workspace.qcow2")
	if !fileExists(cachedRootfs) || !fileExists(cachedWorkspace) {
		return RootDiskSet{}, fmt.Errorf("checkpoint %s: qcow2 files not found in cache", req.CheckpointID)
	}

	disks := RootDiskSet{
		RootfsPath:    filepath.Join(req.SandboxDir, "rootfs.qcow2"),
		WorkspacePath: filepath.Join(req.SandboxDir, "workspace.qcow2"),
	}
	if req.Replace {
		if err := removeIfExists(disks.RootfsPath); err != nil {
			return RootDiskSet{}, fmt.Errorf("remove existing rootfs: %w", err)
		}
		if err := removeIfExists(disks.WorkspacePath); err != nil {
			return RootDiskSet{}, fmt.Errorf("remove existing workspace: %w", err)
		}
	}

	if err := p.copy(cachedRootfs, disks.RootfsPath); err != nil {
		return RootDiskSet{}, fmt.Errorf("copy rootfs from cache: %w", err)
	}
	if err := p.copy(cachedWorkspace, disks.WorkspacePath); err != nil {
		return RootDiskSet{}, fmt.Errorf("copy workspace from cache: %w", err)
	}
	return disks, nil
}

func (p localRootDiskProvider) copy(src, dst string) error {
	copyFile := p.copyFile
	if copyFile == nil {
		copyFile = copyFileReflink
	}
	return copyFile(src, dst)
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

type cloudDiskRootDiskProvider struct {
	cfg CloudDiskConfig
}

func (p cloudDiskRootDiskProvider) PrepareSandboxDisks(ctx context.Context, req PrepareSandboxDisksRequest) (RootDiskSet, error) {
	_ = ctx
	diskName := p.sandboxDiskName(req.SandboxID)
	create := p.createForkCommand(diskName, p.cfg.GoldenDisk, p.cfg.GoldenSnapshot, p.diskSizeMB(req.DiskMB))
	mount := p.mountCommand(diskName)
	return RootDiskSet{}, fmt.Errorf("cloud-disk root backend is not implemented yet: would run %q then %q", create.String(), mount.String())
}

func (p cloudDiskRootDiskProvider) MaterializeCheckpointDisks(ctx context.Context, req MaterializeCheckpointDisksRequest) (RootDiskSet, error) {
	_ = ctx
	diskName := p.sandboxDiskName(req.SandboxID)
	parentDisk, snapshot := p.checkpointDiskRef(req.CheckpointID)
	create := p.createForkCommand(diskName, parentDisk, snapshot, p.cfg.DefaultSizeMB)
	mount := p.mountCommand(diskName)
	return RootDiskSet{}, fmt.Errorf("cloud-disk root backend is not implemented yet: would run %q then %q", create.String(), mount.String())
}

func (p cloudDiskRootDiskProvider) diskSizeMB(requestedMB int) int {
	if requestedMB > 0 {
		return requestedMB
	}
	return p.cfg.DefaultSizeMB
}

func (p cloudDiskRootDiskProvider) sandboxDiskName(sandboxID string) string {
	return cloudDiskName("oc-root", sandboxID)
}

func (p cloudDiskRootDiskProvider) checkpointDiskRef(checkpointID string) (diskName, snapshot string) {
	return cloudDiskName("oc-checkpoint", checkpointID), checkpointID
}

func (p cloudDiskRootDiskProvider) createForkCommand(name, parent, snapshot string, sizeMB int) cloudDiskCommand {
	sizeGB := (sizeMB + 1023) / 1024
	if sizeGB < 1 {
		sizeGB = 1
	}
	args := []string{
		"create", name,
		"-size", fmt.Sprintf("%dG", sizeGB),
		"-no-mount",
		"-parent", parent,
		"-snapshot", snapshot,
		"--set", "no-fs=true",
		"--set", "block-size=512",
		"--set", fmt.Sprintf("disk-cache-path=%s", p.cfg.CachePath),
	}
	return cloudDiskCommand{path: p.cfg.CLIPath, args: args, env: p.env()}
}

func (p cloudDiskRootDiskProvider) mountCommand(name string) cloudDiskCommand {
	return cloudDiskCommand{
		path: p.cfg.CLIPath,
		args: []string{"mount", name},
		env:  p.env(),
	}
}

func (p cloudDiskRootDiskProvider) env() []string {
	return []string{
		"AWS_ACCESS_KEY_ID=" + p.cfg.S3AccessKeyID,
		"AWS_SECRET_ACCESS_KEY=" + p.cfg.S3SecretAccessKey,
		"AWS_ENDPOINT_URL_S3=" + p.cfg.S3Endpoint,
		"AWS_REGION=" + p.cfg.S3Region,
	}
}

type cloudDiskCommand struct {
	path string
	args []string
	env  []string
}

func (c cloudDiskCommand) String() string {
	return strings.Join(append([]string{c.path}, c.args...), " ")
}

func cloudDiskName(parts ...string) string {
	var b strings.Builder
	for _, part := range parts {
		for _, r := range strings.ToLower(part) {
			switch {
			case r >= 'a' && r <= 'z':
				b.WriteRune(r)
			case r >= '0' && r <= '9':
				b.WriteRune(r)
			default:
				b.WriteByte('-')
			}
		}
		b.WriteByte('-')
	}
	name := strings.Trim(b.String(), "-")
	for strings.Contains(name, "--") {
		name = strings.ReplaceAll(name, "--", "-")
	}
	if len(name) > 63 {
		name = strings.Trim(name[:63], "-")
	}
	if name == "" {
		return "oc-root"
	}
	return name
}
