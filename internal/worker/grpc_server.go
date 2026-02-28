package worker

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/secretsproxy"
	"github.com/opensandbox/opensandbox/internal/sparse"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/internal/template"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// GRPCServer implements the SandboxWorker gRPC service for control plane communication.
type GRPCServer struct {
	pb.UnimplementedSandboxWorkerServer
	manager         sandbox.Manager
	router          *sandbox.SandboxRouter
	ptyManager      *sandbox.PTYManager
	sandboxDBs      *sandbox.SandboxDBManager
	checkpointStore *storage.CheckpointStore
	builder         *template.Builder
	store           *db.Store                   // nil if no DB configured
	secretsProxy    *secretsproxy.SecretsProxy  // nil if secrets proxy not configured
	server          *grpc.Server
}

// NewGRPCServer creates a new gRPC server wrapping the sandbox manager.
func NewGRPCServer(mgr sandbox.Manager, ptyMgr *sandbox.PTYManager, sandboxDBs *sandbox.SandboxDBManager, checkpointStore *storage.CheckpointStore, router *sandbox.SandboxRouter, builder *template.Builder, store *db.Store, sp *secretsproxy.SecretsProxy) *GRPCServer {
	s := &GRPCServer{
		manager:         mgr,
		router:          router,
		ptyManager:      ptyMgr,
		sandboxDBs:      sandboxDBs,
		checkpointStore: checkpointStore,
		builder:         builder,
		store:           store,
		secretsProxy:    sp,
		server: grpc.NewServer(
			grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
				MinTime:             5 * time.Second,
				PermitWithoutStream: true,
			}),
			grpc.KeepaliveParams(keepalive.ServerParameters{
				Time:    30 * time.Second,
				Timeout: 10 * time.Second,
			}),
		),
	}
	pb.RegisterSandboxWorkerServer(s.server, s)
	return s
}

// Start starts the gRPC server on the given address.
func (s *GRPCServer) Start(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	return s.server.Serve(lis)
}

// Stop gracefully stops the gRPC server.
func (s *GRPCServer) Stop() {
	s.server.GracefulStop()
}

func (s *GRPCServer) CreateSandbox(ctx context.Context, req *pb.CreateSandboxRequest) (*pb.CreateSandboxResponse, error) {
	cfg := types.SandboxConfig{
		Template:       req.Template,
		Timeout:        int(req.Timeout),
		Envs:           req.Envs,
		MemoryMB:       int(req.MemoryMb),
		CpuCount:       int(req.CpuCount),
		NetworkEnabled: req.NetworkEnabled,
		ImageRef:       req.ImageRef,
		Port:           int(req.Port),
	}

	// If this is a template-based creation, resolve the template drives.
	// Fast path: check local cache (reflink copy from cached ext4 — instant).
	// Slow path: download from S3, extract, and cache for next time.
	var tmpDir string
	if req.TemplateRootfsKey != "" && req.TemplateWorkspaceKey != "" {
		// Extract template ID from S3 key: "templates/{id}/rootfs.tar.zst" → "{id}"
		templateID := extractTemplateID(req.TemplateRootfsKey)

		// Check local cache first
		cachedRootfs := s.manager.TemplateCachePath(templateID, "rootfs.ext4")
		cachedWorkspace := s.manager.TemplateCachePath(templateID, "workspace.ext4")

		if cachedRootfs != "" && cachedWorkspace != "" {
			// Fast path: use cached template drives directly (reflink copy happens in Create)
			log.Printf("firecracker: template %s: using cached drives", templateID)
			cfg.TemplateRootfsKey = "local://" + cachedRootfs
			cfg.TemplateWorkspaceKey = "local://" + cachedWorkspace
		} else {
			// Slow path: download from S3, extract, and cache
			if s.checkpointStore == nil {
				return nil, fmt.Errorf("template-based creation requires checkpoint store (S3)")
			}
			log.Printf("firecracker: template %s: cache miss, downloading from S3", templateID)
			var err error
			tmpDir, err = s.downloadAndCacheTemplateDrives(ctx, templateID, req.TemplateRootfsKey, req.TemplateWorkspaceKey)
			if err != nil {
				return nil, fmt.Errorf("download template drives: %w", err)
			}
			cfg.TemplateRootfsKey = "local://" + filepath.Join(tmpDir, "rootfs.ext4")
			cfg.TemplateWorkspaceKey = "local://" + filepath.Join(tmpDir, "workspace.ext4")
		}
	}
	// tmpDir is only set for S3 downloads — don't clean up (it's the permanent cache dir)
	_ = tmpDir

	sb, err := s.manager.Create(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create sandbox: %w", err)
	}

	// Register with sandbox router for rolling timeout tracking
	if s.router != nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 300
		}
		s.router.Register(sb.ID, time.Duration(timeout)*time.Second)
	}

	// Initialize per-sandbox SQLite
	if s.sandboxDBs != nil {
		sdb, err := s.sandboxDBs.Get(sb.ID)
		if err == nil {
			_ = sdb.LogEvent("created", map[string]string{
				"sandbox_id": sb.ID,
				"template":   cfg.Template,
			})
		}
	}

	return &pb.CreateSandboxResponse{
		SandboxId: sb.ID,
		Status:    string(sb.Status),
	}, nil
}

func (s *GRPCServer) DestroySandbox(ctx context.Context, req *pb.DestroySandboxRequest) (*pb.DestroySandboxResponse, error) {
	if err := s.manager.Kill(ctx, req.SandboxId); err != nil {
		return nil, fmt.Errorf("failed to destroy sandbox: %w", err)
	}

	// Unregister from sandbox router
	if s.router != nil {
		s.router.Unregister(req.SandboxId)
	}

	// Clean up SQLite
	if s.sandboxDBs != nil {
		_ = s.sandboxDBs.Remove(req.SandboxId)
	}

	return &pb.DestroySandboxResponse{}, nil
}

func (s *GRPCServer) GetSandbox(ctx context.Context, req *pb.GetSandboxRequest) (*pb.GetSandboxResponse, error) {
	sb, err := s.manager.Get(ctx, req.SandboxId)
	if err != nil {
		return nil, fmt.Errorf("sandbox not found: %w", err)
	}

	return &pb.GetSandboxResponse{
		SandboxId: sb.ID,
		Status:    string(sb.Status),
		Template:  sb.Template,
		StartedAt: sb.StartedAt.Unix(),
		EndAt:     sb.EndAt.Unix(),
	}, nil
}

func (s *GRPCServer) ListSandboxes(ctx context.Context, _ *pb.ListSandboxesRequest) (*pb.ListSandboxesResponse, error) {
	sandboxes, err := s.manager.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list sandboxes: %w", err)
	}

	var results []*pb.GetSandboxResponse
	for _, sb := range sandboxes {
		results = append(results, &pb.GetSandboxResponse{
			SandboxId: sb.ID,
			Status:    string(sb.Status),
			Template:  sb.Template,
			StartedAt: sb.StartedAt.Unix(),
			EndAt:     sb.EndAt.Unix(),
		})
	}

	return &pb.ListSandboxesResponse{Sandboxes: results}, nil
}

func (s *GRPCServer) ExecCommand(ctx context.Context, req *pb.ExecCommandRequest) (*pb.ExecCommandResponse, error) {
	cfg := types.ProcessConfig{
		Command: req.Command,
		Args:    req.Args,
		Env:     req.Envs,
		Cwd:     req.Cwd,
		Timeout: int(req.Timeout),
	}

	var result *types.ProcessResult

	routeOp := func(ctx context.Context) error {
		var err error
		result, err = s.manager.Exec(ctx, req.SandboxId, cfg)
		return err
	}

	// Route through sandbox router (handles auto-wake, rolling timeout reset)
	if s.router != nil {
		if err := s.router.Route(ctx, req.SandboxId, "exec", routeOp); err != nil {
			return nil, fmt.Errorf("exec failed: %w", err)
		}
	} else {
		if err := routeOp(ctx); err != nil {
			return nil, fmt.Errorf("exec failed: %w", err)
		}
	}

	return &pb.ExecCommandResponse{
		ExitCode: int32(result.ExitCode),
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
	}, nil
}

func (s *GRPCServer) ReadFile(ctx context.Context, req *pb.ReadFileRequest) (*pb.ReadFileResponse, error) {
	var content string

	routeOp := func(ctx context.Context) error {
		var err error
		content, err = s.manager.ReadFile(ctx, req.SandboxId, req.Path)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(ctx, req.SandboxId, "readFile", routeOp); err != nil {
			return nil, fmt.Errorf("read file failed: %w", err)
		}
	} else {
		if err := routeOp(ctx); err != nil {
			return nil, fmt.Errorf("read file failed: %w", err)
		}
	}

	return &pb.ReadFileResponse{Content: []byte(content)}, nil
}

func (s *GRPCServer) WriteFile(ctx context.Context, req *pb.WriteFileRequest) (*pb.WriteFileResponse, error) {
	routeOp := func(ctx context.Context) error {
		return s.manager.WriteFile(ctx, req.SandboxId, req.Path, string(req.Content))
	}

	if s.router != nil {
		if err := s.router.Route(ctx, req.SandboxId, "writeFile", routeOp); err != nil {
			return nil, fmt.Errorf("write file failed: %w", err)
		}
	} else {
		if err := routeOp(ctx); err != nil {
			return nil, fmt.Errorf("write file failed: %w", err)
		}
	}

	return &pb.WriteFileResponse{}, nil
}

func (s *GRPCServer) ListDir(ctx context.Context, req *pb.ListDirRequest) (*pb.ListDirResponse, error) {
	var entries []types.EntryInfo

	routeOp := func(ctx context.Context) error {
		var err error
		entries, err = s.manager.ListDir(ctx, req.SandboxId, req.Path)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(ctx, req.SandboxId, "listDir", routeOp); err != nil {
			return nil, fmt.Errorf("list dir failed: %w", err)
		}
	} else {
		if err := routeOp(ctx); err != nil {
			return nil, fmt.Errorf("list dir failed: %w", err)
		}
	}

	var pbEntries []*pb.DirEntry
	for _, e := range entries {
		pbEntries = append(pbEntries, &pb.DirEntry{
			Name:  e.Name,
			IsDir: e.IsDir,
			Size:  e.Size,
			Path:  e.Path,
		})
	}

	return &pb.ListDirResponse{Entries: pbEntries}, nil
}

// ExecCommandStream and PTY streaming RPCs are not needed since
// SDKs connect directly to the worker HTTP/WS server.
// Stubbed out to satisfy the interface.

func (s *GRPCServer) ExecCommandStream(_ *pb.ExecCommandRequest, _ pb.SandboxWorker_ExecCommandStreamServer) error {
	return fmt.Errorf("streaming exec not implemented, use HTTP API directly")
}

func (s *GRPCServer) CreatePTY(ctx context.Context, req *pb.CreatePTYRequest) (*pb.CreatePTYResponse, error) {
	ptyReq := types.PTYCreateRequest{
		Cols:  int(req.Cols),
		Rows:  int(req.Rows),
		Shell: req.Shell,
	}

	session, err := s.ptyManager.CreateSession(req.SandboxId, ptyReq)
	if err != nil {
		return nil, fmt.Errorf("create PTY failed: %w", err)
	}

	return &pb.CreatePTYResponse{SessionId: session.ID}, nil
}

func (s *GRPCServer) PTYStream(_ pb.SandboxWorker_PTYStreamServer) error {
	return fmt.Errorf("PTY streaming not implemented via gRPC, use WebSocket API directly")
}

func (s *GRPCServer) HibernateSandbox(ctx context.Context, req *pb.HibernateSandboxRequest) (*pb.HibernateSandboxResponse, error) {
	if s.checkpointStore == nil {
		return nil, fmt.Errorf("hibernation not configured on this worker")
	}

	result, err := s.manager.Hibernate(ctx, req.SandboxId, s.checkpointStore)
	if err != nil {
		return nil, fmt.Errorf("failed to hibernate sandbox: %w", err)
	}

	// Mark hibernated in sandbox router
	if s.router != nil {
		s.router.MarkHibernated(req.SandboxId, 600*time.Second)
	}

	// Clean up per-sandbox SQLite
	if s.sandboxDBs != nil {
		_ = s.sandboxDBs.Remove(req.SandboxId)
	}

	return &pb.HibernateSandboxResponse{
		SandboxId:     result.SandboxID,
		CheckpointKey: result.CheckpointKey,
		SizeBytes:     result.SizeBytes,
	}, nil
}

func (s *GRPCServer) WakeSandbox(ctx context.Context, req *pb.WakeSandboxRequest) (*pb.WakeSandboxResponse, error) {
	if s.checkpointStore == nil {
		return nil, fmt.Errorf("hibernation not configured on this worker")
	}

	sb, err := s.manager.Wake(ctx, req.SandboxId, req.CheckpointKey, s.checkpointStore, int(req.Timeout))
	if err != nil {
		return nil, fmt.Errorf("failed to wake sandbox: %w", err)
	}

	// Register with sandbox router after explicit wake
	if s.router != nil {
		timeout := int(req.Timeout)
		if timeout <= 0 {
			timeout = 300
		}
		s.router.Register(sb.ID, time.Duration(timeout)*time.Second)
	}

	// Re-initialize per-sandbox SQLite
	if s.sandboxDBs != nil {
		sdb, err := s.sandboxDBs.Get(sb.ID)
		if err == nil {
			_ = sdb.LogEvent("woke", map[string]string{
				"sandbox_id": sb.ID,
			})
		}
	}

	// Restore secrets proxy session if this sandbox had a secret group attached.
	// The VM snapshot preserves sealed tokens in /etc/environment, but the worker's
	// in-memory {sealedToken→realValue} map is lost on hibernate. Re-resolve from DB.
	if s.secretsProxy != nil && s.store != nil && sb.GuestIP != "" {
		if err := s.restoreProxySession(ctx, sb); err != nil {
			log.Printf("grpc: wake %s: restore proxy session (non-fatal): %v", req.SandboxId, err)
		}
	}

	return &pb.WakeSandboxResponse{
		SandboxId: sb.ID,
		Status:    string(sb.Status),
	}, nil
}

// restoreProxySession re-creates the secrets proxy session after a sandbox wakes from
// hibernation. It re-resolves the secret group from the DB, reads the sealed tokens
// from /etc/environment inside the VM, and rebuilds the {sealedToken→realValue} map.
func (s *GRPCServer) restoreProxySession(ctx context.Context, sb *types.Sandbox) error {
	groupID, err := s.store.GetSandboxSecretGroupID(ctx, sb.ID)
	if err != nil || groupID == nil {
		return nil // No secret group attached — nothing to restore
	}

	envVars, allowedHosts, err := s.store.ResolveSecretGroup(ctx, *groupID)
	if err != nil {
		return fmt.Errorf("resolve secret group: %w", err)
	}
	if len(envVars) == 0 {
		return nil
	}

	// Read /etc/environment from the woken VM to find existing sealed tokens
	envContent, err := s.manager.ReadFile(ctx, sb.ID, "/etc/environment")
	if err != nil {
		return fmt.Errorf("read /etc/environment: %w", err)
	}

	vmEnvs := parseEnvFile(envContent)

	// Build {sealedToken→realValue} by cross-referencing VM env vars with DB values
	tokenMap := make(map[string]string, len(envVars))
	for envVar, realValue := range envVars {
		if sealedToken, ok := vmEnvs[envVar]; ok && strings.HasPrefix(sealedToken, "osb_sealed_") {
			tokenMap[sealedToken] = realValue
		}
	}
	if len(tokenMap) == 0 {
		return nil // Sandbox was created without the proxy (e.g., before this feature)
	}

	s.secretsProxy.RestoreSession(sb.GuestIP, sb.ID, tokenMap, allowedHosts)
	return nil
}

// parseEnvFile parses /etc/environment format (KEY=VALUE lines, optional quotes) into a map.
func parseEnvFile(content string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 0 {
			continue
		}
		key := line[:idx]
		val := line[idx+1:]
		// Strip surrounding quotes if present
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		result[key] = val
	}
	return result
}

func (s *GRPCServer) IsTAPAvailable(ctx context.Context, req *pb.IsTAPAvailableRequest) (*pb.IsTAPAvailableResponse, error) {
	return &pb.IsTAPAvailableResponse{
		Available: s.manager.IsTAPAvailable(req.SandboxId),
	}, nil
}

func (s *GRPCServer) SaveAsTemplate(ctx context.Context, req *pb.SaveAsTemplateRequest) (*pb.SaveAsTemplateResponse, error) {
	if s.checkpointStore == nil {
		return nil, fmt.Errorf("save-as-template requires checkpoint store (S3) — not configured on this worker")
	}

	rootfsKey, workspaceKey, err := s.manager.SaveAsTemplate(ctx, req.SandboxId, req.TemplateId, s.checkpointStore, nil)
	if err != nil {
		return nil, fmt.Errorf("save-as-template failed: %w", err)
	}

	return &pb.SaveAsTemplateResponse{
		RootfsS3Key:    rootfsKey,
		WorkspaceS3Key: workspaceKey,
	}, nil
}

// copyStream copies from r to w, returning bytes written.
func copyStream(w io.Writer, r io.Reader) (int64, error) {
	return io.Copy(w, r)
}

// extractArchiveCmd extracts a tar.zst archive to a directory using the system tar command.
// Uses --sparse to handle large sparse files (e.g., 20GB workspace.ext4 that is mostly zeros).
func extractArchiveCmd(archivePath, destDir string) error {
	cmd := exec.Command("tar", "--zstd", "--sparse", "-xf", archivePath, "-C", destDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar extract: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// extractTemplateID extracts the template UUID from an S3 key like "templates/{id}/rootfs.tar.zst".
func extractTemplateID(s3Key string) string {
	// "templates/495327c0-.../rootfs.tar.zst" → "495327c0-..."
	parts := strings.SplitN(s3Key, "/", 3)
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}

// downloadAndCacheTemplateDrives downloads template archives from S3, extracts them to the
// permanent template cache directory, and returns the cache dir path. On subsequent creates
// the cached ext4 files are used directly (reflink copy — instant).
func (s *GRPCServer) downloadAndCacheTemplateDrives(ctx context.Context, templateID, rootfsKey, workspaceKey string) (string, error) {
	cacheDir := filepath.Join(s.manager.DataDir(), "templates", templateID)
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return "", fmt.Errorf("create template cache dir: %w", err)
	}
	log.Printf("firecracker: downloading template %s from S3 to cache %s", templateID, cacheDir)

	// Download and extract rootfs archive
	t0 := time.Now()
	if err := s.downloadAndExtract(ctx, rootfsKey, cacheDir); err != nil {
		os.RemoveAll(cacheDir)
		return "", fmt.Errorf("rootfs: %w", err)
	}
	log.Printf("firecracker: template %s: rootfs cached (%dms)", templateID, time.Since(t0).Milliseconds())

	// Download and extract workspace archive
	t1 := time.Now()
	if err := s.downloadAndExtract(ctx, workspaceKey, cacheDir); err != nil {
		os.RemoveAll(cacheDir)
		return "", fmt.Errorf("workspace: %w", err)
	}
	log.Printf("firecracker: template %s: workspace cached (%dms)", templateID, time.Since(t1).Milliseconds())
	log.Printf("firecracker: template %s: cached (total %dms)", templateID, time.Since(t0).Milliseconds())

	return cacheDir, nil
}

// downloadAndExtract downloads an archive from S3 and extracts it to destDir.
// Supports two formats:
//   - .sparse.zst — sparse block archive (workspace), restored via sparse.Restore
//   - .tar.zst — standard tar archive (rootfs), extracted via tar command
//
// After extraction, normalizes filenames to canonical names (rootfs.ext4, workspace.ext4).
func (s *GRPCServer) downloadAndExtract(ctx context.Context, s3Key, destDir string) error {
	data, err := s.checkpointStore.Download(ctx, s3Key)
	if err != nil {
		return fmt.Errorf("download %s: %w", s3Key, err)
	}

	archivePath := filepath.Join(destDir, filepath.Base(s3Key))
	f, err := os.Create(archivePath)
	if err != nil {
		data.Close()
		return fmt.Errorf("create archive file: %w", err)
	}
	if _, err := copyStream(f, data); err != nil {
		f.Close()
		data.Close()
		return fmt.Errorf("write archive: %w", err)
	}
	f.Close()
	data.Close()

	if strings.HasSuffix(s3Key, ".sparse.zst") {
		// Sparse format: restore directly to the target ext4 path
		targetName := "workspace.ext4"
		if strings.Contains(s3Key, "rootfs") {
			targetName = "rootfs.ext4"
		}
		dstPath := filepath.Join(destDir, targetName)
		if err := sparse.Restore(archivePath, dstPath); err != nil {
			return fmt.Errorf("sparse restore: %w", err)
		}
		os.Remove(archivePath)
		return nil
	}

	// tar.zst format
	if err := extractArchiveCmd(archivePath, destDir); err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	os.Remove(archivePath)

	// Normalize extracted filenames: older archives may contain "tmpl-{id}-rootfs.ext4"
	// instead of just "rootfs.ext4". Rename to canonical names for consistent cache lookups.
	targetName := "rootfs.ext4"
	if strings.Contains(s3Key, "workspace") {
		targetName = "workspace.ext4"
	}
	canonicalPath := filepath.Join(destDir, targetName)
	if _, err := os.Stat(canonicalPath); err != nil {
		// File doesn't exist with canonical name — find and rename the extracted ext4
		entries, _ := os.ReadDir(destDir)
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".ext4") && strings.Contains(e.Name(), strings.TrimSuffix(targetName, ".ext4")) {
				os.Rename(filepath.Join(destDir, e.Name()), canonicalPath)
				break
			}
		}
	}
	return nil
}

func (s *GRPCServer) BuildTemplate(ctx context.Context, req *pb.BuildTemplateRequest) (*pb.BuildTemplateResponse, error) {
	if s.builder == nil {
		return nil, fmt.Errorf("template builder not configured on this worker")
	}

	imageRef, buildLog, err := s.builder.Build(ctx, req.Dockerfile, req.Name, req.Tag, req.EcrImageRef)
	if err != nil {
		return nil, fmt.Errorf("template build failed: %w", err)
	}

	return &pb.BuildTemplateResponse{
		ImageRef: imageRef,
		BuildLog: buildLog,
	}, nil
}

func (s *GRPCServer) GetSandboxStats(ctx context.Context, req *pb.GetSandboxStatsRequest) (*pb.GetSandboxStatsResponse, error) {
	stats, err := s.manager.Stats(ctx, req.SandboxId)
	if err != nil {
		return nil, fmt.Errorf("failed to get sandbox stats: %w", err)
	}

	return &pb.GetSandboxStatsResponse{
		CpuPercent: stats.CPUPercent,
		MemUsage:   stats.MemUsage,
		MemLimit:   stats.MemLimit,
		NetInput:   stats.NetInput,
		NetOutput:  stats.NetOutput,
		Pids:       int32(stats.PIDs),
	}, nil
}
