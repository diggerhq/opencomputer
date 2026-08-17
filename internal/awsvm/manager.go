package awsvm

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// manager.go — sandbox.Manager over Lambda MicroVMs.
//
// The QEMU manager owns processes, disks, networking and snapshots. This one
// owns almost nothing: AWS holds the VM, and the two things we keep locally are
// a sandboxID→MicroVM mapping and a pool of agent channels. That asymmetry is
// the point — it is why the backend is a few hundred lines instead of the
// tens of thousands internal/qemu needs.
//
// Deliberately unsupported here (see ErrUnsupported): checkpoints, fork-from-
// checkpoint, template/checkpoint caches, reboot and power-cycle. Those are
// snapshot-and-disk operations with no counterpart in this service; a MicroVM
// image is built through an API, not captured from a running box. They return a
// typed error the control plane can turn into a clean 4xx rather than a panic
// or, worse, a silent success.

// ErrUnsupported marks a Manager capability this backend does not implement.
// Callers should surface it as "not available on this runtime", never retry it.
//
// The API boundary substitutes its own text, so this string is not
// customer-visible today — but error text is exactly what escapes into a
// response, a webhook, or a support ticket later, so it stays generic.
var ErrUnsupported = errors.New("awsvm: operation not supported by this sandbox runtime")

func unsupported(op string) error { return fmt.Errorf("%s: %w", op, ErrUnsupported) }

// entry is one sandbox's local bookkeeping.
type entry struct {
	sandboxID string
	microvmID string
	endpoint  string
	template  string
	cpuCount  int
	memoryMB  int
	startedAt time.Time
}

// Manager implements sandbox.Manager against AWS Lambda MicroVMs.
type Manager struct {
	client  *Client
	agents  *agentPool
	dataDir string

	mu   sync.RWMutex
	byID map[string]*entry
}

// Compile-time proof this backend satisfies the same contract as internal/qemu.
// internal/firecracker carried this same assertion and still rotted, because
// nothing built it — keep this package in the build/test matrix.
var _ sandbox.Manager = (*Manager)(nil)

// NewManager builds the backend. dataDir is only used for the Manager's own
// scratch space; unlike QEMU there are no disks to keep there.
func NewManager(client *Client, dataDir string) *Manager {
	return &Manager{
		client:  client,
		agents:  newAgentPool(),
		dataDir: dataDir,
		byID:    make(map[string]*entry),
	}
}

// track records a sandboxID→MicroVM binding. Exported so the pool filler can
// hand pre-launched boxes to the manager at claim time without a second
// RunMicrovm — the fast path where the edge answers a create from stock.
// TrackClaimed binds a pooled box to a sandbox id and adopts the tunnel the
// pool already established, so the customer's first exec is warm (~85ms) rather
// than paying the ~1.4s dial. This is the claim path: still zero AWS calls.
func (m *Manager) TrackClaimed(sandboxID string, e *StockEntry, cfg types.SandboxConfig) {
	m.Track(sandboxID, &Box{ID: e.MicrovmID, Endpoint: e.Endpoint}, cfg)
	if e.agent != nil {
		m.agents.put(sandboxID, e.agent)
	}
}

// Default sizing for a MicroVM whose SandboxConfig does not state one.
//
// These are NOT cosmetic: the usage ticker reads memoryMB/cpuCount off List()
// and puts them in every usage_tick, which is what pro-tier metering prices on.
// Left at zero — which is what a create without an explicit size, or a Restore
// after a control-plane restart, would otherwise produce — every sandbox meters
// as if it consumed nothing.
//
// 2048 MiB matches the image's minimumMemoryInMiB, and Lambda gives a full vCPU
// at that baseline (peak scales to 4x).
const (
	defaultMicrovmMemoryMB = 2048
	defaultMicrovmCPUCount = 1
)

func (m *Manager) Track(sandboxID string, box *Box, cfg types.SandboxConfig) {
	memoryMB, cpuCount := cfg.MemoryMB, cfg.CpuCount
	if memoryMB <= 0 {
		memoryMB = defaultMicrovmMemoryMB
	}
	if cpuCount <= 0 {
		cpuCount = defaultMicrovmCPUCount
	}
	m.mu.Lock()
	m.byID[sandboxID] = &entry{
		sandboxID: sandboxID,
		microvmID: box.ID,
		endpoint:  box.Endpoint,
		template:  cfg.Template,
		cpuCount:  cpuCount,
		memoryMB:  memoryMB,
		startedAt: time.Now(),
	}
	m.mu.Unlock()
}

// MicrovmIDFor returns the AWS MicroVM id bound to a sandbox, from memory only.
//
// Separate from Get because Get calls AWS to report live status. Callers on a
// hot path that only need the binding — the event publisher stamps one on every
// envelope it flushes — must not turn that into a GetMicrovm per event.
func (m *Manager) MicrovmIDFor(sandboxID string) (string, bool) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return "", false
	}
	return e.microvmID, true
}

func (m *Manager) lookup(sandboxID string) (*entry, error) {
	m.mu.RLock()
	e, ok := m.byID[sandboxID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("awsvm: sandbox %s not found", sandboxID)
	}
	return e, nil
}

// agentFor returns the sandbox's agent channel, dialing on first use. The token
// provider closes over the MicroVM id so refreshes are transparent to callers.
func (m *Manager) agentFor(e *entry) (*agentConn, error) {
	return m.agents.get(e.sandboxID, e.endpoint, m.client.Config().AgentPort,
		func(ctx context.Context) (string, error) {
			return m.client.AuthToken(ctx, e.microvmID)
		})
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Create launches a MicroVM for a sandbox. The sandbox id is used as the AWS
// client token so a retried create rejoins the same VM instead of leaking one —
// leaked VMs hold regional memory quota, which is the real cap on pool depth.
func (m *Manager) Create(ctx context.Context, cfg types.SandboxConfig) (*types.Sandbox, error) {
	sandboxID := cfg.SandboxID
	if sandboxID == "" {
		return nil, fmt.Errorf("awsvm: create requires a pre-assigned sandbox id")
	}
	box, err := m.client.Run(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	m.Track(sandboxID, box, cfg)
	log.Printf("awsvm: created %s (microvm=%s endpoint=%s)", sandboxID, box.ID, box.Endpoint)

	return &types.Sandbox{
		ID:        sandboxID,
		Template:  cfg.Template,
		Status:    types.SandboxStatusRunning,
		StartedAt: time.Now(),
		CpuCount:  cfg.CpuCount,
		MemoryMB:  cfg.MemoryMB,
	}, nil
}

func (m *Manager) Get(ctx context.Context, id string) (*types.Sandbox, error) {
	e, err := m.lookup(id)
	if err != nil {
		return nil, err
	}
	box, err := m.client.Get(ctx, e.microvmID)
	if err != nil {
		return nil, err
	}
	return &types.Sandbox{
		ID:        id,
		Template:  e.template,
		Status:    statusFor(box),
		StartedAt: e.startedAt,
		CpuCount:  e.cpuCount,
		MemoryMB:  e.memoryMB,
	}, nil
}

// statusFor maps MicroVM lifecycle onto our sandbox status. SUSPENDED reads as
// hibernated: state is preserved and auto-resume brings it back on demand,
// which is exactly our paused-hibernation contract.
func statusFor(b *Box) types.SandboxStatus {
	switch {
	case b == nil:
		return types.SandboxStatusStopped
	case !b.Alive():
		return types.SandboxStatusStopped
	default:
		return types.SandboxStatusRunning
	}
}

func (m *Manager) Kill(ctx context.Context, id string) error {
	e, err := m.lookup(id)
	if err != nil {
		return nil // already gone; destroy is idempotent
	}
	m.agents.drop(id)
	if err := m.client.Terminate(ctx, e.microvmID); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.byID, id)
	m.mu.Unlock()
	return nil
}

func (m *Manager) List(ctx context.Context) ([]types.Sandbox, error) {
	m.mu.RLock()
	entries := make([]*entry, 0, len(m.byID))
	for _, e := range m.byID {
		entries = append(entries, e)
	}
	m.mu.RUnlock()

	out := make([]types.Sandbox, 0, len(entries))
	for _, e := range entries {
		out = append(out, types.Sandbox{
			ID:        e.sandboxID,
			Template:  e.template,
			Status:    types.SandboxStatusRunning,
			StartedAt: e.startedAt,
			CpuCount:  e.cpuCount,
			MemoryMB:  e.memoryMB,
		})
	}
	return out, nil
}

func (m *Manager) Count(ctx context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.byID), nil
}

// IsSandboxAlive gates billing, so it asks AWS rather than trusting local state:
// a stale in-memory entry driving usage events on a terminated VM is the exact
// "ghost VM" bug this call exists to prevent.
func (m *Manager) IsSandboxAlive(ctx context.Context, id string) (bool, error) {
	e, err := m.lookup(id)
	if err != nil {
		return false, nil
	}
	box, err := m.client.Get(ctx, e.microvmID)
	if err != nil {
		return false, nil
	}
	return box.Alive(), nil
}

func (m *Manager) Close() { m.agents.closeAll() }

// ── Execution ───────────────────────────────────────────────────────────────

func (m *Manager) Exec(ctx context.Context, sandboxID string, cfg types.ProcessConfig) (*types.ProcessResult, error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return nil, err
	}
	a, err := m.agentFor(e)
	if err != nil {
		return nil, err
	}

	timeout := int32(cfg.Timeout)
	if timeout <= 0 {
		timeout = 60
	}
	command, args := cfg.Command, cfg.Args
	if len(args) == 0 {
		args = []string{"-c", command}
		command = "/bin/sh"
	}

	resp, err := a.client.Exec(ctx, &pb.ExecRequest{
		Command:        command,
		Args:           args,
		Envs:           cfg.Env,
		Cwd:            cfg.Cwd,
		TimeoutSeconds: timeout,
	})
	if err != nil {
		return nil, fmt.Errorf("awsvm: exec in %s: %w", sandboxID, err)
	}
	return &types.ProcessResult{
		ExitCode: int(resp.ExitCode),
		Stdout:   resp.Stdout,
		Stderr:   resp.Stderr,
	}, nil
}

// ── Filesystem ──────────────────────────────────────────────────────────────

func (m *Manager) ReadFile(ctx context.Context, sandboxID, path string) (string, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return "", err
	}
	resp, err := a.client.ReadFile(ctx, &pb.ReadFileRequest{Path: path})
	if err != nil {
		return "", err
	}
	return string(resp.Content), nil
}

func (m *Manager) WriteFile(ctx context.Context, sandboxID, path, content string) error {
	a, err := m.agent(sandboxID)
	if err != nil {
		return err
	}
	_, err = a.client.WriteFile(ctx, &pb.WriteFileRequest{Path: path, Content: []byte(content)})
	return err
}

func (m *Manager) ListDir(ctx context.Context, sandboxID, path string) ([]types.EntryInfo, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return nil, err
	}
	resp, err := a.client.ListDir(ctx, &pb.ListDirRequest{Path: path})
	if err != nil {
		return nil, err
	}
	out := make([]types.EntryInfo, 0, len(resp.Entries))
	for _, e := range resp.Entries {
		out = append(out, types.EntryInfo{Name: e.Name, IsDir: e.IsDir, Size: e.Size, Path: e.Path})
	}
	return out, nil
}

func (m *Manager) MakeDir(ctx context.Context, sandboxID, path string) error {
	a, err := m.agent(sandboxID)
	if err != nil {
		return err
	}
	_, err = a.client.MakeDir(ctx, &pb.MakeDirRequest{Path: path})
	return err
}

func (m *Manager) Remove(ctx context.Context, sandboxID, path string) error {
	a, err := m.agent(sandboxID)
	if err != nil {
		return err
	}
	_, err = a.client.Remove(ctx, &pb.RemoveRequest{Path: path})
	return err
}

func (m *Manager) Exists(ctx context.Context, sandboxID, path string) (bool, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return false, err
	}
	resp, err := a.client.Exists(ctx, &pb.ExistsRequest{Path: path})
	if err != nil {
		return false, err
	}
	return resp.Exists, nil
}

func (m *Manager) Stat(ctx context.Context, sandboxID, path string) (*types.FileInfo, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return nil, err
	}
	resp, err := a.client.Stat(ctx, &pb.StatRequest{Path: path})
	if err != nil {
		return nil, err
	}
	return &types.FileInfo{
		Name: resp.Name, IsDir: resp.IsDir, Size: resp.Size,
		Mode: resp.Mode, ModTime: resp.ModTime, Path: resp.Path,
	}, nil
}

// agent is the lookup+dial shorthand the filesystem methods share.
func (m *Manager) agent(sandboxID string) (*agentConn, error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return nil, err
	}
	return m.agentFor(e)
}

// ── Monitoring ──────────────────────────────────────────────────────────────

func (m *Manager) Stats(ctx context.Context, sandboxID string) (*sandbox.SandboxStats, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return nil, err
	}
	resp, err := a.client.Stats(ctx, &pb.StatsRequest{})
	if err != nil {
		return nil, err
	}
	return &sandbox.SandboxStats{
		CPUPercent: resp.CpuPercent,
		MemUsage:   resp.MemUsage,
		MemLimit:   resp.MemLimit,
		NetInput:   resp.NetInput,
		NetOutput:  resp.NetOutput,
		PIDs:       int(resp.Pids),
	}, nil
}

func (m *Manager) DataDir() string { return m.dataDir }

func (m *Manager) ContainerName(id string) string { return "microvm-" + id }

// HostPort has no meaning here: there is no host publishing a port. Customer
// traffic reaches the guest through the MicroVM's own HTTPS endpoint, so 0 is
// the honest answer rather than a fabricated port.
func (m *Manager) HostPort(ctx context.Context, sandboxID string) (int, error) { return 0, nil }

// ContainerAddr returns the endpoint a caller should use to reach a guest port.
// Unlike the QEMU backend this is a public HTTPS endpoint, and the caller must
// also present an auth token plus X-aws-proxy-port.
func (m *Manager) ContainerAddr(ctx context.Context, sandboxID string, port int) (string, error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return "", err
	}
	return AgentURL(e.endpoint), nil
}

// ── Hibernation ─────────────────────────────────────────────────────────────

// Hibernate suspends the MicroVM. AWS snapshots memory and disk itself, so
// there is no checkpoint to upload and no key to hand back — which is why
// SizeBytes is 0 and the store argument is ignored.
func (m *Manager) Hibernate(ctx context.Context, sandboxID string, _ *storage.CheckpointStore) (*sandbox.HibernateResult, error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return nil, err
	}
	if err := m.client.Suspend(ctx, e.microvmID); err != nil {
		return nil, err
	}
	return &sandbox.HibernateResult{SandboxID: sandboxID, HibernationKey: e.microvmID}, nil
}

// Wake resumes a suspended MicroVM. Callers that are about to send a request
// could skip this and let auto-resume cover it, but waking explicitly keeps the
// control plane's state machine honest about when the box became RUNNING.
func (m *Manager) Wake(ctx context.Context, sandboxID string, _ string, _ *storage.CheckpointStore, _ int) (*types.Sandbox, error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return nil, err
	}
	if err := m.client.Resume(ctx, e.microvmID); err != nil {
		return nil, err
	}
	return &types.Sandbox{
		ID: sandboxID, Template: e.template, Status: types.SandboxStatusRunning,
		StartedAt: e.startedAt, CpuCount: e.cpuCount, MemoryMB: e.memoryMB,
	}, nil
}

// ── Not supported on this backend ───────────────────────────────────────────

// SetResourceLimits is a no-op: a MicroVM's shape is fixed by its image and run
// configuration, and cannot be resized in place the way virtio-mem allows.
// Returning nil rather than an error keeps the control plane's post-claim grow
// step harmless instead of failing every create.
func (m *Manager) SetResourceLimits(ctx context.Context, sandboxID string, maxPids int32, maxMemoryBytes, cpuMaxUsec, cpuPeriodUsec int64) error {
	return nil
}

func (m *Manager) UpdateSandboxSecret(ctx context.Context, sandboxID, secretName, value string) (bool, error) {
	return false, unsupported("UpdateSandboxSecret")
}

// ReadFileStream streams a file out of the guest.
//
// This works for the same reason exec does: the agent channel is a real gRPC
// connection tunnelled inside a WebSocket, so server-streaming RPCs traverse it
// unchanged. (It was briefly stubbed as unsupported on the assumption that
// streaming through Lambda's proxy was unsafe — the tunnel is precisely what
// makes that assumption obsolete.)
func (m *Manager) ReadFileStream(ctx context.Context, sandboxID, path string) (io.ReadCloser, int64, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return nil, 0, err
	}
	stream, err := a.client.ReadFileStream(ctx, &pb.ReadFileStreamRequest{Path: path})
	if err != nil {
		return nil, 0, fmt.Errorf("awsvm: read file stream %s: %w", path, err)
	}

	// Pull the first chunk eagerly: total_size only rides on it, and callers
	// need the size before they start reading.
	first, err := stream.Recv()
	if err != nil {
		if err == io.EOF {
			return io.NopCloser(bytes.NewReader(nil)), 0, nil
		}
		return nil, 0, fmt.Errorf("awsvm: read file stream %s: %w", path, err)
	}

	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		if _, err := pw.Write(first.Data); err != nil {
			return
		}
		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				return
			}
			if err != nil {
				// Surface the failure to the reader rather than truncating
				// silently, which would look like a short but successful file.
				pw.CloseWithError(fmt.Errorf("awsvm: read file stream %s: %w", path, err))
				return
			}
			if _, err := pw.Write(chunk.Data); err != nil {
				return
			}
		}
	}()
	return pr, first.TotalSize, nil
}

// WriteFileStream streams a file into the guest. Client-streaming gRPC over the
// same tunnel; path and mode ride the first message only, per the proto.
func (m *Manager) WriteFileStream(ctx context.Context, sandboxID, path string, mode uint32, r io.Reader) (int64, error) {
	a, err := m.agent(sandboxID)
	if err != nil {
		return 0, err
	}
	stream, err := a.client.WriteFileStream(ctx)
	if err != nil {
		return 0, fmt.Errorf("awsvm: write file stream %s: %w", path, err)
	}

	buf := make([]byte, 256*1024)
	first := true
	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			msg := &pb.WriteFileStreamRequest{Data: buf[:n]}
			if first {
				msg.Path, msg.Mode = path, mode
				first = false
			}
			if err := stream.Send(msg); err != nil {
				return 0, fmt.Errorf("awsvm: write file stream %s: %w", path, err)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return 0, fmt.Errorf("awsvm: write file stream %s: read source: %w", path, readErr)
		}
	}
	// An empty file still needs one message, or the agent never learns the path.
	if first {
		if err := stream.Send(&pb.WriteFileStreamRequest{Path: path, Mode: mode}); err != nil {
			return 0, fmt.Errorf("awsvm: write file stream %s: %w", path, err)
		}
	}

	resp, err := stream.CloseAndRecv()
	if err != nil {
		return 0, fmt.Errorf("awsvm: write file stream %s: %w", path, err)
	}
	return resp.BytesWritten, nil
}

func (m *Manager) RebootSandbox(ctx context.Context, sandboxID string) error {
	return unsupported("RebootSandbox")
}

func (m *Manager) PowerCycleSandbox(ctx context.Context, sandboxID string) (int, error) {
	return 0, unsupported("PowerCycleSandbox")
}

func (m *Manager) TemplateCachePath(templateID, filename string) string { return "" }

func (m *Manager) CheckpointCachePath(checkpointID, filename string) string { return "" }

func (m *Manager) CreateCheckpoint(ctx context.Context, sandboxID, checkpointID string, _ *storage.CheckpointStore, _ func()) (string, string, int64, error) {
	return "", "", 0, unsupported("CreateCheckpoint")
}

func (m *Manager) RestoreFromCheckpoint(ctx context.Context, sandboxID, checkpointID string) error {
	return unsupported("RestoreFromCheckpoint")
}

func (m *Manager) ForkFromCheckpoint(ctx context.Context, checkpointID string, cfg types.SandboxConfig) (*types.Sandbox, error) {
	return nil, unsupported("ForkFromCheckpoint")
}
