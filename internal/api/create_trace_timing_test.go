package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// The direct-to-cell path has no edge Worker in front of it, so Server-Timing
// from the CP is the only per-step attribution a benchmark can see. A burst
// there reported exec p50 483ms as one opaque number.
func TestServerTimingCarriesEveryMark(t *testing.T) {
	if !createTraceEnabled {
		t.Skip("tracing compiled off; serverTiming is nil-safe and returns empty")
	}
	tr := newTrace("exectrace")
	tr.mark("session")
	tr.mark("hold")

	got := tr.serverTiming()
	for _, want := range []string{"tot;dur=", "session;dur=", "hold;dur="} {
		if !strings.Contains(got, want) {
			t.Errorf("Server-Timing missing %q: %s", want, got)
		}
	}
}

// A nil trace is the tracing-disabled case and must stay safe at every call
// site, since the emitters are called unconditionally.
func TestNilTraceEmitsNothing(t *testing.T) {
	var tr *createTrace
	if got := tr.serverTiming(); got != "" {
		t.Errorf("nil trace produced a header: %q", got)
	}

	rec := httptest.NewRecorder()
	c := echo.New().NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec)
	tr.emitServerTiming(c) // must not panic
	c.NoContent(http.StatusOK)
	if v := rec.Header().Get("Server-Timing"); v != "" {
		t.Errorf("nil trace set a header: %q", v)
	}
}

// The header has to be set on EVERY exit, which is why it is a Before hook
// rather than a write at each return.
func TestServerTimingSetOnResponse(t *testing.T) {
	if !createTraceEnabled {
		t.Skip("tracing compiled off")
	}
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec)

	tr := newTrace("exectrace")
	tr.emitServerTiming(c)
	tr.mark("session")
	c.NoContent(http.StatusAccepted)

	if v := rec.Header().Get("Server-Timing"); !strings.Contains(v, "session;dur=") {
		t.Errorf("marks recorded after the hook was registered were lost: %q", v)
	}
}
