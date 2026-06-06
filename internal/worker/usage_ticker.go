package worker

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// UsageTicker emits a `usage_tick` event into each running sandbox's per-
// sandbox SQLite on a fixed interval. The RedisEventPublisher picks the
// events up on its 2s poll and ships them to the cell's Redis stream; the
// CF events-ingest Worker then fans them out to per-org CreditAccount DOs,
// which decrement the org's free-tier balance and dispatch a halt webhook
// when it hits zero.
//
// Without this ticker the DO never gets debited and free orgs run forever
// at $5 balance. The architectural intent (see events-ingest /debit fan-out)
// is exactly this periodic emit; no other component has the right scope to
// do it because:
//   - The CP doesn't know about per-sandbox uptime granularity.
//   - The worker is the only place that actually owns running VMs.
//   - The DO can't self-schedule per-sandbox debit cadence.
//
// Cost model — two consumers off the same event:
//   - Free tier: every tick contributes `cost_cents` per sandbox, debited
//     against the org's DO balance. Cost is proportional to the actual
//     elapsed time the tick represents (see "Interval accuracy" below) so a
//     short sandbox that lived 4s pays 4/20 of a steady-state tick's worth.
//   - Pro tier: the tick carries the sandbox's resource dimensions
//     (memory_mb, cpu_count, interval_s). events-ingest lands these into D1
//     `usage_samples` for pro orgs; a rollup cron turns the samples into
//     memory_gb_seconds and meters them to Stripe.
//
// ── Interval accuracy ────────────────────────────────────────────────────
//
// Previous revision stamped `interval_s = tickInterval (20s)` on every tick.
// That broke billing in two directions:
//   - Over-counting: a sandbox that lived 4s and happened to catch one tick
//     was attributed a full 20s of compute (5× over on cell GB-seconds).
//   - Under-counting: a sandbox that lived 1s and missed every tick was
//     attributed 0s (vs cell which records actual scale_events intervals).
//
// Edge usage_samples disagreed with cell sandbox_scale_events by up to 300%
// for short-sandbox-heavy workloads (see usage-parity checker reports).
//
// This revision tracks the last-emit timestamp per sandbox and stamps the
// ACTUAL elapsed interval:
//
//   - First time a sandbox is seen by the ticker: interval = min(now-StartedAt,
//     tickInterval). This catches sandboxes that lived briefly between two
//     tick boundaries — they get accurate, sub-tick attribution.
//   - Subsequent emits: interval = now - lastEmit (capped at 2× tickInterval
//     as a safety net for unexpected scheduling gaps).
//   - On hibernate/destroy: the sandbox drops out of manager.List() OR
//     IsSandboxAlive returns false. We drop its state, so a wake later in
//     the same ticker process treats it as a fresh first-observation
//     (interval measured from sb.StartedAt). Hibernation time isn't counted
//     as compute — sb.StartedAt advances on wake (qemu Manager re-stamps it).
//
// What this revision intentionally doesn't do:
//   - No lifecycle hooks from qemu.Manager. Scale and destroy events still
//     have up to one-tick-interval of slop (the slice between the last tick
//     and the lifecycle event is attributed to whichever config was active
//     at the next observation — or lost on destroy). That slop is bounded
//     and small compared to the 300% drifts we were seeing pre-fix. If
//     parity post-deploy still flags meaningfully, add hook calls in
//     qemu.Manager.{Scale,Hibernate,Kill} next.
type UsageTicker struct {
	manager       sandbox.Manager
	sandboxDBs    *sandbox.SandboxDBManager
	interval      time.Duration
	costPerTickCs int // cents debited per FULL tick interval; scaled by actual interval below

	mu      sync.Mutex
	lastSeen map[string]time.Time // sandbox_id → last emit wall-clock

	stop    chan struct{}
	stopped chan struct{}
	once    sync.Once
}

// NewUsageTicker constructs a ticker. interval ≤ 0 defaults to 20s,
// costPerTickCs ≤ 0 defaults to 10 cents (so a steady-state $5 = 50 ticks
// at the default interval ≈ 17 min). Cost is scaled by actual emit interval,
// so short sandboxes pay proportionally less.
// nil manager or nil sandboxDBs returns nil (ticker disabled).
func NewUsageTicker(manager sandbox.Manager, sandboxDBs *sandbox.SandboxDBManager, interval time.Duration, costPerTickCs int) *UsageTicker {
	if manager == nil || sandboxDBs == nil {
		return nil
	}
	if interval <= 0 {
		interval = 20 * time.Second
	}
	if costPerTickCs <= 0 {
		costPerTickCs = 10
	}
	return &UsageTicker{
		manager:       manager,
		sandboxDBs:    sandboxDBs,
		interval:      interval,
		costPerTickCs: costPerTickCs,
		lastSeen:      make(map[string]time.Time),
		stop:          make(chan struct{}),
		stopped:       make(chan struct{}),
	}
}

// Start begins the tick loop. Safe to call once; subsequent calls are no-ops.
func (t *UsageTicker) Start(ctx context.Context) {
	go t.run(ctx)
}

// Stop signals the loop to exit and waits for it to drain.
func (t *UsageTicker) Stop(ctx context.Context) error {
	t.once.Do(func() { close(t.stop) })
	select {
	case <-t.stopped:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (t *UsageTicker) run(ctx context.Context) {
	defer close(t.stopped)
	ticker := time.NewTicker(t.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.stop:
			return
		case <-ticker.C:
			t.tick(ctx)
		}
	}
}

func (t *UsageTicker) tick(ctx context.Context) {
	list, err := t.manager.List(ctx)
	if err != nil {
		log.Printf("usage_ticker: manager.List failed: %v", err)
		return
	}
	if len(list) == 0 {
		// Still prune any stale state so it doesn't accumulate forever.
		t.pruneStateNotIn(nil)
		log.Printf("usage_ticker: tick: 0 running sandboxes (skip)")
		return
	}
	now := time.Now()
	emitted := 0
	skippedDead := 0
	aliveIDs := make([]string, 0, len(list))
	for _, sb := range list {
		// Defense in depth: even if manager.List() returns a ghost entry
		// (m.vms entry whose qemu/firecracker process died but wasn't
		// cleaned up), don't bill for it. The leak this guards against
		// was a 70+ hour-per-sandbox billing bleed in prod where ghosts
		// kept ticking until the worker process restarted and wiped m.vms.
		// See internal/qemu/ghost_reaper.go for the boundary fix +
		// reaper that drains the map.
		alive, err := t.manager.IsSandboxAlive(ctx, sb.ID)
		if err != nil {
			log.Printf("usage_ticker: %s: IsSandboxAlive check failed: %v — skipping this tick", sb.ID, err)
			continue
		}
		if !alive {
			skippedDead++
			t.dropState(sb.ID)
			log.Printf("usage_ticker: %s: not alive (ghost m.vms entry?) — skipping; reaper should drain it", sb.ID)
			continue
		}
		aliveIDs = append(aliveIDs, sb.ID)

		intervalSec := t.intervalSecondsFor(sb, now)
		if intervalSec <= 0 {
			// Pathological — clock went backwards or two ticks landed in the
			// same instant. Skip rather than emit a zero/negative debit.
			continue
		}

		sdb, err := t.sandboxDBs.Get(sb.ID)
		if err != nil {
			log.Printf("usage_ticker: %s: Get failed: %v", sb.ID, err)
			continue
		}

		costCs := t.scaledCost(intervalSec)
		if err := sdb.LogEvent("usage_tick", map[string]interface{}{
			"sandbox_id": sb.ID,
			"cost_cents": costCs,
			"interval_s": intervalSec,
			// Resource dimensions for pro-tier metering on the edge. Free
			// orgs ignore these (they debit cost_cents); pro orgs land them
			// in D1 usage_samples. MemoryMB/CpuCount come straight off the
			// running VM's tier — the worker owns the VM so these are exact.
			"memory_mb": sb.MemoryMB,
			"cpu_count": sb.CpuCount,
		}); err != nil {
			log.Printf("usage_ticker: %s: LogEvent failed: %v", sb.ID, err)
			continue
		}
		t.markEmitted(sb.ID, now)
		emitted++
	}
	// Drop state for any sandbox we tracked that didn't appear alive this
	// tick — covers hibernate (sb still in list but IsSandboxAlive=false,
	// already handled above) AND outright disappearance (destroy between
	// ticks where the sandbox is gone from List entirely).
	t.pruneStateNotIn(aliveIDs)
	log.Printf("usage_ticker: tick: emitted %d usage_tick event(s) for %d listed sandbox(es) (skipped %d as not-alive)", emitted, len(list), skippedDead)
}

// intervalSecondsFor returns the actual elapsed time (in seconds, integer-rounded)
// to attribute to this emit. Read-only on the state map.
func (t *UsageTicker) intervalSecondsFor(sb types.Sandbox, now time.Time) int {
	t.mu.Lock()
	last, seen := t.lastSeen[sb.ID]
	t.mu.Unlock()

	var elapsed time.Duration
	if !seen {
		// First observation. Measure from sandbox start so a sandbox that
		// lived briefly between two tick boundaries is attributed its actual
		// lifetime, not a full tick interval (the bug this fix addresses).
		//
		// Cap at one tick interval: if we somehow see a sandbox much older
		// than that (e.g. worker just started up and adopted an existing
		// VM), we conservatively attribute only one interval rather than
		// retroactively backfilling history that was never measured.
		if sb.StartedAt.IsZero() {
			elapsed = t.interval
		} else {
			elapsed = now.Sub(sb.StartedAt)
			if elapsed > t.interval {
				elapsed = t.interval
			}
		}
	} else {
		elapsed = now.Sub(last)
		// Safety cap at 2× tick interval. Steady state is 1× ± scheduling
		// jitter. Anything larger means we missed an emit cycle (scheduler
		// stall, wake-from-hibernation that our prune didn't catch, etc.)
		// and we'd rather under-attribute than charge a full hibernation
		// period of catch-up.
		if max := 2 * t.interval; elapsed > max {
			elapsed = max
		}
	}
	if elapsed < 0 {
		return 0
	}
	return int(elapsed.Seconds())
}

// scaledCost returns cents proportional to elapsed time. Steady state at the
// configured tick interval produces costPerTickCs exactly; short emits pay
// less, longer (capped) emits pay more.
func (t *UsageTicker) scaledCost(intervalSec int) int {
	if t.interval <= 0 {
		return t.costPerTickCs
	}
	return t.costPerTickCs * intervalSec / int(t.interval.Seconds())
}

func (t *UsageTicker) markEmitted(sandboxID string, when time.Time) {
	t.mu.Lock()
	t.lastSeen[sandboxID] = when
	t.mu.Unlock()
}

func (t *UsageTicker) dropState(sandboxID string) {
	t.mu.Lock()
	delete(t.lastSeen, sandboxID)
	t.mu.Unlock()
}

// pruneStateNotIn drops any tracked sandbox that's not in the kept set. Cheap
// per-tick GC — bounds the state map to currently-alive sandboxes so a
// long-lived worker doesn't accumulate entries for hibernated/destroyed VMs.
func (t *UsageTicker) pruneStateNotIn(keep []string) {
	keepSet := make(map[string]struct{}, len(keep))
	for _, id := range keep {
		keepSet[id] = struct{}{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for id := range t.lastSeen {
		if _, ok := keepSet[id]; !ok {
			delete(t.lastSeen, id)
		}
	}
}

// ── sandbox.LifecycleObserver implementation ─────────────────────────────
//
// These hooks let qemu.Manager flush an accurate final-slice emit at the
// exact moment a sandbox's config changes or its existence ends. Without
// them, the gap between the last periodic tick and the lifecycle event is
// lost (destroy/hibernate) or misattributed (scale).
//
// Together with the periodic tick's first-emit-uses-StartedAt logic, this
// closes the cell↔edge measurement parity gap that prevented PR 349's
// billing cutover. See internal/sandbox/lifecycle.go for the contract.

// OnSandboxScale fires before resource limits change. Emits a final tick
// attributing the slice [lastSeen, now] (or [startedAt, now] if never seen)
// to the OLD config, then resets lastSeen so the next periodic tick
// attributes the post-scale slice starting from now.
func (t *UsageTicker) OnSandboxScale(sandboxID string, oldMemoryMB, oldCPUCount int, startedAt time.Time) {
	t.flushSlice(sandboxID, oldMemoryMB, oldCPUCount, startedAt, false /* keepState */)
}

// OnSandboxDestroy fires when a sandbox is killed. Emits a final tick and
// drops the per-sandbox state. Uses startedAt as the fallback attribution
// point when the sandbox died before any periodic tick fired (otherwise
// short sandboxes never get billed at all).
func (t *UsageTicker) OnSandboxDestroy(sandboxID string, memoryMB, cpuCount int, startedAt time.Time) {
	t.flushSlice(sandboxID, memoryMB, cpuCount, startedAt, true /* dropState */)
}

// OnSandboxHibernate fires before savevm. Emits a final pre-hibernate tick
// and drops state — the sandbox is gone from the periodic tick's view until
// it wakes, at which point OnSandboxWake re-establishes attribution. Falls
// back to startedAt when the sandbox hibernated before any periodic tick.
func (t *UsageTicker) OnSandboxHibernate(sandboxID string, memoryMB, cpuCount int, startedAt time.Time) {
	t.flushSlice(sandboxID, memoryMB, cpuCount, startedAt, true /* dropState */)
}

// OnSandboxWake fires after loadvm restores a sandbox. Sets lastSeen to wake
// time so the next emit (periodic OR lifecycle hook — including a fast
// post-wake destroy) attributes from wake forward, not from before
// hibernation. Hibernation time itself is not billed: we jumped lastSeen
// from pre-hibernate over the entire hibernation window.
//
// We deliberately SET rather than drop state. Earlier revision dropped, and
// a wake-onto-different-worker followed by destroy before any periodic tick
// would leave the destroy hook unable to attribute anything (flushSlice
// returns early on missing lastSeen). Setting lastSeen=now gives every
// subsequent emit a measurable starting point.
func (t *UsageTicker) OnSandboxWake(sandboxID string) {
	t.markEmitted(sandboxID, time.Now())
}

// flushSlice emits one usage_tick for the elapsed-since-last-seen interval
// under the given config. If we never observed the sandbox before, there's
// nothing to attribute (the first periodic tick will handle that case via
// the StartedAt path). When dropState=true, removes state after emitting;
// otherwise resets lastSeen=now so the next periodic tick measures from
// here forward (used by scale events where the sandbox continues).
func (t *UsageTicker) flushSlice(sandboxID string, memoryMB, cpuCount int, startedAt time.Time, dropState bool) {
	now := time.Now()
	t.mu.Lock()
	last, seen := t.lastSeen[sandboxID]
	if dropState {
		delete(t.lastSeen, sandboxID)
	} else {
		t.lastSeen[sandboxID] = now
	}
	t.mu.Unlock()

	var elapsed time.Duration
	if seen {
		elapsed = now.Sub(last)
	} else if !startedAt.IsZero() {
		// Fallback: no prior emit for this sandbox. Use startedAt as the
		// attribution start so a sandbox that lived <tick-interval and
		// hibernated/destroyed before any periodic tick still gets billed.
		// Without this branch, short sandboxes silently went unbilled —
		// the dominant cause of the -100% drift seen on parity for free
		// orgs whose workload is bursty (e.g. CI hooks).
		elapsed = now.Sub(startedAt)
	} else {
		// No prior emit AND no startedAt — nothing to attribute. Caller
		// should have passed startedAt; treat as no-op rather than guess.
		return
	}
	if elapsed <= 0 {
		return
	}
	if max := 2 * t.interval; elapsed > max {
		elapsed = max
	}
	intervalSec := int(elapsed.Seconds())
	if intervalSec <= 0 {
		return
	}

	// State mutation above completed; if the DB layer isn't wired (test
	// harness, or graceful-shutdown race), still drop/reset state but skip
	// the LogEvent. The next ticker run will be consistent.
	if t.sandboxDBs == nil {
		return
	}
	sdb, err := t.sandboxDBs.Get(sandboxID)
	if err != nil {
		log.Printf("usage_ticker: flushSlice %s: Get failed: %v", sandboxID, err)
		return
	}
	if err := sdb.LogEvent("usage_tick", map[string]interface{}{
		"sandbox_id": sandboxID,
		"cost_cents": t.scaledCost(intervalSec),
		"interval_s": intervalSec,
		"memory_mb":  memoryMB,
		"cpu_count":  cpuCount,
	}); err != nil {
		log.Printf("usage_ticker: flushSlice %s: LogEvent failed: %v", sandboxID, err)
	}
}
