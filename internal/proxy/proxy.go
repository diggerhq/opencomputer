package proxy

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/sandbox"
)

// SandboxProxy reverse-proxies HTTP traffic from subdomain requests
// to the corresponding sandbox container's published port.
type SandboxProxy struct {
	baseDomain string
	manager    *sandbox.Manager
	router     *sandbox.SandboxRouter
}

// New creates a new SandboxProxy.
// baseDomain is the base domain for sandbox subdomains (e.g., "workers.opensandbox.dev" or "localhost").
func New(baseDomain string, mgr *sandbox.Manager, router *sandbox.SandboxRouter) *SandboxProxy {
	return &SandboxProxy{
		baseDomain: baseDomain,
		manager:    mgr,
		router:     router,
	}
}

// Middleware returns an Echo middleware that intercepts subdomain requests
// and proxies them to the sandbox container. Non-subdomain requests pass through.
func (p *SandboxProxy) Middleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			host := c.Request().Host

			// Strip port from host for matching
			hostOnly := host
			if idx := strings.LastIndex(host, ":"); idx != -1 {
				hostOnly = host[:idx]
			}

			sandboxID, ok := p.extractSandboxID(hostOnly)
			if !ok {
				return next(c)
			}

			return p.doProxy(c, sandboxID)
		}
	}
}

// extractSandboxID parses "{sandboxID}.{baseDomain}" from the host.
// For baseDomain "localhost", matches "{sandboxID}.localhost".
// For baseDomain "workers.opensandbox.dev", matches "{sandboxID}.workers.opensandbox.dev".
func (p *SandboxProxy) extractSandboxID(host string) (string, bool) {
	suffix := "." + p.baseDomain
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}
	sandboxID := strings.TrimSuffix(host, suffix)
	if sandboxID == "" || strings.Contains(sandboxID, ".") {
		return "", false
	}
	return sandboxID, true
}

// doProxy looks up the sandbox's host port and reverse-proxies the request.
// If the sandbox is hibernated, it auto-wakes via the router first.
func (p *SandboxProxy) doProxy(c echo.Context, sandboxID string) error {
	ctx := c.Request().Context()

	// Route through the sandbox router for auto-wake and rolling timeout reset
	var hostPort int
	var portErr error

	routeOp := func(ctx context.Context) error {
		hostPort, portErr = p.manager.HostPort(ctx, sandboxID)
		return portErr
	}

	if p.router != nil {
		if err := p.router.Route(ctx, sandboxID, "proxy", routeOp); err != nil {
			log.Printf("proxy: route failed for sandbox %s: %v", sandboxID, err)
			return c.JSON(http.StatusBadGateway, map[string]string{
				"error": fmt.Sprintf("sandbox %s not available: %v", sandboxID, err),
			})
		}
	} else {
		if err := routeOp(ctx); err != nil {
			return c.JSON(http.StatusBadGateway, map[string]string{
				"error": fmt.Sprintf("sandbox %s not available: %v", sandboxID, err),
			})
		}
	}

	// Create reverse proxy to localhost:{hostPort}
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", hostPort),
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("proxy: error proxying to sandbox %s (port %d): %v", sandboxID, hostPort, err)
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, "sandbox %s: upstream unavailable", sandboxID)
	}

	proxy.ServeHTTP(c.Response(), c.Request())
	return nil
}
