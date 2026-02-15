package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
)

// Server holds the API server dependencies.
type Server struct {
	echo       *echo.Echo
	manager    *sandbox.Manager
	ptyManager *sandbox.PTYManager
	templates  *templateDeps
	store      *db.Store           // nil in combined/dev mode without PG
	jwtIssuer  *auth.JWTIssuer     // nil if JWT not configured
	mode       string              // "server", "worker", "combined"
	workerID   string              // this worker's ID
	region     string              // this worker's region
	httpAddr   string              // public HTTP address for direct access
	sandboxDBs *sandbox.SandboxDBManager // per-sandbox SQLite manager
}

// ServerOpts holds optional dependencies for the API server.
type ServerOpts struct {
	Store      *db.Store
	JWTIssuer  *auth.JWTIssuer
	Mode       string // "server", "worker", "combined"
	WorkerID   string
	Region     string
	HTTPAddr   string
	SandboxDBs *sandbox.SandboxDBManager
}

// NewServer creates a new API server with all routes configured.
func NewServer(mgr *sandbox.Manager, ptyMgr *sandbox.PTYManager, apiKey string, opts *ServerOpts) *Server {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	s := &Server{
		echo:       e,
		manager:    mgr,
		ptyManager: ptyMgr,
	}

	if opts != nil {
		s.store = opts.Store
		s.jwtIssuer = opts.JWTIssuer
		s.mode = opts.Mode
		s.workerID = opts.WorkerID
		s.region = opts.Region
		s.httpAddr = opts.HTTPAddr
		s.sandboxDBs = opts.SandboxDBs
	}

	// Global middleware
	e.Use(middleware.Recover())
	e.Use(middleware.Logger())
	e.Use(middleware.CORS())
	e.Use(middleware.RequestID())

	// Health check (no auth)
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	// API routes (with auth)
	api := e.Group("")
	api.Use(auth.PGAPIKeyMiddleware(s.store, apiKey))

	// Sandbox lifecycle
	api.POST("/sandboxes", s.createSandbox)
	api.GET("/sandboxes", s.listSandboxes)
	api.GET("/sandboxes/:id", s.getSandbox)
	api.DELETE("/sandboxes/:id", s.killSandbox)
	api.POST("/sandboxes/:id/timeout", s.setTimeout)

	// Commands
	api.POST("/sandboxes/:id/commands", s.runCommand)

	// Filesystem
	api.GET("/sandboxes/:id/files", s.readFile)
	api.PUT("/sandboxes/:id/files", s.writeFile)
	api.GET("/sandboxes/:id/files/list", s.listDir)
	api.POST("/sandboxes/:id/files/mkdir", s.makeDir)
	api.DELETE("/sandboxes/:id/files", s.removeFile)

	// PTY
	api.POST("/sandboxes/:id/pty", s.createPTY)
	api.GET("/sandboxes/:id/pty/:sessionID", s.ptyWebSocket)
	api.DELETE("/sandboxes/:id/pty/:sessionID", s.killPTY)

	// Templates
	api.POST("/templates", s.buildTemplate)
	api.GET("/templates", s.listTemplates)
	api.GET("/templates/:name", s.getTemplate)
	api.DELETE("/templates/:name", s.deleteTemplate)

	// Session history (requires PG)
	api.GET("/sessions", s.listSessions)

	return s
}

// Start starts the HTTP server on the given address.
func (s *Server) Start(addr string) error {
	return s.echo.Start(addr)
}

// Close gracefully shuts down the server.
func (s *Server) Close() error {
	return s.echo.Close()
}

// Echo returns the underlying echo instance for reuse (e.g., worker HTTP server).
func (s *Server) Echo() *echo.Echo {
	return s.echo
}
