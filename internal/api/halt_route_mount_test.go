package api

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The halt/resume webhooks must be reachable on a cell that has no worker
// registry, because that is what a MicroVM-only cell IS — and at launch it is
// the only kind of cell there will be.
//
// This is a source-level check rather than a live one on purpose. The bug it
// guards against is not in the handler; it is in WHERE the registration sits.
// Twice now the routes have been gated on state that is not true at the moment
// the gate runs:
//
//   - `if s.workerRegistry != nil` — false on a MicroVM-only cell, so the
//     CreditAccount DO's halt webhook 404'd and unpaid orgs kept running.
//   - `if ... || len(s.backends) > 0` — the "obvious" repair, and worse than
//     useless: backends are registered ~400 lines BELOW the mount, so the slice
//     is empty there and the condition is dead code that reads as a fix.
//
// A live test would not have caught either one on our dev cell, whose registry
// is non-nil (it has zero workers, which is not the same thing), so the routes
// mounted regardless and the lite-only path was never exercised.
func TestHaltRoutesAreNotGatedOnLaterState(t *testing.T) {
	src, err := os.ReadFile("router.go")
	if err != nil {
		t.Fatalf("read router.go: %v", err)
	}
	text := string(src)

	// Walk the function body tracking which function-level blocks are OPEN at
	// the mount. Backtracking to the nearest preceding `if` is not enough — an
	// earlier block that has already CLOSED reads as enclosing when it is not,
	// which is a false positive this test hit on its first run.
	var open []string
	found := false
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, `cfAdmin.POST("/halt-org"`) {
			found = true
			break
		}
		// Function-level blocks only: exactly one tab of indent.
		switch {
		case strings.HasPrefix(line, "\tif ") && strings.HasSuffix(line, "{"):
			open = append(open, line)
		case line == "\t{":
			open = append(open, line) // unconditional block — the correct shape
		case strings.HasPrefix(line, "\t}") && len(open) > 0:
			open = open[:len(open)-1]
		}
	}
	if !found {
		t.Fatal("the /admin/halt-org route is not registered at all")
	}
	for _, cond := range open {
		for _, forbidden := range []string{"workerRegistry", "s.backends", "workersDisabled"} {
			if strings.Contains(cond, forbidden) {
				t.Errorf("halt routes are mounted inside `%s`, gating them on %q — "+
					"a MicroVM-only cell would not expose /admin/halt-org and its orgs could not be halted",
					strings.TrimSpace(cond), forbidden)
			}
		}
	}
}

// Backends really are registered after the route table is built, which is the
// fact that makes any `len(s.backends)` gate up there silently false. If this
// ever stops being true the comment above should be revisited rather than
// quietly rotting.
func TestBackendsAreRegisteredAfterRoutesAreMounted(t *testing.T) {
	src, err := os.ReadFile("router.go")
	if err != nil {
		t.Fatalf("read router.go: %v", err)
	}
	text := string(src)
	mount := strings.Index(text, `cfAdmin.POST("/halt-org"`)
	reg := regexp.MustCompile(`s\.registerBackend\(`).FindStringIndex(text)
	if mount < 0 || reg == nil {
		t.Skip("route or registration moved; the assumption needs re-checking by hand")
	}
	if reg[0] < mount {
		t.Errorf("registerBackend now runs BEFORE the halt-route mount (%d < %d) — "+
			"a backend-count gate would finally be meaningful, so revisit the comment there",
			reg[0], mount)
	}
}
