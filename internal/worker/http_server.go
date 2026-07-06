package worker

import (
	"net/http"
	"os"
	"sync"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/mounts"
	"github.com/opensandbox/opensandbox/internal/observability"
	"github.com/opensandbox/opensandbox/internal/obslog"
	"github.com/opensandbox/opensandbox/internal/proxy"
	"github.com/opensandbox/opensandbox/internal/sandbox"
)

// HTTPServer serves the REST/WebSocket API for direct SDK access on the worker.
// It exposes the same endpoints as the control plane but authenticates via sandbox-scoped JWTs.
type HTTPServer struct {
	echo               *echo.Echo
	manager            sandbox.Manager
	ptyManager         *sandbox.PTYManager
	execSessionManager *sandbox.ExecSessionManager
	jwtIssuer          *auth.JWTIssuer
	sandboxDBs         *sandbox.SandboxDBManager
	router             *sandbox.SandboxRouter
	mountSvc           *mounts.Service // nil when store is unavailable
	sandboxDomain      string

	// asyncExecs tracks background exec/run invocations by client-facing
	// execId. The handle is registered synchronously so POST /exec/run returns
	// immediately; the wake + session create + command run happen in a
	// goroutine, so a slow auto-wake never holds the connection (no 524/502).
	// Keyed execId -> *asyncExec. Entries self-expire via a TTL timer.
	asyncExecs sync.Map
}

// NewHTTPServer creates a new worker HTTP server for direct SDK access.
func NewHTTPServer(mgr sandbox.Manager, ptyMgr *sandbox.PTYManager, execMgr *sandbox.ExecSessionManager, jwtIssuer *auth.JWTIssuer, sandboxDBs *sandbox.SandboxDBManager, sbProxy *proxy.SandboxProxy, sbRouter *sandbox.SandboxRouter, sandboxDomain string) *HTTPServer {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	s := &HTTPServer{
		echo:               e,
		manager:            mgr,
		ptyManager:         ptyMgr,
		execSessionManager: execMgr,
		jwtIssuer:          jwtIssuer,
		sandboxDBs:         sandboxDBs,
		router:             sbRouter,
		sandboxDomain:      sandboxDomain,
	}
	if mgr != nil {
		s.mountSvc = mounts.NewService(mgr)
	}

	// Global middleware. Sentry goes first so it can observe panics and
	// attach request context before echo's Recover middleware handles them.
	// RequestID() before obslog so the request_id is on the context when
	// our middleware tags it — and the control plane forwards X-Request-Id
	// from its proxy, which Echo's RequestID() reuses instead of generating
	// a new id, so the same id appears on both control plane and worker logs.
	e.Use(observability.EchoMiddleware())
	e.Use(middleware.Recover())
	e.Use(middleware.RequestID())
	e.Use(obslog.EchoMiddleware())
	e.Use(middleware.CORS())

	// Subdomain proxy middleware (before auth — subdomain traffic is public)
	if sbProxy != nil {
		e.Use(sbProxy.Middleware())
	}

	// Health check (no auth)
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok", "role": "worker"})
	})

	// Debug-only pause/resume hooks for measuring the RAM-resident pause tier
	// (localhost, no auth). Gated by OSB_DEBUG_PAUSE=1 — never registered in
	// normal operation. Scaffolding for Phase-1 validation; remove before GA.
	if os.Getenv("OSB_DEBUG_PAUSE") == "1" {
		e.POST("/debug/pause/:id", s.debugPause)
		e.POST("/debug/resume/:id", s.debugResume)
	}

	// All sandbox routes require JWT auth
	api := e.Group("")
	api.Use(auth.SandboxJWTMiddleware(jwtIssuer))

	// Sandbox status
	api.GET("/sandboxes/:id", s.getSandbox)

	// Exec sessions (replaces old /commands)
	api.POST("/sandboxes/:id/exec/run", s.execRun)            // static path before parameterized (sync, legacy)
	api.POST("/sandboxes/:id/exec/run-async", s.execRunAsync) // async handle + poll /result
	api.POST("/sandboxes/:id/exec", s.createExecSession)
	api.GET("/sandboxes/:id/exec", s.listExecSessions)
	api.GET("/sandboxes/:id/exec/:sessionID", s.execSessionWebSocket)
	api.GET("/sandboxes/:id/exec/:sessionID/result", s.execResult)
	api.POST("/sandboxes/:id/exec/:sessionID/kill", s.killExecSession)

	// Timeout
	api.POST("/sandboxes/:id/timeout", s.setTimeout)

	// Filesystem
	api.GET("/sandboxes/:id/files", s.readFile)
	api.PUT("/sandboxes/:id/files", s.writeFile)
	api.GET("/sandboxes/:id/files/list", s.listDir)
	api.POST("/sandboxes/:id/files/mkdir", s.makeDir)
	api.DELETE("/sandboxes/:id/files", s.removeFile)

	// Mounts (FUSE via rclone)
	api.POST("/sandboxes/:id/mounts", s.addMount)
	api.GET("/sandboxes/:id/mounts", s.listMounts)
	api.DELETE("/sandboxes/:id/mounts", s.removeMount)

	// Token refresh
	api.POST("/sandboxes/:id/token/refresh", s.refreshToken)

	// Agent sessions (Claude Agent SDK)
	api.POST("/sandboxes/:id/agent", s.createAgentSession)
	api.GET("/sandboxes/:id/agent", s.listAgentSessions)
	api.POST("/sandboxes/:id/agent/:sid/prompt", s.sendAgentPrompt)
	api.POST("/sandboxes/:id/agent/:sid/interrupt", s.interruptAgent)
	api.POST("/sandboxes/:id/agent/:sid/kill", s.killAgentSession)

	// PTY
	api.POST("/sandboxes/:id/pty", s.createPTY)
	api.GET("/sandboxes/:id/pty/:sessionID", s.ptyWebSocket)
	api.POST("/sandboxes/:id/pty/:sessionID/resize", s.resizePTY)
	api.DELETE("/sandboxes/:id/pty/:sessionID", s.killPTY)

	return s
}

// Start starts the HTTP server on the given address.
func (s *HTTPServer) Start(addr string) error {
	return s.echo.Start(addr)
}

// Close gracefully shuts down the server.
func (s *HTTPServer) Close() error {
	return s.echo.Close()
}

// debugPause / debugResume are OSB_DEBUG_PAUSE-gated measurement hooks for the
// RAM-resident pause tier. Not part of the product surface.
func (s *HTTPServer) debugPause(c echo.Context) error {
	pm, ok := s.manager.(pausableManager)
	if !ok {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "pause not supported"})
	}
	reclaimed, err := pm.Pause(c.Request().Context(), c.Param("id"))
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	return c.JSON(http.StatusOK, map[string]any{"reclaimedBytes": reclaimed})
}

func (s *HTTPServer) debugResume(c echo.Context) error {
	pm, ok := s.manager.(pausableManager)
	if !ok {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "resume not supported"})
	}
	if err := pm.Resume(c.Request().Context(), c.Param("id")); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	return c.JSON(http.StatusOK, map[string]string{"status": "resumed"})
}
