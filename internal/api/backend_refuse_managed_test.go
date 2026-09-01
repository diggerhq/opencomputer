package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
)

// backend_refuse_managed_test.go — the routes a managed backend does not serve
// must not destroy the sandbox they were asked about.
//
// PTY, agent sessions and mounts bypass dispatchDataPlane and go straight to
// the worker proxy. That proxy resolves a sandbox through the worker registry,
// and a managed sandbox is deliberately absent from it — so the proxy read
// "held by a backend" as "worker lost", wrote the session row to `stopped`, and
// returned 410 for every subsequent request. The sandbox itself kept running
// and billing, unreachable.
//
// One unsupported call should cost a 501, not the sandbox.

// stubBackend holds exactly the sandbox ids it is given.
type stubBackend struct {
	name string
	held map[string]struct{}
}

func (b *stubBackend) Name() string                { return b.name }
func (b *stubBackend) OwnsWorkerID(id string) bool { return id == "vmhost:box-1" }
func (b *stubBackend) WorkerIDPrefixes() []string  { return []string{"vmhost:"} }
func (b *stubBackend) Capacity() (int, int, int)   { return 1, 1, len(b.held) }
func (b *stubBackend) Route(_ context.Context, sandboxID string) (sandbox.Manager, bool) {
	if _, ok := b.held[sandboxID]; ok {
		// A nil manager is fine here: refuseIfManaged decides on ownership
		// alone, and must not depend on the manager implementing anything.
		return nil, true
	}
	return nil, false
}
func (b *stubBackend) Reconcile(context.Context, *db.Store) {}
func (b *stubBackend) Close()                               {}

// call runs refuseIfManaged for a sandbox id and reports the status written and
// whether the wrapped proxy handler ran.
func call(t *testing.T, s *Server, sandboxID string) (status int, proxied bool) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes/"+sandboxID+"/pty", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(sandboxID)

	h := s.refuseIfManaged(func(echo.Context) error {
		proxied = true
		return c.NoContent(http.StatusOK)
	})
	if err := h(c); err != nil {
		t.Fatalf("handler returned error: %v", err)
	}
	return rec.Code, proxied
}

// The whole point: a backend-held sandbox is answered, never proxied. Reaching
// the proxy is what closed the row.
func TestManagedSandboxIsRefusedNotProxied(t *testing.T) {
	s := &Server{}
	s.backends = append(s.backends, &stubBackend{
		name: "vmhost-lite",
		held: map[string]struct{}{"sbx-managed": {}},
	})

	status, proxied := call(t, s, "sbx-managed")
	if proxied {
		t.Fatal("a managed sandbox reached the worker proxy — the proxy would find no registered worker and mark the row stopped")
	}
	if status != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501: this runtime will never serve PTY, and a retryable code invites the client to keep asking", status)
	}
}

// The other direction matters just as much. Every QEMU sandbox depends on
// falling through to the proxy, so the guard must be invisible to them.
func TestUnheldSandboxStillProxies(t *testing.T) {
	s := &Server{}
	s.backends = append(s.backends, &stubBackend{
		name: "vmhost-lite",
		held: map[string]struct{}{"sbx-managed": {}},
	})

	status, proxied := call(t, s, "sbx-on-a-worker")
	if !proxied {
		t.Fatal("a worker-held sandbox was refused — this would break PTY for the entire QEMU fleet")
	}
	if status != http.StatusOK {
		t.Errorf("status = %d, want 200", status)
	}
}

// With no backends registered at all — a plain QEMU cell — nothing is refused.
func TestNoBackendsRefusesNothing(t *testing.T) {
	s := &Server{}
	if _, proxied := call(t, s, "sbx-anything"); !proxied {
		t.Fatal("a cell with no managed backends refused a proxy route")
	}
}
