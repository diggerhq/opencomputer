package worker

import (
	"context"
	"log"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// vmReaper is the subset of the qemu manager the foreign-VM reaper needs.
// Kill removes the VM from the manager's map and tears down the qemu process
// WITHOUT emitting the global "stopped" lifecycle event that the gRPC
// DestroySandbox handler fires — critical here, because a stray VM's canonical
// session is owned by another worker (or is deep-hibernated in blob) and must
// not be flipped to stopped in the edge index.
type vmReaper interface {
	List(ctx context.Context) ([]types.Sandbox, error)
	Kill(ctx context.Context, id string) error
}

// foreignReapCap bounds how many VMs one pass may reap. A correct fleet reaps 0;
// a handful is normal churn. A sudden large number means something is wrong
// (PG blip returning bad rows, a mass mis-label) — refuse to act and log, rather
// than nuke the worker's VMs on bad data.
const foreignReapCap = 20

// StartForeignVMReaper periodically destroys qemu processes this worker is still
// running for sandboxes the control plane no longer places here. These leak from
// failed/abandoned live migrations: a target prepares (or completes) an incoming
// VM, the migration is then aborted or the box is re-homed / deep-hibernated
// elsewhere, and the target's qemu is left running. The ghost reaper misses it
// (the process is alive and no longer flagged -incoming), so it lingers ~58MB +
// a slot until the worker restarts. Blocks until ctx is cancelled; run in a
// goroutine. No-op if store is nil.
func StartForeignVMReaper(ctx context.Context, mgr vmReaper, store *db.Store, workerID string, interval time.Duration) {
	if store == nil || mgr == nil || workerID == "" {
		return
	}
	log.Printf("foreign-vm-reaper: started (worker=%s interval=%s)", workerID, interval)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			reapForeignVMsOnce(ctx, mgr, store, workerID)
		}
	}
}

// isStrayVM reports whether a live VM on workerID, whose cell session is
// `session`, is a stray leftover that is safe to reap. Safe cases:
//
//	(A) the box's canonical home is a DIFFERENT worker and it is not running or
//	    migrating — an abandoned migration leftover. status=running is excluded
//	    so an in-flight incoming migration (worker_id still points at the source)
//	    is never killed.
//	(B) the box is terminal (stopped/error) yet its qemu is still alive on its
//	    OWNING worker — a local teardown that leaked the process.
//
// Everything else — owned-here-and-live, pooled, paused, deep-hibernated-here,
// or mid-migration — returns false and is left alone.
func isStrayVM(session *db.SandboxSession, workerID string) bool {
	if session == nil || session.MigratingToWorker != "" {
		return false
	}
	foreignHome := session.WorkerID != "" && session.WorkerID != workerID
	terminalHere := session.WorkerID == workerID &&
		(session.Status == "stopped" || session.Status == "error")
	return (foreignHome && session.Status != "running") || terminalHere
}

// reapForeignVMsOnce runs a single reap pass, killing every VM isStrayVM flags.
func reapForeignVMsOnce(ctx context.Context, mgr vmReaper, store *db.Store, workerID string) {
	vms, err := mgr.List(ctx)
	if err != nil {
		log.Printf("foreign-vm-reaper: list failed: %v", err)
		return
	}

	type strayVM struct {
		id     string
		home   string
		status string
	}
	var strays []strayVM
	for _, vm := range vms {
		session, err := store.GetSandboxSession(ctx, vm.ID)
		if err != nil || session == nil {
			// Lookup error or no row: leave it. Absent-row VMs are handled
			// conservatively (a create race can briefly have a VM before its row
			// is visible); the ghost/stale-incoming reapers cover the rest.
			continue
		}
		if isStrayVM(session, workerID) {
			strays = append(strays, strayVM{vm.ID, session.WorkerID, session.Status})
		}
	}

	if len(strays) == 0 {
		return
	}
	if len(strays) > foreignReapCap {
		log.Printf("foreign-vm-reaper: %d candidate strays exceeds cap %d — refusing to act (suspect bad PG state)", len(strays), foreignReapCap)
		return
	}

	reaped := 0
	for _, s := range strays {
		if err := mgr.Kill(ctx, s.id); err != nil {
			log.Printf("foreign-vm-reaper: kill stray %s (home=%s status=%s) failed: %v", s.id, s.home, s.status, err)
			continue
		}
		log.Printf("foreign-vm-reaper: killed stray VM %s (home=%s status=%s)", s.id, s.home, s.status)
		reaped++
	}
	if reaped > 0 {
		log.Printf("foreign-vm-reaper: reaped %d stray VM(s) on %s", reaped, workerID)
	}
}
