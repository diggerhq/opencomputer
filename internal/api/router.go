package api

import (
	"context"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/redis/go-redis/v9"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/billing"
	"github.com/opensandbox/opensandbox/internal/cloudflare"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/edgeclient"
	"github.com/opensandbox/opensandbox/internal/metrics"
	"github.com/opensandbox/opensandbox/internal/mounts"
	"github.com/opensandbox/opensandbox/internal/observability"
	"github.com/opensandbox/opensandbox/internal/obslog"
	"github.com/opensandbox/opensandbox/internal/proxy"
	"github.com/opensandbox/opensandbox/internal/reqtime"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/internal/wsgateway"
)

var errSandboxNotAvailable = map[string]string{
	"error": "sandbox execution not available in server-only mode",
}

// Server holds the API server dependencies.
type Server struct {
	// createOverrideForTest substitutes the per-item handler the batch endpoint
	// fans out to. Test-only seam: it lets create_batch_test exercise the
	// batching contract (ordering, per-item isolation, limits) without standing
	// up a backend, a store and a worker registry. Always nil in production,
	// where batchedCreateHandler resolves to internalCreateSandbox.
	createOverrideForTest func(echo.Context) error

	echo               *echo.Echo
	manager            sandbox.Manager
	router             *sandbox.SandboxRouter // routes all sandbox interactions (state machine, auto-wake, rolling timeout)
	ptyManager         *sandbox.PTYManager
	store              *db.Store                         // nil in combined/dev mode without PG
	jwtIssuer          *auth.JWTIssuer                   // nil if JWT not configured
	capTokenIssuer     *auth.JWTIssuer                   // verifies edge→CP capability tokens; nil if SESSION_JWT_SECRET unset
	sessionJWTSecret   string                            // raw shared edge↔CP HMAC secret; mints per-sandbox VM-DO connect tokens (see auth.MintVMDOConnectToken)
	requireCapToken    bool                              // derived from PRO_BILLING_AUTHORITY=edge: reject direct API-key creates that bypass edge billing (split mode only)
	cfAdminSecret      string                            // HMAC shared with CreditAccount DO for /admin/halt-org and /admin/resume-org; empty disables auth (dev only)
	cfEventSecret      string                            // HMAC shared with the api-edge Worker for /internal/secret-refresh and other edge-→cell push paths
	cellID             string                            // this control plane's cell_id (for the cap-token cell check)
	platformOrgID      uuid.UUID                         // owner of the shared catalog snapshots; anchors the public-snapshot fallback + gates publish (uuid.Nil = fallback disabled)
	mode               string                            // "server", "worker", "combined"
	workerID           string                            // this worker's ID
	region             string                            // this worker's region
	httpAddr           string                            // public HTTP address for direct access
	execSessionManager *sandbox.ExecSessionManager       // nil if not configured
	sandboxDBs         *sandbox.SandboxDBManager         // per-sandbox SQLite manager
	workos             *auth.WorkOSMiddleware            // nil if WorkOS not configured
	dashboardAuthMode  string                            // "workos" or "single-tenant"; empty disables dashboard APIs
	workerRegistry     *controlplane.RedisWorkerRegistry // nil in combined/worker mode
	workersDisabled    bool                              // OPENSANDBOX_MAX_WORKERS=0: this cell provisions no workers
	checkpointStore    *storage.CheckpointStore          // nil if hibernation not configured
	sandboxDomain      string                            // base domain for sandbox subdomains
	cfClient           *cloudflare.Client                // nil if Cloudflare not configured
	pendingCreates     sync.Map                          // map[sandboxID]*pendingCreate — async sandbox creation tracking
	pendingEdgeClaims  sync.Map                          // map[sandboxID]*edgePending — edge-claimed boxes awaiting claim-finalize
	mountSvc           *mounts.Service                   // shared with worker.HTTPServer; nil disables the mounts API
	sandboxAPIProxy    *proxy.SandboxAPIProxy            // nil except in server mode (proxies data-plane to workers)
	wsGateway          *wsgateway.Gateway                // nil disables the broker; WS data-plane routes fall back to sandboxAPIProxy
	stripeClient       *billing.StripeClient             // nil if Stripe not configured
	redisClient        *redis.Client                     // nil if Redis not configured (for health checks)
	adminEvents        *AdminEventBus                    // real-time event bus for admin dashboard
	microvm            *microvmBackend                   // managed-host backend; nil unless enabled (see microvm_backend.go)
	lite               *liteBackend                      // direct-exec managed-host backend; mutually exclusive with microvm (see lite_backend.go)
	materialize        *materializer                     // memoizes per-org/user row creation off the create hot path (materialize.go)
	orgRuntime         *orgRuntimeCache                  // memoizes orgs.runtime for the direct-to-cell create path (backend.go)
	templateCache      *templateCache                    // caches name→template so create doesn't call the edge every time (template_cache.go)
	// backends is the dispatch set for placement and routing (see backend.go).
	// The worker path is deliberately absent — it is reached by falling through.
	backends []Backend
	ready    int32 // atomic: 1 = ready, 0 = not ready

	// Axiom log query (sandbox session logs read API).
	// Empty token = endpoint returns 503.
	axiomQueryToken string
	axiomDataset    string

	// CF api-edge HTTP client — HMAC-signed calls to /internal/templates and
	// /internal/secret-stores. nil when the edge isn't configured (legacy
	// single-PG mode or tests); resolveSecretStoreInto + template lookup fall
	// back to s.store in that case.
	edge *edgeclient.Client

	// migrator delegates live-migration to the scaler's orchestrator so the
	// API path (POST /api/sandboxes/:id/migrate) shares the per-target
	// serialization + abort-on-failure cleanup the scaler uses for drains.
	// nil disables the migrate endpoint (returns 503).
	migrator MigrationOrchestrator
}

// MigrationOrchestrator is the slice of the scaler the API needs to delegate
// migration requests to. Defined as an interface here (rather than importing
// the concrete *controlplane.Scaler) so the API package stays test-friendly
// and the dependency direction is API → interface ← controlplane.
type MigrationOrchestrator interface {
	LiveMigrateSandbox(ctx context.Context, sandboxID, sourceWorkerID, targetWorkerID string) error
}

// SetMigrator wires the scaler-backed migration orchestrator. Called from
// cmd/server/main.go after the scaler is constructed.
func (s *Server) SetMigrator(m MigrationOrchestrator) {
	s.migrator = m
}

// SetEdgeClient wires the api-edge HTTP client. Caller is responsible for
// constructing it with the right base URL + HMAC secret (CFEventSecret).
func (s *Server) SetEdgeClient(c *edgeclient.Client) {
	s.edge = c
	s.prewarmPoolTemplate()
}

// prewarmPoolTemplate resolves the default template once at startup so no
// customer create is ever the one that pays for it.
//
// Every SDK create carries a template name ("base" unless overridden), and the
// first one to arrive after a restart would otherwise block on the edge round
// trip — which, if that first create arrives as part of a burst, is the 580ms
// case the template cache exists to prevent. Doing it here costs one request at
// boot, off any hot path.
//
// Best effort by design: a failure just leaves the cache empty, which is
// exactly the state this would have been in anyway. The public-template
// fallback means the pool template resolves without an org.
func (s *Server) prewarmPoolTemplate() {
	if s.edge == nil || s.templateCache == nil {
		return
	}
	name := poolTemplateName()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), templateRefreshTimeout)
		defer cancel()
		if _, err := s.templateCache.lookup(ctx, uuid.Nil, name, func(fctx context.Context) (*db.DBTemplate, error) {
			return s.edge.LookupTemplate(fctx, uuid.Nil, name)
		}); err != nil {
			log.Printf("template cache: prewarm of %q failed: %v — first create will resolve it", name, err)
		}
	}()
}

// SetWSGateway wires the in-process WebSocket broker. When non-nil,
// data-plane WS routes (/sandboxes/:id/pty/:sid, /exec/:sid, /agent/:sid)
// route through the broker instead of the legacy SandboxAPIProxy
// hijack-and-io.Copy path. The broker provides multi-session, redial on
// upstream close, exec-exit marker handling, keepalive, and circuit
// breaking — see internal/wsgateway for the spec. Safe to leave nil
// for cells that prefer the legacy transparent forward.
func (s *Server) SetWSGateway(gw *wsgateway.Gateway) {
	s.wsGateway = gw
}

// SetAxiomQueryConfig wires the read-only Axiom token and dataset for
// the sandbox session logs read API. Token never leaves the control
// plane; the UI proxies through us.
func (s *Server) SetAxiomQueryConfig(queryToken, dataset string) {
	s.axiomQueryToken = queryToken
	s.axiomDataset = dataset
}

// pendingCreate tracks an async sandbox creation.
type pendingCreate struct {
	ready chan struct{} // closed when creation completes
	err   error         // set before closing ready
}

// ServerOpts holds optional dependencies for the API server.
type ServerOpts struct {
	Store                 *db.Store
	JWTIssuer             *auth.JWTIssuer
	SessionJWTSecret      string // shared edge↔CP HMAC secret; enables /internal/sandboxes/create
	RequireCapToken       bool   // set from PRO_BILLING_AUTHORITY=edge; rejects edge-bypassing direct API-key creates
	CFAdminSecret         string // HMAC shared with CF CreditAccount DO; enables /admin/halt-org and /admin/resume-org
	CFEventSecret         string // HMAC shared with the api-edge Worker; enables /internal/secret-refresh and other edge-→cell push paths
	CellID                string // this control plane's cell_id
	PlatformOrgID         string // owner of the shared catalog snapshots (UUID string); empty disables the public-snapshot fallback
	Mode                  string // "server", "worker", "combined"
	WorkerID              string
	Region                string
	HTTPAddr              string
	ExecSessionManager    *sandbox.ExecSessionManager
	SandboxDBs            *sandbox.SandboxDBManager
	Router                *sandbox.SandboxRouter            // nil in server-only mode
	SandboxProxy          *proxy.SandboxProxy               // nil if subdomain routing not configured
	ControlPlaneProxy     *proxy.ControlPlaneProxy          // nil except in server mode (routes subdomains to workers)
	SandboxDomain         string                            // base domain for sandbox subdomains
	WorkOSConfig          *auth.WorkOSConfig                // nil if WorkOS not configured
	DashboardAuthMode     string                            // "workos" or "single-tenant"
	SingleTenantPrincipal *auth.SingleTenantPrincipal       // required for single-tenant dashboard auth
	WorkerRegistry        *controlplane.RedisWorkerRegistry // nil in combined/worker mode
	// WorkersDisabled marks a cell that provisions no workers
	// (OPENSANDBOX_MAX_WORKERS=0). The registry can still be non-nil there, so
	// this — not the registry — is what decides who reports cell capacity.
	WorkersDisabled bool
	CheckpointStore *storage.CheckpointStore // nil if hibernation not configured
	CFClient        *cloudflare.Client       // nil if Cloudflare not configured
	SandboxAPIProxy *proxy.SandboxAPIProxy   // nil except in server mode (proxies data-plane to workers)
	StripeClient    *billing.StripeClient    // nil if Stripe not configured
	RedisClient     *redis.Client            // nil if Redis not configured (for health checks)
}

// NewServer creates a new API server with all routes configured.
func NewServer(mgr sandbox.Manager, ptyMgr *sandbox.PTYManager, apiKey string, opts *ServerOpts) *Server {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	s := &Server{
		echo:          e,
		manager:       mgr,
		ptyManager:    ptyMgr,
		materialize:   newMaterializer(materializeTTL),
		orgRuntime:    newOrgRuntimeCache(orgRuntimeTTL),
		templateCache: newTemplateCache(),
	}
	// Mount service is only useful in combined mode (this process owns the
	// sandbox manager). In server mode the CP proxies to a worker, which
	// instantiates its own mounts.Service backed by its own manager.
	if mgr != nil {
		s.mountSvc = mounts.NewService(mgr)
	}

	if opts != nil {
		s.store = opts.Store
		s.jwtIssuer = opts.JWTIssuer
		if opts.SessionJWTSecret != "" {
			s.capTokenIssuer = auth.NewJWTIssuer(opts.SessionJWTSecret)
			s.sessionJWTSecret = opts.SessionJWTSecret // raw key for VM-DO connect-token minting
		}
		s.requireCapToken = opts.RequireCapToken
		s.cfAdminSecret = opts.CFAdminSecret
		s.cfEventSecret = opts.CFEventSecret
		s.cellID = opts.CellID
		if opts.PlatformOrgID != "" {
			if pid, err := uuid.Parse(opts.PlatformOrgID); err == nil {
				s.platformOrgID = pid
			} else {
				log.Printf("api: ignoring invalid OPENSANDBOX_PLATFORM_ORG_ID %q: %v (public-snapshot fallback disabled)", opts.PlatformOrgID, err)
			}
		}
		s.mode = opts.Mode
		s.workerID = opts.WorkerID
		s.region = opts.Region
		s.httpAddr = opts.HTTPAddr
		s.execSessionManager = opts.ExecSessionManager
		s.sandboxDBs = opts.SandboxDBs
		s.router = opts.Router
		s.dashboardAuthMode = opts.DashboardAuthMode
		s.workerRegistry = opts.WorkerRegistry
		s.workersDisabled = opts.WorkersDisabled
		s.checkpointStore = opts.CheckpointStore
		s.sandboxDomain = opts.SandboxDomain
		s.cfClient = opts.CFClient
		s.sandboxAPIProxy = opts.SandboxAPIProxy
		s.stripeClient = opts.StripeClient
		s.redisClient = opts.RedisClient
		s.adminEvents = NewAdminEventBus()

		// Wire up readiness waiting so the proxy blocks until async creates finish
		if s.sandboxAPIProxy != nil {
			s.sandboxAPIProxy.SetWaitForReady(func(ctx context.Context, sandboxID string) error {
				val, ok := s.pendingCreates.Load(sandboxID)
				if !ok {
					// Not an async create. It may still be an edge claim whose
					// finalize hasn't landed — the other way a caller can hold
					// a sandbox id this process cannot yet look up.
					return s.waitEdgeFinalize(ctx, sandboxID)
				}
				pending := val.(*pendingCreate)
				select {
				case <-pending.ready:
					s.pendingCreates.Delete(sandboxID)
					return pending.err
				case <-ctx.Done():
					return ctx.Err()
				}
			})
		}
	}

	// Global middleware. Sentry goes first so it can attach request context and
	// observe panics before echo's Recover middleware converts them to 500s.
	// RequestID() runs before obslog.EchoMiddleware so the X-Request-Id header
	// is on the response by the time obslog reads it. obslog replaces Echo's
	// built-in Logger() — same access log line, but JSON with the host
	// envelope and request_id/sandbox_id pulled from context.
	// Outermost, so it brackets the whole chain including auth.
	e.Use(reqtime.Middleware())
	e.Use(observability.EchoMiddleware())
	e.Use(middleware.Recover())
	e.Use(middleware.RequestID())
	e.Use(obslog.EchoMiddleware())
	// Prometheus instrumentation: counts requests by status, observes handler
	// latency, tracks in-flight. Uses c.Path() (route template) for the path
	// label so high-cardinality IDs don't blow up the metric.
	e.Use(metrics.EchoMiddleware())
	e.Use(middleware.CORS())

	// Subdomain proxy middleware (before auth — subdomain traffic is public)
	if opts != nil && opts.SandboxProxy != nil {
		e.Use(opts.SandboxProxy.Middleware())
	}
	if opts != nil && opts.ControlPlaneProxy != nil {
		e.Use(opts.ControlPlaneProxy.Middleware())

		// Edge-forwarded preview URL traffic. The api-edge Worker resolves
		// the public preview hostname (sb-{id}-p{port}.opensandbox.ai) to a
		// cell via D1, then forwards via this cell's Tunnel here. We:
		//
		//   1. strip the /internal/preview/{id}/{port} prefix so the inner
		//      URL path matches what the user originally requested
		//   2. synthesize the Host header the downstream worker proxy
		//      expects (sb-{id}-p{port}.{sandbox_domain}) so the worker's
		//      SandboxProxy.Middleware parses it correctly
		//   3. delegate to ControlPlaneProxy.HandleSandboxRequest, which
		//      reuses the same doProxy logic used by the host-header path —
		//      hibernation wake, worker-loss recovery, all of it.
		//
		// No cap-token auth on this route: it's public-internet sandbox
		// traffic that the edge has already validated (via D1 lookup +
		// sandbox-running check). The auth model is "edge gate, cell
		// trust" — same as POST /internal/sandboxes/create.
		cp := opts.ControlPlaneProxy
		sandboxDomain := opts.SandboxDomain
		e.Any("/internal/preview/:id/:port/*", func(c echo.Context) error {
			id := c.Param("id")
			portStr := c.Param("port")
			port, err := strconv.Atoi(portStr)
			if err != nil || port < 1 || port > 65535 {
				return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid port"})
			}
			prefix := "/internal/preview/" + id + "/" + portStr
			rest := strings.TrimPrefix(c.Request().URL.Path, prefix)
			if rest == "" {
				rest = "/"
			}
			c.Request().URL.Path = rest
			c.Request().Host = id + "-p" + portStr + "." + sandboxDomain
			return cp.HandleSandboxRequest(c, id, port)
		})
	}

	// Health checks (no auth)
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})
	e.GET("/healthz", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "alive"})
	})
	e.GET("/readyz", s.readinessCheck)
	// Admin routes — accept API key via header or ?key= query param
	admin := e.Group("/admin", func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			key := c.Request().Header.Get("X-API-Key")
			if key == "" {
				key = c.QueryParam("key")
			}
			if key == "" || key != apiKey {
				return c.JSON(http.StatusUnauthorized, map[string]string{"error": "invalid API key"})
			}
			return next(c)
		}
	})
	admin.GET("/status", s.adminStatusPage)
	admin.GET("/events", s.adminEventsSSE)
	admin.GET("/events/history", s.adminEventsHistory)
	admin.GET("/report", s.adminReport)
	admin.POST("/events/clear", s.adminClearEvents)
	admin.POST("/workers/:id/drain", s.adminSetWorkerDraining)
	admin.POST("/workers/:id/evict", s.adminEvictWorker)
	admin.POST("/sandboxes/:id/hibernate", s.adminForceHibernate)
	admin.GET("/demo/migration", s.demoPingPongPage)
	admin.GET("/demo/chaos", s.demoChaosPage)

	// Signed URL endpoints (self-authenticated via HMAC, no API key required)
	e.GET("/api/sandboxes/:id/files/download", s.signedDownload)
	e.PUT("/api/sandboxes/:id/files/upload", s.signedUpload)

	// Internal routes — called by the api-edge Worker, authenticated by a
	// capability token (HMAC with the shared session-JWT secret). Only mounted
	// when that secret is configured and this is a server-mode CP that can
	// dispatch to workers.
	if s.capTokenIssuer != nil && s.workerRegistry != nil {
		internal := e.Group("/internal", s.capTokenMiddleware)
		internal.POST("/sandboxes/create", s.internalCreateSandbox)
		// Same creates, one request. Serves the edge-side coalescer, which is
		// DEFAULT OFF (CREATE_BATCH) because measurement falsified the premise:
		// batching 26 creates into one request left the edge→cell hop unchanged
		// (132ms vs 126ms solo), so that hop is round-trip bound, not connection
		// bound. Endpoint kept because it is harmless and already deployed — see
		// create_batch.go and the edge's create_batch.ts.
		internal.POST("/sandboxes/create-batch", s.internalCreateSandboxBatch)
		// Edge claim (see edge_claim.go): the api-edge PoolStock DO reserves
		// pool boxes ahead of time and finalizes claims asynchronously.
		internal.POST("/pool/edge-reserve", s.edgeReservePool)
		internal.POST("/pool/edge-release", s.edgeReleasePool)
		internal.POST("/sandboxes/claim-finalize", s.claimFinalize)
		// Zero-subrequest edge claim (see voucher_claim.go): the edge pulls a
		// book of pre-paired boxes per colo OFF the hot path, then answers
		// creates locally. Never on a customer's critical path.
		internal.GET("/pool/vouchers", s.publishVouchers)
		// Cold-start discovery for the in-region voucher cache. Steady-state
		// discovery rides on pop responses, so this is hit once per cold
		// isolate rather than once per create.
		internal.GET("/pool/cache-peers", s.publishCachePeers)
		// Direct-path seam (see microvm_direct.go): lets the edge dial a
		// MicroVM's agent itself instead of relaying exec through this process.
		internal.GET("/microvm/direct/:id", s.microvmDirectInfo)
		// Cross-cell paused-cap enforcement: the edge (which has the org-global
		// view via D1) calls this to promote a specific paused sandbox to deep
		// hibernation, reclaiming its worker RAM.
		internal.POST("/sandboxes/:id/deep-hibernate", s.internalDeepHibernate)

		// Edge-proxied dashboard routes. Same handler functions as
		// /api/dashboard/* (gated below by WorkOS session cookie), exposed
		// under /internal/dashboard/* gated by the edge's cap-token instead.
		// This lets api-edge forward sandbox-runtime ops (PTY, stats, reboot,
		// logs) without requiring users to have a WorkOS cookie on every cell.
		//
		// The dashboard handlers read auth via auth.GetOrgID(c), which both
		// middlewares set — so the same functions work under either auth
		// chain. We only mount the sandbox-runtime subset here; the data-
		// authority routes (api-keys, org settings, checkpoints list) belong
		// on the edge proper, where D1 is the source of truth.
		idash := internal.Group("/dashboard")
		idash.GET("/sessions/:sandboxId", s.dashboardGetSession)
		idash.GET("/sessions/:sandboxId/stats", s.dashboardGetSessionStats)
		idash.DELETE("/sessions/:sandboxId", s.dashboardDeleteSession)
		idash.POST("/sessions/:sandboxId/reboot", s.dashboardRebootSession)
		idash.POST("/sessions/:sandboxId/power-cycle", s.dashboardPowerCycleSession)
		idash.POST("/sessions/:sandboxId/pty", s.dashboardCreatePTY)
		idash.GET("/sessions/:sandboxId/pty/:sessionId", s.dashboardPTYWebSocket)
		idash.POST("/sessions/:sandboxId/pty/:sessionId/resize", s.dashboardResizePTY)
		idash.DELETE("/sessions/:sandboxId/pty/:sessionId", s.dashboardKillPTY)
		// /images is cell-local (image_cache table lives in each cell's PG).
		// Proxy these here so dashboard can render per-cell image lists.
		idash.GET("/images", s.dashboardListImages)
		idash.DELETE("/images/:id", s.dashboardDeleteImage)
		idash.DELETE("/snapshots/:name", s.dashboardDeleteSnapshot)
		// Agents — currently proxied to an external service from each cell.
		// Easier to keep that wiring intact than reimplement on the edge.
		idash.Any("/agents", s.dashboardAgentsProxy)
		idash.Any("/agents/*", s.dashboardAgentsProxy)
		idash.GET("/agents/:agentId/entitlements", s.dashboardListAgentEntitlements)
		idash.POST("/agents/:agentId/subscriptions/:feature", s.dashboardSubscribeAgentFeature)
		idash.DELETE("/agents/:agentId/subscriptions/:feature", s.dashboardCancelAgentFeature)
		idash.GET("/sessions/:sandboxId/logs", s.getSandboxLogs)
	}

	// CF admin webhooks — dispatched by the CreditAccount DO on free-tier
	// halt/resume events. HMAC-authenticated via the shared CF_ADMIN_SECRET.
	// Routes live under /admin/ to match the DO's hard-coded path, but use a
	// distinct middleware chain from the human-API-key /admin group above.
	// Echo treats route registrations independently — there's no conflict.
	//
	// Only mounted when this CP can actually halt sandboxes (workers registry
	// present); a server-only CP without workers has no work to do here.
	if s.workerRegistry != nil {
		if s.cfAdminSecret == "" {
			log.Printf("api: WARNING: CF admin webhooks mounted without CF_ADMIN_SECRET — anyone can halt/resume orgs. Set OPENSANDBOX_CF_ADMIN_SECRET in production.")
		}
		cfAdmin := e.Group("/admin", controlplane.AdminAuth(s.cfAdminSecret))
		ah := controlplane.NewAdminHandlers(s)
		cfAdmin.POST("/halt-org", ah.HaltOrg)
		cfAdmin.POST("/resume-org", ah.ResumeOrg)
	}

	// Edge-→cell push: secret-refresh fan-in. The api-edge Worker posts here
	// after writing a new secret entry to D1 so this cell can update any
	// running sandboxes that bind the store. HMAC-authenticated with the
	// shared event secret (same one the forwarder uses, same one the edge
	// signs internal lookups with). Mounted only when both a workerRegistry
	// exists (otherwise there's nothing to fan out to) AND the event secret
	// is configured.
	if s.workerRegistry != nil && s.cfEventSecret != "" {
		cfEdge := e.Group("/internal", controlplane.AdminAuth(s.cfEventSecret))
		cfEdge.POST("/secret-refresh", s.internalSecretRefresh)
	}

	// API routes (with API key auth)
	api := e.Group("/api")
	api.Use(auth.PGAPIKeyMiddleware(s.store, apiKey, s.jwtIssuer, s.capTokenIssuer, s.cellID))

	// Identity
	api.POST("/auth/token", s.createAuthToken)

	// Per-agent paywalled-feature entitlement check, callable from
	// sessions-api with a JWT (aud=opencomputer-api) right before
	// allowing a connect-channel operation.
	api.GET("/agents/:agentId/entitlements/:feature", s.apiAgentEntitlement)

	// Sandbox lifecycle
	api.POST("/sandboxes", s.createSandbox)
	api.GET("/sandboxes", s.listSandboxes)
	api.GET("/sandboxes/:id", s.getSandbox)
	api.DELETE("/sandboxes/:id", s.killSandbox)

	// Sandbox session logs — SDK / curl variant. Same handler as the
	// dashboard's /api/dashboard/sessions/:sandboxId/logs route below;
	// auth here is X-API-Key (or identity-JWT) instead of cookie.
	// Useful for headless testing and SDK consumers.
	api.GET("/sandboxes/:id/logs", s.getSandboxLogs)

	// Reserved capacity (spec: ws-pricing/design/001-reserved-capacity-squares.md)
	api.GET("/capacity/calendar", s.getCapacityCalendar)
	api.POST("/capacity/reservations", s.createCapacityReservation)
	api.GET("/capacity/reservations", s.listCapacityReservations)
	// Internal/undocumented — phase-2 outbox inspection. See note in
	// getCapacityBillableEvents handler.
	api.GET("/capacity/billable-events", s.getCapacityBillableEvents)

	// Usage + tags (design: .agents/design/sandbox-tags-and-usage.md)
	api.GET("/usage", s.getUsage)
	api.GET("/tags", s.listTags)
	api.GET("/sandboxes/:id/usage", s.getSandboxUsage)
	api.GET("/sandboxes/:id/tags", s.getSandboxTags)
	api.PUT("/sandboxes/:id/tags", s.putSandboxTags)

	// Sandbox lifecycle webhooks are served by the api-edge Worker (all-Svix-at-edge):
	// the edge handles /api/webhooks* before its proxy catch-all, so the CP no longer
	// mounts these routes. The CP only sources lifecycle events (the outbox + relay)
	// and registers inline webhooks via the edge internal API.
	// (.agents/work/sandbox-webhooks-rearchitecture.md)

	// Hibernation
	api.POST("/sandboxes/:id/hibernate", s.hibernateSandbox)
	api.POST("/sandboxes/:id/wake", s.wakeSandbox)

	// Reset operations: reboot is a soft, in-place guest restart; power-cycle
	// is a hard restart that re-creates the QEMU process. Both preserve the
	// sandbox's identity and persistent data.
	api.POST("/sandboxes/:id/reboot", s.rebootSandbox)
	api.POST("/sandboxes/:id/power-cycle", s.powerCycleSandbox)

	// Live migration
	api.POST("/sandboxes/:id/migrate", s.migrateSandbox)

	// Resource limits
	api.PUT("/sandboxes/:id/limits", s.setLimits)
	api.POST("/sandboxes/:id/scale", s.scaleSandbox)
	api.PUT("/sandboxes/:id/autoscale", s.setAutoscale)
	api.GET("/sandboxes/:id/autoscale", s.getAutoscale)
	api.PUT("/sandboxes/:id/scaling-lock", s.setScalingLock)
	api.GET("/sandboxes/:id/scaling-lock", s.getScalingLock)
	api.GET("/sandboxes/:id/allowed-hosts", s.getSandboxAllowedHosts)

	// Checkpoints
	api.POST("/sandboxes/:id/checkpoints", s.createCheckpoint)
	api.GET("/sandboxes/:id/checkpoints", s.listCheckpoints)
	api.POST("/sandboxes/:id/checkpoints/:checkpointId/restore", s.restoreCheckpoint)
	api.POST("/sandboxes/from-checkpoint/:checkpointId", s.createFromCheckpoint)
	api.DELETE("/sandboxes/:id/checkpoints/:checkpointId", s.deleteCheckpoint)

	// Checkpoint patches
	api.POST("/sandboxes/checkpoints/:checkpointId/patches", s.createCheckpointPatch)
	api.GET("/sandboxes/checkpoints/:checkpointId/patches", s.listCheckpointPatches)
	api.DELETE("/sandboxes/checkpoints/:checkpointId/patches/:patchId", s.deleteCheckpointPatch)

	// Checkpoint publish / unpublish (design 009)
	api.POST("/sandboxes/checkpoints/:checkpointId/publish", s.publishCheckpoint)
	api.POST("/sandboxes/checkpoints/:checkpointId/unpublish", s.unpublishCheckpoint)

	// Signed file URLs
	api.POST("/sandboxes/:id/files/download-url", s.createDownloadURL)
	api.POST("/sandboxes/:id/files/upload-url", s.createUploadURL)

	// Preview URLs (on-demand port-based)
	api.POST("/sandboxes/:id/preview", s.createPreviewURL)
	api.GET("/sandboxes/:id/preview", s.listPreviewURLs)
	api.DELETE("/sandboxes/:id/preview/:port", s.deletePreviewURL)
	api.POST("/sandboxes/:id/preview/rotate", s.rotateSandboxPreviewAuth)

	// Data-plane routes: in server mode, proxy to workers; otherwise handle locally
	if s.sandboxAPIProxy != nil {
		// Server mode: proxy all data-plane requests to the worker that owns the sandbox
		pxy := s.sandboxAPIProxy.ProxyHandler

		// WS data-plane handler — dispatches dynamically per request so
		// SetWSGateway works regardless of whether it was called before or
		// after route registration. Non-WS verbs on the same paths always
		// go through the proxy: the broker only handles bidi streaming.
		wsHandler := func(c echo.Context) error {
			if s.wsGateway != nil {
				return s.brokerWebSocket(c)
			}
			return pxy(c)
		}

		// Data-plane dispatch: a sandbox held by a registered backend is served
		// in-process; everything else is proxied to the worker that holds it.
		//
		// One table, one wrapper. Previously each route was wrapped by hand, which
		// meant a new data-plane route defaulted to the proxy — and the proxy does
		// not merely fail for a backend-held sandbox, it resolves the route through
		// the worker registry, concludes the worker was lost, and writes the
		// session to `error`. A forgotten route killed healthy sandboxes on their
		// first request.
		dataPlane := []struct {
			method, path string
			local        echo.HandlerFunc
		}{
			{http.MethodPost, "/sandboxes/:id/exec", s.createExecSession},
			{http.MethodGet, "/sandboxes/:id/exec", s.listExecSessions},
			{http.MethodGet, "/sandboxes/:id/exec/:sessionID/result", s.execResult},
			{http.MethodPost, "/sandboxes/:id/exec/:sessionID/kill", s.killExecSession},
			{http.MethodPost, "/sandboxes/:id/exec/run", s.execRun},
			{http.MethodPost, "/sandboxes/:id/exec/run-async", s.execRunAsyncRoute},

			{http.MethodGet, "/sandboxes/:id/files", s.readFile},
			{http.MethodPut, "/sandboxes/:id/files", s.writeFile},
			{http.MethodGet, "/sandboxes/:id/files/list", s.listDir},
			{http.MethodPost, "/sandboxes/:id/files/mkdir", s.makeDir},
			{http.MethodDelete, "/sandboxes/:id/files", s.removeFile},
		}
		for _, r := range dataPlane {
			api.Add(r.method, r.path, s.dispatchDataPlane(r.local, pxy))
		}

		// Streaming and agent routes stay on the proxy: the backends that serve
		// in-process do not implement PTY, agent sessions, or bidi streaming, so
		// routing them here would answer a request no manager can serve. They
		// reach the worker path exactly as before.
		api.GET("/sandboxes/:id/exec/:sessionID", wsHandler)

		// Agent
		api.POST("/sandboxes/:id/agent", pxy)
		api.GET("/sandboxes/:id/agent", pxy)
		api.GET("/sandboxes/:id/agent/:sid", wsHandler)
		api.POST("/sandboxes/:id/agent/:sid/prompt", pxy)
		api.POST("/sandboxes/:id/agent/:sid/interrupt", pxy)
		api.POST("/sandboxes/:id/agent/:sid/kill", pxy)

		// Mounts (FUSE)
		api.POST("/sandboxes/:id/mounts", pxy)
		api.GET("/sandboxes/:id/mounts", pxy)
		api.DELETE("/sandboxes/:id/mounts", pxy)

		// PTY
		api.POST("/sandboxes/:id/pty", pxy)
		api.GET("/sandboxes/:id/pty/:sessionID", wsHandler)
		api.POST("/sandboxes/:id/pty/:sessionID/resize", pxy)
		api.DELETE("/sandboxes/:id/pty/:sessionID", pxy)

		// Timeout
		api.POST("/sandboxes/:id/timeout", pxy)

		// Token refresh
		api.POST("/sandboxes/:id/token/refresh", pxy)
	} else {
		// Combined/worker mode: handle locally
		api.POST("/sandboxes/:id/exec", s.createExecSession)
		api.GET("/sandboxes/:id/exec", s.listExecSessions)
		api.GET("/sandboxes/:id/exec/:sessionID", s.execSessionWebSocket)
		api.GET("/sandboxes/:id/exec/:sessionID/result", s.execResult)
		api.POST("/sandboxes/:id/exec/:sessionID/kill", s.killExecSession)
		api.POST("/sandboxes/:id/exec/run", s.execRun)
		api.POST("/sandboxes/:id/exec/run-async", s.execRunAsyncRoute)

		api.POST("/sandboxes/:id/agent", s.createAgentSession)
		api.GET("/sandboxes/:id/agent", s.listAgentSessions)
		api.POST("/sandboxes/:id/agent/:sid/prompt", s.sendAgentPrompt)
		api.POST("/sandboxes/:id/agent/:sid/interrupt", s.interruptAgent)
		api.POST("/sandboxes/:id/agent/:sid/kill", s.killAgentSession)

		api.GET("/sandboxes/:id/files", s.readFile)
		api.PUT("/sandboxes/:id/files", s.writeFile)
		api.GET("/sandboxes/:id/files/list", s.listDir)
		api.POST("/sandboxes/:id/files/mkdir", s.makeDir)
		api.DELETE("/sandboxes/:id/files", s.removeFile)

		api.POST("/sandboxes/:id/mounts", s.addMount)
		api.GET("/sandboxes/:id/mounts", s.listMounts)
		api.DELETE("/sandboxes/:id/mounts", s.removeMount)

		api.POST("/sandboxes/:id/pty", s.createPTY)
		api.GET("/sandboxes/:id/pty/:sessionID", s.ptyWebSocket)
		api.POST("/sandboxes/:id/pty/:sessionID/resize", s.resizePTY)
		api.DELETE("/sandboxes/:id/pty/:sessionID", s.killPTY)

		api.POST("/sandboxes/:id/timeout", s.setTimeout)
	}

	// Snapshots (pre-built declarative images)
	api.POST("/snapshots", s.createSnapshot)
	api.GET("/snapshots", s.listSnapshots)
	api.GET("/snapshots/:name", s.getSnapshot)
	api.DELETE("/snapshots/:name", s.deleteSnapshot)

	// Snapshot patches (resolve snapshot name → checkpoint, then delegate to checkpoint patch logic)
	api.POST("/snapshots/:name/patches", s.createSnapshotPatch)
	api.GET("/snapshots/:name/patches", s.listSnapshotPatches)
	api.DELETE("/snapshots/:name/patches/:patchId", s.deleteSnapshotPatch)

	// Publish/unpublish a named snapshot (owner-org only) so other orgs can fork
	// it — used to share the platform runtime/hands snapshots.
	api.POST("/snapshots/:name/publish", s.publishSnapshot)
	api.POST("/snapshots/:name/unpublish", s.unpublishSnapshot)

	// Images (all cached images, named or unnamed)
	api.GET("/images", s.listImages)

	// Image patches — by name or by ID
	api.POST("/images/:name/patches", s.createImagePatch)
	api.GET("/images/:name/patches", s.listImagePatches)
	api.DELETE("/images/:name/patches/:patchId", s.deleteImagePatch)

	// Secret stores
	api.POST("/secret-stores", s.createSecretStore)
	api.GET("/secret-stores", s.listSecretStores)
	api.GET("/secret-stores/:id", s.getSecretStore)
	api.PUT("/secret-stores/:id", s.updateSecretStore)
	api.DELETE("/secret-stores/:id", s.deleteSecretStore)

	// Secret store entries
	api.PUT("/secret-stores/:id/secrets/:name", s.setSecretEntry)
	api.DELETE("/secret-stores/:id/secrets/:name", s.deleteSecretEntry)
	api.GET("/secret-stores/:id/secrets", s.listSecretEntries)

	// Workers (server mode only — queries worker registry)
	api.GET("/workers", s.listWorkers)

	// Session history (requires PG)
	api.GET("/sessions", s.listSessions)

	// Dashboard authentication. WorkOS owns its OAuth routes; single-tenant
	// mode supplies one persistent local principal for trusted development
	// deployments. The dashboard routes themselves are provider-independent.
	var frontendURL string
	var dashboardAuth echo.MiddlewareFunc
	if opts != nil {
		workosConfigured := opts.WorkOSConfig != nil && opts.WorkOSConfig.APIKey != ""
		authMode := opts.DashboardAuthMode
		// Preserve existing deployments that configure WorkOS without the new
		// explicit mode.
		if authMode == "" && workosConfigured {
			authMode = "workos"
			s.dashboardAuthMode = authMode
		}

		switch authMode {
		case "workos":
			if workosConfigured {
				frontendURL = opts.WorkOSConfig.FrontendURL
				s.workos = auth.NewWorkOSMiddleware(*opts.WorkOSConfig, s.store)
				oauthHandlers := auth.NewOAuthHandlers(s.workos)
				e.GET("/auth/login", oauthHandlers.HandleLogin)
				e.GET("/auth/callback", oauthHandlers.HandleCallback)
				e.POST("/auth/logout", oauthHandlers.HandleLogout)
				dashboardAuth = s.workos.Middleware()
			}
		case "single-tenant":
			if opts.SingleTenantPrincipal != nil {
				dashboardAuth = auth.SingleTenantMiddleware(*opts.SingleTenantPrincipal)
			}
		}
	}

	if dashboardAuth != nil {
		dash := e.Group("/api/dashboard")
		dash.Use(dashboardAuth)

		dash.GET("/me", s.dashboardMe)
		// Direct dashboard creates are a self-hosted single-tenant convenience.
		// Hosted WorkOS deployments create through the Cloudflare edge, which
		// enforces global policy before calling /internal/sandboxes/create.
		if s.dashboardAuthMode == "single-tenant" {
			dash.POST("/sandboxes", s.createSandbox)
		}
		dash.GET("/sessions", s.dashboardSessions)
		dash.GET("/api-keys", s.dashboardListAPIKeys)
		dash.POST("/api-keys", s.dashboardCreateAPIKey)
		dash.DELETE("/api-keys/:keyId", s.dashboardDeleteAPIKey)
		dash.GET("/org", s.dashboardGetOrg)
		dash.PUT("/org", s.dashboardUpdateOrg)
		dash.PUT("/org/custom-domain", s.dashboardSetCustomDomain)
		dash.DELETE("/org/custom-domain", s.dashboardDeleteCustomDomain)
		dash.POST("/org/custom-domain/refresh", s.dashboardRefreshCustomDomain)
		dash.GET("/checkpoints", s.dashboardListCheckpoints)
		dash.DELETE("/checkpoints/:id", s.dashboardDeleteCheckpoint)
		dash.GET("/images", s.dashboardListImages)
		dash.DELETE("/images/:id", s.dashboardDeleteImage)
		dash.DELETE("/snapshots/:name", s.dashboardDeleteSnapshot)

		// Organization members and invitations
		dash.GET("/org/members", s.dashboardListOrgMembers)
		dash.DELETE("/org/members/:membershipId", s.dashboardRemoveMember)
		dash.POST("/org/invitations", s.dashboardSendInvitation)
		dash.GET("/org/invitations", s.dashboardListInvitations)
		dash.DELETE("/org/invitations/:id", s.dashboardRevokeInvitation)
		dash.GET("/orgs", s.dashboardListOrgs)
		dash.POST("/org/switch", s.dashboardSwitchOrg)
		dash.GET("/org/credits", s.dashboardGetCredits)

		// Billing
		dash.POST("/billing/setup", s.billingSetup)
		dash.GET("/billing", s.billingGet)
		dash.GET("/billing/invoices", s.billingInvoices)
		dash.POST("/billing/redeem", s.billingRedeem)
		dash.POST("/billing/portal", s.billingPortal)
		dash.GET("/billing/agent-subscriptions", s.dashboardListOrgAgentSubscriptions)

		// Admin endpoints

		// Agents — reverse-proxy to sessions-api. Mints short-lived identity
		// JWTs for the inbound (sessions-api) and downstream (OC API) hops so
		// no API key is needed end-to-end. CLI users bypass this and hit
		// sessions-api directly with X-API-Key.
		dash.Any("/agents", s.dashboardAgentsProxy)
		// Per-agent paywalled-feature subscriptions (telegram et al).
		// Mounted BEFORE the catch-all /agents/* proxy so they don't
		// get forwarded to sessions-api.
		dash.GET("/agents/:agentId/entitlements", s.dashboardListAgentEntitlements)
		dash.POST("/agents/:agentId/subscriptions/:feature", s.dashboardSubscribeAgentFeature)
		dash.DELETE("/agents/:agentId/subscriptions/:feature", s.dashboardCancelAgentFeature)

		dash.Any("/agents/*", s.dashboardAgentsProxy)

		// Session detail + stats
		dash.GET("/sessions/:sandboxId", s.dashboardGetSession)
		dash.GET("/sessions/:sandboxId/stats", s.dashboardGetSessionStats)
		dash.DELETE("/sessions/:sandboxId", s.dashboardDeleteSession)
		// Reset operations
		dash.POST("/sessions/:sandboxId/reboot", s.dashboardRebootSession)
		dash.POST("/sessions/:sandboxId/power-cycle", s.dashboardPowerCycleSession)
		// Sandbox session logs (SSE; historical + 1s-poll live tail).
		// Server queries Axiom server-side with a read-only token that
		// never reaches the browser. Org-ownership enforced via
		// GetSandboxSessionInOrg (404 on mismatch — no cross-org leak).
		dash.GET("/sessions/:sandboxId/logs", s.getSandboxLogs)
		// PTY (terminal)
		dash.POST("/sessions/:sandboxId/pty", s.dashboardCreatePTY)
		dash.GET("/sessions/:sandboxId/pty/:sessionId", s.dashboardPTYWebSocket)
		dash.POST("/sessions/:sandboxId/pty/:sessionId/resize", s.dashboardResizePTY)
		dash.DELETE("/sessions/:sandboxId/pty/:sessionId", s.dashboardKillPTY)
	}

	// Stripe webhook (public — verified by Stripe signature)
	if s.stripeClient != nil {
		e.POST("/webhooks/stripe", s.stripeWebhook)
	}

	// Auto-detect FrontendURL for dev: if web/dist doesn't exist, assume Vite dev on :3000
	if frontendURL == "" && !dashboardDistExists() {
		frontendURL = "http://localhost:3000"
		log.Println("opensandbox: web/dist/ not found, auto-setting FrontendURL=http://localhost:3000 (Vite dev)")
	}

	// Serve web dashboard SPA at root (catch-all after API/auth routes)
	s.serveDashboardUI(e, frontendURL)

	// The direct-exec MicroVM backend (OPENSANDBOX_MICROVM_LITE=1). Selected
	// INSTEAD of the agent-tunnel one below, never alongside it: both manufacture
	// boxes from the same image against the same regional quota, and two fillers
	// each believing they own the fleet would overrun it and starve each other.
	//
	// See lite_backend.go. The trade is total — no files, no hibernate, no
	// streaming — so this is a measurement configuration, not a default.
	if lite, err := newLiteBackend(context.Background()); err != nil {
		log.Fatalf("opensandbox: vmhost-lite backend: %v", err)
	} else if lite != nil {
		s.lite = lite
		s.registerBackend(lite)
		// Rebuild sandbox→box bindings before serving. A restart otherwise
		// leaves live sandboxes unroutable AND unreapable.
		lite.Restore(context.Background(), s.store)
		lite.StartReconciler(context.Background(), s.store)
		lite.StartUsageTicker(context.Background(), s.sandboxDBs)
		lite.StartEventPublisher(context.Background(), s.sandboxDBs, s.redisClient, s.cellID, s.store)
		if s.workerRegistry == nil || s.workersDisabled {
			lite.StartCapacityReporter(context.Background(), s.redisClient, s.cellID)
		}
	}

	// AWS Lambda MicroVM backend. Disabled by default: this returns nil and no
	// AWS call is ever made, so the QEMU fleet is unaffected. When it IS enabled
	// but misconfigured, fail loudly rather than silently serving QEMU from a
	// cell the operator believes is running MicroVMs.
	if mvm, err := newMicrovmBackend(context.Background(), s.checkpointStore); err != nil {
		log.Fatalf("opensandbox: microvm backend: %v", err)
	} else if mvm != nil {
		s.microvm = mvm
		// A reservation that dies unclaimed must wake anything parked on its
		// finalize — see THE FINALIZE RACE in edge_claim.go.
		mvm.onReservationLost = s.resolveEdgePending
		// Registering it is what makes every claim/route site find it. Before
		// this the sites each hardcoded their own check, and any new one
		// silently defaulted to the worker path.
		s.registerBackend(mvm)
		// Rebuild the sandbox→MicroVM map before serving. A restart otherwise
		// leaves live sandboxes unroutable and their boxes unreapable.
		mvm.Restore(context.Background(), s.store)
		// Nothing else will ever notice a MicroVM dying — no worker reports in
		// for these — so sweep on a ticker for the lifetime of the process.
		mvm.StartReconciler(context.Background(), s.store)
		// Billing: no worker exists to emit usage ticks for these sandboxes, so
		// the control plane emits them itself over the same interface.
		mvm.StartUsageTicker(context.Background(), s.sandboxDBs)
		// ...and drains them to the cell stream. The ticker alone writes to
		// local SQLite; without this half nothing ever reads it, and the
		// sandboxes run free while every log line says billing is working.
		mvm.StartEventPublisher(context.Background(), s.sandboxDBs, s.redisClient, s.cellID, s.store)
		// Release suspended boxes once their archive is durable. Without this a
		// hibernation holds regional memory quota — the ceiling on warm-pool
		// depth — for the whole life of the box rather than the 10 minutes it
		// is actually useful as a fast-wake cache.
		mvm.StartHibernationExpiry(context.Background(), s.store)
		// Capacity, but only when no registry-backed reporter is publishing it
		// already — two writers on one stream would alternate between MicroVM
		// depth and worker counts, flapping the cell in and out of the edge's
		// routing set. Keyed on workersDisabled rather than a nil registry: a
		// MicroVM cell in server mode still HAS a registry (worker_id lookups,
		// lifecycle publishing), it just never has workers in it, and gating on
		// the registry left the worker-counting reporter running to publish
		// available_workers=0 forever.
		if s.workerRegistry == nil || s.workersDisabled {
			mvm.StartCapacityReporter(context.Background(), s.redisClient, s.cellID)
		}
	}

	// The QEMU fleet, registered last so it is the fall-through rather than the
	// preference: a cell running both serves creates from the backend that holds
	// its own warm stock, and reaches the fleet only when that one declines.
	//
	// Registration order is placement policy — claimBackend takes the first
	// Placer — so moving this line changes which runtime serves every create.
	if wb := newWorkerBackend(s.workerRegistry); wb != nil && !s.workersDisabled {
		s.registerBackend(wb)
	}

	return s
}

// dashboardDistExists checks if the built web dashboard exists.
func dashboardDistExists() bool {
	if _, err := os.Stat("web/dist/index.html"); err == nil {
		return true
	}
	execPath, _ := os.Executable()
	distIndex := filepath.Join(filepath.Dir(execPath), "web", "dist", "index.html")
	if _, err := os.Stat(distIndex); err == nil {
		return true
	}
	return false
}

// serveDashboardUI serves the web dashboard SPA from web/dist/ at the root path.
// All unmatched routes fall through to the SPA (client-side routing).
func (s *Server) serveDashboardUI(e *echo.Echo, frontendURL string) {
	// Look for web/dist relative to the working directory
	distDir := "web/dist"
	if _, err := os.Stat(distDir); err != nil {
		execPath, _ := os.Executable()
		distDir = filepath.Join(filepath.Dir(execPath), "web", "dist")
	}

	if _, err := os.Stat(distDir); err == nil {
		// Production: serve built static files at root
		fsys := os.DirFS(distDir)
		fileServer := http.FileServer(http.FS(fsys))

		spaHandler := echo.WrapHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			if path == "" || path == "/" {
				http.ServeFileFS(w, r, fsys, "index.html")
				return
			}

			// Serve static asset if it exists
			if f, err := fs.Stat(fsys, strings.TrimPrefix(path, "/")); err == nil && !f.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}

			// SPA fallback — serve index.html for client-side routes
			http.ServeFileFS(w, r, fsys, "index.html")
		}))

		e.GET("/*", spaHandler)
		return
	}

	// Dev mode: proxy to the Vite dev server
	e.GET("/*", func(c echo.Context) error {
		if frontendURL != "" {
			target := frontendURL + c.Request().URL.Path
			return c.Redirect(http.StatusFound, target)
		}
		return c.HTML(http.StatusOK, `<!DOCTYPE html>
<html><head><title>OpenSandbox</title></head><body style="font-family:sans-serif;padding:40px;text-align:center">
<h1>Dashboard not built</h1>
<p>Run <code>cd web && npm run build</code> or start Vite dev: <code>cd web && npm run dev</code></p>
</body></html>`)
	})
}

// Start starts the HTTP server on the given address.
// SetReady marks the server as ready to accept traffic.
func (s *Server) SetReady() {
	atomic.StoreInt32(&s.ready, 1)
}

// SetNotReady marks the server as not ready (draining).
func (s *Server) SetNotReady() {
	atomic.StoreInt32(&s.ready, 0)
}

// readinessCheck verifies the server can serve requests (DB + Redis reachable).
func (s *Server) readinessCheck(c echo.Context) error {
	if atomic.LoadInt32(&s.ready) == 0 {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"status": "not ready",
			"reason": "server is draining or starting up",
		})
	}

	result := map[string]string{"status": "ready"}
	ctx, cancel := context.WithTimeout(c.Request().Context(), 2*time.Second)
	defer cancel()

	if s.store != nil {
		if err := s.store.Ping(ctx); err != nil {
			result["status"] = "not ready"
			result["postgres"] = err.Error()
			return c.JSON(http.StatusServiceUnavailable, result)
		}
		result["postgres"] = "ok"
	}

	if s.redisClient != nil {
		if err := s.redisClient.Ping(ctx).Err(); err != nil {
			result["status"] = "not ready"
			result["redis"] = err.Error()
			return c.JSON(http.StatusServiceUnavailable, result)
		}
		result["redis"] = "ok"
	}

	return c.JSON(http.StatusOK, result)
}

func (s *Server) Start(addr string) error {
	return s.echo.Start(addr)
}

// Shutdown gracefully drains in-flight requests and stops the server.
func (s *Server) Shutdown(ctx context.Context) error {
	// Drain every backend before the HTTP server goes away. Warm stock we
	// abandon keeps billing compute and holding capacity until its lifetime
	// cap, so a redeploying control plane would leak a full pool per rollout.
	s.closeBackends()
	return s.echo.Shutdown(ctx)
}

// Close immediately shuts down the server (no drain).
func (s *Server) Close() error {
	s.closeBackends()
	return s.echo.Close()
}

// closeBackends releases every registered runtime. Iterating the registry
// rather than naming one is the point: a backend added later is drained without
// anyone remembering to add a line here.
func (s *Server) closeBackends() {
	for _, b := range s.backends {
		b.Close()
	}
}

// Echo returns the underlying echo instance for reuse (e.g., worker HTTP server).
func (s *Server) Echo() *echo.Echo {
	return s.echo
}
