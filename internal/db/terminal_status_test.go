package db

import "testing"

// Pure, DB-free coverage of the terminal-status classification that drives both
// the scale-event close and the `stopped`→D1 publish. The firing behavior
// (RowsAffected coupling) is covered by the pgfixture integration test; this
// guards the classification itself — adding a new terminal status (e.g.
// "killed") without listing it here is the easy regression that would silently
// leave it billing on the edge.
func TestIsTerminalSessionStatus(t *testing.T) {
	terminal := []string{"stopped", "error", "failed", "terminated"}
	notTerminal := []string{"running", "pending", "migrating", "hibernated", "woke", "", "unknown"}

	for _, s := range terminal {
		if !isTerminalSessionStatus(s) {
			t.Errorf("isTerminalSessionStatus(%q) = false, want true (must stop billing + publish stopped)", s)
		}
	}
	for _, s := range notTerminal {
		if isTerminalSessionStatus(s) {
			t.Errorf("isTerminalSessionStatus(%q) = true, want false (hibernated/running must NOT publish stopped)", s)
		}
	}
}
