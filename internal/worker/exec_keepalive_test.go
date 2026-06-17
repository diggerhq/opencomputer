package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func newKeepaliveCtx() (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes/sb-x/exec/run", nil)
	rec := httptest.NewRecorder()
	return e.NewContext(req, rec), rec
}

// Fast commands return with normal status codes and no heartbeat bytes.
func TestRespondExecKeepalive_FastPath(t *testing.T) {
	c, rec := newKeepaliveCtx()
	want := &types.ProcessResult{ExitCode: 3, Stdout: "ok"}
	if err := respondExecKeepalive(c, func(ctx context.Context) (*types.ProcessResult, error) {
		return want, nil
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.HasPrefix(rec.Body.String(), " ") {
		t.Fatalf("fast path should not emit heartbeat whitespace: %q", rec.Body.String())
	}
	var got types.ProcessResult
	if e := json.Unmarshal(rec.Body.Bytes(), &got); e != nil {
		t.Fatalf("decode: %v", e)
	}
	if got != *want {
		t.Fatalf("result = %+v, want %+v", got, *want)
	}
}

// Fast-path errors keep their 500.
func TestRespondExecKeepalive_FastPathError(t *testing.T) {
	c, rec := newKeepaliveCtx()
	if err := respondExecKeepalive(c, func(ctx context.Context) (*types.ProcessResult, error) {
		return nil, fmt.Errorf("nope")
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

// A long (effectively un-timed-out) command commits 200, heartbeats, and still
// returns a decodable ProcessResult.
func TestRespondExecKeepalive_SlowPathStreamsValidJSON(t *testing.T) {
	og, oi := execKeepaliveGrace, execKeepaliveInterval
	execKeepaliveGrace, execKeepaliveInterval = 5*time.Millisecond, 5*time.Millisecond
	defer func() { execKeepaliveGrace, execKeepaliveInterval = og, oi }()

	c, rec := newKeepaliveCtx()
	want := &types.ProcessResult{ExitCode: 0, Stdout: "done"}
	if err := respondExecKeepalive(c, func(ctx context.Context) (*types.ProcessResult, error) {
		time.Sleep(40 * time.Millisecond)
		return want, nil
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.HasPrefix(rec.Body.String(), " ") {
		t.Fatalf("slow path should emit heartbeat whitespace: %q", rec.Body.String())
	}
	var got types.ProcessResult
	if e := json.Unmarshal(rec.Body.Bytes(), &got); e != nil {
		t.Fatalf("heartbeat body must decode as JSON: %v (%q)", e, rec.Body.String())
	}
	if got != *want {
		t.Fatalf("result = %+v, want %+v", got, *want)
	}
}

// An error after commit is surfaced as a ProcessResult (ExitCode -1).
func TestRespondExecKeepalive_SlowPathErrorAsResult(t *testing.T) {
	og := execKeepaliveGrace
	execKeepaliveGrace = 5 * time.Millisecond
	defer func() { execKeepaliveGrace = og }()

	c, rec := newKeepaliveCtx()
	if err := respondExecKeepalive(c, func(ctx context.Context) (*types.ProcessResult, error) {
		time.Sleep(20 * time.Millisecond)
		return nil, fmt.Errorf("agent gone")
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (committed)", rec.Code)
	}
	var got types.ProcessResult
	if e := json.Unmarshal(rec.Body.Bytes(), &got); e != nil {
		t.Fatalf("decode: %v", e)
	}
	if got.ExitCode != -1 || !strings.Contains(got.Stderr, "agent gone") {
		t.Fatalf("error not surfaced: %+v", got)
	}
}
