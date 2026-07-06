package qemu

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// pauseReclaimMinRegionBytes is the size floor for a /proc/<pid>/maps region to
// be treated as guest RAM (and paged out on pause). QEMU's own heap/stacks are
// far below this; guest RAM regions are >= the configured memory.
const pauseReclaimMinRegionBytes = 64 << 20 // 64 MiB

// Pause freezes a running VM's vCPUs (QMP stop) and proactively pages its guest
// memory out to the host swap tier, dropping the paused VM's physical footprint
// to its compressed working set. Unlike Hibernate (savevm → evict), the VM stays
// resident on this worker, so Resume is an instant QMP cont with a lazy
// page-fault warm-up. No guest cooperation, no file-backed memory, no savevm —
// so it avoids the qcow2/ext4 corruption surface entirely.
//
// Idempotent: pausing an already-paused VM is a no-op. Serialized with other
// destructive VM ops via opMu.
func (m *Manager) Pause(_ context.Context, sandboxID string) (reclaimedBytes uint64, err error) {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return 0, err
	}
	if !vm.opMu.TryLock() {
		return 0, fmt.Errorf("another operation is in progress on sandbox %s — try again shortly", sandboxID)
	}
	defer vm.opMu.Unlock()

	if !vm.pausedAt.IsZero() {
		return 0, nil // already paused
	}
	if vm.qmp == nil {
		return 0, fmt.Errorf("no QMP client for sandbox %s", sandboxID)
	}

	if err := vm.qmp.Stop(); err != nil {
		return 0, fmt.Errorf("qmp stop: %w", err)
	}
	vm.pausedAt = time.Now()
	vm.Status = types.SandboxStatusPaused

	// Stop billing: flush the final running slice, exactly like hibernate. The
	// usage ticker skips non-running VMs, so a paused VM accrues nothing while
	// resident. Resume calls OnSandboxWake to start billing again.
	if m.lifecycleObs != nil {
		m.lifecycleObs.OnSandboxHibernate(sandboxID, vm.MemoryMB, vm.CpuCount, vm.StartedAt)
	}

	// Proactively reclaim now that the vCPUs are frozen (nothing will re-fault
	// the pages immediately). Best-effort: a failure here just means less
	// physical reclaim — the kernel still swaps the cold pages under pressure —
	// not a broken pause, so we keep the VM paused regardless.
	t0 := time.Now()
	advised, rErr := reclaimGuestRAM(vm.pid, pauseReclaimMinRegionBytes)
	if rErr != nil {
		log.Printf("qemu: pause %s: stopped; reclaim best-effort failed: %v", sandboxID, rErr)
	} else {
		log.Printf("qemu: pause %s: stopped + advised %d MiB to swap in %dms",
			sandboxID, advised>>20, time.Since(t0).Milliseconds())
	}
	return advised, nil
}

// Resume restores a paused VM's vCPUs (QMP cont). Paged-out guest memory faults
// back from swap lazily as the guest runs — instant, no savevm/loadvm restore.
//
// Idempotent: resuming a non-paused VM is a no-op.
func (m *Manager) Resume(_ context.Context, sandboxID string) error {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return err
	}
	if !vm.opMu.TryLock() {
		return fmt.Errorf("another operation is in progress on sandbox %s — try again shortly", sandboxID)
	}
	defer vm.opMu.Unlock()

	if vm.pausedAt.IsZero() {
		return nil // not paused
	}
	if vm.qmp == nil {
		return fmt.Errorf("no QMP client for sandbox %s", sandboxID)
	}

	if err := vm.qmp.Cont(); err != nil {
		return fmt.Errorf("qmp cont: %w", err)
	}
	vm.pausedAt = time.Time{}
	vm.Status = types.SandboxStatusRunning

	// Resume billing (the VM is a live running sandbox again).
	if m.lifecycleObs != nil {
		m.lifecycleObs.OnSandboxWake(sandboxID)
	}
	log.Printf("qemu: resume %s: vCPUs running", sandboxID)
	return nil
}

// IsPaused reports whether the VM is currently paused and, if so, since when.
// A best-effort read for the promotion sweeper and status projection; the
// pausedAt read is not opMu-guarded (a benign race for a monotonic timestamp).
func (m *Manager) IsPaused(sandboxID string) (since time.Time, paused bool) {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return time.Time{}, false
	}
	return vm.pausedAt, !vm.pausedAt.IsZero()
}
