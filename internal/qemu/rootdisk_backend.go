package qemu

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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

type RootDiskCheckpoint struct {
	Backend  string `json:"backend"`
	DiskName string `json:"diskName"`
	Snapshot string `json:"snapshot"`
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

type CaptureCheckpointDisksRequest struct {
	CheckpointID string
	SandboxID    string
	SandboxDir   string
	StagingDir   string
}

type RootDiskProvider interface {
	PrepareSandboxDisks(ctx context.Context, req PrepareSandboxDisksRequest) (RootDiskSet, error)
	CaptureCheckpointDisks(ctx context.Context, req CaptureCheckpointDisksRequest) (*RootDiskCheckpoint, error)
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

func (p localRootDiskProvider) CaptureCheckpointDisks(ctx context.Context, req CaptureCheckpointDisksRequest) (*RootDiskCheckpoint, error) {
	_ = ctx
	srcRootfs := filepath.Join(req.SandboxDir, "rootfs.qcow2")
	srcWorkspace := filepath.Join(req.SandboxDir, "workspace.qcow2")
	if err := p.copy(srcRootfs, filepath.Join(req.StagingDir, "rootfs.qcow2")); err != nil {
		return nil, fmt.Errorf("copy rootfs: %w", err)
	}
	if err := p.copy(srcWorkspace, filepath.Join(req.StagingDir, "workspace.qcow2")); err != nil {
		return nil, fmt.Errorf("copy workspace: %w", err)
	}
	return &RootDiskCheckpoint{Backend: RootDiskBackendLocal}, nil
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
	run func(context.Context, cloudDiskCommand) ([]byte, error)
}

func (p cloudDiskRootDiskProvider) PrepareSandboxDisks(ctx context.Context, req PrepareSandboxDisksRequest) (RootDiskSet, error) {
	diskName := p.sandboxDiskName(req.SandboxID)
	create := p.createForkCommand(diskName, p.cfg.GoldenDisk, p.cfg.GoldenSnapshot, p.diskSizeMB(req.DiskMB))
	mount := p.mountCommand(diskName)
	if _, err := p.runCommand(ctx, create); err != nil {
		return RootDiskSet{}, fmt.Errorf("cloud-disk create root disk %s: %w", diskName, err)
	}
	if _, err := p.runCommand(ctx, mount); err != nil {
		return RootDiskSet{}, fmt.Errorf("cloud-disk mount root disk %s: %w", diskName, err)
	}
	device, err := p.devicePath(ctx, diskName)
	if err != nil {
		return RootDiskSet{}, err
	}
	return RootDiskSet{RootfsPath: device}, nil
}

func (p cloudDiskRootDiskProvider) MaterializeCheckpointDisks(ctx context.Context, req MaterializeCheckpointDisksRequest) (RootDiskSet, error) {
	diskName := p.sandboxDiskName(req.SandboxID)
	parentDisk, snapshot := p.checkpointDiskRef(req.CacheDir, req.CheckpointID)
	create := p.createForkCommand(diskName, parentDisk, snapshot, p.cfg.DefaultSizeMB)
	mount := p.mountCommand(diskName)
	if req.Replace {
		return RootDiskSet{}, fmt.Errorf("cloud-disk restore-in-place is not implemented yet")
	}
	if _, err := p.runCommand(ctx, create); err != nil {
		return RootDiskSet{}, fmt.Errorf("cloud-disk create checkpoint fork %s: %w", diskName, err)
	}
	if _, err := p.runCommand(ctx, mount); err != nil {
		return RootDiskSet{}, fmt.Errorf("cloud-disk mount checkpoint fork %s: %w", diskName, err)
	}
	device, err := p.devicePath(ctx, diskName)
	if err != nil {
		return RootDiskSet{}, err
	}
	return RootDiskSet{RootfsPath: device}, nil
}

func (p cloudDiskRootDiskProvider) CaptureCheckpointDisks(ctx context.Context, req CaptureCheckpointDisksRequest) (*RootDiskCheckpoint, error) {
	diskName := p.sandboxDiskName(req.SandboxID)
	out, err := p.runCommand(ctx, p.snapshotCommand(diskName))
	if err != nil {
		return nil, fmt.Errorf("cloud-disk snapshot root disk %s: %w", diskName, err)
	}
	version := parseCloudDiskSnapshotVersion(string(out))
	if version == "" {
		return nil, fmt.Errorf("cloud-disk snapshot root disk %s: snapshot version not found in output %q", diskName, strings.TrimSpace(string(out)))
	}
	cp := &RootDiskCheckpoint{
		Backend:  RootDiskBackendCloudDisk,
		DiskName: diskName,
		Snapshot: version,
	}
	if err := writeRootDiskCheckpoint(req.StagingDir, cp); err != nil {
		return nil, err
	}
	return cp, nil
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

func (p cloudDiskRootDiskProvider) checkpointDiskRef(cacheDir, checkpointID string) (diskName, snapshot string) {
	cp, err := readRootDiskCheckpoint(cacheDir)
	if err == nil && cp != nil && cp.Backend == RootDiskBackendCloudDisk && cp.DiskName != "" && cp.Snapshot != "" {
		return cp.DiskName, cp.Snapshot
	}
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

func (p cloudDiskRootDiskProvider) snapshotCommand(name string) cloudDiskCommand {
	return cloudDiskCommand{
		path: p.cfg.CLIPath,
		args: []string{"snapshot", name},
		env:  p.env(),
	}
}

func (p cloudDiskRootDiskProvider) configShowCommand(name string) cloudDiskCommand {
	return cloudDiskCommand{
		path: p.cfg.CLIPath,
		args: []string{"config", name, "show", "-all"},
		env:  p.env(),
	}
}

func (p cloudDiskRootDiskProvider) devicePath(ctx context.Context, name string) (string, error) {
	out, err := p.runCommand(ctx, p.configShowCommand(name))
	if err != nil {
		return "", fmt.Errorf("cloud-disk inspect root disk %s: %w", name, err)
	}
	device := parseCloudDiskNBDDevice(string(out))
	if device == "" {
		return "", fmt.Errorf("cloud-disk root disk %s: nbd-device not found in config output", name)
	}
	return device, nil
}

func parseCloudDiskNBDDevice(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if !strings.Contains(line, "nbd-device") {
			continue
		}
		fields := strings.FieldsFunc(line, func(r rune) bool {
			return r == '=' || r == ':' || r == '"' || r == '\'' || r == ' ' || r == '\t'
		})
		for _, field := range fields {
			if strings.HasPrefix(field, "/dev/nbd") {
				return field
			}
		}
	}
	return ""
}

func parseCloudDiskSnapshotVersion(output string) string {
	var last string
	for _, field := range strings.FieldsFunc(output, func(r rune) bool {
		return r < '0' || r > '9'
	}) {
		if field != "" {
			last = field
		}
	}
	return last
}

func rootDiskCheckpointPath(cacheDir string) string {
	return filepath.Join(cacheDir, "snapshot", "rootdisk.json")
}

func writeRootDiskCheckpoint(cacheDir string, cp *RootDiskCheckpoint) error {
	data, err := json.Marshal(cp)
	if err != nil {
		return fmt.Errorf("marshal root disk checkpoint metadata: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(rootDiskCheckpointPath(cacheDir)), 0755); err != nil {
		return fmt.Errorf("mkdir root disk checkpoint metadata dir: %w", err)
	}
	if err := os.WriteFile(rootDiskCheckpointPath(cacheDir), data, 0644); err != nil {
		return fmt.Errorf("write root disk checkpoint metadata: %w", err)
	}
	return nil
}

func readRootDiskCheckpoint(cacheDir string) (*RootDiskCheckpoint, error) {
	data, err := os.ReadFile(rootDiskCheckpointPath(cacheDir))
	if err != nil {
		return nil, err
	}
	var cp RootDiskCheckpoint
	if err := json.Unmarshal(data, &cp); err != nil {
		return nil, err
	}
	return &cp, nil
}

func (p cloudDiskRootDiskProvider) runCommand(ctx context.Context, cmd cloudDiskCommand) ([]byte, error) {
	run := p.run
	if run == nil {
		run = runCloudDiskCommand
	}
	return run(ctx, cmd)
}

func runCloudDiskCommand(ctx context.Context, c cloudDiskCommand) ([]byte, error) {
	cmd := exec.CommandContext(ctx, c.path, c.args...)
	cmd.Env = append(os.Environ(), c.env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("%s: %w (%s)", c.String(), err, strings.TrimSpace(string(out)))
	}
	return out, nil
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
