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
	// A customer-driven resume always bills: if this box was mid unbilled
	// migration (billingSuppressed), the touch flips it to a normal billed box.
	vm.billingSuppressed = false

	// The vCPUs were frozen for the entire pause, so the guest clock is now
	// behind wall-clock by the pause duration. Re-sync it to host time — the
	// same step every wake/restore/migration path runs — otherwise the box
	// resumes with a skewed clock. Best-effort: a failed sync must not block the
	// resume (the VM is already running).
	if vm.agent != nil {
		if err := syncGuestClock(context.Background(), vm.agent); err != nil {
			log.Printf("qemu: resume %s: clock sync failed: %v", sandboxID, err)
		}
	}

	// Resume billing (the VM is a live running sandbox again).
	if m.lifecycleObs != nil {
		m.lifecycleObs.OnSandboxWake(sandboxID)
	}
	log.Printf("qemu: resume %s: vCPUs running", sandboxID)
	return nil
}

// ResumeUnbilled genuinely resumes a paused VM (QMP cont, vCPUs running, agent
// live) for an unbilled platform-initiated migration — but marks it
// billingSuppressed so the usage ticker skips it and fires NO OnSandboxWake
// billing hook. From this point the box is a normal live VM (so the migration is
// a normal live migration and the agent stays healthy), it just isn't charged.
// A customer request that touches it mid-move goes through the normal resume,
// which clears billingSuppressed and starts billing from the touch.
func (m *Manager) ResumeUnbilled(_ context.Context, sandboxID string) error {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return err
	}
	if !vm.opMu.TryLock() {
		return fmt.Errorf("another operation is in progress on sandbox %s — try again shortly", sandboxID)
	}
	defer vm.opMu.Unlock()

	if vm.qmp == nil {
		return fmt.Errorf("no QMP client for sandbox %s", sandboxID)
	}
	if !vm.pausedAt.IsZero() {
		if err := vm.qmp.Cont(); err != nil {
			return fmt.Errorf("qmp cont: %w", err)
		}
		vm.pausedAt = time.Time{}
		// Same clock resync as Resume — the box's vCPUs were frozen while paused.
		// The migration target also re-syncs on arrival, but correct the source
		// now so a stalled/aborted migration can't leave it skewed. Best-effort.
		if vm.agent != nil {
			if err := syncGuestClock(context.Background(), vm.agent); err != nil {
				log.Printf("qemu: resume-unbilled %s: clock sync failed: %v", sandboxID, err)
			}
		}
	}
	vm.Status = types.SandboxStatusRunning
	vm.billingSuppressed = true
	log.Printf("qemu: resume-unbilled %s: vCPUs running (billing suppressed for migration)", sandboxID)
	return nil
}

// SetBillingSuppressed marks a RUNNING VM as billing-suppressed as soon as it's
// registered on the migration target, so the usage ticker never charges for the
// live-migration transfer window. It does NOT change run-state — the box arrives
// and completes as a normal running migration (agent healthy); RepauseAfterMigration
// does the real pause afterward.
func (m *Manager) SetBillingSuppressed(sandboxID string) error {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return err
	}
	vm.billingSuppressed = true
	return nil
}

// RepauseAfterMigration performs a NORMAL pause of a healthy, running, just-
// migrated box on the target — QMP stop + reclaim, clearing billingSuppressed.
// Because it runs on a fully-settled running sandbox (the live migration left it
// running with a live agent), this is identical to a routine Pause, so wake works
// exactly like any paused box. Fires no billing hook (the box was suppressed, so
// there is no running slice to flush).
func (m *Manager) RepauseAfterMigration(_ context.Context, sandboxID string) (reclaimedBytes uint64, err error) {
	vm, err := m.getVM(sandboxID)
	if err != nil {
		return 0, err
	}
	if !vm.opMu.TryLock() {
		return 0, fmt.Errorf("another operation is in progress on sandbox %s — try again shortly", sandboxID)
	}
	defer vm.opMu.Unlock()

	if vm.qmp == nil {
		return 0, fmt.Errorf("no QMP client for sandbox %s", sandboxID)
	}
	if err := vm.qmp.Stop(); err != nil {
		return 0, fmt.Errorf("qmp stop: %w", err)
	}
	vm.pausedAt = time.Now()
	vm.Status = types.SandboxStatusPaused
	vm.billingSuppressed = false

	t0 := time.Now()
	advised, rErr := reclaimGuestRAM(vm.pid, pauseReclaimMinRegionBytes)
	if rErr != nil {
		log.Printf("qemu: repause-after-migration %s: stopped; reclaim best-effort failed: %v", sandboxID, rErr)
	} else {
		log.Printf("qemu: repause-after-migration %s: stopped + advised %d MiB to swap in %dms",
			sandboxID, advised>>20, time.Since(t0).Milliseconds())
	}
	return advised, nil
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
