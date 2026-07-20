package controlplane

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/alert"
)

type fakeAlerter struct {
	mu   sync.Mutex
	sent []alert.Alert
}

func (f *fakeAlerter) Send(_ context.Context, a alert.Alert) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, a)
}

func (f *fakeAlerter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func (f *fakeAlerter) last() alert.Alert {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[len(f.sent)-1]
}

// newTestMonitor returns a monitor with a controllable clock (via the returned
// pointer) and a 45m deadline / 3m grace.
func newTestMonitor(fa alert.Alerter) (*rollHealthMonitor, *time.Time) {
	m := newRollHealthMonitor(fa, rollHealthConfig{Deadline: 45 * time.Minute, clearGrace: 3 * time.Minute})
	clock := time.Unix(1_700_000_000, 0)
	m.now = func() time.Time { return clock }
	return m, &clock
}

func workers(target string, versions ...string) []*WorkerInfo {
	out := make([]*WorkerInfo, len(versions))
	for i, v := range versions {
		out[i] = &WorkerInfo{ID: "w" + string(rune('0'+i)), Region: "eastus2", WorkerVersion: v}
	}
	return out
}

// An in-progress roll (skew younger than the deadline) must not alert.
func TestRollHealth_InProgressNoAlert(t *testing.T) {
	fa := &fakeAlerter{}
	m, clock := newTestMonitor(fa)
	snap := rollFleetSnapshot{region: "eastus2", targetVersion: "new", workers: workers("new", "new", "old")}

	m.observe(context.Background(), snap)          // t=0, skew begins
	*clock = clock.Add(30 * time.Minute)           // < 45m deadline
	m.observe(context.Background(), snap)
	if fa.count() != 0 {
		t.Fatalf("in-progress roll should not alert, got %d", fa.count())
	}
}

// Skew that persists past the deadline alerts, and the message names the stale worker.
func TestRollHealth_StuckSkewAlerts(t *testing.T) {
	fa := &fakeAlerter{}
	m, clock := newTestMonitor(fa)
	snap := rollFleetSnapshot{region: "eastus2", targetVersion: "new", workers: workers("new", "new", "old")}

	m.observe(context.Background(), snap) // t=0
	*clock = clock.Add(46 * time.Minute)  // past deadline
	m.observe(context.Background(), snap)

	if fa.count() == 0 {
		t.Fatal("stuck skew past deadline must alert")
	}
	a := fa.last()
	if a.Severity != alert.Critical || !strings.Contains(a.Title, "rolling replace stuck") {
		t.Errorf("unexpected alert: %+v", a)
	}
	if !strings.Contains(a.Detail, "old") || a.DedupKey != "roll_skew:eastus2" {
		t.Errorf("alert detail/key wrong: %+v", a)
	}
}

// Once the fleet converges the timer clears, so a later transient skew restarts
// the clock rather than instantly alerting.
func TestRollHealth_ConvergenceClears(t *testing.T) {
	fa := &fakeAlerter{}
	m, clock := newTestMonitor(fa)
	stale := rollFleetSnapshot{region: "eastus2", targetVersion: "new", workers: workers("new", "old")}
	converged := rollFleetSnapshot{region: "eastus2", targetVersion: "new", workers: workers("new", "new")}

	m.observe(context.Background(), stale) // t=0 skew begins
	*clock = clock.Add(10 * time.Minute)
	m.observe(context.Background(), converged) // converged
	*clock = clock.Add(5 * time.Minute)        // past grace → timer cleared
	m.observe(context.Background(), converged)
	*clock = clock.Add(20 * time.Minute)
	m.observe(context.Background(), stale) // fresh skew, only 20m old
	if fa.count() != 0 {
		t.Fatalf("cleared+fresh skew should not alert yet, got %d", fa.count())
	}
}

// A one-tick backoff flicker (inside the grace window) must not reset the timer.
func TestRollHealth_BackoffFlickerKeepsTimer(t *testing.T) {
	fa := &fakeAlerter{}
	m, clock := newTestMonitor(fa)
	until := time.Unix(1_700_000_000, 0).Add(10 * time.Minute)
	active := rollFleetSnapshot{region: "eastus2", targetVersion: "", backoffActive: true, backoffUntil: until}
	inactive := rollFleetSnapshot{region: "eastus2", targetVersion: "", backoffActive: false}

	m.observe(context.Background(), active) // t=0 backoff begins
	*clock = clock.Add(44 * time.Minute)
	m.observe(context.Background(), active) // t=44m, keeps lastSeen fresh (real ticks are 30s)
	*clock = clock.Add(1 * time.Minute)
	m.observe(context.Background(), inactive) // t=45m flicker: 1m gap < 3m grace → timer kept
	*clock = clock.Add(1 * time.Minute)       // t=46m, past 45m deadline
	m.observe(context.Background(), active)

	if fa.count() == 0 {
		t.Fatal("backoff persisting past deadline (through a flicker) must alert")
	}
	if !strings.Contains(fa.last().Title, "cannot create workers") {
		t.Errorf("expected creation-backoff alert, got %+v", fa.last())
	}
}

// No target version yet → never a false skew alert.
func TestRollHealth_NoTargetNoAlert(t *testing.T) {
	fa := &fakeAlerter{}
	m, clock := newTestMonitor(fa)
	snap := rollFleetSnapshot{region: "eastus2", targetVersion: "", workers: workers("", "v1", "v2")}
	m.observe(context.Background(), snap)
	*clock = clock.Add(90 * time.Minute)
	m.observe(context.Background(), snap)
	if fa.count() != 0 {
		t.Fatalf("no target version must not alert, got %d", fa.count())
	}
}
