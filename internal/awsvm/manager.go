package awsvm

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
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
// checkpoint, and resource limits. The first two are snapshot-and-disk
// operations with no counterpart in this service — a MicroVM image is built
// through an API, not captured from a running box. The third has no knob to
// turn: sizing belongs to the image, not the sandbox (see deliveredSize). They
// return a typed error the control plane can turn into a clean 501 rather than
// a panic or, worse, a silent success.
//
// Reboot and power-cycle ARE supported (PowerCycleSandbox delegates to
// RebootSandbox); template/checkpoint caches are inert rather than erroring,
// since "" is a truthful answer to "is it cached locally".

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

	// term paces destroys against the TerminateMicrovm quota. See terminator.go
	// for why a direct call on this path leaked a box on every throttle.
	term *terminator

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
		term:    newTerminator(client),
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
	// Whether the warm tunnel actually reached the customer. This is the single
	// biggest term in benchmark TTI — TTI measures the FIRST exec, and a cold
	// dial costs ~330ms against an 82ms warm call — so it is worth one line.
	log.Printf("awsvm: TrackClaimed %s (box %s) warm_tunnel=%v", sandboxID, e.MicrovmID, e.agent != nil)
	if e.agent != nil {
		m.agents.put(sandboxID, e.agent)
		// TRANSFER OWNERSHIP. The pool and the manager would otherwise hold the
		// same *agentConn, and Pool.terminate closes e.agent — so any pool-side
		// path that retires this entry (expireReservations, aged-stock retire,
		// overshoot shed) would close the tunnel of a box a customer is already
		// using. The binding survives that, so the sandbox keeps routing and
		// every exec fails instantly with "grpc: the client connection is
		// closing" until the box is destroyed. Observed on dev: exec dead in
		// ~5ms from localhost, no network involved.
		//
		// Clearing the pool's reference is the whole fix: the manager now owns
		// the channel and closes it in agents.drop (destroy/Forget), and
		// terminate's nil check makes the pool a no-op on an adopted entry.
		e.agent = nil
	}
}

// What a MicroVM actually gets, regardless of what the create asked for.
//
// These are NOT cosmetic and they are NOT defaults: the usage ticker reads
// memoryMB/cpuCount off List() and puts them in every usage_tick, which is what
// pro-tier metering prices on. Whatever is recorded here is what the customer
// is billed for.
//
// The default image's minimumMemoryInMiB, used when Config.DefaultMemoryMB is
// unset. MUST track the image or every box is metered at the wrong size.
//
// Raised 2048 → 4096 on 2026-08-24 (image version 12.0) so the backend actually
// delivers the platform default: the API defaults a create to 4096 and QEMU
// gives 4096, while this image gave 2048 — so every default create was silently
// served half what it asked for, and metered at the half.
//
// Lambda gives a full vCPU from 2048 up (peak scales to 4x), so 4096 keeps the
// 1-vCPU tier promise. Supported sizes are an ENUM, not a free integer:
// [512, 1024, 2048, 4096, 8192] on base image al2023-1.
const (
	deliveredMicrovmMemoryMB = 4096
	deliveredMicrovmCPUCount = 1
)

// vcpusForMemory reports the vCPU count that goes with a memory tier.
//
// We do NOT control this. There is no vCPU field anywhere in the API —
// CpuConfiguration carries an Architecture (x86_64/arm64) and nothing else — so
// the platform allocates CPU as a function of memory. The tier table is
// therefore the honest reading of what a customer on that tier is buying, and
// the same number QEMU delivers for it, which is what parity means here.
//
// Unknown tiers fall back to the baseline rather than guessing upward: over-
// reporting cpuCount is an overcharge, and the meter reads this.
//
// NOT VALIDATED per tier. The proportional allocation is documented for the
// default only; the 1024 tier is the one to check first, because it is the only
// tier whose memory sits BELOW the baseline where a full vCPU is known good.
func vcpusForMemory(memoryMB int) int {
	for _, t := range types.AllowedResourceTiers {
		if t.MemoryMB == memoryMB {
			return t.VCPUs
		}
	}
	return deliveredMicrovmCPUCount
}

// deliveredSize reports what the platform actually provides for a request,
// given the memory the resolved image delivers.
//
// RunMicrovmInput has no memory or vCPU field — sizing is a property of the
// IMAGE. Offering more than one size means running more than one image and
// picking at launch (Config.SizeImages); within a single image there is no knob
// to turn at all.
//
// This used to record the REQUESTED size, which was never sent to AWS but was
// still what the meter charged for: ask for 8 GB, receive the baseline, pay for
// 8 GB. A silent overcharge that scaled with the size of the ask. Metering the
// delivered size is the only honest reading, and the mismatch is logged rather
// than swallowed so an operator can see demand the images cannot satisfy.
func deliveredSize(sandboxID string, requestedMemoryMB, requestedCPUCount, deliveredMemoryMB int) (memoryMB, cpuCount int) {
	if deliveredMemoryMB <= 0 {
		deliveredMemoryMB = deliveredMicrovmMemoryMB
	}
	cpuCount = vcpusForMemory(deliveredMemoryMB)
	if requestedMemoryMB > deliveredMemoryMB || requestedCPUCount > cpuCount {
		log.Printf("awsvm: %s requested %dMB/%dcpu but this backend delivers %dMB/%dcpu — "+
			"metering the delivered size (sizing is a property of the image)",
			sandboxID, requestedMemoryMB, requestedCPUCount,
			deliveredMemoryMB, cpuCount)
	}
	return deliveredMemoryMB, cpuCount
}

// Track records a sandbox→MicroVM binding and returns the size it recorded.
//
// The return values exist so callers can report the DELIVERED size rather than
// the requested one. Get reads them back off the entry; Create used to echo
// cfg.MemoryMB/cfg.CpuCount straight back instead, so a create asking for 8 GB
// answered "8192" and the very next Get on the same sandbox answered "2048".
// Same reasoning as deliveredSize itself: the requested number is not a fact
// about this sandbox, and repeating it anywhere is how it ends up believed.
func (m *Manager) Track(sandboxID string, box *Box, cfg types.SandboxConfig) (memoryMB, cpuCount int) {
	// Which tier this box actually is. A request for a tier we do not offer is
	// rejected in Create long before here; if one somehow reaches this point,
	// resolving to the default is the safe direction (it is what the box
	// physically is) and deliveredSize logs the mismatch.
	_, deliveredMB, _ := m.config().ImageForMemory(cfg.MemoryMB)
	memoryMB, cpuCount = deliveredSize(sandboxID, cfg.MemoryMB, cfg.CpuCount, deliveredMB)
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
	return memoryMB, cpuCount
}

// config returns the client's resolved config, tolerating a nil client.
//
// Track runs on paths that construct a Manager without one (tests, and the
// bookkeeping-only callers that never talk to AWS), so reaching through
// m.client unguarded turns a pure in-memory bind into a panic. Defaults applied
// here match applyDefaults so an unconfigured Manager still resolves the
// default tier rather than reporting 0 MB.
func (m *Manager) config() Config {
	if m == nil || m.client == nil {
		return Config{DefaultMemoryMB: deliveredMicrovmMemoryMB}
	}
	return m.client.Config()
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
	// Pick the image that delivers the requested size. A tier with no image
	// configured is refused rather than served from the default: handing a 16 GB
	// request a 4 GB box, and billing it as 4 GB, is a silent wrong-size
	// delivery — the failure mode ErrUnsupported exists to make impossible.
	image, _, ok := m.config().ImageForMemory(cfg.MemoryMB)
	if !ok {
		return nil, fmt.Errorf("awsvm: %s: no image configured for %dMB: %w",
			sandboxID, cfg.MemoryMB, ErrUnsupported)
	}
	box, err := m.client.RunImage(ctx, sandboxID, image)
	if err != nil {
		return nil, err
	}
	memoryMB, cpuCount := m.Track(sandboxID, box, cfg)
	log.Printf("awsvm: created %s (microvm=%s endpoint=%s)", sandboxID, box.ID, box.Endpoint)

	// Delivered, not requested — see Track. Get answers from the same numbers.
	return &types.Sandbox{
		ID:        sandboxID,
		Template:  cfg.Template,
		Status:    types.SandboxStatusRunning,
		StartedAt: time.Now(),
		CpuCount:  cpuCount,
		MemoryMB:  memoryMB,
	}, nil
}

// TrackedMicrovmIDs returns every MicroVM this manager is routing a sandbox to.
// The orphan sweep subtracts these (plus warm stock) from what AWS reports, so
// whatever is left over is genuinely owned by nobody.
func (m *Manager) TrackedMicrovmIDs() map[string]struct{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make(map[string]struct{}, len(m.byID))
	for _, e := range m.byID {
		ids[e.microvmID] = struct{}{}
	}
	return ids
}

// TrackedBindings returns every sandbox id this manager is routing, mapped to
// the MicroVM behind it.
//
// TrackedMicrovmIDs answers "which boxes are spoken for", which is what the
// orphan sweep needs. This answers the other direction — "which bindings do we
// hold" — which is what a reconciler needs to find bindings whose sandbox no
// longer exists. Those are invisible to any pass driven by the sessions table,
// because such a pass can only visit sandboxes that still have a row.
func (m *Manager) TrackedBindings() map[string]string {
	if m == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]string, len(m.byID))
	for id, e := range m.byID {
		out[id] = e.microvmID
	}
	return out
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

// statusFor maps MicroVM lifecycle onto our sandbox status.
//
// SUSPENDED reads as RUNNING, not hibernated: the box is alive and auto-resume
// brings it back on the next request, so callers must keep treating it as
// serving. Reporting it as hibernated would make the reconciler's liveness
// check close a row whose box is fine.
//
// Only TERMINATING/TERMINATED read as stopped. That distinction is what the
// reconciler keys on to decide whether a row still has a host behind it.
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
	// Forget the binding first, then hand the box to the paced queue. Order
	// matters: the sandbox is gone from the caller's perspective the moment this
	// returns, and leaving it routable while the terminate drains would let an
	// exec land on a box already condemned.
	m.mu.Lock()
	delete(m.byID, id)
	m.mu.Unlock()

	// A throttled terminate used to surface as a 500 AND leave the box running —
	// a leak on the customer-facing delete path, which is where a share of the
	// orphan population came from. Queued, it retries at the quota instead.
	if m.term.enqueue(e.microvmID) {
		return nil
	}
	// Queue full: better to pay the call inline than lose the box.
	return m.client.Terminate(ctx, e.microvmID)
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

// DetachAgent surrenders a sandbox's agent channel without closing it. Only the
// edge-release path should use this: it is handing a still-good tunnel back to
// the pool rather than throwing it away. Every other unbind wants Forget.
func (m *Manager) DetachAgent(sandboxID string) *agentConn {
	if m == nil {
		return nil
	}
	return m.agents.detach(sandboxID)
}

// WarmAgents re-establishes idle agent channels for the given sandboxes. See
// agentPool.warm — intended for edge reservations awaiting a customer.
func (m *Manager) WarmAgents(sandboxIDs map[string]struct{}) int {
	if m == nil || len(sandboxIDs) == 0 {
		return 0
	}
	return m.agents.warm(sandboxIDs)
}

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

// Hibernate captures the workspace to blob storage, then suspends the box.
//
// The order is the whole design. Exporting BEFORE suspending means the archive
// is produced by a running box, so no ResumeMicrovm is ever needed to make one
// — which matters because Resume is rate-limited at 5/s and boxes created
// together expire together. Once the blob exists the suspended box is a pure
// latency cache: it can be terminated at any moment without losing anything but
// wake speed, which is what lets the expiry sweep free regional memory quota
// aggressively.
//
// Suspending first and exporting later would invert all of that: every
// promotion would need a Resume, and there would be a window where the box is
// suspended and no durable copy exists yet — a wake during that window has
// nothing to restore from.
func (m *Manager) Hibernate(ctx context.Context, sandboxID string, store *storage.CheckpointStore) (*sandbox.HibernateResult, error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return nil, err
	}
	if store == nil {
		return nil, fmt.Errorf("awsvm: hibernate %s: no checkpoint store configured", sandboxID)
	}

	rc, _, err := m.ExportWorkspace(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	// Spool to disk: the store uploads from a path, not a stream.
	local, size, err := stageArchive(rc, m.dataDir)
	if err != nil {
		return nil, fmt.Errorf("awsvm: hibernate %s: stage archive: %w", sandboxID, err)
	}
	defer os.Remove(local)

	key := hibernationKey(sandboxID)
	uploaded, err := store.Upload(ctx, key, local)
	if err != nil {
		return nil, fmt.Errorf("awsvm: hibernate %s: upload: %w", sandboxID, err)
	}
	if uploaded > 0 {
		size = uploaded
	}

	// Only now is it safe to stop serving. A failure above leaves the box
	// running and the sandbox usable, which is the right way to fail.
	if err := m.client.Suspend(ctx, e.microvmID); err != nil {
		return nil, fmt.Errorf("awsvm: hibernate %s: suspend: %w", sandboxID, err)
	}
	return &sandbox.HibernateResult{SandboxID: sandboxID, HibernationKey: key, SizeBytes: size}, nil
}

// Wake takes the fastest path that is still correct.
//
//	box SUSPENDED   Resume in place, ~1s, processes intact
//	box gone        launch a replacement and restore the archive into it
//
// Callers do not choose: which tier a sandbox is in depends on how long it sat
// and how quota pressure fell, neither of which the caller knows. Returning the
// best available answer means a wake degrades in latency rather than failing.
func (m *Manager) Wake(ctx context.Context, sandboxID, hibernationKey string, store *storage.CheckpointStore, _ int) (*types.Sandbox, error) {
	// Still tracked and alive? Resume is strictly cheaper than a restore, and
	// it keeps whatever the customer left running.
	if e, err := m.lookup(sandboxID); err == nil {
		if box, gErr := m.client.Get(ctx, e.microvmID); gErr == nil && box.Alive() {
			if err := m.client.Resume(ctx, e.microvmID); err != nil {
				return nil, fmt.Errorf("awsvm: wake %s: resume: %w", sandboxID, err)
			}
			// The cached gRPC channel did not survive the suspend: the proxy
			// drops it, and reusing it fails the next call with an abnormal
			// websocket close rather than anything that reads like "reconnect".
			// Dropping it here makes the next use dial fresh.
			m.agents.drop(sandboxID)
			return &types.Sandbox{
				ID: sandboxID, Template: e.template, Status: types.SandboxStatusRunning,
				StartedAt: e.startedAt, CpuCount: e.cpuCount, MemoryMB: e.memoryMB,
			}, nil
		}
	}

	// The box is gone, so the archive is the sandbox now.
	if store == nil || hibernationKey == "" {
		return nil, fmt.Errorf("awsvm: wake %s: host is gone and no archive was recorded", sandboxID)
	}
	return m.restoreFromArchive(ctx, sandboxID, hibernationKey, store)
}

// restoreFromArchive launches a replacement box and unpacks the workspace into
// it. Deliberately separate from Wake so the expensive path is legible.
func (m *Manager) restoreFromArchive(ctx context.Context, sandboxID, key string, store *storage.CheckpointStore) (*types.Sandbox, error) {
	rc, err := store.Download(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("awsvm: wake %s: download archive: %w", sandboxID, err)
	}
	defer rc.Close()

	box, err := m.client.Run(ctx, "")
	if err != nil {
		return nil, fmt.Errorf("awsvm: wake %s: launch replacement: %w", sandboxID, err)
	}
	ready, err := m.client.WaitRunning(ctx, box.ID, 60*time.Second)
	if err != nil {
		// Do not leak a box we cannot use: it bills and holds quota until the cap.
		go func() { _ = m.client.Terminate(context.WithoutCancel(ctx), box.ID) }()
		return nil, fmt.Errorf("awsvm: wake %s: replacement never became ready: %w", sandboxID, err)
	}

	cfg := types.SandboxConfig{SandboxID: sandboxID}
	if e, lErr := m.lookup(sandboxID); lErr == nil {
		cfg.MemoryMB, cfg.CpuCount = e.memoryMB, e.cpuCount
	}
	// Drop before tracking: the pooled connection is keyed by sandbox id, and
	// this sandbox now lives on a different host entirely.
	m.agents.drop(sandboxID)
	m.Track(sandboxID, ready, cfg)

	if err := m.ImportWorkspace(ctx, sandboxID, rc); err != nil {
		go func() { _ = m.client.Terminate(context.WithoutCancel(ctx), ready.ID) }()
		return nil, err
	}
	return &types.Sandbox{
		ID: sandboxID, Status: types.SandboxStatusRunning, StartedAt: ready.StartedAt,
		CpuCount: cfg.CpuCount, MemoryMB: cfg.MemoryMB,
	}, nil
}

// ── Not supported on this backend ───────────────────────────────────────────

// SetResourceLimits is a no-op: a MicroVM's shape is fixed by its image and run
// configuration, and cannot be resized in place the way virtio-mem allows.
// Returning nil rather than an error keeps the control plane's post-claim grow
// step harmless instead of failing every create.
// SetResourceLimits cannot be honoured on this backend.
//
// Sizing is a property of the IMAGE (see deliveredSize): RunMicrovmInput has no
// memory or vCPU field, and the only knob in the whole API is
// Resources.MinimumMemoryInMiB at image build/update time — which is
// account-wide for every box on that image, not per sandbox.
//
// This used to `return nil`, which made a resize request answer 200 OK and
// change nothing. That is the failure mode ErrUnsupported exists to prevent: a
// caller cannot tell a silent success apart from a real one, so it believes a
// limit is in force that was never applied. 501 tells the truth — the operation
// will never succeed on this runtime, so do not retry it.
func (m *Manager) SetResourceLimits(ctx context.Context, sandboxID string, maxPids int32, maxMemoryBytes, cpuMaxUsec, cpuPeriodUsec int64) error {
	return unsupported("SetResourceLimits")
}

// UpdateSandboxSecret injects or replaces a secret in a running sandbox.
//
// The QEMU backend routes this through its in-guest secrets proxy, which does
// not exist here — there is no worker host to run one. The agent's SetEnvs
// reaches the same place over the tunnel every exec already uses, so the value
// lands in the environment new processes inherit.
//
// Note the narrower promise than QEMU's proxy: processes ALREADY running keep
// the old environment, because a process's environment cannot be rewritten from
// outside. Anything that needs the new value must be restarted.
func (m *Manager) UpdateSandboxSecret(ctx context.Context, sandboxID, secretName, value string) (bool, error) {
	if secretName == "" {
		return false, fmt.Errorf("awsvm: %s: empty secret name", sandboxID)
	}
	a, err := m.agent(sandboxID)
	if err != nil {
		return false, err
	}
	if _, err := a.client.SetEnvs(ctx, &pb.SetEnvsRequest{
		Envs: map[string]string{secretName: value},
	}); err != nil {
		return false, fmt.Errorf("awsvm: %s: set secret %s: %w", sandboxID, secretName, err)
	}
	return true, nil
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

// RebootSandbox restarts a sandbox on a clean host, preserving its workspace.
//
// There is no reboot API — the seven MicroVM operations are Run, Get, Suspend,
// Resume, Terminate, List and CreateAuthToken. So a reboot is assembled from
// the pieces hibernate already uses: capture the workspace, throw the host
// away, launch a replacement from the image, and unpack into it.
//
// That is a stronger guarantee than a soft reboot, not a weaker one. The
// replacement boots from the image snapshot, so the kernel, the process table
// and anything a runaway process dirtied outside the workspace are all genuinely
// new — where a soft reboot leaves the same disk in place.
//
// The cost is real and worth stating: this is a full export/import round trip
// (~3.3s floor plus workspace size), not the sub-second restart a QEMU reboot
// gives. And what survives is /home/sandbox — anything installed elsewhere came
// from the image and comes back from the image, but anything installed
// elsewhere AT RUNTIME does not.
func (m *Manager) RebootSandbox(ctx context.Context, sandboxID string) error {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return err
	}

	rc, _, err := m.ExportWorkspace(ctx, sandboxID)
	if err != nil {
		return fmt.Errorf("awsvm: reboot %s: capture workspace: %w", sandboxID, err)
	}
	defer rc.Close()

	// Launch the replacement BEFORE terminating the old host. If Run fails —
	// quota, throttling, a bad image — the sandbox is still alive and the reboot
	// simply did not happen, which is far better than a customer left with
	// neither host nor a way back.
	box, err := m.client.Run(ctx, "")
	if err != nil {
		return fmt.Errorf("awsvm: reboot %s: launch replacement: %w", sandboxID, err)
	}
	ready, err := m.client.WaitRunning(ctx, box.ID, 60*time.Second)
	if err != nil {
		go func() { _ = m.client.Terminate(context.WithoutCancel(ctx), box.ID) }()
		return fmt.Errorf("awsvm: reboot %s: replacement never became ready: %w", sandboxID, err)
	}

	oldID := e.microvmID
	// Drop before tracking: the pooled gRPC connection is keyed by sandbox id
	// and the sandbox now lives on a different host entirely.
	m.agents.drop(sandboxID)
	m.Track(sandboxID, ready, types.SandboxConfig{
		SandboxID: sandboxID, Template: e.template,
		MemoryMB: e.memoryMB, CpuCount: e.cpuCount,
	})

	if err := m.ImportWorkspace(ctx, sandboxID, rc); err != nil {
		// The replacement is unusable. Terminate it and put the tracking back on
		// the original, which is still running — the customer keeps the sandbox
		// they had rather than losing it to a failed reboot.
		go func() { _ = m.client.Terminate(context.WithoutCancel(ctx), ready.ID) }()
		m.agents.drop(sandboxID)
		m.Track(sandboxID, &Box{ID: oldID, Endpoint: e.endpoint, StartedAt: e.startedAt}, types.SandboxConfig{
			SandboxID: sandboxID, Template: e.template,
			MemoryMB: e.memoryMB, CpuCount: e.cpuCount,
		})
		return fmt.Errorf("awsvm: reboot %s: restore workspace: %w", sandboxID, err)
	}

	// Only now is the old host redundant.
	go func() { _ = m.client.Terminate(context.WithoutCancel(ctx), oldID) }()
	log.Printf("awsvm: reboot %s: %s -> %s (workspace preserved)", sandboxID, oldID, ready.ID)
	return nil
}

// PowerCycleSandbox is a reboot on this backend.
//
// On QEMU the two differ: reboot asks the guest to restart, power-cycle kills
// QEMU and starts it again. Here even the gentler path already replaces the
// host, so there is no harsher one to escalate to — and pretending otherwise by
// leaving this unsupported would make callers implement a fallback that does
// exactly what this does.
//
// Returns 0 for the pid the QEMU implementation reports; there is no host
// process here to name.
func (m *Manager) PowerCycleSandbox(ctx context.Context, sandboxID string) (int, error) {
	return 0, m.RebootSandbox(ctx, sandboxID)
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

// Forget drops a sandbox from the in-memory map without touching AWS.
//
// For a hibernation that has been retired to blob-only: the box is already
// terminated, and leaving the binding behind would make Route claim the sandbox
// is served in-process, sending the next request to a host that no longer
// exists instead of down the restore path.
func (m *Manager) Forget(sandboxID string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	delete(m.byID, sandboxID)
	m.mu.Unlock()
	m.agents.drop(sandboxID)
}

// DirectInfo returns everything a caller OUTSIDE this process needs to reach a
// sandbox's agent itself: the MicroVM's public endpoint, a proxy auth token,
// and the guest port that token is scoped to.
//
// This is the seam for taking the control plane out of the exec data path. The
// endpoint is a public TLS host and the token is a plain header credential — the
// same one dialAgent presents on the WebSocket upgrade — so a caller that
// speaks the tunnel protocol gets an identical channel without relaying through
// here. Tokens are cached and port-scoped by AuthToken, so this is cheap to call
// and cannot widen access beyond the agent port.
func (m *Manager) DirectInfo(ctx context.Context, sandboxID string) (endpoint, token string, port int32, err error) {
	e, err := m.lookup(sandboxID)
	if err != nil {
		return "", "", 0, err
	}
	tok, err := m.client.AuthToken(ctx, e.microvmID)
	if err != nil {
		return "", "", 0, err
	}
	return e.endpoint, tok, m.client.Config().AgentPort, nil
}

// PingAgents keeps the given sandboxes' boxes out of AWS's idle policy. See the
// keepalive block in agent.go for why an open connection is not enough.
//
// Also retires channels that keep failing, so a reservation whose tunnel died
// does not hand its eventual customer a cold dial. retired counts those; sample
// is one representative failure, for the caller to log.
func (m *Manager) PingAgents(ctx context.Context, sandboxIDs map[string]struct{}) (ok, failed, retired int, sample error) {
	return m.agents.pingTracked(ctx, sandboxIDs)
}
