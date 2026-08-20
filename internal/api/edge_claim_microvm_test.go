package api

import (
	"context"
	"errors"
	"os"
	"testing"

	lambdamicrovms "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	mvtypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"

	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// failingGetAPI answers every describe with an error, standing in for the
// transient API failures that must never be mistaken for a terminated box.
type failingGetAPI struct{ sweepAPI }

func (f *failingGetAPI) GetMicrovm(context.Context, *lambdamicrovms.GetMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	return nil, errors.New("describe unavailable")
}

// A disabled backend is what every QEMU cell has. The edge-claim endpoints are
// reachable on all of them, so each entry point must be inert rather than
// dereferencing a nil pool — the same class of bug the conformance suite exists
// to catch, now on three new methods.
func TestEdgeClaimIsInertWhenDisabled(t *testing.T) {
	var b *microvmBackend
	if got := b.EdgeReserve(5); got != nil {
		t.Errorf("disabled backend reserved %d box(es)", len(got))
	}
	if n := b.EdgeRelease([]string{"sb-anything"}); n != 0 {
		t.Errorf("disabled backend released %d", n)
	}
	if _, err := b.EdgeFinalize("sb-anything", types.SandboxConfig{}); err == nil {
		t.Error("disabled backend finalized a claim without error")
	}
}

// The expiry callback is the counterpart to binding a sandbox id at reserve
// time. Its whole job is to make that id stop resolving once the box behind it
// has been terminated; a binding that outlives its box turns a clean 404 into a
// timeout somewhere in the agent tunnel.
func TestForgetExpiredReservationDropsTheBinding(t *testing.T) {
	b := &microvmBackend{manager: awsvm.NewManager(nil, os.TempDir())}
	const microvmID = "microvm-abc123"
	const sandboxID = "sb-deadbeef"

	b.manager.TrackClaimed(sandboxID, &awsvm.StockEntry{MicrovmID: microvmID}, types.SandboxConfig{})
	b.edgeReserved.put(microvmID, sandboxID)
	if _, ok := b.manager.MicrovmIDFor(sandboxID); !ok {
		t.Fatal("reserve did not bind the sandbox id — routing would 404 before finalize")
	}

	b.forgetExpiredReservation(microvmID)

	if _, ok := b.manager.MicrovmIDFor(sandboxID); ok {
		t.Error("sandbox id still resolves after its reservation expired and its box was terminated")
	}
	if b.edgeReserved.depth() != 0 {
		t.Errorf("reservation map still holds %d entry(s)", b.edgeReserved.depth())
	}
	// Idempotent: the pool fires this from a goroutine per stale entry, and a
	// duplicate must not unbind something a later reserve rebound.
	b.forgetExpiredReservation(microvmID)
}

// Finalize must refuse a sandbox id it never handed out. Accepting one would
// write a durable row for a box this cell does not hold.
func TestEdgeFinalizeRejectsAnUnboundSandbox(t *testing.T) {
	b := &microvmBackend{
		manager: awsvm.NewManager(nil, os.TempDir()),
		pool:    awsvm.NewPool(nil, awsvm.PoolConfig{}),
	}
	if _, err := b.EdgeFinalize("sb-neverseen", types.SandboxConfig{}); err == nil {
		t.Fatal("finalized a sandbox that was never reserved")
	}
}

// The pool's box budget is only as good as the inventory it is fed. Reserving
// for the edge binds a box in the manager while it is still counted as pool
// stock, so a naive "in use = everything tracked" double-counts the entire
// magazine — on dev that read 130 in use against a fleet of exactly 130 boxes,
// freezing refill for good.
func TestEdgeReservationsAreNotCountedAsBoxesInUse(t *testing.T) {
	b := &microvmBackend{manager: awsvm.NewManager(nil, os.TempDir())}

	// Two boxes sitting in edge stock, one genuinely claimed by a customer.
	for _, id := range []string{"mvm-stock-1", "mvm-stock-2"} {
		sb := "sb-" + id
		b.manager.TrackClaimed(sb, &awsvm.StockEntry{MicrovmID: id}, types.SandboxConfig{})
		b.edgeReserved.put(id, sb)
	}
	b.manager.TrackClaimed("sb-live", &awsvm.StockEntry{MicrovmID: "mvm-live"}, types.SandboxConfig{})

	if got := b.boxesInUse(); got != 1 {
		t.Fatalf("boxesInUse = %d, want 1 — edge stock is already counted by the pool's committed(), so counting it here inflates the budget by the whole magazine", got)
	}

	// Finalizing a reservation hands the box to a customer: it leaves the
	// reservation map and must start counting.
	b.edgeReserved.take("mvm-stock-1")
	if got := b.boxesInUse(); got != 2 {
		t.Fatalf("boxesInUse = %d after a reservation was claimed, want 2", got)
	}
}

// A reserve landing between the two unsynchronized reads must never produce a
// negative, which would hand the budget headroom that does not exist.
func TestBoxesInUseNeverGoesNegative(t *testing.T) {
	b := &microvmBackend{manager: awsvm.NewManager(nil, os.TempDir())}
	b.edgeReserved.put("mvm-racing", "sb-racing") // reserved, not yet tracked
	if got := b.boxesInUse(); got != 0 {
		t.Fatalf("boxesInUse = %d, want 0", got)
	}
}

// The reconciler is driven by the sessions table, so it can only ever repair a
// binding whose sandbox still has a running row. Bindings whose row reached a
// terminal state by some other path are unreachable by it — and because
// TrackedMicrovmIDs feeds boxesInUse, which is the pool budget's "in use" term,
// each one permanently convinces the pool that a box is busy. The pool then
// refuses to manufacture a replacement for a box that no longer exists, so a
// cell's usable depth decays over its uptime and only a restart clears it.
//
// Measured on dev: 80 "in use" against a 230-box budget, with the pool pinned at
// depth 1-3 out of a target of 150 while the edge served creates cold.
func TestDeadBindingsStopHoldingPoolBudget(t *testing.T) {
	f := &sweepAPI{
		getImage: map[string]string{},
		getState: map[string]mvtypes.MicrovmState{
			"mvm-dead": mvtypes.MicrovmStateTerminated,
		},
	}
	b := sweepBackend(t, f)

	// Four bindings, one of each shape the sweep has to tell apart.
	b.manager.TrackClaimed("sb-live", &awsvm.StockEntry{MicrovmID: "mvm-live"}, types.SandboxConfig{})
	b.manager.TrackClaimed("sb-dead", &awsvm.StockEntry{MicrovmID: "mvm-dead"}, types.SandboxConfig{})
	b.manager.TrackClaimed("sb-rowless", &awsvm.StockEntry{MicrovmID: "mvm-rowless"}, types.SandboxConfig{})
	b.manager.TrackClaimed("sb-reserved", &awsvm.StockEntry{MicrovmID: "mvm-reserved"}, types.SandboxConfig{})
	b.edgeReserved.put("mvm-reserved", "sb-reserved")

	// Only sb-live still has a row; everything else is invisible to reconcileOnce.
	b.forgetDeadBindings(context.Background(), map[string]struct{}{"sb-live": {}})

	if _, ok := b.manager.MicrovmIDFor("sb-dead"); ok {
		t.Error("kept a binding whose box AWS reports terminated — this is the entry that holds budget forever")
	}
	if _, ok := b.manager.MicrovmIDFor("sb-live"); !ok {
		t.Error("dropped a binding that still has a running row")
	}
	// Rowless but alive is ambiguous — a create mid-flight looks exactly like a
	// leak. On an account shared with other products the sweep reports it and
	// leaves it to sweepOrphans, which has the age and image guards.
	if _, ok := b.manager.MicrovmIDFor("sb-rowless"); !ok {
		t.Error("unbound a live box on the strength of a missing row alone")
	}
	// Reservations are rowless by construction: binding before the row exists is
	// the entire point of reserving. Reaping them would break every create the
	// edge has in flight.
	if _, ok := b.manager.MicrovmIDFor("sb-reserved"); !ok {
		t.Error("unbound an in-flight edge reservation")
	}
	if len(f.terminated) != 0 {
		t.Errorf("binding sweep terminated %v — it must only ever drop local state; this AWS account is shared", f.terminated)
	}
}

// A describe that fails must not be read as "the box is gone". Unbinding a live
// sandbox on a transient API error would 404 a customer's running box.
func TestBindingSweepKeepsBindingsItCannotProveDead(t *testing.T) {
	f := &failingGetAPI{}
	b := sweepBackend(t, &sweepAPI{getImage: map[string]string{}})
	b.client = awsvm.NewClientWithAPI(f, awsvm.Config{ImageIdentifier: "arn:ours"})
	b.manager.TrackClaimed("sb-unprovable", &awsvm.StockEntry{MicrovmID: "mvm-unprovable"}, types.SandboxConfig{})

	b.forgetDeadBindings(context.Background(), nil)

	if _, ok := b.manager.MicrovmIDFor("sb-unprovable"); !ok {
		t.Fatal("dropped a binding because the describe failed — an API blip must not unbind a running sandbox")
	}
}
