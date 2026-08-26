package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
)

// create_batch.go — serve N creates on ONE edge→control-plane request.
//
// WHY. A burst of 100 creates costs ~115ms EACH in the edge's `cell` mark while
// this control plane answers every one of them in ~59us. Practically none of
// that hop is work: it is the connection. The cell's origin
// (cp-uswest2.opensandbox.ai → 20.64.208.62) is NOT behind Cloudflare's proxy,
// so a Worker subrequest dials the Azure box directly and a concurrent burst
// opens a pile of fresh connections, each paying a TLS handshake to westus2.
// Serially the same hop is ~30ms — one warm connection, one round trip.
//
// The protocol knob that would fix this does not exist for us: `fetch()` in a
// Worker exposes no way to force HTTP/2, and zone-level "HTTP/2 to Origin"
// applies only to proxied hostnames, which this origin is not. So the only
// reliable way to stop paying ~100 handshakes is to stop making ~100 requests.
//
// This is the same shape as the fix that took the template lookup from 580ms to
// nothing earlier: collapse a herd of identical concurrent calls into one.
// There the herd was per-key and the answer was a single flight; here the calls
// are distinct but the TRANSPORT is the contended resource, so the answer is a
// single request carrying all of them.
//
// HOW. Deliberately NOT a reimplementation of the create path. Each item is run
// through the very same internalCreateSandbox handler via a child echo context
// with a recorder, so batched and unbatched creates cannot drift in behaviour —
// there is exactly one create implementation, and this calls it. The cost is a
// synthetic request per item, which is allocation, not I/O.

// maxBatchItems bounds one request. The window that fills a batch is small, so
// a batch this large means something is very wrong upstream; the cap keeps a
// bad or hostile caller from turning one request into unbounded work.
const maxBatchItems = 256

type createBatchRequest struct {
	// Items are raw create bodies, byte-identical to what a single
	// POST /internal/sandboxes/create would carry.
	Items []json.RawMessage `json:"items"`
}

type createBatchResult struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

type createBatchResponse struct {
	// Results is positional: results[i] answers items[i]. Callers fan these
	// back out to the waiters they batched, so order is load-bearing.
	Results []createBatchResult `json:"results"`
}

// internalCreateSandboxBatch runs every item through the single-create handler
// and returns their responses positionally. An item that fails fails alone: its
// own status and body are reported and the rest still land, because these are
// unrelated customer creates that happen to share a connection.
func (s *Server) internalCreateSandboxBatch(c echo.Context) error {
	var req createBatchRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid batch body: " + err.Error()})
	}
	if len(req.Items) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "batch has no items"})
	}
	if len(req.Items) > maxBatchItems {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "batch too large"})
	}

	// The cap-token was verified once, by the middleware, for the batch request.
	// Every item inherits it: they were authenticated as one request and they
	// are all for the caller the token names.
	claims, _ := c.Get(capClaimsKey).(*auth.CapabilityClaims)
	if claims == nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "missing capability claims"})
	}

	parent := c.Request()
	results := make([]createBatchResult, len(req.Items))

	// Concurrent, because the whole point is that these do not queue behind each
	// other. The single-create path already runs concurrently for ordinary
	// traffic, so nothing here is newly shared.
	var wg sync.WaitGroup
	for i, item := range req.Items {
		wg.Add(1)
		go func(i int, body []byte) {
			defer wg.Done()
			results[i] = s.runBatchedCreate(parent, claims, body)
		}(i, item)
	}
	wg.Wait()

	return c.JSON(http.StatusOK, createBatchResponse{Results: results})
}

// runBatchedCreate executes one item on the real create handler and captures
// what it wrote.
func (s *Server) runBatchedCreate(parent *http.Request, claims *auth.CapabilityClaims, body []byte) createBatchResult {
	// Carry the parent's context so a client disconnect or deadline cancels the
	// whole batch rather than leaving items running with nothing to answer.
	sub := httptest.NewRequest(http.MethodPost, "/internal/sandboxes/create", bytes.NewReader(body)).
		WithContext(parent.Context())
	sub.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	// Region selection reads this header (see createSandboxRemote).
	if r := parent.Header.Get("Fly-Region"); r != "" {
		sub.Header.Set("Fly-Region", r)
	}

	rec := httptest.NewRecorder()
	cc := s.echo.NewContext(sub, rec)
	// The child never passes through capTokenMiddleware — it is not a real
	// request — so hand it the claims the middleware would have set. This is the
	// ONLY request-scoped value that needs carrying: the create path reads the
	// runtime off these claims (runtimeFor), and internalCreateSandbox derives
	// org and user identity from them too. Anything added to the middleware
	// chain that the create path later reads must be copied here as well, or a
	// batched create will quietly behave differently from an unbatched one.
	cc.Set(capClaimsKey, claims)

	if err := s.batchedCreateHandler()(cc); err != nil {
		// The handler returns its errors as responses; a non-nil error here is
		// echo-level and would normally be rendered by the error handler.
		return createBatchResult{
			Status: http.StatusInternalServerError,
			Body:   mustJSON(map[string]string{"error": err.Error()}),
		}
	}

	raw, _ := io.ReadAll(rec.Result().Body)
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	return createBatchResult{Status: rec.Code, Body: json.RawMessage(raw)}
}

// batchedCreateHandler is the handler each item runs on: the real single-create
// path in production, and only ever something else under test.
func (s *Server) batchedCreateHandler() func(echo.Context) error {
	if s.createOverrideForTest != nil {
		return s.createOverrideForTest
	}
	return s.internalCreateSandbox
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{"error":"marshal failed"}`)
	}
	return b
}
