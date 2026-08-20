package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// worker_backend.go — the QEMU fleet as a Backend.
//
// Placement here is two steps, not one, and the order is forced: the worker
// reads org_id out of the sandbox_sessions row while booting the VM, so the row
// must exist before dispatch. That is why Placer splits Claim from Activate —
// a single Claim that returned a worker_id could not express "persist between
// these two calls", and a single Claim that persisted internally would have to
// know about tokens, webhooks, and response shaping.
//
// A backend whose hosts are already running (nothing to start) implements
// Activate as a no-op. A backend that boots on demand puts the boot there.

// workerSelector is the slice of the worker registry placement needs.
//
// An interface rather than the concrete registry because selection is the one
// part of create with real branching — immediate hit, wait-then-hit, give up —
// and until this existed none of it could be tested: the handler reached
// straight into a Redis-backed struct.
type workerSelector interface {
	GetLeastLoadedWorker(region string) (*controlplane.WorkerEntry, pb.SandboxWorkerClient, error)
}

// ErrNoCapacity means no worker became available within the wait. Distinct from
// a transport error so the caller can answer 503 rather than 500.
var ErrNoCapacity = errors.New("no workers available in region")

// workerWaitTimeout bounds how long a create queues for a worker. The scaler
// may be mid-launch, so a short wait converts a burst into slow creates rather
// than failed ones; past that the honest answer is that the cell is full.
const workerWaitTimeout = 30 * time.Second

// workerWaitInterval paces the retry while queued.
const workerWaitInterval = 2 * time.Second

// workerCreateTimeout bounds the boot RPC. Generous because a cold fork of a
// multi-GB checkpoint downloads from blob storage; warm creates return in well
// under a second regardless.
const workerCreateTimeout = 5 * time.Minute

// workerScaleTimeout bounds the post-create resize, which is local to the
// worker (virtio-mem hotplug + cgroup write).
const workerScaleTimeout = 10 * time.Second

// defaultSandboxMemoryMB is the size a create with no memory request gets.
const defaultSandboxMemoryMB = 1024

// mbPerVCPU is the implied CPU ratio when a create asks for memory alone.
const mbPerVCPU = 4096

// workerBackend places sandboxes on the QEMU worker fleet.
type workerBackend struct {
	selector workerSelector
	registry *controlplane.RedisWorkerRegistry

	// waitTimeout and waitInterval are fields rather than constants so a test
	// can exercise the queue-then-succeed and give-up paths without spending
	// 30 real seconds. Zero means the constants above.
	waitTimeout  time.Duration
	waitInterval time.Duration

	// pending holds what Claim selected, until Activate consumes it.
	mu      sync.Mutex
	pending map[string]claimedWorker
}

// claimedWorker is the result of a selection, held between Claim and Activate.
//
// Kept here rather than returned from Claim so Claim's signature stays uniform
// across backends — a worker_id is the only thing every backend has in common,
// and it is the only thing the row needs.
type claimedWorker struct {
	entry  *controlplane.WorkerEntry
	client pb.SandboxWorkerClient
}

func newWorkerBackend(registry *controlplane.RedisWorkerRegistry) *workerBackend {
	if registry == nil {
		return nil
	}
	return &workerBackend{selector: registry, registry: registry}
}

func (w *workerBackend) Name() string { return "worker" }

// WorkerIDPrefixes is empty: this backend's sandboxes carry real registered
// worker ids, so the managed-prefix predicates must not match them. Returning a
// prefix here would exclude the entire fleet from the orphan sweep.
func (w *workerBackend) WorkerIDPrefixes() []string { return nil }

// OwnsWorkerID reports whether a live worker holds this id. Deliberately asks
// the registry rather than pattern-matching the string: worker ids have no
// reserved shape, and guessing would let this backend claim another runtime's
// sandboxes.
func (w *workerBackend) OwnsWorkerID(workerID string) bool {
	if w == nil || w.registry == nil || workerID == "" {
		return false
	}
	return w.registry.GetWorker(workerID) != nil
}

// Route returns no in-process manager: the sandbox lives on a worker and is
// reached by proxying. Reporting false keeps the data-plane dispatcher sending
// these to the proxy, which is the only thing that can serve them.
func (w *workerBackend) Route(context.Context, string) (sandbox.Manager, bool) {
	return nil, false
}

func (w *workerBackend) Capacity() (healthy, available, running int) {
	if w == nil || w.registry == nil {
		return 0, 0, 0
	}
	return controlplane.WorkerRegistryCapacity(w.registry).Capacity()
}

// Reconcile is a no-op: the fleet's sweeps (orphan reconciliation, stale-pending
// reaping, worker-rejoin reconcile) already run from cmd/server against the
// registry, and duplicating them here would double-close the same rows.
func (w *workerBackend) Reconcile(context.Context, *db.Store) {}

// selectWorker picks a worker, queueing briefly when none is free.
//
// Extracted from createSandboxRemote so the branching is reachable from a test.
// The three outcomes differ in what the customer should do — served, served
// after a wait, or told the cell is full — and none of them had coverage.
func (w *workerBackend) selectWorker(ctx context.Context, region string) (*controlplane.WorkerEntry, pb.SandboxWorkerClient, error) {
	worker, client, err := w.selector.GetLeastLoadedWorker(region)
	if err == nil {
		return worker, client, nil
	}

	timeout, interval := w.waitTimeout, w.waitInterval
	if timeout <= 0 {
		timeout = workerWaitTimeout
	}
	if interval <= 0 {
		interval = workerWaitInterval
	}

	deadline := time.After(timeout)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			return nil, nil, ErrNoCapacity
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-ticker.C:
			worker, client, err = w.selector.GetLeastLoadedWorker(region)
			if err == nil {
				log.Printf("sandbox: worker became available after queuing (region=%s)", region)
				return worker, client, nil
			}
		}
	}
}

// Accepts takes every create not explicitly assigned elsewhere.
//
// The empty runtime is the load-bearing case: an org with no D1 assignment, a
// capability token minted before the field existed, and a create that never
// passed the edge all arrive here. That is deliberate — this is the runtime
// with the full feature set (checkpoints, fork, PTY, custom templates, resize),
// so it is the only safe answer to "we do not know". A newer runtime declines
// what it cannot serve; this one has nowhere to pass a create on to.
func (w *workerBackend) Accepts(p placement) bool {
	return p.runtime == "" || p.runtime == runtimeQEMU
}

// Claim chooses a worker. No side effects on the fleet: the VM is not started
// until Activate, so a failure here costs nothing but the selection attempt.
func (w *workerBackend) Claim(ctx context.Context, p placement) (string, error) {
	worker, client, err := w.selectWorker(ctx, p.region)
	if err != nil {
		return "", err
	}
	w.mu.Lock()
	if w.pending == nil {
		w.pending = make(map[string]claimedWorker)
	}
	w.pending[p.sandboxID] = claimedWorker{entry: worker, client: client}
	w.mu.Unlock()
	return worker.ID, nil
}

// takePending removes and returns what Claim selected.
func (w *workerBackend) takePending(sandboxID string) (claimedWorker, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	cw, ok := w.pending[sandboxID]
	delete(w.pending, sandboxID)
	return cw, ok
}

// dropPending releases a claim that will never be activated, so an abandoned
// create does not pin a worker entry and its connection for the process's life.
func (w *workerBackend) dropPending(sandboxID string) {
	w.mu.Lock()
	delete(w.pending, sandboxID)
	w.mu.Unlock()
}

// RequiresPersistedRow is false: workers report the sandboxes they hold on
// every heartbeat, so the orphan reconciler rediscovers one whose row failed to
// write. Failing the create instead would destroy a booted VM over a database
// blip.
func (w *workerBackend) RequiresPersistedRow() bool { return false }

// DefersPersist is false. The worker path resolves a sandbox by reading its
// session row (worker_id, org, status) on the very next request, so answering
// a create before that row exists would make the SDK's own follow-up call race
// a write in flight.
func (w *workerBackend) DefersPersist() bool { return false }

// Release forgets the selection. Nothing was started — Claim only picked a
// worker — so there is no host to reclaim, and the worker's own capacity
// accounting needs no correction.
func (w *workerBackend) Release(_ context.Context, sandboxID, _ string) {
	w.dropPending(sandboxID)
}

// Activate boots the VM on the worker Claim selected, then scales it to the
// requested shape.
//
// The scale-up is part of activation rather than a step of its own because the
// golden snapshot has fixed CPU and RAM: a sandbox is not yet the size the
// customer asked for when CreateSandbox returns. Keeping it here means every
// backend's Activate has the same postcondition — a host running at the
// requested shape — instead of the caller knowing which runtimes need a second
// call.
//
// A scale failure is logged, not returned: the sandbox is up and usable at
// default size, and failing the create would destroy a working box over a
// resize.
func (w *workerBackend) Activate(ctx context.Context, a activation) (activated, error) {
	held, ok := w.takePending(a.sandboxID)
	if !ok {
		return activated{}, fmt.Errorf("worker: no claim held for %s", a.sandboxID)
	}
	client := held.client

	// The worker caches checkpoints locally (~300ms) but downloads from blob on
	// a cold fork, where a multi-GB checkpoint under any blob-side contention
	// needs far more than a tight budget. The happy path returns as soon as the
	// VM is up, so a generous ceiling costs warm creates nothing.
	createCtx, cancel := context.WithTimeout(ctx, workerCreateTimeout)
	defer cancel()

	cfg := a.cfg
	resp, err := client.CreateSandbox(createCtx, &pb.CreateSandboxRequest{
		SandboxId:            a.sandboxID,
		Template:             cfg.Template,
		Timeout:              int32(cfg.Timeout),
		Envs:                 cfg.Envs,
		NetworkEnabled:       cfg.IsNetworkEnabled(),
		Port:                 int32(cfg.Port),
		TemplateRootfsKey:    a.templateRootfsKey,
		TemplateWorkspaceKey: a.templateWorkspaceKey,
		EgressAllowlist:      cfg.EgressAllowlist,
		SecretAllowedHosts:   flattenSecretAllowedHosts(cfg.SecretAllowedHosts),
		SecretEnvs:           cfg.SecretEnvs,
		DiskMb:               int32(cfg.DiskMB),
		VmdoConnectToken:     a.connectToken,
	})
	if err != nil {
		return activated{}, err
	}

	w.scaleToRequested(ctx, client, resp.SandboxId, cfg)

	// Stamp the golden the worker actually built on, falling back to the one the
	// registry advertised for pre-golden workers. Every box must end up with
	// some golden_version — a blank one cannot be migrated.
	golden := resp.GetGoldenVersion()
	if golden == "" && held.entry != nil {
		golden = held.entry.GoldenVersion
	}
	return activated{sandboxID: resp.SandboxId, status: resp.Status, goldenVersion: golden}, nil
}

// scaleToRequested hotplugs the box up to the customer's requested shape.
func (w *workerBackend) scaleToRequested(ctx context.Context, client pb.SandboxWorkerClient, sandboxID string, cfg types.SandboxConfig) {
	if cfg.MemoryMB <= 0 && cfg.CpuCount <= 0 {
		return
	}
	memMB := cfg.MemoryMB
	if memMB <= 0 {
		memMB = defaultSandboxMemoryMB
	}
	cpus := cfg.CpuCount
	if cpus <= 0 {
		cpus = memMB / mbPerVCPU // 1 vCPU per 4GB
		if cpus < 1 {
			cpus = 1
		}
	}
	const cpuPeriod = int64(100000)

	scaleCtx, cancel := context.WithTimeout(ctx, workerScaleTimeout)
	defer cancel()
	if _, err := client.SetSandboxLimits(scaleCtx, &pb.SetSandboxLimitsRequest{
		SandboxId:      sandboxID,
		MaxMemoryBytes: int64(memMB) * 1024 * 1024,
		CpuMaxUsec:     int64(cpus) * cpuPeriod,
		CpuPeriodUsec:  cpuPeriod,
	}); err != nil {
		log.Printf("sandbox: post-create scale failed for %s: %v (continuing with defaults)", sandboxID, err)
	}
}

// Close has nothing to release: this backend keeps no warm stock of its own,
// and the worker connections it hands out are owned by the registry.
func (w *workerBackend) Close() {}
