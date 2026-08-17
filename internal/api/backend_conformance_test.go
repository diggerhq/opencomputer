package api

import (
	"context"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
)

// backend_conformance_test.go — one contract, run against every Backend.
//
// Adding a backend means adding a row to conformanceBackends. Every invariant
// below then applies to it automatically, which is the point: the bugs this
// suite exists to catch were all cases where a new runtime silently failed to
// answer a question the system assumed someone had answered.
//
// The cautionary example is in this repo: internal/firecracker declares
// `var _ sandbox.Manager = (*Manager)(nil)` and does not compile, because
// nothing ever built it. An interface assertion is not coverage.
//
// Provider-dependent behavior (real launches, quota errors) is deliberately out
// of scope — those need credentials and cost money. What is in scope is every
// decision the dispatch layer makes from local state: identity, ownership,
// routing, capacity shape, and nil-safety.

// conformanceBackend pairs a Backend with the facts a test needs to drive it.
type conformanceBackend struct {
	name string
	// build returns a backend in its disabled/zero state — the state a cell not
	// running this runtime sees, which must be inert rather than panicking.
	buildDisabled func() Backend
	// ownedWorkerID is a worker_id this backend must claim as its own.
	ownedWorkerID string
	// foreignWorkerIDs must never be claimed. A false positive here is worse
	// than a false negative: it routes another runtime's sandbox into this one.
	foreignWorkerIDs []string
}

var conformanceBackends = []conformanceBackend{
	{
		name:          "vmhost",
		buildDisabled: func() Backend { return (*microvmBackend)(nil) },
		ownedWorkerID: microvmWorkerID("abc123"),
		foreignWorkerIDs: []string{
			"w-azure-osb-worker-2512f614", // a real QEMU worker
			"worker-eastus2-7",
			"",
			"vmhost:",  // prefix with no id
			"vmhost",   // prefix without separator
			"microvm:", // legacy prefix, no id
			// A RAW provider host id. This is the shape the provider SDK
			// returns, and it is deliberately NOT owned — which is why Claim
			// must encode before returning a worker_id. Returning the raw id
			// made every row invisible to the orphan sweep, the restore scan,
			// and the event publisher, all of which match on the prefixes.
			hostIDPrefix + "abc123",
		},
	},
}

// A backend must recognize what it owns. This is the durable identity question
// the reconciler and the orphan sweep both ask using only database rows; a
// backend that fails it leaves its sandboxes unroutable and its hosts running.
func TestConformanceOwnsItsOwnWorkerID(t *testing.T) {
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.buildDisabled()
			if !b.OwnsWorkerID(tc.ownedWorkerID) {
				t.Fatalf("%s does not recognize its own worker_id %q", tc.name, tc.ownedWorkerID)
			}
		})
	}
}

// Claiming another runtime's worker_id is the dangerous direction: the orphan
// sweep would stop reaping real workers' sandboxes, and routing would send
// traffic to a backend that does not hold the sandbox.
func TestConformanceDisownsForeignWorkerIDs(t *testing.T) {
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.buildDisabled()
			for _, id := range tc.foreignWorkerIDs {
				if b.OwnsWorkerID(id) {
					t.Errorf("%s claimed foreign worker_id %q", tc.name, id)
				}
			}
		})
	}
}

// A backend's identifier must not name the infrastructure behind it. Name()
// reaches logs and telemetry, and those get pasted into tickets and dashboards.
func TestConformanceNameIsRuntimeNeutral(t *testing.T) {
	banned := []string{"aws", "amazon", "lambda", "microvm", "azure", "gcp"}
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			name := strings.ToLower(tc.buildDisabled().Name())
			if name == "" {
				t.Fatal("backend has no name")
			}
			for _, bad := range banned {
				if strings.Contains(name, bad) {
					t.Errorf("backend name %q names the provider", name)
				}
			}
		})
	}
}

// A disabled backend is the state every cell not running it sees — on the QEMU
// fleet that is the only state. Every entry point must be inert rather than
// panicking, because a nil dereference here takes down the create path for a
// cell that has nothing to do with this runtime.
func TestConformanceDisabledBackendIsInert(t *testing.T) {
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.buildDisabled()
			ctx := context.Background()

			if mgr, ok := b.Route(ctx, "sb-anything"); ok || mgr != nil {
				t.Errorf("disabled %s routed a sandbox: mgr=%v ok=%v", tc.name, mgr, ok)
			}
			if p, isPlacer := b.(Placer); isPlacer {
				if _, err := p.Claim(ctx, placement{sandboxID: "sb-anything"}); err == nil {
					t.Errorf("disabled %s claimed a sandbox without error", tc.name)
				}
			}
			healthy, available, running := b.Capacity()
			if healthy != 0 || available != 0 || running != 0 {
				t.Errorf("disabled %s advertised capacity (%d,%d,%d) — the edge would route creates to it",
					tc.name, healthy, available, running)
			}
			if p, isPlacer := b.(Placer); isPlacer {
				// Releasing a sandbox a disabled backend never claimed must be
				// a no-op. Cleanup runs on every failed create, including ones
				// that failed before this backend was involved.
				p.Release(ctx, "sb-never-claimed", "")
			}
			// Must not panic.
			b.Reconcile(ctx, nil)
			b.Close()
		})
	}
}

// A backend that cannot rediscover its own sandboxes must say so, because that
// is what decides whether a failed row write fails the create. Getting this
// backwards in either direction is expensive: false when it should be true
// leaks a host forever, true when it should be false destroys a working sandbox
// over a transient database error.
func TestConformanceDeclaresWhetherItNeedsTheRow(t *testing.T) {
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			p, isPlacer := tc.buildDisabled().(Placer)
			if !isPlacer {
				t.Skip("not a Placer")
			}
			// A backend that writes a synthetic worker_id has no registry to ask
			// what it is running, so it can only rebuild from the rows.
			needsRow := p.RequiresPersistedRow()
			if synthetic := len(p.WorkerIDPrefixes()) > 0; synthetic != needsRow {
				t.Errorf("%s: RequiresPersistedRow=%v but synthetic worker ids=%v — one of these is wrong",
					tc.name, needsRow, synthetic)
			}
		})
	}
}

// A backend that fakes a worker_id must declare every prefix it can produce,
// or the SQL built from these will not recognize its own rows — the orphan
// sweep reaps them, and the restore scan cannot find them after a restart.
func TestConformancePrefixesCoverOwnedWorkerID(t *testing.T) {
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.buildDisabled()
			prefixes := b.WorkerIDPrefixes()
			if len(prefixes) == 0 {
				t.Fatalf("%s declares no worker_id prefixes but synthesizes worker ids", tc.name)
			}
			matched := false
			for _, p := range prefixes {
				if strings.HasPrefix(tc.ownedWorkerID, p) {
					matched = true
				}
			}
			if !matched {
				t.Fatalf("%s owns %q but declares prefixes %v — SQL built from these misses its own rows",
					tc.name, tc.ownedWorkerID, prefixes)
			}
			// A prefix that matches a real worker id would exclude the whole
			// QEMU fleet from the orphan sweep.
			for _, p := range prefixes {
				if strings.HasPrefix("w-azure-osb-worker-2512f614", p) {
					t.Errorf("%s prefix %q matches a real worker id", tc.name, p)
				}
			}
		})
	}
}

// Route must answer "not mine" for a sandbox the backend does not hold, never
// "mine but unavailable" — the caller reads false as permission to try another
// backend, so a wrong answer here strands the sandbox.
func TestConformanceRouteDeclinesUnknownSandbox(t *testing.T) {
	for _, tc := range conformanceBackends {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := tc.buildDisabled().Route(context.Background(), "sb-never-created"); ok {
				t.Fatalf("%s claimed a sandbox it never held", tc.name)
			}
		})
	}
}

// ── dispatch-layer invariants ───────────────────────────────────────────────

// fakeBackend is a Backend that holds exactly one sandbox, for exercising the
// registry itself rather than any real runtime.
type fakeBackend struct {
	name   string
	holds  string
	mgr    sandbox.Manager
	places bool // implements Placer via fakePlacer
}

// fakePlacer is a fakeBackend that can also accept new sandboxes.
type fakePlacer struct{ *fakeBackend }

func (f *fakePlacer) RequiresPersistedRow() bool { return false }

func (f *fakePlacer) Release(context.Context, string, string) {}

func (f *fakePlacer) Claim(context.Context, placement) (string, error) {
	return f.name + ":host", nil
}
func (f *fakePlacer) Activate(_ context.Context, a activation) (activated, error) {
	return activated{sandboxID: a.sandboxID, status: "running"}, nil
}

func (f *fakeBackend) Name() string               { return f.name }
func (f *fakeBackend) WorkerIDPrefixes() []string { return []string{f.name + ":"} }
func (f *fakeBackend) OwnsWorkerID(w string) bool {
	return strings.HasPrefix(w, f.name+":")
}
func (f *fakeBackend) Route(_ context.Context, id string) (sandbox.Manager, bool) {
	if id == f.holds {
		return f.mgr, true
	}
	return nil, false
}
func (f *fakeBackend) Capacity() (int, int, int)            { return 1, 1, 0 }
func (f *fakeBackend) Reconcile(context.Context, *db.Store) {}

func (f *fakeBackend) Close() {}

// Registration order is placement policy: claimBackend serves new sandboxes
// from the first registered backend, and backendFor must find the one that
// actually holds a given sandbox rather than the first that answers.
func TestRegistryDispatchesToTheHoldingBackend(t *testing.T) {
	first := &fakeBackend{name: "first", holds: "sb-first"}
	second := &fakePlacer{&fakeBackend{name: "second", holds: "sb-second"}}
	s := &Server{}
	s.registerBackend(first)
	s.registerBackend(second)

	got, _, ok := s.backendFor(context.Background(), "sb-second")
	if !ok || got.Name() != "second" {
		t.Fatalf("backendFor picked %v (ok=%v), want the backend holding the sandbox", got, ok)
	}
	// "first" is registered ahead of "second" but cannot place, so creates must
	// skip it rather than being diverted to a backend that would fail them.
	claim, ok := s.claimBackend()
	if !ok || claim.Name() != "second" {
		t.Fatalf("claimBackend picked %v, want the first backend that can place", claim)
	}
	if _, _, ok := s.backendFor(context.Background(), "sb-unheld"); ok {
		t.Fatal("registry claimed a sandbox no backend holds")
	}
}

// A Server with no backends must route nothing. That nil case IS the QEMU
// fleet, and a stray true here would divert its traffic in-process.
func TestNoBackendsRoutesNothing(t *testing.T) {
	s := &Server{}
	if _, _, ok := s.backendFor(context.Background(), "sb-1"); ok {
		t.Fatal("empty registry claimed a sandbox")
	}
	if _, ok := s.claimBackend(); ok {
		t.Fatal("empty registry offered to serve a create")
	}
	if mgr, ok := s.execManagerFor("sb-1"); ok || mgr != nil {
		t.Fatal("empty registry returned an exec manager")
	}
}
