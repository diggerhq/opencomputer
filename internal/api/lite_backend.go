package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/awsvmlite"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/internal/worker"
	"github.com/opensandbox/opensandbox/pkg/types"
	"github.com/redis/go-redis/v9"
)

// lite_backend.go — the MicroVM runtime.
//
// A box is reached with a plain HTTPS POST to a hook endpoint in the guest,
// which translates it into loopback gRPC inside the box (cmd/microvm-hooks).
// That indirection is not an optimisation, it is the only thing that works:
// the platform's proxy forwards guest traffic to exactly one declared port and
// strips the HTTP/2 trailers gRPC reports status in, so gRPC cannot survive the
// hop from outside — but it is fine over loopback on the far side of it.
//
// The predecessor carried gRPC to osb-agent inside a WebSocket tunnel held per
// box by this process. It is deleted (see microvm_common.go); this backend is
// what the runtime is. See internal/awsvmlite for the measurement that
// motivated the change.

// liteEnabled reports whether this cell serves MicroVM-backed sandboxes. It is
// microvmEnabled by another name — kept as its own function because the call
// sites read better for it, and because OPENSANDBOX_MICROVM_LITE used to select
// between two data planes and operators still have it set.
func liteEnabled() bool {
	if os.Getenv("OPENSANDBOX_MICROVM_LITE") == "0" {
		// Honouring this would mean serving nothing at all: the agent-tunnel
		// backend it used to select no longer exists. Say so rather than boot a
		// MicroVM cell with no MicroVM backend registered.
		log.Printf("microvm: ignoring OPENSANDBOX_MICROVM_LITE=0 — the agent-tunnel backend it selected has been removed; unset the variable")
	}
	return microvmEnabled()
}

type liteBackend struct {
	client *awsvm.Client
	mgr    *awsvmlite.Manager
	// sm is the sandbox.Manager face the control plane's data-plane routes
	// dispatch through. One instance, shared: it holds no state of its own.
	sm *awsvmlite.SandboxManager

	stopRun     context.CancelFunc
	usageTicker *worker.UsageTicker
	eventPub    *worker.RedisEventPublisher
	capacity    *controlplane.CapacityReporter
}

// newLiteBackend builds the direct-exec MicroVM backend, or returns nil if this
// cell is not configured for it.
func newLiteBackend(ctx context.Context, checkpointStore *storage.CheckpointStore) (*liteBackend, error) {
	if !liteEnabled() {
		return nil, nil
	}
	client, err := newMicrovmClient(ctx)
	if err != nil {
		return nil, err
	}

	// Warm target falls back to the agent path's pool target so a cell that is
	// switched over keeps the depth it was sized for, rather than silently
	// dropping to a default and cold-launching every create.
	warm := envInt("OPENSANDBOX_MICROVM_LITE_WARM", envInt("OPENSANDBOX_MICROVM_POOL_TARGET", 20))

	mgr := awsvmlite.New(client, awsvmlite.Config{
		WarmTarget: warm,
		// How many sandboxes may sit hibernated. A parked box holds regional
		// quota it can never give back, so this is a guard on the warm pool
		// rather than a limit AWS imposes — see awsvmlite/hibernate.go.
		SuspendedCap: envInt("OPENSANDBOX_MICROVM_LITE_SUSPENDED_CAP", 0),
		TouchInterval: time.Duration(
			envInt("OPENSANDBOX_MICROVM_LITE_TOUCH_SECONDS", 300)) * time.Second,
	})
	runCtx, stop := context.WithCancel(context.Background())
	b := &liteBackend{client: client, mgr: mgr,
		sm:      awsvmlite.NewSandboxManager(mgr).WithCheckpointStore(checkpointStore),
		stopRun: stop}
	go mgr.Run(runCtx)

	log.Printf("vmhost-lite: backend enabled (region=%s warm=%d) — direct exec, no agent tunnel",
		client.Config().Region, warm)
	return b, nil
}

// ── Backend ─────────────────────────────────────────────────────────────────

// Compile-time proof this satisfies the dispatch seam, for the same reason the
// agent-path backend asserts it: a signature drift here surfaces as a silent
// fall-through to the worker path rather than a build failure.
var _ Placer = (*liteBackend)(nil)

func (b *liteBackend) Name() string { return "vmhost-lite" }

// WorkerIDPrefixes and OwnsWorkerID keep reading the encoding the deleted
// agent-tunnel backend wrote as well as this one's. A worker_id names which box
// holds a sandbox, and the box is the same box — a row nothing claims is a box
// nothing terminates. Both are nil-safe: knownBackends calls them on the zero
// value, before any Server exists.
func (b *liteBackend) WorkerIDPrefixes() []string {
	return []string{microvmWorkerPrefix, legacyWorkerPrefix}
}

func (b *liteBackend) OwnsWorkerID(workerID string) bool {
	_, ok := parseMicrovmWorkerID(workerID)
	return ok
}

// Route reports whether this backend holds the sandbox, from its in-memory
// binding only — never an availability check. False sends the caller to another
// backend, so "mine but sick" must not look like "not mine".
func (b *liteBackend) Route(_ context.Context, sandboxID string) (sandbox.Manager, bool) {
	if b == nil {
		return nil, false
	}
	if _, ok := b.mgr.BoxFor(sandboxID); !ok {
		return nil, false
	}
	return b.sm, true
}

// Capacity reports a constant 1 available, as the agent path does and for the
// same reason: the real ceiling is an AWS regional quota far above current use,
// and advertising warm depth would 503 creates this backend can serve. The
// freshness of the report is the load-bearing half — the edge drops a cell whose
// capacity_updated_at is older than 120s, so this doubles as a heartbeat.
func (b *liteBackend) Capacity() (healthy, available, running int) {
	if b == nil {
		return 0, 0, 0
	}
	return 1, 1, len(b.mgr.Bound())
}

// Close stops the warm-set loop and gives the stock back.
//
// Not optional: a redeploy that abandons warm boxes leaks a full set on every
// rollout, and each one bills compute and holds regional memory quota until the
// 8h service cap. Bound sandboxes are left alone — they belong to customers, and
// the reconciler re-adopts them on the way back up.
func (b *liteBackend) Close() {
	if b == nil {
		return
	}
	if b.usageTicker != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = b.usageTicker.Stop(stopCtx)
		cancel()
	}
	// After the ticker, so its final slices are in SQLite before the publisher
	// drains them.
	if b.eventPub != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = b.eventPub.Stop(stopCtx)
		cancel()
	}
	if b.capacity != nil {
		b.capacity.Stop()
	}
	b.stopRun()
	drainCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if n := b.mgr.DrainWarm(drainCtx); n > 0 {
		log.Printf("vmhost-lite: released %d warm box(es) on shutdown", n)
	}
	// After the drain, not before: closing the queue first would drop whatever
	// DrainWarm just enqueued.
	b.mgr.CloseTerminator()
}

// ── Placer ──────────────────────────────────────────────────────────────────

// Accepts mirrors the agent path exactly — same runtime assignment, same
// template rule. It has to: an org pinned to the MicroVM runtime reaches
// whichever of the two backends this cell registered, and a cell that accepted
// a different set of creates depending on its data plane would make the choice
// visible to customers.
// ErrSizeUnavailable means the requested memory size has no published image in
// this region. Permanent for the request as written: size is fixed at launch
// from a per-tier image, so there is no later point at which a sandbox created
// at the wrong size could be corrected, and no retry that finds a tier we never
// published.
var ErrSizeUnavailable = errors.New("requested sandbox size is not available in this region")

// ExplainRefusal names the one refusal in Accepts that a customer can act on.
//
// Deliberately silent about the template case: whether a named template is
// servable is not decidable here (Accepts only sees the template NAME), so
// claiming it as the reason would sometimes be a lie.
func (b *liteBackend) ExplainRefusal(p placement) error {
	if b == nil || p.runtime != runtimeMicrovm {
		return nil
	}
	if _, _, ok := b.client.Config().ImageForMemory(p.cfg.MemoryMB); !ok {
		offered := sortedTiers(b.client.Config().SizeImages)
		sizes := make([]string, 0, len(offered)+1)
		sizes = append(sizes, strconv.Itoa(b.client.Config().DefaultMemoryMB))
		for _, mb := range offered {
			if mb != b.client.Config().DefaultMemoryMB {
				sizes = append(sizes, strconv.Itoa(mb))
			}
		}
		return fmt.Errorf("%w: %dMB was requested; this region offers %s MB",
			ErrSizeUnavailable, p.cfg.MemoryMB, strings.Join(sizes, ", "))
	}
	return nil
}

func (b *liteBackend) Accepts(p placement) bool {
	if b == nil {
		return false
	}
	if p.runtime != runtimeMicrovm {
		return false
	}
	// Named templates are ACCEPTED now. They are served by claiming a pooled
	// default box and unpacking the template's workspace archive onto it (see
	// Activate), so a template costs a tarball rather than a published image
	// per template.
	//
	// Whether a specific template is servable cannot be decided here —
	// placement carries the template NAME, not the resolved drive keys — so the
	// refusal for a template this runtime cannot honour lives in Activate,
	// where the keys are available.
	// Sizes are images, and only the tiers this cell has published images for
	// can be served. Declining here is what turns an unavailable size into a
	// clean placement failure instead of a sandbox that is quietly the wrong
	// size — memory cannot be adjusted after launch, so there is no later point
	// at which the mistake could be corrected.
	if _, _, ok := b.client.Config().ImageForMemory(p.cfg.MemoryMB); !ok {
		return false
	}
	return true
}

// Claim pops a warm box, or launches one when the set is empty.
//
// A miss is slow (a cold launch, ~3s) but not an error — the warm set is a
// latency optimization, not the capacity limit.
func (b *liteBackend) Claim(ctx context.Context, p placement) (string, error) {
	if b == nil {
		return "", errors.New("vmhost-lite: backend disabled")
	}
	start := time.Now()
	box, warm, err := b.mgr.Claim(ctx, p.sandboxID, awsvmlite.Meta{
		Template: p.cfg.Template,
		MemoryMB: p.cfg.MemoryMB,
		CPUCount: p.cfg.CpuCount,
	})
	if err != nil {
		return "", err
	}
	if !warm {
		log.Printf("vmhost-lite: COLD CREATE %s -> %s in %s (warm set was empty)",
			p.sandboxID, box.MicrovmID, time.Since(start).Round(time.Millisecond))
	}
	return microvmWorkerID(box.MicrovmID), nil
}

// Activate applies the sandbox's environment, if it has one.
//
// Claim returns a box that is already RUNNING, so there is nothing to start —
// but `envs` on a create used to be dropped here in silence: Claim carries only
// template and size, and nothing else ever looked at cfg.Envs. The create
// returned 200 and the customer's program saw an unset variable.
//
// Conditional, because this is the create path. A create with no envs — which
// is every pooled create the benchmark makes — does not pay for this at all.
// One that has them pays one request, before the response, because the first
// exec can arrive the moment the caller has the sandbox id and an environment
// applied afterwards would reach some commands and not others.
func (b *liteBackend) Activate(ctx context.Context, a activation) (activated, error) {
	// A template's workspace, restored into the box we just claimed.
	//
	// This is how templates and forks work on this runtime: the sandbox starts
	// from the POOLED default image — so it keeps the fast claim — and the
	// template is a tarball unpacked on top, rather than a custom AWS image per
	// template. See internal/awsvmlite/checkpoint.go.
	//
	// Before envs and secrets deliberately: the archive can contain dotfiles
	// and shell profiles, and the environment should be applied to the sandbox
	// the customer will actually get, not to one that is about to be written
	// over.
	if a.templateRootfsKey != "" {
		// A template with a ROOTFS drive came from the QEMU fleet, where a
		// snapshot captures the whole disk. This runtime can only replay the
		// workspace half, and doing that silently would hand the customer their
		// files while dropping every system change the snapshot was taken for —
		// a template that looks like it worked and isn't.
		//
		// The empty rootfs key is a reliable marker here because this runtime's
		// own CreateCheckpoint returns "" for it (there is nothing to capture),
		// and the store writes that through as an empty string rather than NULL.
		return activated{}, fmt.Errorf(
			"vmhost-lite: template for %s carries a rootfs image, which this runtime cannot restore", a.sandboxID)
	}
	if a.templateWorkspaceKey != "" {
		if err := b.mgr.RestoreWorkspaceKey(ctx, a.sandboxID, a.templateWorkspaceKey); err != nil {
			return activated{}, fmt.Errorf("vmhost-lite: restore template into %s: %w", a.sandboxID, err)
		}
	}

	switch {
	case awsvmlite.HasSecrets(a.cfg):
		// INSTEAD OF SetEnvs, not as well as. The guest seals the secrets and
		// merges the plaintext envs into ONE environment; a SetEnvs afterwards
		// would replace that with an environment holding none of the sealed
		// values, silently disabling the secret store.
		if err := b.mgr.SetSecrets(ctx, a.sandboxID, a.cfg); err != nil {
			return activated{}, fmt.Errorf("vmhost-lite: set secrets on %s: %w", a.sandboxID, err)
		}
	case len(a.cfg.Envs) > 0:
		if err := b.mgr.SetEnvs(ctx, a.sandboxID, a.cfg.Envs); err != nil {
			// Fail the create rather than hand back a sandbox whose environment
			// is not what was asked for. Silently proceeding is what this whole
			// change exists to stop.
			return activated{}, fmt.Errorf("vmhost-lite: set envs on %s: %w", a.sandboxID, err)
		}
	}
	// The host's hard deadline, carried to the row. Zero when unknown, which
	// the persist step treats as "no deadline" rather than "already expired".
	return activated{
		sandboxID: a.sandboxID,
		status:    "running",
		endAt:     b.mgr.DeadlineFor(a.sandboxID),
	}, nil
}

// RequiresPersistedRow is true: this backend rebuilds its bindings FROM these
// rows after a restart (see Restore), so a box with no row is one nothing will
// ever terminate.
func (b *liteBackend) RequiresPersistedRow() bool { return true }

// DefersPersist is true: Claim binds sandbox→box in memory before it returns,
// so exec, destroy and routing all resolve without reading the row.
func (b *liteBackend) DefersPersist() bool { return true }

// Release terminates a box whose create failed after Claim. Merely forgetting it
// would leave one billing with nothing tracking it.
func (b *liteBackend) Release(ctx context.Context, sandboxID, _ string) {
	if b == nil {
		return
	}
	// Metering happens inside Destroy, via the lifecycle observer, so that
	// every path that kills a box bills it — this one, the customer's DELETE,
	// the idle sweep and the shutdown drain. Doing it here would have covered
	// only create-cleanup.
	if err := b.mgr.Destroy(ctx, sandboxID); err != nil {
		log.Printf("vmhost-lite: release %s: %v", sandboxID, err)
	}
}

var _ MemoryStateCapturer = (*liteBackend)(nil)

// CapturesMemoryState is false: this runtime's provider offers suspend/resume
// but no way to read a running host's RAM out, so a checkpoint here is the
// workspace archive and nothing more. Saying so lets the checkpoint API refuse
// a full capture with a reason instead of accepting one it cannot make.
func (b *liteBackend) CapturesMemoryState() bool { return false }

var _ IdleTimeouter = (*liteBackend)(nil)

// SetIdleTimeout applies a customer's idle timeout, reporting what is actually
// in force. See internal/awsvmlite/idle.go — a timeout at or beyond the host's
// remaining life is refused, because the provider ends the host at its cap
// whatever we do and pretending otherwise would be a promise this runtime
// cannot keep.
func (b *liteBackend) SetIdleTimeout(sandboxID string, d time.Duration) (time.Duration, error) {
	if b == nil {
		return 0, errors.New("vmhost-lite: backend disabled")
	}
	return b.mgr.SetIdleTimeout(sandboxID, d)
}

// StartIdleSweeper parks sandboxes whose customer-set idle timeout has elapsed.
//
// It lives here rather than in the manager because parking is a database
// transition as much as a provider call. Suspending the box alone would leave
// the row reading `running` — the customer sees a live sandbox that is actually
// asleep, it keeps consuming their concurrency limit — and, worse, wake answers
// "no active hibernation found" because nothing recorded one, stranding the
// sandbox parked for good. So this mirrors the customer-initiated path
// (hibernateViaBackend) exactly: park, record, flip, flush.
func (b *liteBackend) StartIdleSweeper(ctx context.Context, store *db.Store, sandboxDBs *sandbox.SandboxDBManager) {
	if b == nil || store == nil {
		return
	}
	go func() {
		t := time.NewTicker(awsvmlite.IdleSweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				for _, sandboxID := range b.mgr.ExpiredIdle(time.Now()) {
					b.parkIdle(ctx, store, sandboxDBs, sandboxID)
				}
			}
		}
	}()
	log.Printf("vmhost-lite: idle sweeper started (every %s)", awsvmlite.IdleSweepInterval)
}

// parkIdle performs the whole park, in the order that keeps the sandbox
// recoverable.
func (b *liteBackend) parkIdle(ctx context.Context, store *db.Store, sandboxDBs *sandbox.SandboxDBManager, sandboxID string) {
	session, err := store.GetSandboxSession(ctx, sandboxID)
	if err != nil || session == nil {
		// No row to move. Parking anyway would produce exactly the invisible
		// asleep-but-"running" sandbox this function exists to avoid.
		log.Printf("vmhost-lite: idle-park %s skipped — no session row (%v)", sandboxID, err)
		return
	}
	result, err := b.Hibernate(ctx, sandboxID)
	if err != nil {
		// Most likely the suspended cap is full. Leave it running and retry
		// next pass: a customer who asked for "park when idle" has not asked to
		// be billed differently because the cell was busy, but nor have they
		// asked for anything destructive.
		log.Printf("vmhost-lite: idle-park %s failed (%v) — retrying next sweep", sandboxID, err)
		return
	}
	// Record BEFORE flipping status, same as the customer path: a row marked
	// hibernated with no hibernation record is unwakeable.
	// The key is empty on this runtime: parking is a provider-side suspend, so
	// the disk stays where it is and there is no archive to name. The record
	// still has to exist — wake looks it up and 404s without one.
	if _, _, cErr := store.CreateHibernation(ctx, sandboxID, session.OrgID,
		result.HibernationKey, result.SizeBytes, session.Region, session.Template, session.Config); cErr != nil {
		// The box is ALREADY asleep at this point, and without a record wake
		// answers "no active hibernation found" — the sandbox would be parked
		// and unreachable for good. Undo the park rather than leave it there;
		// the next sweep will try again. Being billed for a few more minutes is
		// strictly better than being stranded.
		log.Printf("vmhost-lite: idle-park %s: record hibernation failed (%v) — waking it back", sandboxID, cErr)
		if _, wErr := b.Wake(ctx, sandboxID, "", 0); wErr != nil {
			log.Printf("vmhost-lite: idle-park %s: CRITICAL could not wake back after a failed park: %v", sandboxID, wErr)
		}
		return
	}
	if uErr := store.UpdateSandboxSessionStatus(ctx, sandboxID, "hibernated", nil); uErr != nil {
		log.Printf("vmhost-lite: idle-park %s: status flip failed: %v", sandboxID, uErr)
	}
	if sandboxDBs != nil {
		// The lifecycle event is what carries this to D1 sandboxes_index, which
		// is what the edge answers GET /sandboxes/:id from. Postgres alone is
		// not enough: a customer-initiated hibernate travels THROUGH the edge,
		// which updates D1 itself, but a park decided here has no such request
		// to piggyback on. Without this the sandbox is asleep while every
		// customer-facing surface still reports it running.
		if sdb, dbErr := sandboxDBs.Get(sandboxID); dbErr == nil {
			_ = sdb.LogEvent("hibernated", map[string]string{
				"sandbox_id":     sandboxID,
				"checkpoint_key": result.HibernationKey,
			})
		}
		// Remove flushes what was just logged — the lifecycle event above and
		// the closing usage slice — before the per-sandbox DB is dropped.
		_ = sandboxDBs.Remove(sandboxID)
	}
	log.Printf("vmhost-lite: parked %s after its idle timeout", sandboxID)
}

// ── Hibernation ─────────────────────────────────────────────────────────────

// Compile-time proof this backend can park and revive its own sandboxes.
// Without it, hibernate and wake dispatch into the worker registry — which on
// this cell is empty — and fail with "no workers available" for a sandbox that
// is running perfectly well. That is exactly how the agent path's tiered
// hibernation ended up reachable from a test harness and from nothing else.
var _ Hibernator = (*liteBackend)(nil)

// Hibernate suspends the box. There is no archive and therefore no key: the
// state is the suspended box. See internal/awsvmlite/hibernate.go for the
// tradeoff, and in particular for why this is capped.
func (b *liteBackend) Hibernate(ctx context.Context, sandboxID string) (*sandbox.HibernateResult, error) {
	if b == nil {
		return nil, errors.New("vmhost-lite: backend disabled")
	}
	if err := b.mgr.Hibernate(ctx, sandboxID); err != nil {
		return nil, err
	}
	return &sandbox.HibernateResult{SandboxID: sandboxID}, nil
}

// Wake resumes the box and reports the worker_id still serving the sandbox.
//
// Unchanged, deliberately: a suspend/resume never moves the sandbox, so the
// persisted row already points at the right box. Returning a different id here
// would rewrite a correct row with a wrong one.
func (b *liteBackend) Wake(ctx context.Context, sandboxID, _ string, _ int) (string, error) {
	if b == nil {
		return "", errors.New("vmhost-lite: backend disabled")
	}
	if err := b.mgr.Wake(ctx, sandboxID); err != nil {
		return "", err
	}
	box, ok := b.mgr.BoxFor(sandboxID)
	if !ok {
		return "", fmt.Errorf("vmhost-lite: woke %s but hold no box for it", sandboxID)
	}
	return microvmWorkerID(box.MicrovmID), nil
}

// PreviewTarget reports how to reach a port inside this sandbox's guest, for
// the preview-URL proxy. False means this backend does not hold the sandbox.
//
// The port returned is the runtime's HOOK port, not the customer's: Lambda's
// proxy forwards only to the port declared on the image, so the customer's port
// travels in the path (/oc/port/<port>/...) and is fanned out inside the guest.
func (b *liteBackend) PreviewTarget(sandboxID string) (host, token string, hookPort int32, ok bool) {
	if b == nil {
		return "", "", 0, false
	}
	h, t, p, err := b.mgr.PreviewTarget(sandboxID)
	if err != nil {
		return "", "", 0, false
	}
	return h, t, p, true
}

// ── Terminals ───────────────────────────────────────────────────────────────
//
// Delegated straight to the manager. They live on the backend rather than on
// the sandbox.Manager adapter because a terminal is not one of sandbox.Manager's
// operations — it is a session with a socket, and forcing it into that
// interface would mean every runtime grew a method only this one implements.

func (b *liteBackend) PTYCreate(ctx context.Context, sandboxID string, req awsvmlite.PTYRequest) (string, error) {
	return b.mgr.PTYCreate(ctx, sandboxID, req)
}

func (b *liteBackend) PTYResize(ctx context.Context, sandboxID, sessionID string, cols, rows int32) error {
	return b.mgr.PTYResize(ctx, sandboxID, sessionID, cols, rows)
}

func (b *liteBackend) PTYKill(ctx context.Context, sandboxID, sessionID string) error {
	return b.mgr.PTYKill(ctx, sandboxID, sessionID)
}

func (b *liteBackend) DialPTY(ctx context.Context, sandboxID, sessionID string) (*websocket.Conn, error) {
	return b.mgr.DialPTY(ctx, sandboxID, sessionID)
}

// ── Exec sessions ───────────────────────────────────────────────────────────

func (b *liteBackend) ExecSessionCreate(ctx context.Context, sandboxID string, req awsvmlite.ExecSessionRequest) (string, error) {
	return b.mgr.ExecSessionCreate(ctx, sandboxID, req)
}

func (b *liteBackend) ExecSessionList(ctx context.Context, sandboxID string) ([]awsvmlite.ExecSessionInfo, error) {
	return b.mgr.ExecSessionList(ctx, sandboxID)
}

func (b *liteBackend) ExecSessionKill(ctx context.Context, sandboxID, sessionID string, signal int32) error {
	return b.mgr.ExecSessionKill(ctx, sandboxID, sessionID, signal)
}

func (b *liteBackend) ExecSessionGetResult(ctx context.Context, sandboxID, sessionID string) (*awsvmlite.ExecSessionResult, error) {
	return b.mgr.ExecSessionGetResult(ctx, sandboxID, sessionID)
}

func (b *liteBackend) DialExecSession(ctx context.Context, sandboxID, sessionID string) (*websocket.Conn, error) {
	return b.mgr.DialExecSession(ctx, sandboxID, sessionID)
}

// ── Reconciliation ──────────────────────────────────────────────────────────

// Restore rebuilds the sandbox→box map from the database after a restart.
//
// Nothing here survives the process, but the boxes do. Skipping this leaves
// live sandboxes simultaneously unroutable and unreapable — billing until the
// 8h cap with nothing able to find them.
func (b *liteBackend) Restore(ctx context.Context, store *db.Store) {
	b.Reconcile(ctx, store)
}

func (b *liteBackend) Reconcile(ctx context.Context, store *db.Store) {
	if b == nil || store == nil {
		return
	}
	rows, err := store.ListMicrovmSessions(ctx, b.WorkerIDPrefixes())
	if err != nil {
		log.Printf("vmhost-lite: reconcile query failed: %v", err)
		return
	}
	bound := b.mgr.Bindings()

	// One fleet-wide liveness answer for this pass.
	//
	// Without it, a sandbox that is BOTH held in memory AND has a row was never
	// liveness-checked by either loop below: the adopt loop skipped it because
	// it was held, and the forget loop skipped it because a row existed. So when
	// AWS reaped its box at the 8h cap the binding survived indefinitely —
	// measured on prod as bound=15 against exactly ONE live box.
	//
	// That number is not cosmetic. Capacity() reports len(Bound()) as the cell's
	// running count, which is what the edge routes on, so a count that only ever
	// grows makes the cell look progressively busier than it is.
	//
	// nil means the lookup FAILED, which is deliberately different from "nothing
	// is alive": dropping every binding on a transient AWS error would close out
	// every live sandbox on the cell.
	live, liveErr := b.mgr.LiveMicrovmIDs(ctx)
	if liveErr != nil {
		log.Printf("vmhost-lite: reconcile: fleet liveness unavailable (%v) — "+
			"skipping the stale-binding sweep this pass", liveErr)
		live = nil
	}

	var adopted, closed int
	var evicted, skipped, expired int
	seen := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		seen[r.SandboxID] = struct{}{}
		microvmID, ok := parseMicrovmWorkerID(r.WorkerID)
		if !ok {
			continue
		}
		// Past its deadline: the provider has destroyed this host by its own
		// contract, so no API call is needed to know that. Doing this FIRST is
		// what makes the pass useful even when AWS is unreachable — the case
		// where a liveness-based sweep can do nothing at all.
		//
		// The gated reads already hide this row, so closing it is bookkeeping
		// rather than a correctness fix. That is the intended shape.
		if !r.EndAt.IsZero() && time.Now().After(r.EndAt) {
			if _, held := bound[r.SandboxID]; held {
				b.mgr.Forget(r.SandboxID)
			}
			msg := "microvm reached its maximum lifetime"
			_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
			expired++
			continue
		}
		if microvmID2, held := bound[r.SandboxID]; held {
			// Held AND has a row — the case that used to fall through both
			// loops unchecked. Verify the box is still there.
			if live != nil {
				if _, alive := live[microvmID2]; !alive {
					b.mgr.Forget(r.SandboxID)
					msg := "microvm no longer exists"
					_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
					evicted++
				}
			}
			continue
		}
		// Sizing is re-derived from the row rather than defaulted, so a restart
		// does not silently re-meter every sandbox at the default tier for the
		// rest of its life.
		var meta awsvmlite.Meta
		if len(r.Config) > 0 {
			var cfg types.SandboxConfig
			if err := json.Unmarshal(r.Config, &cfg); err != nil {
				log.Printf("vmhost-lite: reconcile %s: config unmarshal failed (%v) — adopting with defaults", r.SandboxID, err)
			} else {
				meta = awsvmlite.Meta{Template: cfg.Template, MemoryMB: cfg.MemoryMB, CPUCount: cfg.CpuCount}
			}
		}
		// The fleet listing answers this without another API call, and it is
		// strictly better than a per-row GetMicrovm: one call for the whole
		// pass, and — decisively — no ambiguity between "gone" and "could not
		// ask". A host absent from a listing that SUCCEEDED is gone.
		if live != nil {
			if _, stillThere := live[microvmID]; !stillThere {
				msg := "microvm no longer exists"
				_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
				closed++
				continue
			}
		}
		alive, err := b.mgr.Adopt(ctx, r.SandboxID, microvmID, meta)
		if err != nil {
			// ErrNotFound is PROOF, not a failure to observe. AWS has no record
			// of this host and never will again, so the old blanket "skip on any
			// error" left the row `running` for the life of the database — the
			// error recurs identically on every pass. Measured on dev as three
			// rows skipped silently, forever.
			if errors.Is(err, awsvm.ErrNotFound) {
				msg := "microvm no longer exists"
				_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
				closed++
				continue
			}
			// Genuinely unknown — a throttle or timeout must never end a live
			// sandbox — so leave the row for the next pass, but SAY SO. The
			// silent continue is what let those three rows go unnoticed.
			skipped++
			log.Printf("vmhost-lite: reconcile %s: liveness unknown (%v) — leaving row running for the next pass",
				r.SandboxID, err)
			continue
		}
		if !alive {
			msg := "microvm no longer exists"
			_ = store.UpdateSandboxSessionStatus(ctx, r.SandboxID, "stopped", &msg)
			closed++
			continue
		}
		adopted++
	}

	// The mirror image: a binding whose row has reached a terminal state by some
	// path that never called Kill. Nothing else would ever drop it, and it would
	// keep being metered.
	var forgotten int
	for sandboxID, microvmID := range bound {
		if _, ok := seen[sandboxID]; ok {
			continue
		}
		if live == nil {
			continue // liveness unknown this pass; never drop on a guess
		}
		if _, alive := live[microvmID]; alive {
			continue
		}
		b.mgr.Forget(sandboxID)
		forgotten++
	}

	// skipped is in the summary deliberately: a row this pass could not resolve
	// is the one that becomes a permanent leak if the cause is not transient,
	// so it must be visible without turning on debug logging.
	if adopted > 0 || closed > 0 || forgotten > 0 || evicted > 0 || skipped > 0 || expired > 0 {
		log.Printf("vmhost-lite: reconciled — adopted %d, closed %d dead row(s), expired %d past-deadline row(s), forgot %d dead binding(s), evicted %d stale binding(s), skipped %d unresolved row(s)",
			adopted, closed, expired, forgotten, evicted, skipped)
	}
}

// StartReconciler sweeps on a ticker for the life of the process. Nothing
// reports in for these boxes — no worker exists — so this is the only thing that
// ever notices one dying.
func (b *liteBackend) StartReconciler(ctx context.Context, store *db.Store) {
	if b == nil || store == nil {
		return
	}
	go func() {
		t := time.NewTicker(microvmReconcileInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				b.Reconcile(ctx, store)
			}
		}
	}()
}

// ── Billing ─────────────────────────────────────────────────────────────────

// StartUsageTicker meters these sandboxes. There is no worker to emit ticks for
// them, so the control plane does it over the same sandbox.Manager interface.
func (b *liteBackend) StartUsageTicker(ctx context.Context, sandboxDBs *sandbox.SandboxDBManager) {
	if b == nil {
		return
	}
	t := worker.NewUsageTicker(b.sm, sandboxDBs, 20*time.Second, 10)
	if t == nil {
		// Said loudly: silent non-billing is the failure mode nobody notices.
		log.Printf("vmhost-lite: WARNING usage ticker disabled — sandboxes will not be metered")
		return
	}
	b.usageTicker = t
	// The manager fires the metering boundaries, because it is where a box
	// actually dies — see SetLifecycleObserver.
	b.mgr.SetLifecycleObserver(t)
	t.Start(ctx)
	log.Printf("vmhost-lite: usage ticker started")
}

// StartEventPublisher drains those ticks to the cell's Redis stream. Without
// this half the ticks sit on local disk and are never billed — and every log
// line still says metering is working.
func (b *liteBackend) StartEventPublisher(ctx context.Context, sandboxDBs *sandbox.SandboxDBManager, rdb *redis.Client, cellID string, store *db.Store) {
	if b == nil {
		return
	}
	if sandboxDBs == nil || rdb == nil || cellID == "" {
		log.Printf("vmhost-lite: WARNING event publisher disabled (sandboxDBs=%v redis=%v cellID=%q) — usage ticks stay on local disk",
			sandboxDBs != nil, rdb != nil, cellID)
		return
	}

	// events-ingest drops a tick whose worker_id disagrees with
	// sandboxes_index.worker_id, and each of these sandboxes has its own, so the
	// id has to be resolved per sandbox rather than stamped fleet-wide.
	//
	// WorkerIDFor, not BoxFor: the closing tick of a destroyed sandbox is
	// drained after its binding is gone, so a live-only lookup missed and the
	// publisher stamped a generic fallback id — which never matches the row, so
	// the tick was discarded as coming from a non-owner worker. That silently
	// unbilled the last slice of every destroyed sandbox.
	workerIDs := func(sandboxID string) (string, bool) {
		microvmID, ok := b.mgr.WorkerIDFor(sandboxID)
		if !ok {
			return "", false
		}
		return microvmWorkerID(microvmID), true
	}

	var meta worker.MetadataResolver
	if store != nil {
		meta = func(sandboxID string) (string, string, bool) {
			lookupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			orgIDStr, err := store.GetSandboxOrgID(lookupCtx, sandboxID)
			if err != nil || orgIDStr == "" {
				return "", "", false
			}
			orgID, err := uuid.Parse(orgIDStr)
			if err != nil {
				return "", "", false
			}
			org, err := store.GetOrg(lookupCtx, orgID)
			if err != nil {
				return orgIDStr, "", true
			}
			return orgIDStr, org.Plan, true
		}
	}

	pub, err := worker.NewRedisEventPublisher(worker.RedisEventPublisherConfig{
		Client:           rdb,
		SandboxDBs:       sandboxDBs,
		CellID:           cellID,
		WorkerID:         microvmPublisherWorkerID,
		Resolver:         meta,
		WorkerIDResolver: workerIDs,
	})
	if err != nil {
		log.Printf("vmhost-lite: WARNING event publisher init failed: %v — usage ticks will not be billed", err)
		return
	}
	// Flush before the SQLite file is deleted, or a destroyed sandbox's final
	// usage slice races the 2s poll and is lost.
	sandboxDBs.SetOnRemove(func(sandboxID string) {
		pub.FlushSandbox(context.Background(), sandboxID)
	})
	pub.Start(ctx)
	b.eventPub = pub
	log.Printf("vmhost-lite: event publisher started (stream=events:%s)", cellID)
}

// StartCapacityReporter publishes this cell's capacity, without which the edge
// does not route creates to it at all — its health gate reads the worker
// registry, and a cell with no workers never writes one.
func (b *liteBackend) StartCapacityReporter(ctx context.Context, rdb *redis.Client, cellID string) {
	if b == nil {
		return
	}
	if rdb == nil || cellID == "" {
		log.Printf("vmhost-lite: WARNING capacity reporter disabled (redis=%v cellID=%q) — the edge will not route creates here",
			rdb != nil, cellID)
		return
	}
	cr, err := controlplane.NewCapacityReporter(controlplane.CapacityReporterConfig{
		Redis:  rdb,
		Source: b,
		CellID: cellID,
	})
	if err != nil {
		log.Printf("vmhost-lite: WARNING capacity reporter init failed: %v", err)
		return
	}
	cr.Start(ctx)
	b.capacity = cr
	log.Printf("vmhost-lite: capacity reporter started (cell=%s)", cellID)
}

// Depth reports warm stock, for telemetry.
func (b *liteBackend) Depth() int {
	if b == nil {
		return 0
	}
	return b.mgr.Depth()
}

// Status is the operator's view of the warm set, for the admin endpoint.
func (b *liteBackend) Status() map[string]any {
	if b == nil {
		return map[string]any{"enabled": false}
	}
	return map[string]any{
		"enabled": true,
		"warm":    b.mgr.Depth(),
		"bound":   len(b.mgr.Bound()),
		// Parked boxes hold regional quota that can never be reclaimed, so this
		// is the number that explains a warm pool which will not fill.
		"suspended": b.mgr.SuspendedCount(),
		"region":    b.client.Config().Region,
	}
}

// ServesOwnStock: this backend manufactures and holds its own warm boxes, so the
// cell's Postgres pool is not its supply. See SelfStocking — consulting that
// pool for these creates measured 49-78ms of guaranteed miss per create.
func (b *liteBackend) ServesOwnStock() bool { return true }

// ── Halt: archive, release, restore ─────────────────────────────────────────

// Compile-time proof this backend can park a sandbox in a way that outlives its
// host. Without it an org halt falls through to the worker registry, which on
// this cell is empty, and the org's sandboxes keep running while the org is
// halted — billed and reachable, which is the opposite of a halt.
var _ haltArchiver = (*liteBackend)(nil)

// ArchiveForHalt copies the sandbox's durable state to the checkpoint store.
//
// Deliberately does NOT touch the box. Suspending is what a customer hibernate
// does and it is wrong here: the provider counts suspended time against the
// same 8h lifetime cap as running time, so a suspended sandbox still dies at
// the cap and takes its disk with it. A credit halt lasts as long as it takes
// someone to pay, which is routinely longer than that.
//
// What survives is the workspace, not the process tree. There is no memory
// capture on this runtime (see CapturesMemoryState), so a halted-and-resumed
// sandbox comes back as a fresh boot holding its files — the honest limit, and
// the reason halt is not offered as a customer-facing pause.
func (b *liteBackend) ArchiveForHalt(ctx context.Context, sandboxID string, store *storage.CheckpointStore) (string, int64, error) {
	if b == nil {
		return "", 0, errors.New("vmhost-lite: backend disabled")
	}
	if store == nil {
		// Without a store there is nowhere durable to put the state, and
		// releasing the host would destroy it. Refusing leaves the sandbox
		// running, which is recoverable; proceeding would not be.
		return "", 0, errors.New("vmhost-lite: no checkpoint store configured — refusing to halt, the archive would have nowhere to go")
	}
	// Keyed by a fresh id rather than the sandbox id: a sandbox can be halted,
	// resumed and halted again, and reusing one key would have the second
	// archive overwrite the first while the first was still the recorded
	// hibernation for anything that had not yet resumed.
	key := awsvmlite.WorkspaceKey("halt-" + uuid.NewString())
	size, err := b.mgr.CheckpointWorkspace(ctx, sandboxID, key, store)
	if err != nil {
		return "", 0, fmt.Errorf("vmhost-lite: archive %s for halt: %w", sandboxID, err)
	}
	return key, size, nil
}

// ReleaseForHalt terminates the host. The point of no return: after this the
// archive is the only copy, so the caller must have recorded it first.
func (b *liteBackend) ReleaseForHalt(ctx context.Context, sandboxID string) error {
	if b == nil {
		return errors.New("vmhost-lite: backend disabled")
	}
	// Destroy bills the closing usage slice on the way out, which is the whole
	// point of halting: the charge stops here rather than running to the cap.
	return b.mgr.Destroy(ctx, sandboxID)
}

// RestoreForResume gives the sandbox a brand new host and lays the archive back
// onto it.
//
// Not a wake: there is nothing to wake. The host was released at halt, so this
// claims a fresh box and rebinds the SAME sandbox id to it, which is why the
// caller has to write the returned worker id back onto the row.
func (b *liteBackend) RestoreForResume(ctx context.Context, sandboxID, key string, store *storage.CheckpointStore, spec HaltRestoreSpec) (string, error) {
	if b == nil {
		return "", errors.New("vmhost-lite: backend disabled")
	}
	// Key first, deliberately. An empty key means the sandbox was SUSPENDED,
	// not archived — that is what an idle park records. Restoring a fresh box
	// for it would strand the suspended one and hand the customer an empty
	// sandbox. That diagnosis is more specific than a missing store and stays
	// true regardless of how this cell is configured, so it must not be
	// masked by the config check below.
	if key == "" {
		return "", errors.New("vmhost-lite: no archive key — this sandbox was suspended, not halted; wake it instead")
	}
	if store == nil {
		return "", errors.New("vmhost-lite: no checkpoint store configured")
	}
	box, _, err := b.mgr.Claim(ctx, sandboxID, awsvmlite.Meta{
		Template: spec.Template,
		MemoryMB: spec.MemoryMB,
		CPUCount: spec.CPUCount,
	})
	if err != nil {
		return "", fmt.Errorf("vmhost-lite: claim a host for %s: %w", sandboxID, err)
	}
	if err := b.mgr.RestoreWorkspace(ctx, sandboxID, key, store); err != nil {
		// Give the box back. A claimed host with none of the customer's data on
		// it is worse than no host at all: it bills, it answers, and it looks
		// like a resumed sandbox that has silently lost everything.
		if dErr := b.mgr.Destroy(ctx, sandboxID); dErr != nil {
			log.Printf("vmhost-lite: resume %s: restore failed AND could not release the host: %v", sandboxID, dErr)
		}
		return "", fmt.Errorf("vmhost-lite: restore %s from %s: %w", sandboxID, key, err)
	}
	return microvmWorkerID(box.MicrovmID), nil
}
