package api

import (
	"context"
	"testing"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// backend_hibernation_test.go — which backend answers a hibernate or a wake.
//
// The dispatch decision here is a fork in the road with no error path: pick
// wrong and the request either goes to an empty worker fleet ("no workers
// available" for a sandbox this process could have woken) or into a local
// manager that has never heard of the sandbox. Neither failure looks like a
// routing bug from the outside, so the routing is what these tests pin.

// The QEMU fleet must NOT implement Hibernator. Its hibernate and wake depend
// on reaching one specific worker — a wake prefers the machine holding the
// qcow2 files and refuses to move while the archive upload is unfinished — and
// none of that survives being expressed as "call the local manager".
//
// This is a type assertion rather than a behavioural test because that is where
// the decision actually lives: the moment workerBackend grows a Hibernate
// method, every QEMU hibernate silently changes path, with no compiler error
// and no test failure anywhere else.
func TestWorkerBackendIsNotAHibernator(t *testing.T) {
	var b Backend = &workerBackend{}
	if _, ok := b.(Hibernator); ok {
		t.Fatal("workerBackend implements Hibernator — QEMU hibernate/wake would " +
			"bypass wakeSandboxRemote and lose source-worker affinity")
	}
}

// ...and the MicroVM backend must, or the handlers fall through to the registry
// branch and the whole tiered hibernation is unreachable over HTTP again.
func TestMicrovmBackendIsAHibernator(t *testing.T) {
	var b Backend = &microvmBackend{}
	if _, ok := b.(Hibernator); !ok {
		t.Fatal("microvmBackend does not implement Hibernator — hibernate/wake " +
			"would dispatch into an empty worker fleet")
	}
}

// The resolver must key on durable ownership, not the live routing map.
//
// This is the case that motivated hibernatorFor existing at all. A deep-
// hibernated sandbox has no host: the retirement sweep terminated the suspended
// box and called Forget, so the manager tracks nothing and Route answers "not
// mine". If dispatch consulted Route, it would decline for exactly the
// sandboxes wake exists to serve, and the request would fall through to a
// worker fleet that cannot restore an archive it has never seen.
//
// OwnsWorkerID reads the persisted worker_id instead, which outlives the host.
func TestHibernatorResolvesASandboxWhoseHostIsGone(t *testing.T) {
	// A backend tracking nothing — the state after retirement to blob-only.
	b := &microvmBackend{manager: awsvm.NewManager(nil, "")}
	s := &Server{backends: []Backend{b}}

	workerID := microvmWorkerID("microvm-deadbeef")

	if _, routed := b.Route(context.Background(), "sb-parked"); routed {
		t.Fatal("precondition failed: Route claims a sandbox with no tracked host")
	}
	if h, ok := s.hibernatorFor(workerID); !ok || h == nil {
		t.Fatalf("hibernatorFor declined %q for a backend that owns it — a "+
			"blob-only hibernation would be unwakeable", workerID)
	}
}

// A worker_id belonging to some other runtime must not resolve here, or a QEMU
// sandbox's wake would be handed to the MicroVM manager and restored from an
// archive it cannot read.
func TestHibernatorDeclinesForeignWorkerIDs(t *testing.T) {
	s := &Server{backends: []Backend{&microvmBackend{manager: awsvm.NewManager(nil, "")}}}

	for _, workerID := range []string{
		"worker-abc123",      // a real registered QEMU worker
		"",                   // never persisted
		"vmhost",             // prefix-adjacent but not a valid encoded id
		hostIDPrefix + "raw", // a raw host id, which Claim must never persist
	} {
		if h, ok := s.hibernatorFor(workerID); ok {
			t.Errorf("hibernatorFor claimed foreign worker_id %q (got %T)", workerID, h)
		}
	}
}

// With no backends registered — every QEMU cell — the resolver must decline so
// both handlers fall through to their existing registry paths untouched.
func TestHibernatorDeclinesWithNoBackends(t *testing.T) {
	s := &Server{}
	if _, ok := s.hibernatorFor("worker-abc"); ok {
		t.Fatal("resolved a hibernator on a cell with no backends registered")
	}
}
