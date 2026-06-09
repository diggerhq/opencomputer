package qemu

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
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

// vmAlive reports whether the qemu process backing this VM is still running
// and functional. "Functional" excludes zombie (Z-state) processes — a zombie
// has exited but its parent hasn't reaped it, so Signal(0) succeeds (kernel
// still has the PID entry) but the process is doing nothing. Treating zombies
// as alive means usage_ticker keeps emitting billing events for a dead VM,
// and the ghost-reaper can't drain the m.vms entry.
//
// Three checks in order:
//   1. ProcessState — if cmd.Wait() returned, definitively dead.
//   2. /proc/<pid>/stat — if state is Z (zombie) or X (dying), treat as dead.
//   3. Signal(0) — fallback liveness probe; ESRCH means PID gone.
//
// Returns false for: nil cmd, nil cmd.Process, reaped process, zombie, or
// "no such process".
func vmAlive(vm *VMInstance) bool {
	if vm == nil || vm.cmd == nil || vm.cmd.Process == nil {
		return false
	}
	if vm.cmd.ProcessState != nil && vm.cmd.ProcessState.Exited() {
		return false
	}
	if state, ok := procState(vm.cmd.Process.Pid); ok {
		// State chars from man proc(5): R(unning), S(leeping), D(disk-sleep),
		// Z(ombie), T(stopped), t(traced), W(paging old kernels), X(dying),
		// x(dead old kernels), K(wakekill), P(parked), I(idle).
		// Z and X mean "kernel is about to clean up, no useful work happening."
		if state == "Z" || state == "X" || state == "x" {
			return false
		}
	}
	return vm.cmd.Process.Signal(syscall.Signal(0)) == nil
}

// procState reads /proc/<pid>/stat and returns the process state char (one of
// RSDZTtWXxKPI). Returns ("", false) if the file can't be read — caller should
// fall back to Signal(0). Cheap (~1 syscall) and Linux-only; on platforms
// without /proc the (false) return naturally degrades.
func procState(pid int) (string, bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", false
	}
	// Format: "PID (comm) STATE PPID ..."
	// comm may contain spaces and parens; find the last ')' to skip it.
	s := string(data)
	idx := strings.LastIndexByte(s, ')')
	if idx == -1 || idx+2 >= len(s) {
		return "", false
	}
	// After ')' there's a space then the state char.
	rest := s[idx+2:]
	if len(rest) == 0 {
		return "", false
	}
	return string(rest[0]), true
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
