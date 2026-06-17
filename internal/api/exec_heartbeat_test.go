package api

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

// newExecCtx builds an echo context backed by a recorder for handler tests.
func newExecCtx() (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes/sb-x/exec/run", nil)
	rec := httptest.NewRecorder()
	return e.NewContext(req, rec), rec
}

// Fast commands (under the grace window) keep the original status semantics
// and a plain JSON body — no heartbeat bytes.
func TestRespondExecWithHeartbeat_FastPath(t *testing.T) {
	c, rec := newExecCtx()
	want := &types.ProcessResult{ExitCode: 7, Stdout: "out", Stderr: "err"}
	err := respondExecWithHeartbeat(c, func(ctx context.Context) (*types.ProcessResult, error) {
		return want, nil
	})
	if err != nil {
		t.Fatalf("handler returned err: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.HasPrefix(rec.Body.String(), " ") {
		t.Fatalf("fast path should not emit leading heartbeat whitespace, got %q", rec.Body.String())
	}
	var got types.ProcessResult
	if e := json.Unmarshal(rec.Body.Bytes(), &got); e != nil {
		t.Fatalf("decode: %v", e)
	}
	if got != *want {
		t.Fatalf("result = %+v, want %+v", got, *want)
	}
}

// Fast-path errors still surface as a 500 (unchanged behavior).
func TestRespondExecWithHeartbeat_FastPathError(t *testing.T) {
	c, rec := newExecCtx()
	err := respondExecWithHeartbeat(c, func(ctx context.Context) (*types.ProcessResult, error) {
		return nil, fmt.Errorf("boom")
	})
	if err != nil {
		t.Fatalf("handler returned err: %v", err)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

// Long commands commit a 200 and emit whitespace heartbeats, but the body still
// decodes as a ProcessResult (leading whitespace is valid JSON).
func TestRespondExecWithHeartbeat_SlowPathStreamsValidJSON(t *testing.T) {
	og, oi := execHeartbeatGrace, execHeartbeatInterval
	execHeartbeatGrace, execHeartbeatInterval = 5*time.Millisecond, 5*time.Millisecond
	defer func() { execHeartbeatGrace, execHeartbeatInterval = og, oi }()

	c, rec := newExecCtx()
	want := &types.ProcessResult{ExitCode: 0, Stdout: "hello", Stderr: ""}
	err := respondExecWithHeartbeat(c, func(ctx context.Context) (*types.ProcessResult, error) {
		time.Sleep(40 * time.Millisecond) // forces slow path + several heartbeats
		return want, nil
	})
	if err != nil {
		t.Fatalf("handler returned err: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, " ") {
		t.Fatalf("slow path should emit leading heartbeat whitespace, got %q", body)
	}
	var got types.ProcessResult
	if e := json.Unmarshal(rec.Body.Bytes(), &got); e != nil {
		t.Fatalf("heartbeat body must still decode as JSON: %v (body=%q)", e, body)
	}
	if got != *want {
		t.Fatalf("decoded result = %+v, want %+v", got, *want)
	}
}

// An error after commit is surfaced as a ProcessResult (ExitCode -1), since the
// 200 status is already on the wire — strictly better than the 524 it replaces.
func TestRespondExecWithHeartbeat_SlowPathErrorAsResult(t *testing.T) {
	og := execHeartbeatGrace
	execHeartbeatGrace = 5 * time.Millisecond
	defer func() { execHeartbeatGrace = og }()

	c, rec := newExecCtx()
	err := respondExecWithHeartbeat(c, func(ctx context.Context) (*types.ProcessResult, error) {
		time.Sleep(20 * time.Millisecond)
		return nil, fmt.Errorf("agent unreachable")
	})
	if err != nil {
		t.Fatalf("handler returned err: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (already committed)", rec.Code)
	}
	var got types.ProcessResult
	if e := json.Unmarshal(rec.Body.Bytes(), &got); e != nil {
		t.Fatalf("decode: %v", e)
	}
	if got.ExitCode != -1 || !strings.Contains(got.Stderr, "agent unreachable") {
		t.Fatalf("error not surfaced as ProcessResult: %+v", got)
	}
}
