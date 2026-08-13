package qemu

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// wakeSem bounds how many pool boxes may resume (Cont + guest-RAM swap-in) at
// once on this worker. A warm-pool burst can land dozens of simultaneous claims
// on a single worker; without a cap they all fault paged-out guest RAM back from
// the zram/swap tier at the same instant and thrash, inflating every box's wake
// and blowing the burst tail. Serializing to a small width — paired with
// prefetchGuestRAM's eager, batched swap-in — keeps each resume fast so the tail
// stays tight. There is exactly one Manager per worker process, so a package
// singleton is per-worker. Sized from OPENSANDBOX_WAKE_CONCURRENCY (default 8).
var wakeSem = make(chan struct{}, wakeConcurrency())

func wakeConcurrency() int {
	if v := os.Getenv("OPENSANDBOX_WAKE_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 8
}

// WarmGuest runs a best-effort warm-up command in a running pool box so the
// interpreter/binary pages the first customer command needs are already resident
// (page cache warm). Only meaningful for a HOT (unpaused) pool box — a paused
// box's pages get reclaimed to swap, so warming it is pointless. Best-effort:
// warm-up failures never fail manufacture. Command from OPENSANDBOX_POOL_WARMUP_CMD
// (default warms the common runtimes).
func (m *Manager) WarmGuest(ctx context.Context, sandboxID string) {
	vm, err := m.getVM(sandboxID)
	if err != nil || vm.agent == nil {
		return
	}
	cmd := os.Getenv("OPENSANDBOX_POOL_WARMUP_CMD")
	if cmd == "" {
		// Measured 2026-08-12: guest page cache is NOT the first-exec cost — a
		// cold `node -v` costs ~1ms more than a warm one. The real ~240ms is
		// per-exec-session setup, and it is paid by whichever exec runs first
		// WHATEVER it runs (a bare `sh -c :` first cost 522ms; the `node -v`
		// right after it cost 123ms = fully-warm). So warm with the cheapest
		// possible command: we are establishing the session, not faulting pages.
		cmd = ":"
	}
	execCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if _, e := vm.agent.Exec(execCtx, &pb.ExecRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", cmd + " >/dev/null 2>&1 || true"},
		// NOT RunAsRoot: customer commands run as the sandbox user, so warming as
		// root would establish the wrong session if any of the setup is per-user.
		RunAsRoot: false,
	}); e != nil {
		log.Printf("qemu: warm-guest %s: %v (best-effort)", sandboxID, e)
	}
}

// WarmClaimed re-warms a box's exec session AFTER ClaimPooled has bound it to a
// customer. Manufacture-time WarmGuest is not enough: prod journals show it runs
// on every manufacture and never errors (348/342 per worker in 6h, zero error
// lines), yet the first customer exec still pays ~240ms. ClaimPooled re-applies
// env/secrets/network via PrepareResume in between, which appears to invalidate
// whatever the manufacture-time warm established — so the warm has to happen on
// the customer's side of the claim.
//
// Fire-and-forget on its own context: this must never extend claim latency (the
// caller's ctx dies with the gRPC request), and a failed warm just means the
// customer's first exec pays what it pays today.
func (m *Manager) WarmClaimed(sandboxID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		// Deliberately Exec, not WarmGuest: WarmGuest talks to vm.agent directly,
		// so it skips getReadyVM — and getReadyVM's virtio-mem hotplug wait is the
		// prime suspect for the first-exec penalty (a claimed box is grown to its
		// requested memory asynchronously, so only the first exec blocks on it).
		// A warm that bypasses the wait pre-pays nothing. This takes the exact
		// path a customer's first exec takes, including that gate.
		// /bin/true, not ":" — shellSafeArgv sends a metacharacter-free command
		// straight to execve, and ":" only exists as a shell builtin.
		if _, err := m.Exec(ctx, sandboxID, types.ProcessConfig{Command: "/bin/true", Timeout: 5}); err != nil {
			log.Printf("qemu: warm-claimed %s: %v (best-effort)", sandboxID, err)
		}
	}()
}

// ClaimPooled binds a parked pool box (manufactured via Create + Pause +
// MarkPooled) to a customer: QMP cont to resume the vCPUs, then re-apply the
// customer's env/secrets + network/clock via the same post-restore bind
// createFromGolden uses (folded PrepareResume, else the legacy per-op path).
//
// Unlike Resume it fires NO OnSandboxWake billing hook — a claimed box is a
// brand-new customer sandbox, billed from the gRPC handler's
// recordInitialScaleEvent, not "resumed". The box keeps its manufacture-time
// IP/TAP + metadata registration (the guest IP is stable), so there is no re-IP
// or metadata churn. Memory is grown to the requested size separately by the
// control plane via SetSandboxLimits, exactly as for a cold create.
//
// The ~260ms golden restore is skipped entirely — it was pre-paid at manufacture.
func (m *Manager) ClaimPooled(ctx context.Context, sandboxID string, cfg types.SandboxConfig) (*types.Sandbox, error) {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return nil, err
	}
	if !vm.opMu.TryLock() {
		return nil, fmt.Errorf("another operation is in progress on sandbox %s — try again shortly", sandboxID)
	}
	defer vm.opMu.Unlock()

	if vm.qmp == nil {
		return nil, fmt.Errorf("no QMP client for pooled sandbox %s", sandboxID)
	}
	if vm.agent == nil {
		return nil, fmt.Errorf("no agent client for pooled sandbox %s", sandboxID)
	}

	t0 := time.Now()
	// Resume vCPUs — paused pool boxes only. A HOT pool box (OPENSANDBOX_HOT_POOL)
	// is already running, so it skips the wake gate, RAM prefetch, and Cont
	// entirely: the claim is a pure assign + rebind. No billing hook — see doc.
	if !vm.pausedAt.IsZero() {
		// Bound concurrent wakes so a burst doesn't thrash the swap tier all at
		// once (see wakeSem); held through the claim so the swap-in it kicks off
		// stays bounded.
		select {
		case wakeSem <- struct{}{}:
			defer func() { <-wakeSem }()
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		// Eagerly swap the paged-out guest RAM back in (batched readahead) so the
		// guest doesn't lazy-fault it page-by-page on first touch after Cont —
		// the swap-in stall that otherwise dominates a warm-pool wake.
		if _, err := prefetchGuestRAM(vm.pid, pauseReclaimMinRegionBytes); err != nil {
			log.Printf("qemu: claim %s: guest-RAM prefetch best-effort failed: %v", sandboxID, err)
		}
		if err := vm.qmp.Cont(); err != nil {
			return nil, fmt.Errorf("claim %s: qmp cont: %w", sandboxID, err)
		}
		vm.pausedAt = time.Time{}
	}
	vm.Status = types.SandboxStatusRunning
	vm.billingSuppressed = false

	// A pooled box sits paused until claimed; a long pause dwell can let gRPC
	// keepalive tear down the agent control channel (or leave it wedged), so the
	// first real RPC after Cont would otherwise hang until its deadline. Refresh
	// the channel up front — cheap Ping, redial only if it's actually stale, both
	// on short timeouts — so every customer-facing agent op below (secret cert
	// write, PrepareResume) runs on a known-live conn instead of eating a
	// multi-second stall + hard claim failure on the create critical path.
	m.ensureAgentLive(ctx, sandboxID, vm.agent)

	// Re-bind customer state onto the resumed box: envs + secrets + network +
	// clock, folded through PrepareResume (falls back to the legacy per-op path).
	envsToInject := m.sealSandboxEnvs(ctx, sandboxID, vm.network, vm.agent, cfg)
	if m.usePrepareResume() {
		if err := m.agentPrepareResume(ctx, sandboxID, vm.agent, vm.network, envsToInject); err != nil {
			log.Printf("qemu: claim %s: PrepareResume unavailable (%v) — legacy post-restore", sandboxID, err)
			m.legacyPostRestore(sandboxID, vm.agent, vm.network, envsToInject)
		}
	} else {
		m.legacyPostRestore(sandboxID, vm.agent, vm.network, envsToInject)
	}

	log.Printf("qemu: claim %s: resumed + rebound in %dms (template=%s)", sandboxID, time.Since(t0).Milliseconds(), vm.Template)
	return &types.Sandbox{
		ID:            sandboxID,
		Template:      vm.Template,
		Status:        types.SandboxStatusRunning,
		StartedAt:     time.Now(),
		CpuCount:      vm.CpuCount,
		MemoryMB:      vm.MemoryMB,
		HostPort:      vm.HostPort,
		GoldenVersion: vm.goldenVersion,
	}, nil
}

// ensureAgentLive verifies the agent control channel is responsive after a pool
// box is un-paused, and redials once if it isn't. Both the probe and the
// post-redial re-probe use short timeouts so a stale/wedged channel is turned
// into a fast redial (~single-digit ms on a healthy conn, ~1-2s worst case on a
// stale one) rather than a multi-second hang on the first customer-facing RPC
// that trips the CP's claim deadline into a hard failure + cold create.
//
// Best-effort: on a box whose agent is genuinely wedged this can't help, but it
// costs one cheap Ping on the healthy path and recovers the common
// "paused-dwell keepalive dropped the conn" case transparently.
func (m *Manager) ensureAgentLive(ctx context.Context, sandboxID string, agent *AgentClient) {
	if agent == nil {
		return
	}
	pingCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	_, err := agent.Ping(pingCtx)
	cancel()
	if err == nil {
		return // channel healthy — no redial
	}
	log.Printf("qemu: claim %s: agent ping failed (%v) — redialing stale channel", sandboxID, err)
	if rdErr := agent.Redial(); rdErr != nil {
		log.Printf("qemu: claim %s: agent redial failed: %v", sandboxID, rdErr)
		return
	}
	pingCtx2, cancel2 := context.WithTimeout(ctx, 1500*time.Millisecond)
	if _, perr := agent.Ping(pingCtx2); perr != nil {
		log.Printf("qemu: claim %s: agent still unresponsive after redial: %v", sandboxID, perr)
	}
	cancel2()
}
