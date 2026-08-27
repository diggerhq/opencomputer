package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// newTestEchoContext builds a bare echo context for handler-free unit tests.
func newTestEchoContext() echo.Context {
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes", nil)
	return echo.New().NewContext(req, httptest.NewRecorder())
}

// backend_gating_test.go — which runtime serves a create, and the one-way street.
//
// Assignment lives in D1 orgs.runtime and reaches the cell on the capability
// token. Two properties have to hold, and they pull in opposite directions:
//
//	strict at create      — nobody unassigned lands on a specialised runtime
//	absent afterwards     — reassigning an org must not strand what is running
//
// The second is the one that would be missed. Placement is permanent: a sandbox
// resolves its backend from the persisted worker_id forever after. If runtime
// were ever consulted post-create, moving an org back to QEMU would orphan its
// live MicroVM sandboxes — the rollback would cause the outage.

// The empty runtime is the load-bearing default. Every org that predates the
// D1 column, every token minted before the claim existed, and every create that
// never passed the edge arrives with "" — and all of them must land on the
// fleet, which is the only backend that can serve anything.
func TestUnassignedRuntimeGoesToTheFleet(t *testing.T) {
	var fleet workerBackend
	micro := &microvmBackend{}

	if !fleet.Accepts(placement{runtime: ""}) {
		t.Error("fleet declined an unassigned create — orgs with no D1 runtime would 503")
	}
	if micro.Accepts(placement{runtime: ""}) {
		t.Error("MicroVM accepted an unassigned create — an org would reach a specialised runtime by default")
	}
}

// An explicit assignment routes to exactly that runtime and no other.
func TestRuntimeAssignmentRoutesExactly(t *testing.T) {
	var fleet workerBackend
	micro := &microvmBackend{}

	if !micro.Accepts(placement{runtime: runtimeMicrovm}) {
		t.Error("MicroVM declined an org assigned to it — the assignment would do nothing")
	}
	if fleet.Accepts(placement{runtime: runtimeMicrovm}) {
		t.Error("fleet accepted a microvm-assigned create — the org would silently get the wrong runtime")
	}
	if !fleet.Accepts(placement{runtime: runtimeQEMU}) {
		t.Error("fleet declined an org explicitly assigned to it")
	}
	if micro.Accepts(placement{runtime: runtimeQEMU}) {
		t.Error("MicroVM accepted a qemu-assigned create")
	}
}

// Selection must skip a declining backend and reach the next Placer, which is
// how an unassigned org reaches the fleet on a cell running both.
func TestUnassignedFallsThroughToTheFleet(t *testing.T) {
	s := &Server{}
	s.registerBackend(&microvmBackend{})
	s.registerBackend(&fakePlacer{&fakeBackend{name: "fleet"}})

	got, ok := s.claimBackend(placement{runtime: ""})
	if !ok {
		t.Fatal("no backend accepted an unassigned create — every existing customer would 503")
	}
	if got.Name() != "fleet" {
		t.Fatalf("unassigned create placed on %q, want the fleet", got.Name())
	}
}

// An org assigned to a runtime this cell does not run must FAIL, not fall
// through. Silently serving the other runtime is the exact outcome this design
// exists to prevent — it would mean benchmark numbers measuring QEMU, and
// capability promises made by a backend that never saw the request.
func TestAssignedRuntimeAbsentOnCellFailsRatherThanFallsBack(t *testing.T) {
	// The real fleet backend, not the permissive fake: this test is precisely
	// about what the fleet refuses, so a fake that accepts everything would
	// assert nothing.
	s := &Server{}
	s.registerBackend(&workerBackend{}) // no microvm backend on this cell

	if _, ok := s.claimBackend(placement{runtime: runtimeMicrovm}); ok {
		t.Fatal("a microvm-assigned create was served by another runtime — " +
			"the org would silently get QEMU instead of failing loudly")
	}
}

// THE one-way-street property: runtime is a create-time input and nothing else.
// Ownership afterwards comes from the persisted worker_id.
//
// Written as a test because the failure is silent and delayed. Reassigning an
// org to stop new MicroVM traffic must not make the sandboxes it already has
// unreachable — otherwise the rollback IS the incident.
func TestReassigningRuntimeNeverStrandsRunningSandboxes(t *testing.T) {
	b := &microvmBackend{}
	s := &Server{backends: []Backend{b}}

	// The org has been moved back to the fleet: no NEW create lands here.
	if b.Accepts(placement{runtime: runtimeQEMU}) {
		t.Fatal("precondition failed: backend should decline a reassigned org")
	}

	// What it already placed still resolves to it.
	workerID := microvmWorkerID("microvm-alreadyrunning")
	if !b.OwnsWorkerID(workerID) {
		t.Error("backend disowned a worker_id it issued — routing, reap and billing would all miss it")
	}
	if _, ok := s.hibernatorFor(workerID); !ok {
		t.Error("hibernate/wake stopped resolving for an existing sandbox after reassignment")
	}
}

// A create the backend cannot honour is declined even when the org IS assigned
// to it. A custom template is a QEMU checkpoint; there is no such artifact on
// this runtime, so accepting one builds from the wrong image and reports
// success.
func TestDeclinesRequestsItCannotServe(t *testing.T) {
	b := &microvmBackend{}

	if b.Accepts(placement{runtime: runtimeMicrovm, cfg: types.SandboxConfig{Template: "customer-toolchain-v3"}}) {
		t.Error("accepted a custom template it cannot build — the sandbox would come from the wrong image")
	}
	for _, tmpl := range []string{"", "default"} {
		if !b.Accepts(placement{runtime: runtimeMicrovm, cfg: types.SandboxConfig{Template: tmpl}}) {
			t.Errorf("declined template %q, which maps to its own image", tmpl)
		}
	}
}

// The org id is carried for logging and future policy but must not by itself
// decide placement — runtime does. A stray org check here would resurrect the
// per-cell config problem this replaced.
func TestOrgIDAloneDoesNotDecidePlacement(t *testing.T) {
	b := &microvmBackend{}
	org := uuid.MustParse("11111111-1111-4111-8111-111111111111")

	if b.Accepts(placement{orgID: org, runtime: ""}) {
		t.Error("an org reached MicroVM without a runtime assignment")
	}
	if !b.Accepts(placement{orgID: org, runtime: runtimeMicrovm}) {
		t.Error("an assigned org was declined")
	}
}

// runtimeFor resolves the runtime for a create. The cap-token path is the
// normal one; the direct-to-cell path (API key straight at this CP, no edge)
// has no token and must fall back to the per-org column without ever turning
// into a cell-wide default — that would divert unassigned QEMU orgs onto a
// specialised backend, which is exactly what the gating above forbids.
func TestRuntimeForPrefersTheCapToken(t *testing.T) {
	s := &Server{orgRuntime: newOrgRuntimeCache(orgRuntimeTTL)}
	c := newTestEchoContext()
	c.Set(capClaimsKey, &auth.CapabilityClaims{Runtime: runtimeMicrovm})

	if got := s.runtimeFor(c); got != runtimeMicrovm {
		t.Fatalf("cap-token runtime ignored: got %q, want %q", got, runtimeMicrovm)
	}
}

// The safety property: no token and no store to consult resolves to the fleet,
// never to a specialised backend. A regression here sends every unlabeled
// create — including ordinary QEMU orgs — onto the MicroVM lane.
func TestRuntimeForWithoutTokenOrStoreIsTheFleet(t *testing.T) {
	s := &Server{orgRuntime: newOrgRuntimeCache(orgRuntimeTTL)}
	c := newTestEchoContext()
	auth.SetOrgID(c, uuid.New())

	if got := s.runtimeFor(c); got != "" {
		t.Fatalf("unlabeled create did not resolve to the fleet: got %q", got)
	}
}

func TestOrgRuntimeCacheExpires(t *testing.T) {
	cache := newOrgRuntimeCache(-1 * time.Second) // already expired on write
	org := uuid.New()
	cache.put(org, runtimeMicrovm)

	if _, ok := cache.get(org); ok {
		t.Error("expired entry served — a runtime flip would never take effect")
	}

	fresh := newOrgRuntimeCache(time.Minute)
	fresh.put(org, runtimeMicrovm)
	got, ok := fresh.get(org)
	if !ok || got != runtimeMicrovm {
		t.Errorf("live entry not served: got %q ok=%v", got, ok)
	}
}
