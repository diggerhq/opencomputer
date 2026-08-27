// Package reqtime carries per-request timing that spans the middleware chain.
//
// The create trace starts inside the handler, which is exactly the wrong place
// to answer the question it was built for. Instrumenting the create path showed
// every in-handler mark at 0.0ms — including `tot` — while the client measured
// a 215ms create. A handler that finishes in under a millisecond cannot be the
// thing costing 215ms, so the cost is upstream of it, and the trace as built
// cannot see upstream of itself.
//
// This package covers the gap between Go accepting the request and the handler
// being entered: the middleware chain, and specifically the API-key validation
// that does two Postgres round trips before any handler runs. It lives in its
// own package because both internal/api and internal/auth need it and neither
// may import the other.
package reqtime

import (
	"sync/atomic"
	"time"

	"github.com/labstack/echo/v4"
)

// ctxKey is the echo-context key. A string rather than a struct{} because
// echo.Context.Set takes a string.
const ctxKey = "osb_reqtime"

// T accumulates timings for one request.
type T struct {
	// Start is when the outermost middleware saw the request. Everything
	// before it — accept queue, TCP, TLS — is by construction invisible here,
	// and that invisibility is itself the signal: if Start-to-response is
	// near zero and the client still measured hundreds of ms, the queue is in
	// front of Go and no server-side change will move it.
	Start time.Time

	authNanos atomic.Int64
}

// Middleware installs a T on the context. Register it outermost.
func Middleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Set(ctxKey, &T{Start: time.Now()})
			return next(c)
		}
	}
}

// From returns the request's T, or nil if the middleware is not installed
// (which is the case in unit tests that build a bare echo context).
func From(c echo.Context) *T {
	t, _ := c.Get(ctxKey).(*T)
	return t
}

// AddAuth records time spent authenticating. Additive because a request can
// take more than one validation path before one succeeds.
func AddAuth(c echo.Context, d time.Duration) {
	if t := From(c); t != nil {
		t.authNanos.Add(int64(d))
	}
}

// Auth is the accumulated authentication time.
func (t *T) Auth() time.Duration {
	if t == nil {
		return 0
	}
	return time.Duration(t.authNanos.Load())
}

// Since is time elapsed inside Go's handler chain so far.
func (t *T) Since() time.Duration {
	if t == nil {
		return 0
	}
	return time.Since(t.Start)
}
