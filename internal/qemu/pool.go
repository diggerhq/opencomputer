package qemu

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
)

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
	// Resume vCPUs. No billing hook — see doc comment.
	if !vm.pausedAt.IsZero() {
		if err := vm.qmp.Cont(); err != nil {
			return nil, fmt.Errorf("claim %s: qmp cont: %w", sandboxID, err)
		}
		vm.pausedAt = time.Time{}
	}
	vm.Status = types.SandboxStatusRunning
	vm.billingSuppressed = false

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
