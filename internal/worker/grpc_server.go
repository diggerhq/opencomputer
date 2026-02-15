package worker

import (
	"context"
	"fmt"
	"net"

	"google.golang.org/grpc"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// GRPCServer implements the SandboxWorker gRPC service for control plane communication.
type GRPCServer struct {
	pb.UnimplementedSandboxWorkerServer
	manager    *sandbox.Manager
	ptyManager *sandbox.PTYManager
	sandboxDBs *sandbox.SandboxDBManager
	server     *grpc.Server
}

// NewGRPCServer creates a new gRPC server wrapping the sandbox manager.
func NewGRPCServer(mgr *sandbox.Manager, ptyMgr *sandbox.PTYManager, sandboxDBs *sandbox.SandboxDBManager) *GRPCServer {
	s := &GRPCServer{
		manager:    mgr,
		ptyManager: ptyMgr,
		sandboxDBs: sandboxDBs,
		server:     grpc.NewServer(),
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
	}

	sb, err := s.manager.Create(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create sandbox: %w", err)
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

	result, err := s.manager.Exec(ctx, req.SandboxId, cfg)
	if err != nil {
		return nil, fmt.Errorf("exec failed: %w", err)
	}

	return &pb.ExecCommandResponse{
		ExitCode: int32(result.ExitCode),
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
	}, nil
}

func (s *GRPCServer) ReadFile(ctx context.Context, req *pb.ReadFileRequest) (*pb.ReadFileResponse, error) {
	content, err := s.manager.ReadFile(ctx, req.SandboxId, req.Path)
	if err != nil {
		return nil, fmt.Errorf("read file failed: %w", err)
	}
	return &pb.ReadFileResponse{Content: []byte(content)}, nil
}

func (s *GRPCServer) WriteFile(ctx context.Context, req *pb.WriteFileRequest) (*pb.WriteFileResponse, error) {
	if err := s.manager.WriteFile(ctx, req.SandboxId, req.Path, string(req.Content)); err != nil {
		return nil, fmt.Errorf("write file failed: %w", err)
	}
	return &pb.WriteFileResponse{}, nil
}

func (s *GRPCServer) ListDir(ctx context.Context, req *pb.ListDirRequest) (*pb.ListDirResponse, error) {
	entries, err := s.manager.ListDir(ctx, req.SandboxId, req.Path)
	if err != nil {
		return nil, fmt.Errorf("list dir failed: %w", err)
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
