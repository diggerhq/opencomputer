package qemu

import (
	"context"
	"log"
	"syscall"
	"time"
)

// Ghost VM reaper — defense for the case where a code path adds to m.vms,
// later kills the qemu process (or qemu dies on its own), and never cleans the
// map entry. Symptom in the wild: usage_ticker.tick() reads m.vms, finds the
// ghost, emits usage_tick events every 20s — runs forever until the worker
// process restarts and clears the map.
//
// Three layers, top-down (matches Fix A / B / C in the triage):
//
//   A. usage_ticker calls IsSandboxAlive(id) before LogEvent("usage_tick"). Even
//      if List() returns a ghost, the ticker won't bill for it.
//   B. List() filters m.vms entries whose qemu process is dead. + a reaper
//      goroutine (started by NewManager, stopped by Close) walks m.vms every
//      30s and prunes dead entries so they free memory + stop appearing in any
//      consumer of m.vms — not just usage_ticker.
//   C. Each m.vms add-site's failure paths are audited so the leak doesn't
//      occur in the first place; the reaper is only the safety net.

const reaperInterval = 30 * time.Second

// vmAlive reports whether the qemu process backing this VM is still running.
// Uses signal-0 ("does this process exist?") which is non-blocking and safe to
// call on every tick. Survives transient QMP unresponsiveness (e.g. during a
// savevm) because it checks the OS process, not the QMP socket.
//
// Returns false for: nil cmd, nil cmd.Process, or a reaped/exited process.
func vmAlive(vm *VMInstance) bool {
	if vm == nil || vm.cmd == nil || vm.cmd.Process == nil {
		return false
	}
	// If cmd.Wait() already returned, ProcessState is non-nil and Exited() is true.
	if vm.cmd.ProcessState != nil && vm.cmd.ProcessState.Exited() {
		return false
	}
	// Signal(0) is the standard Unix "test process existence" probe. Returns
	// nil if the process is still around, ESRCH/"already finished" otherwise.
	return vm.cmd.Process.Signal(syscall.Signal(0)) == nil
}

// IsSandboxAlive returns true iff the manager has a tracked VM for this id AND
// its qemu process is still running. Used by usage_ticker before emitting
// billing events so a ghost m.vms entry can't drive billing on a dead sandbox.
//
// (false, nil) on unknown id (not in m.vms) OR known id whose process is dead.
// Caller treats both the same: skip the tick.
func (m *Manager) IsSandboxAlive(ctx context.Context, id string) (bool, error) {
	m.mu.RLock()
	vm, ok := m.vms[id]
	m.mu.RUnlock()
	if !ok {
		return false, nil
	}
	return vmAlive(vm), nil
}

// startGhostReaper launches the reaper goroutine. Called once from NewManager.
// Stop via m.stopGhostReaper() — Close() does that.
func (m *Manager) startGhostReaper() {
	m.reaperStop = make(chan struct{})
	m.reaperDone = make(chan struct{})
	go m.runGhostReaper()
}

// stopGhostReaper signals the reaper to exit and waits up to 2s for it to
// drain. Idempotent — multiple Close() calls are safe.
func (m *Manager) stopGhostReaper() {
	m.reaperOnce.Do(func() {
		if m.reaperStop != nil {
			close(m.reaperStop)
		}
	})
	if m.reaperDone == nil {
		return
	}
	select {
	case <-m.reaperDone:
	case <-time.After(2 * time.Second):
		log.Printf("qemu: ghost reaper did not exit within 2s; continuing close")
	}
}

func (m *Manager) runGhostReaper() {
	defer close(m.reaperDone)
	t := time.NewTicker(reaperInterval)
	defer t.Stop()
	for {
		select {
		case <-m.reaperStop:
			return
		case <-t.C:
			m.reapDeadVMs(context.Background())
		}
	}
}

// reapDeadVMs walks m.vms under the write lock and removes entries whose qemu
// process has exited. Logs each removal — these are bugs upstream (a code path
// that should have delete()'d on failure) and the log is the trail back to the
// leaking path.
//
// Holds the write lock for the duration; the loop is short (one Signal(0)
// syscall per VM) so this doesn't measurably contend with create/list/exec.
func (m *Manager) reapDeadVMs(_ context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var reaped int
	for id, vm := range m.vms {
		if vmAlive(vm) {
			continue
		}
		log.Printf("qemu: ghost-reaper: removing dead VM %s (pid=%d) from m.vms — qemu process is gone but entry was not cleaned up", id, vm.pid)
		delete(m.vms, id)
		reaped++
	}
	if reaped > 0 {
		log.Printf("qemu: ghost-reaper: removed %d dead VM(s) from m.vms; %d alive remain", reaped, len(m.vms))
	}
}
