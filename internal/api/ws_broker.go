package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/wsgateway"
)

// brokerWSUpgrader is the gorilla upgrader used for client WS upgrades
// inside the broker route handlers. CheckOrigin returns true because by
// the time the request reaches this handler it has already passed the
// edge's auth (cap-token + API key) and CORS layers — same posture as
// the existing api/pty.go and api/exec_session.go upgraders.
var brokerWSUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// brokerWebSocket is the Echo handler mounted at the data-plane WS paths
// (/api/sandboxes/:id/pty/:sessionID, /exec/:sessionID, /agent/:sid)
// when s.wsGateway is non-nil. Replaces the legacy SandboxAPIProxy
// hijack-and-io.Copy path with the in-process broker, which adds
// redial, keepalive, exec-exit handling, etc.
//
// Auth has already happened upstream (PGAPIKeyMiddleware on the api
// group). This handler does the worker resolution + broker handoff.
func (s *Server) brokerWebSocket(c echo.Context) error {
	if s.wsGateway == nil || s.sandboxAPIProxy == nil {
		// Belt-and-suspenders. Routes shouldn't be registered without both.
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "ws broker not configured",
		})
	}
	sandboxID := c.Param("id")
	sessionID := c.Param("sessionID")
	if sessionID == "" {
		sessionID = c.Param("sid") // /agent/:sid uses :sid
	}
	if sandboxID == "" || sessionID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "sandbox ID and session ID required",
		})
	}

	// Resolve once pre-upgrade so we can return a normal HTTP error if
	// the sandbox is migrating / stopped / not found. After the upgrade
	// the only failure channel is the WS close frame.
	if _, err := s.sandboxAPIProxy.ResolveWorker(c, sandboxID); err != nil {
		return err
	}

	// cellPath is the request path verbatim — drives isExec detection
	// inside the broker (/exec/ and /agent/ flip it; /pty/ doesn't).
	cellPath := c.Request().URL.Path
	cellPathStripped := strings.TrimPrefix(cellPath, "/api")
	rawQuery := c.Request().URL.RawQuery

	// ResolveWorker closure: the broker calls it on initial dial AND on
	// every redial, so a post-migration worker change picks up
	// automatically. Route cache (3s TTL inside the proxy) coalesces
	// rapid back-to-back lookups.
	//
	// When the cell-CP reports the sandbox is mid-migration (HTTP 503
	// with "migrating" in the message), wrap the error with the
	// wsgateway sentinel so the redial loop switches to the long
	// migration cadence instead of burning its fast-ladder budget.
	resolve := func() (string, string, error) {
		r, err := s.sandboxAPIProxy.ResolveWorker(c, sandboxID)
		if err != nil {
			if isMigratingErr(err) {
				return "", "", fmt.Errorf("%w: %v", wsgateway.ErrUpstreamMigrating, err)
			}
			if isTerminalErr(err) {
				return "", "", fmt.Errorf("%w: %v", wsgateway.ErrUpstreamTerminal, err)
			}
			return "", "", err
		}
		return buildWorkerWSURL(r.WorkerURL, cellPathStripped, rawQuery), r.Token, nil
	}

	return s.wsGateway.Serve(c.Response(), c.Request(), &brokerWSUpgrader, wsgateway.ServeOpts{
		SandboxID:     sandboxID,
		SessionID:     sessionID,
		CellPath:      cellPath,
		ResolveWorker: resolve,
	})
}

// isTerminalErr matches the echo.HTTPError shapes ResolveWorker returns
// for sandboxes that are permanently gone — 404 (no DB row, e.g. just
// DELETEd or never existed) and 410 (status=stopped or error). The
// broker uses this to close the client with a clean 1000 reason
// instead of cycling through the redial budget.
func isTerminalErr(err error) bool {
	if err == nil {
		return false
	}
	var he *echo.HTTPError
	if !errors.As(err, &he) {
		return false
	}
	return he.Code == http.StatusNotFound || he.Code == http.StatusGone
}

// isMigratingErr peeks at the echo.HTTPError returned by ResolveWorker
// and reports whether it's the "sandbox is migrating, retry shortly"
// flavor — the only ResolveWorker error path that should drive the
// broker into its migration backoff cadence rather than failing fast.
func isMigratingErr(err error) bool {
	if err == nil {
		return false
	}
	var he *echo.HTTPError
	if !errors.As(err, &he) {
		return false
	}
	if he.Code != http.StatusServiceUnavailable {
		return false
	}
	msg := ""
	if s, ok := he.Message.(string); ok {
		msg = s
	}
	return strings.Contains(strings.ToLower(msg), "migrating")
}

// buildWorkerWSURL composes the WebSocket URL the broker should dial
// against the worker. Worker addresses are http:// (or https://); we
// flip to ws:// (or wss://) and stitch the cell-stripped path + query.
//
// Worker URL examples:
//
//	http://10.0.0.5:8080  →  ws://10.0.0.5:8080/sandboxes/sb-xxx/pty/yyy?api_key=...
//	https://worker.svc    →  wss://worker.svc/sandboxes/sb-xxx/pty/yyy
func buildWorkerWSURL(workerAddr, cellPathStripped, rawQuery string) string {
	scheme := "ws"
	rest := workerAddr
	switch {
	case strings.HasPrefix(workerAddr, "https://"):
		scheme = "wss"
		rest = strings.TrimPrefix(workerAddr, "https://")
	case strings.HasPrefix(workerAddr, "http://"):
		scheme = "ws"
		rest = strings.TrimPrefix(workerAddr, "http://")
	}
	rest = strings.TrimRight(rest, "/")
	u := fmt.Sprintf("%s://%s%s", scheme, rest, cellPathStripped)
	if rawQuery != "" {
		u += "?" + rawQuery
	}
	return u
}
