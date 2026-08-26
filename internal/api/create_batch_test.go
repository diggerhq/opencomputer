package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
)

// newBatchTestServer returns a Server whose echo can mint child contexts, with a
// stub standing in for the single-create handler so these tests exercise the
// batching contract rather than the create path.
func newBatchTestServer(handler func(echo.Context) error) *Server {
	s := &Server{echo: echo.New()}
	s.createOverrideForTest = handler
	return s
}

func batchReq(t *testing.T, s *Server, body string, claims *auth.CapabilityClaims) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/internal/sandboxes/create-batch", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := s.echo.NewContext(req, rec)
	if claims != nil {
		c.Set(capClaimsKey, claims)
	}
	if err := s.internalCreateSandboxBatch(c); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return rec
}

// Results are positional — callers fan them back to the waiters they batched, so
// a shuffled response silently hands sandbox A to the caller who asked for B.
// Concurrency makes completion order deliberately non-sequential here.
func TestCreateBatchResultsArePositional(t *testing.T) {
	var mu sync.Mutex
	s := newBatchTestServer(func(c echo.Context) error {
		var in struct {
			N int `json:"n"`
		}
		_ = json.NewDecoder(c.Request().Body).Decode(&in)
		mu.Lock()
		defer mu.Unlock()
		return c.JSON(http.StatusOK, map[string]int{"got": in.N})
	})

	const n = 25
	items := make([]string, n)
	for i := range items {
		items[i] = fmt.Sprintf(`{"n":%d}`, i)
	}
	rec := batchReq(t, s, `{"items":[`+strings.Join(items, ",")+`]}`,
		&auth.CapabilityClaims{OrgID: "11111111-1111-1111-1111-111111111111"})

	var resp createBatchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
	}
	if len(resp.Results) != n {
		t.Fatalf("got %d results, want %d", len(resp.Results), n)
	}
	for i, r := range resp.Results {
		var got struct {
			Got int `json:"got"`
		}
		if err := json.Unmarshal(r.Body, &got); err != nil {
			t.Fatalf("result %d: decode %v", i, err)
		}
		if got.Got != i {
			t.Fatalf("result %d carries item %d — results are not positional", i, got.Got)
		}
	}
}

// One item failing must not take the batch down: these are unrelated customer
// creates that merely share a connection.
func TestCreateBatchIsolatesPerItemFailure(t *testing.T) {
	s := newBatchTestServer(func(c echo.Context) error {
		var in struct {
			Fail bool `json:"fail"`
		}
		_ = json.NewDecoder(c.Request().Body).Decode(&in)
		if in.Fail {
			return c.JSON(http.StatusNotFound, map[string]string{"error": "nope"})
		}
		return c.JSON(http.StatusOK, map[string]string{"ok": "yes"})
	})

	rec := batchReq(t, s, `{"items":[{"fail":false},{"fail":true},{"fail":false}]}`,
		&auth.CapabilityClaims{OrgID: "11111111-1111-1111-1111-111111111111"})

	var resp createBatchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []int{http.StatusOK, http.StatusNotFound, http.StatusOK}
	for i, w := range want {
		if resp.Results[i].Status != w {
			t.Fatalf("result %d status=%d want %d — a failing item changed its neighbours",
				i, resp.Results[i].Status, w)
		}
	}
}

func TestCreateBatchRejectsEmptyOversizeAndUnauthenticated(t *testing.T) {
	s := newBatchTestServer(func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"ok": "yes"})
	})
	claims := &auth.CapabilityClaims{OrgID: "11111111-1111-1111-1111-111111111111"}

	if rec := batchReq(t, s, `{"items":[]}`, claims); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty batch: got %d want 400", rec.Code)
	}

	big := make([]string, maxBatchItems+1)
	for i := range big {
		big[i] = `{}`
	}
	if rec := batchReq(t, s, `{"items":[`+strings.Join(big, ",")+`]}`, claims); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversize batch: got %d want 400", rec.Code)
	}

	// No claims == the middleware did not run. Must never fall through to
	// creating sandboxes for an unauthenticated caller.
	if rec := batchReq(t, s, `{"items":[{}]}`, nil); rec.Code != http.StatusInternalServerError {
		t.Fatalf("missing claims: got %d want 500", rec.Code)
	}
}
