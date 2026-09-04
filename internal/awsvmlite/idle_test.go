package awsvmlite

import (
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

func idleTestManager(t *testing.T) *Manager {
	t.Helper()
	return New(awsvm.NewClientWithAPI(nil, awsvm.Config{ImageIdentifier: "arn:image"}), Config{})
}

// bindBox puts a sandbox in the bound map with a chosen launch time.
func bindBox(m *Manager, sandboxID string, launchedAt time.Time) *Box {
	b := &Box{
		MicrovmID:  "microvm-" + sandboxID,
		Meta:       Meta{MemoryMB: 4096, CPUCount: 1},
		launchedAt: launchedAt,
		boundAt:    time.Now(),
	}
	m.mu.Lock()
	m.bound[sandboxID] = b
	m.mu.Unlock()
	return b
}

// THE defining rule: the keepalive must not look like the customer.
//
// Warm and bound boxes are poked on a timer so the provider does not suspend
// them. If the idle policy read that clock, every sandbox would appear busy
// forever and no timeout would ever fire — the timeout would be accepted by the
// API and silently do nothing, which is worse than refusing it.
func TestKeepaliveTouchDoesNotCountAsCustomerActivity(t *testing.T) {
	m := idleTestManager(t)
	b := bindBox(m, "sb-1", time.Now())
	if _, err := m.SetIdleTimeout("sb-1", time.Minute); err != nil {
		t.Fatalf("SetIdleTimeout: %v", err)
	}

	// Age the sandbox past its timeout, then let the keepalive poke it.
	m.mu.Lock()
	b.lastUsed = time.Now().Add(-5 * time.Minute)
	b.lastTouch = time.Now()
	m.mu.Unlock()

	if got := m.ExpiredIdle(time.Now()); len(got) != 1 {
		t.Fatalf("keepalive touch kept an idle sandbox alive (expired=%v) — no timeout would ever fire", got)
	}

	// Real customer activity DOES refresh it.
	m.MarkUsed("sb-1")
	if got := m.ExpiredIdle(time.Now()); len(got) != 0 {
		t.Fatalf("customer activity did not refresh the timeout (expired=%v)", got)
	}
}

// A timeout longer than the host has left is refused, not stored.
//
// The provider destroys every host at a hard cap. Accepting a longer timeout
// would have the API claim the sandbox has hours left while it vanishes at the
// cap — a promise this runtime cannot keep. Zero back means "nothing running".
func TestTimeoutBeyondTheHostsRemainingLifeIsRefused(t *testing.T) {
	m := idleTestManager(t)
	// Launched 7h ago against the 8h cap: roughly one hour left.
	bindBox(m, "sb-old", time.Now().Add(-7*time.Hour))

	got, err := m.SetIdleTimeout("sb-old", 4*time.Hour)
	if err != nil {
		t.Fatalf("SetIdleTimeout: %v", err)
	}
	if got != 0 {
		t.Fatalf("accepted a %s timeout on a host with ~1h left (got %s) — the sandbox "+
			"would disappear at the cap while the API claimed it was alive", 4*time.Hour, got)
	}
	if running := m.IdleTimeout("sb-old"); running != 0 {
		t.Fatalf("a refused timeout was still stored: %s", running)
	}

	// Comfortably inside the remaining life: honoured exactly.
	got, err = m.SetIdleTimeout("sb-old", 10*time.Minute)
	if err != nil {
		t.Fatalf("SetIdleTimeout: %v", err)
	}
	if got != 10*time.Minute {
		t.Fatalf("a timeout inside the host's life was not honoured: got %s", got)
	}
}

// Zero clears the timeout — the documented "persistent" case, matching QEMU.
func TestZeroTimeoutMeansPersistent(t *testing.T) {
	m := idleTestManager(t)
	bindBox(m, "sb-2", time.Now())
	if _, err := m.SetIdleTimeout("sb-2", time.Minute); err != nil {
		t.Fatalf("SetIdleTimeout: %v", err)
	}
	if _, err := m.SetIdleTimeout("sb-2", 0); err != nil {
		t.Fatalf("SetIdleTimeout(0): %v", err)
	}
	m.mu.Lock()
	m.bound["sb-2"].lastUsed = time.Now().Add(-24 * time.Hour)
	m.mu.Unlock()
	if got := m.ExpiredIdle(time.Now()); len(got) != 0 {
		t.Fatalf("a persistent sandbox expired anyway: %v", got)
	}
}

// A sandbox created and never touched still expires — measured from its bind
// time, so silence after create is not immunity.
func TestNeverUsedSandboxExpiresFromItsBindTime(t *testing.T) {
	m := idleTestManager(t)
	b := bindBox(m, "sb-3", time.Now())
	if _, err := m.SetIdleTimeout("sb-3", time.Minute); err != nil {
		t.Fatalf("SetIdleTimeout: %v", err)
	}
	m.mu.Lock()
	b.lastUsed = time.Time{} // never used
	b.boundAt = time.Now().Add(-5 * time.Minute)
	m.mu.Unlock()

	if got := m.ExpiredIdle(time.Now()); len(got) != 1 {
		t.Fatalf("a never-used sandbox did not expire (%v) — silence after create would run to the cap", got)
	}
}

// An already-parked sandbox is not collected again: it is not billing, and a
// second suspend against a rate-limited API buys nothing.
func TestAlreadyParkedSandboxIsNotCollectedAgain(t *testing.T) {
	m := idleTestManager(t)
	b := bindBox(m, "sb-4", time.Now())
	if _, err := m.SetIdleTimeout("sb-4", time.Minute); err != nil {
		t.Fatalf("SetIdleTimeout: %v", err)
	}
	m.mu.Lock()
	b.lastUsed = time.Now().Add(-time.Hour)
	if m.suspended == nil {
		m.suspended = map[string]time.Time{}
	}
	m.suspended["sb-4"] = time.Now()
	m.mu.Unlock()

	if got := m.ExpiredIdle(time.Now()); len(got) != 0 {
		t.Fatalf("a parked sandbox was collected again: %v", got)
	}
}
