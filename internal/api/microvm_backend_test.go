package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// The MicroVM backend is off by default and its hooks sit in three handlers the
// QEMU fleet uses on every request (createSandbox, killSandboxByID,
// execRunAsyncRoute). These tests pin the property that makes that safe: with
// the backend disabled, every hook is inert.
//
// This is the regression guard for a real bug found the hard way — the claim
// was originally placed behind the worker-registry check, which made it
// unreachable on a MicroVM-only cell. Placement in these handlers is load
// bearing in both directions.

// The Backend contract itself is covered generically in
// backend_conformance_test.go. What remains here is this backend's own
// lifecycle wiring — the calls the router makes at startup and shutdown, which
// no other backend has and which must not panic when the runtime is disabled.
// That nil case IS the QEMU fleet.
func TestNilMicrovmBackendIsInert(t *testing.T) {
	var b *microvmBackend // explicitly nil, as on a QEMU cell

	if id, ok := b.claimPooled("sb-test", types.SandboxConfig{}); ok || id != "" {
		t.Fatalf("nil backend claimed a box: id=%q ok=%v", id, ok)
	}
	if d := b.Depth(); d != 0 {
		t.Fatalf("nil backend reported depth %d", d)
	}
	owned, err := b.Kill(context.Background(), "sb-test")
	if owned || err != nil {
		t.Fatalf("nil backend claimed ownership on Kill: owned=%v err=%v", owned, err)
	}
	// Must not panic.
	b.Close()
	b.Restore(context.Background(), nil)
	b.StartReconciler(context.Background(), nil)
	b.StartUsageTicker(context.Background(), nil)
	b.StartCapacityReporter(context.Background(), nil, "")
	b.StartEventPublisher(context.Background(), nil, nil, "", nil)
}

// execManagerFor decides whether a sandbox is served in-process or dispatched
// to a worker. On a QEMU cell it must never claim a sandbox, or exec would be
// routed to a backend that does not hold it.
func TestExecManagerForDeclinesWhenBackendDisabled(t *testing.T) {
	s := &Server{} // microvm nil
	if mgr, ok := s.execManagerFor("sb-anything"); ok || mgr != nil {
		t.Fatalf("disabled backend claimed sandbox routing: mgr=%v ok=%v", mgr, ok)
	}
}

// ErrUnsupported must surface as 501, not 500: a 500 reads as our bug and
// invites a retry, while the operation can never succeed on this runtime.
func TestRespondManagerErrMapsUnsupportedTo501(t *testing.T) {
	e := echo.New()
	rec := httptest.NewRecorder()
	c := e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec)

	if err := respondManagerErr(c, awsvm.ErrUnsupported); err != nil {
		t.Fatalf("respondManagerErr: %v", err)
	}
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported op returned %d, want 501", rec.Code)
	}
}

// Anything that is not ErrUnsupported stays a 500 — a transport failure or a
// dead box is a real error and must not be reported as "not implemented".
func TestRespondManagerErrKeeps500ForRealErrors(t *testing.T) {
	e := echo.New()
	rec := httptest.NewRecorder()
	c := e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec)

	if err := respondManagerErr(c, errors.New("connection reset")); err != nil {
		t.Fatalf("respondManagerErr: %v", err)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("ordinary error returned %d, want 500", rec.Code)
	}
}

// A full region and a rate limit are different problems with opposite fixes:
// raise the quota vs. wait a second. The response has to say which, or an
// operator tunes the wrong knob and a client cannot decide whether to retry.
func TestRespondCreateErrDistinguishesQuotaFromThrottle(t *testing.T) {
	newCtx := func() (echo.Context, *httptest.ResponseRecorder) {
		e := echo.New()
		rec := httptest.NewRecorder()
		return e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec), rec
	}

	c, rec := newCtx()
	if err := respondCreateErr(c, fmt.Errorf("run: %w", awsvm.ErrQuotaExceeded)); err != nil {
		t.Fatalf("respondCreateErr: %v", err)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("quota returned %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "out of capacity") {
		t.Fatalf("quota body does not say out of capacity: %s", rec.Body.String())
	}
	// Retrying cannot help until a box is released, so we must not invite it.
	if got := rec.Header().Get("Retry-After"); got != "" {
		t.Fatalf("quota set Retry-After=%q, inviting a retry storm at a full region", got)
	}

	c, rec = newCtx()
	if err := respondCreateErr(c, fmt.Errorf("run: %w", awsvm.ErrThrottled)); err != nil {
		t.Fatalf("respondCreateErr: %v", err)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("throttle returned %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("throttle is transient but gave the client no Retry-After")
	}
	if strings.Contains(rec.Body.String(), "out of capacity") {
		t.Fatal("throttle reported as out of capacity — sends operators to raise a quota that is fine")
	}
}

// Anything unclassified stays a 500: reporting an unknown failure as capacity
// exhaustion would hide a real bug behind a plausible-looking operational
// message.
func TestRespondCreateErrKeeps500ForUnknown(t *testing.T) {
	e := echo.New()
	rec := httptest.NewRecorder()
	c := e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec)

	if err := respondCreateErr(c, errors.New("connection reset")); err != nil {
		t.Fatalf("respondCreateErr: %v", err)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unknown error returned %d, want 500", rec.Code)
	}
}

// microvmWorkerID round-trips through worker_id. That encoding is the only
// durable link between a sandbox and its AWS box; if it breaks, a restarted
// control plane cannot rebuild its map and the boxes are both unroutable and
// unreapable.
func TestMicrovmWorkerIDRoundTrips(t *testing.T) {
	const id = "microvm-abc123"
	got, ok := parseMicrovmWorkerID(microvmWorkerID(id))
	if !ok || got != id {
		t.Fatalf("round-trip failed: got %q ok=%v", got, ok)
	}

	// A real worker id must never be mistaken for a MicroVM row, or the
	// reconciler would start closing live QEMU sandboxes.
	for _, notOurs := range []string{"worker-eastus2-7", "", "microvm:", "microvm", "vmhost:", "vmhost"} {
		if _, ok := parseMicrovmWorkerID(notOurs); ok {
			t.Fatalf("parsed %q as a MicroVM worker id", notOurs)
		}
	}
}

// Rows written before the vendor-neutral rename still carry the old prefix.
// They must stay parseable: the restore path uses this to rebuild the sandbox→
// box map, so a parse failure leaves those sandboxes unroutable and their boxes
// running until the provider's duration cap with nothing able to reap them.
func TestParseMicrovmWorkerIDAcceptsLegacyPrefix(t *testing.T) {
	got, ok := parseMicrovmWorkerID("microvm:microvm-abc123")
	if !ok || got != "microvm-abc123" {
		t.Fatalf("legacy prefix not parsed: got %q ok=%v", got, ok)
	}
}

// The written form must be the neutral one. worker_id is returned in the create
// response and written to D1, so writing the old prefix would keep advertising
// the provider to every customer.
func TestMicrovmWorkerIDWritesNeutralPrefix(t *testing.T) {
	if got := microvmWorkerID("abc123"); strings.Contains(got, "microvm") {
		t.Fatalf("microvmWorkerID produced %q, which names the runtime", got)
	}
}
