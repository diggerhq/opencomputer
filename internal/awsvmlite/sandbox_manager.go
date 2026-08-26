package awsvmlite

import (
	"context"
	"fmt"
	"io"

	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// SandboxManager presents this backend through sandbox.Manager, the interface
// the control plane's data-plane routes already dispatch on.
//
// Written as an adapter rather than a set of special cases in the API layer for
// one reason: every route that touches a sandbox — exec, files, stats, kill,
// hibernate — resolves its manager through the backend registry, and a backend
// that answered only some of them would have to be checked for by hand at each
// site. That is precisely the shape internal/api/backend.go was introduced to
// remove, and every one of the bugs it removed failed silently.
//
// So this type implements ALL of it, and says no to most of it. The
// unimplemented half returns awsvm.ErrUnsupported, which the API layer already
// maps to 501 Not Implemented — "this runtime will never do that", as distinct
// from a 500 that invites a retry. That is the truthful answer here: without a
// gRPC tunnel there is no file transfer, no PTY, no streaming, and no
// checkpoint. See the package doc for why that trade was made deliberately.
type SandboxManager struct {
	m *Manager
}

// NewSandboxManager wraps a Manager for the control plane's dispatch seam.
func NewSandboxManager(m *Manager) *SandboxManager { return &SandboxManager{m: m} }

// Compile-time proof the adapter is complete. Without it a change to
// sandbox.Manager would surface as a registration failure at startup rather
// than here.
var _ sandbox.Manager = (*SandboxManager)(nil)

// unsupported is the answer for everything the direct exec path cannot carry.
// Wrapping ErrUnsupported is what turns it into a 501 upstream.
func unsupported(op string) error {
	return fmt.Errorf("awsvmlite: %s: %w", op, awsvm.ErrUnsupported)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Create is not reachable: placement goes through the backend's Claim, which
// pops a warm box. A create arriving here would launch a SECOND box for a
// sandbox that already has one, so it refuses rather than leaking.
func (s *SandboxManager) Create(context.Context, types.SandboxConfig) (*types.Sandbox, error) {
	return nil, unsupported("create (placement is the backend's Claim)")
}

func (s *SandboxManager) Get(ctx context.Context, id string) (*types.Sandbox, error) {
	b, ok := s.m.BoxFor(id)
	if !ok {
		return nil, fmt.Errorf("awsvmlite: sandbox %s not found", id)
	}
	// Status comes from AWS, not the local binding: the binding is exactly what
	// goes stale when a box dies underneath us, and Get is where a caller asks
	// whether the sandbox is really there.
	box, err := s.m.client.Get(ctx, b.MicrovmID)
	if err != nil {
		return nil, err
	}
	status := types.SandboxStatusRunning
	if !box.Alive() {
		status = types.SandboxStatusStopped
	}
	return &types.Sandbox{
		ID:        id,
		Template:  b.Meta.Template,
		Status:    status,
		StartedAt: b.boundAt,
		CpuCount:  b.Meta.CPUCount,
		MemoryMB:  b.Meta.MemoryMB,
	}, nil
}

func (s *SandboxManager) Kill(ctx context.Context, id string) error {
	return s.m.Destroy(ctx, id)
}

func (s *SandboxManager) List(context.Context) ([]types.Sandbox, error) {
	bound := s.m.Bound()
	out := make([]types.Sandbox, 0, len(bound))
	for id, b := range bound {
		out = append(out, types.Sandbox{
			ID:        id,
			Template:  b.Meta.Template,
			Status:    types.SandboxStatusRunning,
			StartedAt: b.boundAt,
			CpuCount:  b.Meta.CPUCount,
			MemoryMB:  b.Meta.MemoryMB,
		})
	}
	return out, nil
}

func (s *SandboxManager) Count(context.Context) (int, error) {
	return len(s.m.Bound()), nil
}

// IsSandboxAlive gates billing, so it asks AWS rather than trusting the local
// map — a stale binding metering a terminated box is the failure this exists to
// prevent. An error is reported as not-alive: skipping a tick costs a fraction
// of a cent, and billing a sandbox that does not exist costs trust.
func (s *SandboxManager) IsSandboxAlive(ctx context.Context, id string) (bool, error) {
	alive, err := s.m.Alive(ctx, id)
	if err != nil {
		return false, nil
	}
	return alive, nil
}

func (s *SandboxManager) Close() {}

// ── Execution ───────────────────────────────────────────────────────────────

// Exec is the whole point of this backend: one HTTPS POST, no tunnel.
func (s *SandboxManager) Exec(ctx context.Context, sandboxID string, cfg types.ProcessConfig) (*types.ProcessResult, error) {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 60
	}
	res, err := s.m.Exec(ctx, sandboxID, RunRequest{
		Cmd:        cfg.Command,
		Args:       cfg.Args,
		Env:        cfg.Env,
		Cwd:        cfg.Cwd,
		TimeoutSec: timeout,
	})
	if err != nil {
		return nil, err
	}
	return &types.ProcessResult{
		ExitCode: res.ExitCode,
		Stdout:   res.Stdout,
		Stderr:   res.Stderr,
	}, nil
}

// ── Filesystem ──────────────────────────────────────────────────────────────
//
// All refused. The agent's file RPCs are gRPC, and gRPC is the one thing this
// path deliberately cannot speak. A customer gets 501 rather than a hang or a
// half-written file.

func (s *SandboxManager) ReadFile(context.Context, string, string) (string, error) {
	return "", unsupported("read file")
}

func (s *SandboxManager) WriteFile(context.Context, string, string, string) error {
	return unsupported("write file")
}

func (s *SandboxManager) ReadFileStream(context.Context, string, string) (io.ReadCloser, int64, error) {
	return nil, 0, unsupported("read file stream")
}

func (s *SandboxManager) WriteFileStream(context.Context, string, string, uint32, io.Reader) (int64, error) {
	return 0, unsupported("write file stream")
}

func (s *SandboxManager) ListDir(context.Context, string, string) ([]types.EntryInfo, error) {
	return nil, unsupported("list dir")
}

func (s *SandboxManager) MakeDir(context.Context, string, string) error {
	return unsupported("make dir")
}

func (s *SandboxManager) Remove(context.Context, string, string) error {
	return unsupported("remove")
}

func (s *SandboxManager) Exists(context.Context, string, string) (bool, error) {
	return false, unsupported("exists")
}

func (s *SandboxManager) Stat(context.Context, string, string) (*types.FileInfo, error) {
	return nil, unsupported("stat")
}

// ── Everything else ─────────────────────────────────────────────────────────

// SetResourceLimits: sizing belongs to the image, so there is no per-sandbox
// knob to turn. Same answer the agent-path backend gives.
func (s *SandboxManager) SetResourceLimits(context.Context, string, int32, int64, int64, int64) error {
	return unsupported("set resource limits")
}

// UpdateSandboxSecret reports (false, nil) — "no session matched" — rather than
// an error, which is the contract the secret-store update flow expects for a
// transient miss. There is no secrets proxy on this path to update.
func (s *SandboxManager) UpdateSandboxSecret(context.Context, string, string, string) (bool, error) {
	return false, nil
}

func (s *SandboxManager) Stats(context.Context, string) (*sandbox.SandboxStats, error) {
	return nil, unsupported("stats")
}

func (s *SandboxManager) HostPort(context.Context, string) (int, error) {
	return 0, unsupported("host port")
}

func (s *SandboxManager) ContainerAddr(context.Context, string, int) (string, error) {
	return "", unsupported("container addr")
}

// DataDir has no meaning here — the host is managed and its disk is not ours to
// name — but it must not panic, because callers log it.
func (s *SandboxManager) DataDir() string { return "" }

func (s *SandboxManager) ContainerName(id string) string { return id }

// Hibernate/Wake: parking needs the workspace archived out of the guest, and
// that is a file transfer over the agent. Refused rather than half-done — a
// hibernate that reported success without an archive would destroy the box and
// the customer's data with it.
func (s *SandboxManager) Hibernate(context.Context, string, *storage.CheckpointStore) (*sandbox.HibernateResult, error) {
	return nil, unsupported("hibernate")
}

func (s *SandboxManager) Wake(context.Context, string, string, *storage.CheckpointStore, int) (*types.Sandbox, error) {
	return nil, unsupported("wake")
}

func (s *SandboxManager) RebootSandbox(context.Context, string) error {
	return unsupported("reboot")
}

func (s *SandboxManager) PowerCycleSandbox(context.Context, string) (int, error) {
	return 0, unsupported("power cycle")
}

func (s *SandboxManager) TemplateCachePath(string, string) string { return "" }

func (s *SandboxManager) CreateCheckpoint(context.Context, string, string, *storage.CheckpointStore, func()) (string, string, int64, error) {
	return "", "", 0, unsupported("create checkpoint")
}

func (s *SandboxManager) RestoreFromCheckpoint(context.Context, string, string) error {
	return unsupported("restore from checkpoint")
}

func (s *SandboxManager) ForkFromCheckpoint(context.Context, string, types.SandboxConfig) (*types.Sandbox, error) {
	return nil, unsupported("fork from checkpoint")
}

func (s *SandboxManager) CheckpointCachePath(string, string) string { return "" }
