package awsvmlite

import (
	"context"
	"testing"
	"time"
)

// recordingObs captures the usage-metering boundaries the manager reports.
type recordingObs struct {
	destroyed  []string
	hibernated []string
	woken      []string
	memoryMB   int
	cpuCount   int
	startedAt  time.Time
}

func (r *recordingObs) OnSandboxScale(string, int, int, time.Time) {}
func (r *recordingObs) OnSandboxDestroy(id string, memoryMB, cpuCount int, startedAt time.Time) {
	r.destroyed = append(r.destroyed, id)
	r.memoryMB, r.cpuCount, r.startedAt = memoryMB, cpuCount, startedAt
}
func (r *recordingObs) OnSandboxHibernate(id string, memoryMB, cpuCount int, startedAt time.Time) {
	r.hibernated = append(r.hibernated, id)
	r.memoryMB, r.cpuCount, r.startedAt = memoryMB, cpuCount, startedAt
}
func (r *recordingObs) OnSandboxWake(id string) { r.woken = append(r.woken, id) }

// Destroying a box must report the final billing slice, with the size and start
// time the sandbox actually ran at.
//
// The failure this prevents is silent and one-directional: the usage ticker
// samples every 20s and prices only what it sees, so a sandbox created and
// destroyed between two samples is never observed and bills EXACTLY NOTHING.
// Short-lived sandboxes are the normal shape of traffic on this runtime.
//
// It is asserted on Manager.Destroy rather than on any one caller because every
// path that kills a box goes through here — the customer's DELETE, the idle
// sweep, the shutdown drain, create-cleanup. An earlier version of this fix
// hooked a single caller and missed the customer's own delete entirely.
func TestDestroyReportsTheFinalBillingSlice(t *testing.T) {
	obs := &recordingObs{}
	m := New(nil, Config{})
	m.SetLifecycleObserver(obs)

	boundAt := time.Now().Add(-3 * time.Second)
	m.mu.Lock()
	m.bound["sb-flash"] = &Box{
		MicrovmID: "microvm-flash",
		Meta:      Meta{MemoryMB: 4096, CPUCount: 1},
		boundAt:   boundAt,
	}
	m.mu.Unlock()

	// nil client: Terminate will fail, and that must NOT swallow the billing —
	// the customer ran the sandbox whether or not the teardown call succeeds.
	func() {
		defer func() { _ = recover() }()
		_ = m.Destroy(context.Background(), "sb-flash")
	}()

	if len(obs.destroyed) != 1 || obs.destroyed[0] != "sb-flash" {
		t.Fatalf("destroy reported %v, want one slice for sb-flash — a sandbox "+
			"that lived under one tick interval would bill nothing", obs.destroyed)
	}
	if obs.memoryMB != 4096 || obs.cpuCount != 1 {
		t.Errorf("slice priced at %dMB/%dcpu, want the delivered 4096MB/1cpu",
			obs.memoryMB, obs.cpuCount)
	}
	if !obs.startedAt.Equal(boundAt) {
		t.Errorf("slice measured from %s, want the bind time %s", obs.startedAt, boundAt)
	}
}

// Destroying a sandbox this manager does not hold must bill nothing: there is
// no size to price a slice at, and inventing one invents a charge.
func TestDestroyOfAnUnheldSandboxBillsNothing(t *testing.T) {
	obs := &recordingObs{}
	m := New(nil, Config{})
	m.SetLifecycleObserver(obs)

	if err := m.Destroy(context.Background(), "sb-never-existed"); err != nil {
		t.Fatalf("Destroy of an unheld sandbox errored: %v", err)
	}
	if len(obs.destroyed) != 0 {
		t.Fatalf("billed a sandbox that was never held: %v", obs.destroyed)
	}
}

// A destroyed sandbox's host must stay resolvable briefly, or its closing usage
// tick cannot be attributed and is thrown away.
//
// The event publisher stamps each tick with a worker_id resolved from this
// manager, and events-ingest discards any tick whose worker_id disagrees with
// the sandbox's row. The closing tick is emitted during Destroy and drained a
// beat later, so a live-only lookup misses, the publisher falls back to a
// generic id, and the tick is dropped as coming from a non-owner worker — the
// last slice of every destroyed sandbox, unbilled, for that reason alone.
func TestDestroyedSandboxStaysAttributableForItsClosingTick(t *testing.T) {
	m := New(nil, Config{})
	m.mu.Lock()
	m.bound["sb-1"] = &Box{MicrovmID: "microvm-1", Meta: Meta{MemoryMB: 4096, CPUCount: 1}}
	m.mu.Unlock()

	if id, ok := m.WorkerIDFor("sb-1"); !ok || id != "microvm-1" {
		t.Fatalf("live sandbox resolved to (%q,%v), want microvm-1", id, ok)
	}

	func() {
		defer func() { _ = recover() }() // nil client: Terminate panics, billing already happened
		_ = m.Destroy(context.Background(), "sb-1")
	}()

	// Routing must NOT see it — a destroyed sandbox is unreachable.
	if _, ok := m.BoxFor("sb-1"); ok {
		t.Error("BoxFor still resolves a destroyed sandbox — it would look routable")
	}
	// Attribution must.
	if id, ok := m.WorkerIDFor("sb-1"); !ok || id != "microvm-1" {
		t.Fatalf("destroyed sandbox resolved to (%q,%v) — its closing tick would be "+
			"stamped with a fallback id and discarded as non-owner", id, ok)
	}

	// And it must not be remembered forever.
	m.mu.Lock()
	m.lastBox["sb-1"] = lastBoxEntry{microvmID: "microvm-1", at: time.Now().Add(-2 * lastBoxRetention)}
	m.mu.Unlock()
	if _, ok := m.WorkerIDFor("sb-1"); ok {
		t.Error("a long-expired entry still resolves — the map would grow without bound")
	}
}

// A sandbox this manager never held resolves to nothing, so a stray tick cannot
// borrow another sandbox's identity.
func TestWorkerIDForUnknownSandboxResolvesToNothing(t *testing.T) {
	m := New(nil, Config{})
	if id, ok := m.WorkerIDFor("sb-never"); ok {
		t.Fatalf("unknown sandbox resolved to %q", id)
	}
}
