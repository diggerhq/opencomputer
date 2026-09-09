package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/awsvmlite"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// newTestEchoContext builds a bare echo context for handler-free unit tests.
func newTestEchoContext() echo.Context {
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes", nil)
	return echo.New().NewContext(req, httptest.NewRecorder())
}

// newGatingLite builds the MicroVM backend in the state placement decisions are
// made from: a client whose image config is populated (so size gating has a
// default tier to compare against) and nothing else. Placement reads no
// manager, no pool, and no network.
func newGatingLite() *liteBackend {
	return &liteBackend{
		client: awsvm.NewClientWithAPI(nil, awsvm.Config{
			ImageIdentifier: "arn:test:image",
		}),
	}
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
	micro := newGatingLite()

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
	micro := newGatingLite()

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
	s.registerBackend(newGatingLite())
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
	b := newGatingLite()
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
// to it. Size is the case that must be caught HERE: memory is a property of the
// image, so a tier this cell has published no image for can never be corrected
// after launch — declining turns it into a clean placement failure instead of a
// sandbox that is quietly the wrong size and metered at the size it was asked
// for.
//
// Templates are deliberately NOT in that category any more. A template is
// served by claiming a pooled default box and unpacking the template's
// workspace archive onto it, so it costs a tarball rather than a published
// image; and placement is handed the template NAME, not the resolved drive
// keys, so whether a specific template is servable simply cannot be decided at
// this point. That refusal lives in Activate, which has the keys — see
// TestActivateRefusesARootfsBearingTemplate.
func TestDeclinesRequestsItCannotServe(t *testing.T) {
	b := newGatingLite()

	if b.Accepts(placement{runtime: runtimeMicrovm, cfg: types.SandboxConfig{MemoryMB: 65536}}) {
		t.Error("accepted a size tier with no published image — memory cannot be adjusted after launch, so the sandbox would be silently the wrong size")
	}
	for _, tmpl := range []string{"", "default", "customer-toolchain-v3"} {
		if !b.Accepts(placement{runtime: runtimeMicrovm, cfg: types.SandboxConfig{Template: tmpl}}) {
			t.Errorf("declined template %q — templates are served from a workspace archive on a pooled box", tmpl)
		}
	}
}

// The org id is carried for logging and future policy but must not by itself
// decide placement — runtime does. A stray org check here would resurrect the
// per-cell config problem this replaced.
func TestOrgIDAloneDoesNotDecidePlacement(t *testing.T) {
	b := newGatingLite()
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

// Templates are accepted at placement, so the refusal for one this runtime
// cannot honour has to land here, where the resolved drive keys exist.
//
// A template carrying a ROOTFS drive was made on the QEMU fleet, where a
// snapshot captures the whole disk. This runtime can replay only the workspace
// half, and doing that silently is the dangerous outcome: the customer gets
// their files back while every system change the snapshot was taken for is
// dropped — a template that looks like it worked and didn't. The empty rootfs
// key is a sound "made here" marker because this runtime's own CreateCheckpoint
// returns "" for it and the store persists that as an empty string, not NULL.
func TestActivateRefusesARootfsBearingTemplate(t *testing.T) {
	b := newGatingLite()
	// An empty manager: it holds no boxes, so the restore path fails cleanly
	// instead of reaching AWS. The rootfs guard must fire before it either way.
	b.mgr = awsvmlite.New(nil, awsvmlite.Config{})
	_, err := b.Activate(context.Background(), activation{
		sandboxID:            "sb-cross-runtime",
		templateRootfsKey:    "templates/qemu-made/rootfs.qcow2",
		templateWorkspaceKey: "templates/qemu-made/workspace.tgz",
	})
	if err == nil {
		t.Fatal("accepted a QEMU-made template — the customer would get the workspace half " +
			"and silently lose every system change the snapshot was taken for")
	}

	// ...and a template with no rootfs drive is not refused by that guard. It
	// reaches the restore, which fails here only because there is no box.
	_, err = b.Activate(context.Background(), activation{
		sandboxID:            "sb-native",
		templateWorkspaceKey: "templates/lite-made/workspace.tgz",
	})
	if err != nil && strings.Contains(err.Error(), "carries a rootfs image") {
		t.Fatal("a workspace-only template was refused as cross-runtime")
	}
}

// Resizing is refused by the runtime, not by a hardcoded rule in the handler.
//
// The scale handler used to fall through to the worker registry, and a managed
// cell HAS a registry with no workers in it — so a customer asking to resize a
// MicroVM sandbox got "no gRPC connection to worker vmhost:…", which reads as
// an outage rather than as "this runtime has no sizing knob". Memory is a
// property of the image here; there is nothing to turn.
func TestResizeIsRefusedByTheRuntimeWithAReason(t *testing.T) {
	m := awsvmlite.New(nil, awsvmlite.Config{})
	sm := awsvmlite.NewSandboxManager(m)

	err := sm.SetResourceLimits(context.Background(), "sb-1", 0, 8<<30, 400000, 100000)
	if err == nil {
		t.Fatal("SetResourceLimits succeeded on a runtime whose size is fixed by its image")
	}
	if !errors.Is(err, awsvm.ErrUnsupported) {
		t.Fatalf("resize failed with %v, want ErrUnsupported — respondManagerErr maps only "+
			"that to 501, so anything else surfaces as a 500 and reads as our bug", err)
	}
}

// A runtime that cannot snapshot RAM must say so, so the checkpoint API can
// refuse a full capture up front instead of accepting one and silently never
// producing it.
func TestRuntimeWithoutMemoryCaptureDeclaresItself(t *testing.T) {
	var b Backend = &liteBackend{}
	c, ok := b.(MemoryStateCapturer)
	if !ok {
		t.Fatal("liteBackend no longer declares its memory-capture capability — " +
			"the checkpoint API would accept a full checkpoint it cannot make")
	}
	if c.CapturesMemoryState() {
		t.Fatal("claimed memory capture on a runtime whose provider offers no way to read host RAM")
	}

	// The fleet says nothing, which must keep meaning "yes" — a backend that
	// never considered the question must not start refusing full checkpoints.
	var fleet Backend = &workerBackend{}
	if _, declares := fleet.(MemoryStateCapturer); declares {
		t.Fatal("workerBackend now declares memory capture; if that is deliberate it must " +
			"return true, or every QEMU full checkpoint starts 501ing")
	}
}
