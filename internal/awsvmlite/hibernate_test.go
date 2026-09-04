package awsvmlite

import (
	"context"
	"errors"
	"testing"
	"time"
)

// hibernate_test.go — the two ways parking a sandbox fails silently.
//
// Both were found by reading rather than by a failure, and neither would show
// up in a smoke test: the sandbox looks hibernated, the API returns 200, and
// the damage is either a bill the customer did not expect or a warm pool that
// quietly stops filling.

// newParkedManager returns a Manager holding one bound sandbox, with the
// suspended set pre-populated. Constructed directly rather than through New so
// no AWS client is needed.
func newParkedManager(parked ...string) *Manager {
	m := &Manager{
		cfg:       Config{TouchInterval: time.Minute},
		bound:     map[string]*Box{},
		suspended: map[string]time.Time{},
	}
	m.bound["sbx-awake"] = &Box{MicrovmID: "mvm-awake"}
	for _, id := range parked {
		m.bound[id] = &Box{MicrovmID: "mvm-" + id}
		m.suspended[id] = time.Now()
	}
	return m
}

// The touch loop must skip parked sandboxes. Lambda auto-resumes a suspended
// box on ANY inbound request, so a probe would wake it within one tick — the
// hibernation undoes itself and the customer is billed throughout.
func TestTouchNeverProbesAParkedSandbox(t *testing.T) {
	m := newParkedManager("sbx-parked")

	// Everything is due: a zero lastTouch is past any interval.
	m.mu.Lock()
	var due []string
	for id, b := range m.bound {
		if _, parked := m.suspended[id]; parked {
			continue
		}
		if b.lastTouch.IsZero() || time.Since(b.lastTouch) >= m.cfg.TouchInterval {
			due = append(due, id)
		}
	}
	m.mu.Unlock()

	for _, id := range due {
		if id == "sbx-parked" {
			t.Fatal("a parked sandbox was scheduled for a touch — the probe would auto-resume it and silently un-hibernate the sandbox")
		}
	}
	if len(due) != 1 || due[0] != "sbx-awake" {
		t.Errorf("due = %v, want only the awake sandbox", due)
	}
}

// Billing asks IsSandboxAlive, and AWS says a SUSPENDED box is alive. If that
// answer reaches the usage ticker, a parked sandbox meters at the full rate
// forever while the product tells the customer it is hibernated.
func TestParkedSandboxIsNotAliveForBilling(t *testing.T) {
	m := newParkedManager("sbx-parked")
	sm := NewSandboxManager(m)

	alive, err := sm.IsSandboxAlive(context.Background(), "sbx-parked")
	if err != nil {
		t.Fatalf("IsSandboxAlive: %v", err)
	}
	if alive {
		t.Fatal("a hibernated sandbox reported alive — the usage ticker would keep billing it at the full rate")
	}
}

func TestIsHibernatedTracksTheSet(t *testing.T) {
	m := newParkedManager("sbx-parked")
	if !m.IsHibernated("sbx-parked") {
		t.Error("parked sandbox not reported hibernated")
	}
	if m.IsHibernated("sbx-awake") {
		t.Error("running sandbox reported hibernated")
	}
	if got := m.SuspendedCount(); got != 1 {
		t.Errorf("SuspendedCount = %d, want 1", got)
	}
}

// The cap is a guard on the quota that funds the warm pool, so it must refuse
// rather than park. A suspended box can never be reclaimed — there is no
// archive to restore from — so letting parked sandboxes past the cap turns into
// cold launches for every customer on the cell.
func TestHibernateRefusesPastTheCap(t *testing.T) {
	m := &Manager{bound: map[string]*Box{}, suspended: map[string]time.Time{}}
	for i := 0; i < defaultSuspendedCap; i++ {
		id := "filler-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		m.suspended[id] = time.Now()
	}
	m.bound["sbx-one-too-many"] = &Box{MicrovmID: "mvm-x"}

	err := m.Hibernate(context.Background(), "sbx-one-too-many")
	if err == nil {
		t.Fatal("hibernate past the cap succeeded — parked boxes would eat the quota the warm pool needs")
	}
	if m.IsHibernated("sbx-one-too-many") {
		t.Error("a refused hibernate still marked the sandbox parked")
	}
}

// A retried hibernate must not issue a second suspend, and must not fail.
func TestHibernateIsIdempotent(t *testing.T) {
	m := newParkedManager("sbx-parked")
	if err := m.Hibernate(context.Background(), "sbx-parked"); err != nil {
		t.Fatalf("re-hibernating a parked sandbox failed: %v", err)
	}
	if got := m.SuspendedCount(); got != 1 {
		t.Errorf("SuspendedCount = %d after a retry, want 1", got)
	}
}

// An unbound sandbox is refused before anything is marked.
func TestHibernateUnknownSandbox(t *testing.T) {
	m := newParkedManager()
	err := m.Hibernate(context.Background(), "sbx-nope")
	if err == nil {
		t.Fatal("hibernated a sandbox this process holds no box for")
	}
	if !errors.Is(err, err) || m.SuspendedCount() != 0 {
		t.Errorf("SuspendedCount = %d, want 0", m.SuspendedCount())
	}
}
