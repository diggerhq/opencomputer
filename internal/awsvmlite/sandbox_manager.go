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
// So this type implements ALL of it. Most of it is served — exec, files, stats,
// reboot — by the guest front door in dataplane.go. What is left returns
// awsvm.ErrUnsupported, which the API layer maps to 501 Not Implemented: "this
// runtime will never do that", as distinct from a 500 that invites a retry.
//
// Still refused, and why: PTY and streaming exec sessions need a bidirectional
// stream this path has not built; checkpoint and fork have no counterpart in
// the service, since a MicroVM image is produced through an API rather than
// captured from a running box; resource limits have no knob, because sizing is
// a property of the image.
type SandboxManager struct {
	m *Manager
	// store is where checkpoint archives live. RestoreFromCheckpoint is handed
	// only a checkpoint id — unlike CreateCheckpoint, which receives the store
	// per call — so the adapter has to hold one.
	store *storage.CheckpointStore
}

// NewSandboxManager wraps a Manager for the control plane's dispatch seam.
func NewSandboxManager(m *Manager) *SandboxManager { return &SandboxManager{m: m} }

// WithCheckpointStore attaches the blob store used by RestoreFromCheckpoint.
func (s *SandboxManager) WithCheckpointStore(store *storage.CheckpointStore) *SandboxManager {
	s.store = store
	// The Manager needs it too: the create path restores a template archive
	// through the Manager directly, with no adapter involved.
	if s.m != nil {
		s.m.SetCheckpointStore(store)
	}
	return s
}

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
	// Parked first, because the provider disagrees: Box.Alive() counts a
	// SUSPENDED microvm as alive — for its purposes the host still exists — so
	// asking only that question reports a hibernated sandbox as `running`. The
	// customer then sees a live sandbox that is actually asleep, and it keeps
	// counting against their concurrency limit.
	status := types.SandboxStatusRunning
	switch {
	case s.m.IsHibernated(id):
		status = types.SandboxStatusHibernated
	case !box.Alive():
		status = types.SandboxStatusStopped
	}
	return &types.Sandbox{
		ID:        id,
		Template:  b.Meta.Template,
		Status:    status,
		StartedAt: b.boundAt,
		// When the provider destroys this host, whatever anyone does. Surfaced
		// because it is the honest answer to "how long do I have": the cap
		// counts from LAUNCH, so a sandbox claimed off the warm set already has
		// less than a full window, and a customer who cannot see it only finds
		// out when the sandbox disappears. Zero when it cannot be determined —
		// never a guess, which would read as a promise. See awsvm.Config.Deadline.
		EndAt:    s.m.DeadlineFor(id),
		CpuCount: b.Meta.CPUCount,
		MemoryMB: b.Meta.MemoryMB,
	}, nil
}

func (s *SandboxManager) Kill(ctx context.Context, id string) error {
	return s.m.Destroy(ctx, id)
}

func (s *SandboxManager) List(context.Context) ([]types.Sandbox, error) {
	bound := s.m.Bound()
	out := make([]types.Sandbox, 0, len(bound))
	for id, b := range bound {
		// Same reasoning as Get: a parked sandbox is not running, and listing it
		// as such is what a customer's dashboard would show.
		status := types.SandboxStatusRunning
		if s.m.IsHibernated(id) {
			status = types.SandboxStatusHibernated
		}
		out = append(out, types.Sandbox{
			ID:        id,
			Template:  b.Meta.Template,
			Status:    status,
			StartedAt: b.boundAt,
			EndAt:     s.m.DeadlineFor(id),
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
	// A hibernated sandbox is not alive FOR BILLING, which is the only question
	// this method is asked. AWS disagrees — Box.Alive() counts SUSPENDED as
	// alive, because for AWS's purposes the microvm still exists — so without
	// this check a customer who parked a sandbox would go on being metered at
	// the full rate for it, indefinitely, while every status the product shows
	// them says hibernated.
	if s.m.IsHibernated(id) {
		return false, nil
	}
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
// Served, not refused. These were 501 for as long as this backend had no way to
// carry gRPC to the agent — but the obstacle was always the PROXY HOP stripping
// HTTP/2 trailers, never the agent. The guest now translates: plain JSON across
// the proxy, loopback gRPC to the agent behind it. See internal/awsvmlite's
// dataplane.go and cmd/microvm-hooks/oc.go.

func (s *SandboxManager) ReadFile(ctx context.Context, sandboxID, path string) (string, error) {
	return s.m.ReadFile(ctx, sandboxID, path)
}

func (s *SandboxManager) WriteFile(ctx context.Context, sandboxID, path, content string) error {
	return s.m.WriteFile(ctx, sandboxID, path, content)
}

func (s *SandboxManager) ReadFileStream(ctx context.Context, sandboxID, path string) (io.ReadCloser, int64, error) {
	return s.m.ReadFileStream(ctx, sandboxID, path)
}

func (s *SandboxManager) WriteFileStream(ctx context.Context, sandboxID, path string, mode uint32, r io.Reader) (int64, error) {
	return s.m.WriteFileStream(ctx, sandboxID, path, mode, r)
}

func (s *SandboxManager) ListDir(ctx context.Context, sandboxID, path string) ([]types.EntryInfo, error) {
	return s.m.ListDir(ctx, sandboxID, path)
}

func (s *SandboxManager) MakeDir(ctx context.Context, sandboxID, path string) error {
	return s.m.MakeDir(ctx, sandboxID, path)
}

func (s *SandboxManager) Remove(ctx context.Context, sandboxID, path string) error {
	return s.m.Remove(ctx, sandboxID, path)
}

func (s *SandboxManager) Exists(ctx context.Context, sandboxID, path string) (bool, error) {
	return s.m.Exists(ctx, sandboxID, path)
}

func (s *SandboxManager) Stat(ctx context.Context, sandboxID, path string) (*types.FileInfo, error) {
	return s.m.Stat(ctx, sandboxID, path)
}

// ── Everything else ─────────────────────────────────────────────────────────

// SetResourceLimits: sizing belongs to the image, so there is no per-sandbox
// knob to turn. Same answer the agent-path backend gives.
func (s *SandboxManager) SetResourceLimits(context.Context, string, int32, int64, int64, int64) error {
	return unsupported("set resource limits")
}

// UpdateSandboxSecret refreshes one secret in the guest's proxy session.
//
// (false, nil) means no session or no name matched, which is what the
// secret-store refresh flow expects for a sandbox that does not hold the secret
// being rotated — it sweeps every sandbox in an org, and most are misses. An
// ERROR is reserved for a box that could not be reached, so a rotation that
// silently failed to land is distinguishable from one that had nothing to do.
func (s *SandboxManager) UpdateSandboxSecret(ctx context.Context, sandboxID, secretName, value string) (bool, error) {
	return s.m.UpdateSecret(ctx, sandboxID, secretName, value)
}

func (s *SandboxManager) Stats(ctx context.Context, sandboxID string) (*sandbox.SandboxStats, error) {
	return s.m.Stats(ctx, sandboxID)
}

// HostPort is 0 and no error, as on the agent path: nothing publishes a host
// port here, and 0 is the honest answer rather than a fabricated one.
func (s *SandboxManager) HostPort(context.Context, string) (int, error) {
	return 0, nil
}

// ContainerAddr returns the box's HTTPS host. Note that this address is NOT
// dialable on its own — reaching a guest port needs the runtime's auth token
// and the port carried in the path, which a bare address cannot express. The
// preview proxy therefore uses liteBackend.PreviewTarget, and this exists so
// callers that only want to know where the sandbox lives get an answer instead
// of an error.
func (s *SandboxManager) ContainerAddr(_ context.Context, sandboxID string, _ int) (string, error) {
	host, _, _, err := s.m.PreviewTarget(sandboxID)
	if err != nil {
		return "", err
	}
	return host, nil
}

// DataDir has no meaning here — the host is managed and its disk is not ours to
// name — but it must not panic, because callers log it.
func (s *SandboxManager) DataDir() string { return "" }

func (s *SandboxManager) ContainerName(id string) string { return id }

// Hibernate parks the sandbox by suspending its box. See hibernate.go for what
// that does and does not buy — in particular that it defers cost, not the 8h
// service cap, and that a parked box holds quota it can never give back.
//
// The checkpoint store is ignored, and no key is returned: there is no archive.
// The state lives in the suspended box itself, which is why Wake below does not
// take one either.
func (s *SandboxManager) Hibernate(ctx context.Context, sandboxID string, _ *storage.CheckpointStore) (*sandbox.HibernateResult, error) {
	if err := s.m.Hibernate(ctx, sandboxID); err != nil {
		return nil, err
	}
	return &sandbox.HibernateResult{SandboxID: sandboxID}, nil
}

// Wake resumes the suspended box. The sandbox comes back on the SAME box it was
// parked on — unlike an archive restore, which lands on a new host — so there is
// no new worker_id for the caller to persist.
func (s *SandboxManager) Wake(ctx context.Context, sandboxID, _ string, _ *storage.CheckpointStore, _ int) (*types.Sandbox, error) {
	if err := s.m.Wake(ctx, sandboxID); err != nil {
		return nil, err
	}
	return s.Get(ctx, sandboxID)
}

// RebootSandbox restarts the workload in place: every process the sandbox user
// owns is killed and the agent is restarted. See Manager.Reboot for why this is
// not — and cannot be — a kernel restart, and why it nonetheless preserves more
// than the agent path's export/import reboot did.
func (s *SandboxManager) RebootSandbox(ctx context.Context, sandboxID string) error {
	return s.m.Reboot(ctx, sandboxID)
}

// PowerCycleSandbox is a reboot here, as it is on the agent path: this backend
// already restarts everything a power cycle would, and there is no harsher step
// to escalate to. Returns 0 for the QEMU implementation's pid — there is no host
// process to name.
func (s *SandboxManager) PowerCycleSandbox(ctx context.Context, sandboxID string) (int, error) {
	return 0, s.m.Reboot(ctx, sandboxID)
}

func (s *SandboxManager) TemplateCachePath(string, string) string { return "" }

// CreateCheckpoint archives the sandbox's workspace. See checkpoint.go for what
// that does and does not capture — in short, files but not memory.
//
// Returns "" for the rootfs key, which the caller records as "there isn't one".
// The QEMU path returns two keys because it captures two things; inventing a
// second key here would make a restore look for an object that was never
// written.
// CreateDiskOnlyCheckpoint is CreateCheckpoint. On this runtime the two are the
// same operation, because every checkpoint it can make is disk-only: there is
// no way to read a running host's RAM out, so there is no memory half to omit.
//
// Both names exist because the API distinguishes them for the QEMU fleet, where
// a full checkpoint really does capture memory and costs far more. A caller
// asking for disk-only here should get a checkpoint, not "not supported" —
// which is what it got while only the full-shaped name was implemented, so the
// SDK's plain createCheckpoint(name) worked and an explicit disk_only did not.
func (s *SandboxManager) CreateDiskOnlyCheckpoint(ctx context.Context, sandboxID, checkpointID string, store *storage.CheckpointStore, onReady func()) (string, string, int64, error) {
	return s.CreateCheckpoint(ctx, sandboxID, checkpointID, store, onReady)
}

func (s *SandboxManager) CreateCheckpoint(ctx context.Context, sandboxID, checkpointID string, store *storage.CheckpointStore, onReady func()) (string, string, int64, error) {
	key := WorkspaceKey(checkpointID)
	size, err := s.m.CheckpointWorkspace(ctx, sandboxID, key, store)
	if err != nil {
		return "", "", 0, err
	}
	// Fired only after the upload is durable: onReady is what flips the row to
	// ready, and a checkpoint advertised as ready before its object exists is
	// one a fork will fail to find.
	if onReady != nil {
		onReady()
	}
	return "", key, size, nil
}

// RestoreFromCheckpoint unpacks a checkpoint's workspace into a running
// sandbox. The sandbox keeps its box — there is nothing to reboot, because
// nothing but files changed.
func (s *SandboxManager) RestoreFromCheckpoint(ctx context.Context, sandboxID, checkpointID string) error {
	if s.store == nil {
		return fmt.Errorf("awsvmlite: restore %s: no checkpoint store configured", sandboxID)
	}
	return s.m.RestoreWorkspace(ctx, sandboxID, WorkspaceKey(checkpointID), s.store)
}

// ForkFromCheckpoint is refused, deliberately, even though the pieces exist.
//
// A fork has to CREATE a sandbox, and creation on this backend belongs to the
// placement path (see Create above): the backend's Claim pops a warm box, binds
// it, and the control plane records the row. A manager that launched its own
// box here would produce one nothing had placed, nothing had persisted, and
// therefore nothing would ever reap — the exact leak RequiresPersistedRow
// exists to prevent.
//
// The right shape is a create that carries a checkpoint id and restores after
// the claim, which is a change to the create flow rather than to this method.
// Until then this refuses rather than leaking boxes.
func (s *SandboxManager) ForkFromCheckpoint(context.Context, string, types.SandboxConfig) (*types.Sandbox, error) {
	return nil, unsupported("fork from checkpoint")
}

func (s *SandboxManager) CheckpointCachePath(string, string) string { return "" }
