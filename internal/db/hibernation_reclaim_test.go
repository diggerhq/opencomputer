package db

import "testing"

// The reclaim query decides which sandboxes are dead enough that their
// hibernation archive can be deleted, and it does so with its own hardcoded
// status list because the predicate has to run inside SQL. Two lists meaning
// the same thing is how they drift.
//
// Drift in either direction costs something real:
//
//   - a status terminal here but missing from reclaimTerminalStatuses leaks
//     archives forever, which is the bug this whole path exists to fix;
//   - a status in reclaimTerminalStatuses that is NOT terminal deletes the
//     archive of a sandbox someone can still wake.
func TestReclaimTerminalStatusesMatchIsTerminal(t *testing.T) {
	for _, status := range reclaimTerminalStatuses {
		if !isTerminalSessionStatus(status) {
			t.Errorf("reclaimTerminalStatuses has %q, which isTerminalSessionStatus says is NOT terminal — "+
				"the sweep would delete the archive of a wakeable sandbox", status)
		}
	}

	// And the other direction: every status the codebase calls terminal must be
	// reclaimable, or archives pile up under a status nobody thought to add.
	known := []string{"stopped", "error", "failed", "terminated", "running", "hibernated", "paused", "pooled"}
	inReclaim := make(map[string]bool, len(reclaimTerminalStatuses))
	for _, s := range reclaimTerminalStatuses {
		inReclaim[s] = true
	}
	for _, status := range known {
		if isTerminalSessionStatus(status) && !inReclaim[status] {
			t.Errorf("%q is terminal but missing from reclaimTerminalStatuses — its archives leak forever", status)
		}
	}
}

// The statuses a sandbox can still be woken from must never appear in the
// reclaim list. Spelled out separately from the pinning test above because this
// is the invariant a reader needs to see stated, not derived: these are the
// sandboxes whose archive is load-bearing.
func TestWakeableStatusesAreNeverReclaimed(t *testing.T) {
	for _, status := range []string{"hibernated", "paused", "running", "pooled", "migrating"} {
		for _, r := range reclaimTerminalStatuses {
			if r == status {
				t.Fatalf("%q is in reclaimTerminalStatuses — waking that sandbox would find its archive deleted", status)
			}
		}
	}
}
