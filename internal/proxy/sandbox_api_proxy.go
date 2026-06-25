package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/redis/go-redis/v9"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// SandboxAPIProxy proxies data-plane HTTP/WebSocket requests from the control
// plane to the worker that owns the sandbox. This enables ALB-based TLS
// termination: clients talk to the control plane through the ALB, and the
// control plane forwards exec/files/pty/agent requests to workers over the
// internal VPC network.
// proxyRouteCache caches the sandbox→worker mapping + JWT in Redis to avoid
// DB lookups and JWT minting on every proxied request. Shared across HA control planes.
type proxyRouteCache struct {
	rdb *redis.Client // nil = caching disabled (combined/dev mode)
}

type routeCacheEntry struct {
	WorkerURL string `json:"u"`
	WorkerID  string `json:"w"`
	Token     string `json:"t"`
}

const routeCacheTTL = 3 * time.Second

func newProxyRouteCache(rdb *redis.Client) *proxyRouteCache {
	return &proxyRouteCache{rdb: rdb}
}

func (c *proxyRouteCache) get(sandboxID string) (workerURL, workerID, token string, ok bool) {
	if c.rdb == nil {
		return "", "", "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	val, err := c.rdb.Get(ctx, "routecache:"+sandboxID).Bytes()
	if err != nil {
		return "", "", "", false
	}
	var e routeCacheEntry
	if err := json.Unmarshal(val, &e); err != nil {
		return "", "", "", false
	}
	return e.WorkerURL, e.WorkerID, e.Token, true
}

func (c *proxyRouteCache) set(sandboxID, workerURL, workerID, token string) {
	if c.rdb == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	data, _ := json.Marshal(routeCacheEntry{WorkerURL: workerURL, WorkerID: workerID, Token: token})
	c.rdb.Set(ctx, "routecache:"+sandboxID, data, routeCacheTTL)
}

func (c *proxyRouteCache) invalidate(sandboxID string) {
	if c.rdb == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c.rdb.Del(ctx, "routecache:"+sandboxID)
}

// SandboxAPIProxy proxies data-plane HTTP/WebSocket requests from the control
// plane to the worker that owns the sandbox.
type SandboxAPIProxy struct {
	store        *db.Store
	registry     *controlplane.RedisWorkerRegistry
	jwtIssuer    *auth.JWTIssuer
	transport    *http.Transport      // shared connection pool for all proxy requests
	routeCache   *proxyRouteCache     // sandbox→worker cache to avoid DB lookup per request
	waitForReady func(ctx context.Context, sandboxID string) error // blocks until async sandbox creation completes; nil = no-op
}

// NewSandboxAPIProxy creates a new sandbox API proxy.
func NewSandboxAPIProxy(store *db.Store, registry *controlplane.RedisWorkerRegistry, jwtIssuer *auth.JWTIssuer) *SandboxAPIProxy {
	return &SandboxAPIProxy{
		store:      store,
		registry:   registry,
		jwtIssuer:  jwtIssuer,
		routeCache: newProxyRouteCache(registry.RedisClient()),
		// Shared transport with connection pooling — creating a new Transport per request
		// exhausts ephemeral ports under load and causes 502s.
		transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   5 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ResponseHeaderTimeout: 600 * time.Second,
			MaxIdleConns:          200,
			MaxIdleConnsPerHost:   50,
			MaxConnsPerHost:       100,
			IdleConnTimeout:       120 * time.Second,
		},
	}
}

// SetWaitForReady sets a callback that blocks until an async sandbox creation
// completes. The proxy calls this before forwarding requests to avoid proxying
// to a worker that hasn't finished booting the sandbox yet.
func (p *SandboxAPIProxy) SetWaitForReady(fn func(ctx context.Context, sandboxID string) error) {
	p.waitForReady = fn
}

// ResolvedRoute is the output of ResolveWorker: the worker's HTTP base
// URL, its registered worker ID, and a fresh short-TTL sandbox JWT to
// hand the worker on this request. Used by callers that need to do
// their own transport (e.g. the WebSocket broker) but want the same
// auth + routing logic as the proxy.
type ResolvedRoute struct {
	WorkerURL string
	WorkerID  string
	Token     string
}

// ResolveWorker performs the same lookup as ProxyHandler — waits for
// async creation, rejects migrating, wakes hibernated, returns 404/410
// equivalents — but instead of forwarding the request, returns the
// resolved worker URL + token to the caller. Used by the WebSocket
// broker (internal/wsgateway) which manages its own dialing.
//
// Errors are echo HTTP errors with the same status codes ProxyHandler
// would return, so the caller can `return err` from a route handler and
// get the right client-facing response.
func (p *SandboxAPIProxy) ResolveWorker(c echo.Context, sandboxID string) (*ResolvedRoute, error) {
	if sandboxID == "" {
		return nil, echo.NewHTTPError(http.StatusBadRequest, "sandbox ID required")
	}
	ctx := c.Request().Context()

	if workerURL, workerID, token, ok := p.routeCache.get(sandboxID); ok {
		return &ResolvedRoute{WorkerURL: workerURL, WorkerID: workerID, Token: token}, nil
	}

	if p.waitForReady != nil {
		if err := p.waitForReady(ctx, sandboxID); err != nil {
			return nil, echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("sandbox %s: creation failed: %v", sandboxID, err))
		}
	}

	session, err := p.store.GetSandboxSession(ctx, sandboxID)
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, fmt.Sprintf("sandbox %s not found", sandboxID))
	}
	if session.Status == "migrating" {
		return nil, echo.NewHTTPError(http.StatusServiceUnavailable, fmt.Sprintf("sandbox %s is migrating, retry shortly", sandboxID))
	}
	if session.Status == "hibernated" {
		worker, workerURL, err := p.wakeHibernatedSandbox(ctx, sandboxID)
		if err != nil {
			return nil, echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("sandbox %s: failed to wake: %v", sandboxID, err))
		}
		token := p.mintToken(c, sandboxID, worker.ID)
		p.routeCache.set(sandboxID, workerURL, worker.ID, token)
		return &ResolvedRoute{WorkerURL: workerURL, WorkerID: worker.ID, Token: token}, nil
	}
	if session.Status == "stopped" || session.Status == "error" {
		return nil, echo.NewHTTPError(http.StatusGone, fmt.Sprintf("sandbox %s has been stopped", sandboxID))
	}

	worker := p.registry.GetWorker(session.WorkerID)
	if worker == nil {
		// Worker disappeared. Same recover-from-hibernation path the proxy uses,
		// but we don't have a request to forward here so just surface the error.
		return nil, echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("worker %s unavailable", session.WorkerID))
	}
	if worker.HTTPAddr == "" {
		return nil, echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("worker %s has no HTTP address", session.WorkerID))
	}
	token := p.mintToken(c, sandboxID, session.WorkerID)
	p.routeCache.set(sandboxID, worker.HTTPAddr, session.WorkerID, token)
	return &ResolvedRoute{WorkerURL: worker.HTTPAddr, WorkerID: session.WorkerID, Token: token}, nil
}

// mintToken issues the same 5-minute sandbox JWT the proxy's forward()
// path uses. Returns empty string if no jwtIssuer is configured (legacy
// dev mode) — workers then accept anonymous in dev.
func (p *SandboxAPIProxy) mintToken(c echo.Context, sandboxID, workerID string) string {
	if p.jwtIssuer == nil {
		return ""
	}
	orgID, _ := auth.GetOrgID(c)
	t, err := p.jwtIssuer.IssueSandboxToken(orgID, sandboxID, workerID, 5*time.Minute)
	if err != nil {
		return ""
	}
	return t
}

// InvalidateRouteCache removes a sandbox from the proxy route cache.
// Call this on hibernate, kill, or any event that changes the sandbox→worker mapping.
func (p *SandboxAPIProxy) InvalidateRouteCache(sandboxID string) {
	if p.routeCache != nil {
		p.routeCache.invalidate(sandboxID)
	}
}

// ProxyHandler forwards requests for a sandbox to the worker that owns it.
// Uses a short-TTL cache to avoid DB + Redis lookups on every request.
func (p *SandboxAPIProxy) ProxyHandler(c echo.Context) error {
	sandboxID := c.Param("id")
	if sandboxID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "sandbox ID required",
		})
	}

	ctx := c.Request().Context()

	// Fast path: check route cache (avoids DB + Redis + JWT mint)
	if workerURL, workerID, token, ok := p.routeCache.get(sandboxID); ok {
		return p.forwardWithToken(c, sandboxID, workerURL, workerID, token)
	}

	// If this sandbox is still being created asynchronously, wait for it.
	if p.waitForReady != nil {
		if err := p.waitForReady(ctx, sandboxID); err != nil {
			return c.JSON(http.StatusBadGateway, map[string]string{
				"error": fmt.Sprintf("sandbox %s: creation failed: %v", sandboxID, err),
			})
		}
	}

	// Look up which worker owns this sandbox
	session, err := p.store.GetSandboxSession(ctx, sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("sandbox %s not found", sandboxID),
		})
	}

	// If migrating, reject requests until migration completes
	if session.Status == "migrating" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": fmt.Sprintf("sandbox %s is migrating, retry shortly", sandboxID),
		})
	}

	// If hibernated, wake on demand.
	if session.Status == "hibernated" {
		// Async exec path (POST /exec/run, GET …/result): never hold the
		// connection on the restore — a large cold checkpoint can exceed
		// Cloudflare's 100s and 524. Claim a worker (atomic CAS) and forward
		// immediately; the worker's execRun returns a handle right away and
		// self-restores in the background (router doWake), off the connection.
		// /result is DB-routed to that worker, so this is correct across
		// multiple control planes. Other (synchronous) ops keep the inline wake.
		if isAsyncExecPath(c) {
			workerURL, workerID, err := p.claimWorkerForAsyncWake(ctx, sandboxID)
			if err != nil {
				log.Printf("sandbox-api-proxy: async-wake claim failed for sandbox %s: %v", sandboxID, err)
				return c.JSON(http.StatusBadGateway, map[string]string{
					"error": fmt.Sprintf("sandbox %s: failed to wake: %v", sandboxID, err),
				})
			}
			return p.forward(c, sandboxID, workerURL, workerID)
		}
		// File ops are synchronous (the caller wants the bytes/result now) so
		// handle+poll doesn't apply, but a cold restore can exceed Cloudflare's
		// 100s → 524 (or the 90s WakeSandbox cap → 502). Instead of restoring
		// on the connection, kick the wake to the background and return 503
		// "waking" + Retry-After; the SDK retries and the warm retry proxies
		// normally (the restore flips the DB status to running). Wake is deduped
		// across control planes via a Redis lock so we never double-restore.
		if isFilesPath(c) {
			p.startBackgroundWake(sandboxID)
			c.Response().Header().Set("Retry-After", "1")
			return c.JSON(http.StatusServiceUnavailable, map[string]any{
				"error":  fmt.Sprintf("sandbox %s is waking", sandboxID),
				"waking": true,
			})
		}
		worker, workerURL, err := p.wakeHibernatedSandbox(ctx, sandboxID)
		if err != nil {
			log.Printf("sandbox-api-proxy: wake-on-request failed for sandbox %s: %v", sandboxID, err)
			return c.JSON(http.StatusBadGateway, map[string]string{
				"error": fmt.Sprintf("sandbox %s: failed to wake: %v", sandboxID, err),
			})
		}
		log.Printf("sandbox-api-proxy: wake-on-request succeeded for sandbox %s → worker %s (%s)", sandboxID, worker.ID, workerURL)
		return p.forward(c, sandboxID, workerURL, session.WorkerID)
	}

	if session.Status == "stopped" || session.Status == "error" {
		return c.JSON(http.StatusGone, map[string]string{
			"error": fmt.Sprintf("sandbox %s has been stopped", sandboxID),
		})
	}

	// Look up worker address
	worker := p.registry.GetWorker(session.WorkerID)
	if worker == nil {
		// Worker gone — try to recover from hibernation checkpoint
		return p.tryRecoverOrFail(c, ctx, sandboxID, session)
	}

	if worker.HTTPAddr == "" {
		return c.JSON(http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("worker %s has no HTTP address", session.WorkerID),
		})
	}

	return p.forward(c, sandboxID, worker.HTTPAddr, session.WorkerID)
}

// isAsyncExecPath reports whether the request is part of the async exec/run
// flow (the POST that dispatches, or a /result poll). Those tolerate a 503
// "waking" + retry, so we never hold their connection on a restore. Everything
// else keeps the inline synchronous wake.
func isAsyncExecPath(c echo.Context) bool {
	p := c.Request().URL.Path
	m := c.Request().Method
	return (m == http.MethodPost && strings.HasSuffix(p, "/exec/run")) ||
		(m == http.MethodGet && strings.HasSuffix(p, "/result"))
}

// isFilesPath reports whether the request targets the filesystem API
// (read/write/list/mkdir/remove, including the signed download/upload variants
// that re-enter via the proxy). These are synchronous ops that tolerate a 503
// "waking" + client retry, so we never restore on their connection.
func isFilesPath(c echo.Context) bool {
	return strings.Contains(c.Request().URL.Path, "/files")
}

// startBackgroundWake restores a hibernated sandbox off the request connection.
// Deduped across control planes via a Redis SETNX lock (120s TTL) so a burst of
// 503-driven client retries — which the edge may spread across CP instances —
// triggers exactly one restore (no split-brain double-restore). The restore
// flips the DB status to running on success, so subsequent retries proxy
// normally; on failure the lock is released so a later retry can try again.
func (p *SandboxAPIProxy) startBackgroundWake(sandboxID string) {
	key := "sandbox:waking:" + sandboxID
	rdb := p.registry.RedisClient()
	if rdb != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		won, err := rdb.SetNX(ctx, key, "1", 120*time.Second).Result()
		cancel()
		if err == nil && !won {
			return // another control plane already owns this wake
		}
		// err != nil → Redis hiccup; fall through and wake best-effort.
	}
	go func() {
		t0 := time.Now()
		_, _, err := p.wakeHibernatedSandbox(context.Background(), sandboxID)
		slog.Info("files_async_wake", "sandbox", sandboxID,
			"wake_ms", time.Since(t0).Milliseconds(), "ok", err == nil)
		if err != nil {
			log.Printf("sandbox-api-proxy: background wake failed for sandbox %s: %v", sandboxID, err)
		}
		if rdb != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = rdb.Del(dctx, key).Err()
			dcancel()
		}
	}()
}

// claimWorkerForAsyncWake atomically assigns a hibernated sandbox to a worker
// and returns that worker's address — WITHOUT performing the restore. The
// restore happens lazily on the worker (its execRun → router doWake) so it
// stays off the connection.
//
// Multi-CP safe: UpdateSandboxSessionForWake is a compare-and-swap
// (UPDATE … WHERE status='hibernated'), so if several control planes race only
// the first flips the row. We then RE-READ the session and forward to whatever
// worker actually won the claim — so every racing CP converges on the same
// worker and the box restores exactly once (the worker's router + manager.Wake
// singleflight dedup any remaining concurrency).
func (p *SandboxAPIProxy) claimWorkerForAsyncWake(ctx context.Context, sandboxID string) (string, string, error) {
	checkpoint, err := p.store.GetActiveHibernation(ctx, sandboxID)
	if err != nil {
		return "", "", fmt.Errorf("no active hibernation: %w", err)
	}
	candidate, _, err := p.registry.GetLeastLoadedWorker(checkpoint.Region)
	if err != nil {
		return "", "", fmt.Errorf("no workers available in region %s: %w", checkpoint.Region, err)
	}
	// CAS claim (no-ops if another CP already flipped the row).
	if err := p.store.UpdateSandboxSessionForWake(ctx, sandboxID, candidate.ID); err != nil {
		return "", "", fmt.Errorf("claim worker for wake: %w", err)
	}
	// Authoritative re-read: forward to whoever actually won the claim.
	sess, err := p.store.GetSandboxSession(ctx, sandboxID)
	if err != nil {
		return "", "", fmt.Errorf("re-read session after claim: %w", err)
	}
	w := p.registry.GetWorker(sess.WorkerID)
	if w == nil || w.HTTPAddr == "" {
		return "", "", fmt.Errorf("claimed worker %s unavailable", sess.WorkerID)
	}
	log.Printf("sandbox-api-proxy: async-wake claim for sandbox %s → worker %s (%s), worker will restore lazily", sandboxID, sess.WorkerID, w.HTTPAddr)
	return w.HTTPAddr, sess.WorkerID, nil
}

// forward proxies the request to the worker, mints a JWT, caches the route.
func (p *SandboxAPIProxy) forward(c echo.Context, sandboxID, workerURL, workerID string) error {
	token := ""
	if p.jwtIssuer != nil {
		orgID, _ := auth.GetOrgID(c)
		t, err := p.jwtIssuer.IssueSandboxToken(orgID, sandboxID, workerID, 5*time.Minute)
		if err == nil {
			token = t
		}
	}

	// Cache the route for subsequent requests to the same sandbox
	p.routeCache.set(sandboxID, workerURL, workerID, token)

	return p.forwardWithToken(c, sandboxID, workerURL, workerID, token)
}

// forwardWithToken proxies the request using a pre-resolved worker URL and JWT.
func (p *SandboxAPIProxy) forwardWithToken(c echo.Context, sandboxID, workerURL, workerID, token string) error {
	if isWebSocketUpgrade(c.Request()) {
		return p.doWebSocket(c, sandboxID, workerURL, token)
	}
	return p.doHTTP(c, sandboxID, workerURL, token)
}

// doHTTP reverse-proxies a normal HTTP request to the worker.
// Streams the response directly to the client without buffering, enabling
// large file downloads via signed URLs.
func (p *SandboxAPIProxy) doHTTP(c echo.Context, sandboxID, workerURL, token string) error {
	target, err := url.Parse(workerURL)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{
			"error": "invalid worker URL",
		})
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1    // flush chunks immediately
	proxy.Transport = p.transport // shared connection pool — avoids ephemeral port exhaustion

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("sandbox-api-proxy: error proxying sandbox %s to %s: %v", sandboxID, workerURL, err)
		// Invalidate cache — worker may have moved or restarted
		p.routeCache.invalidate(sandboxID)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"error":"sandbox %s: upstream unavailable"}`, sandboxID)
	}

	// Rewrite request to target worker, preserving the original path
	proxy.Director = func(r *http.Request) {
		r.URL.Scheme = target.Scheme
		r.URL.Host = target.Host
		// Path is already correct (/sandboxes/:id/...)
		// Remove the /api prefix — worker routes don't have it
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api")
		r.URL.RawQuery = c.Request().URL.RawQuery
		r.Host = target.Host

		// Forward X-Request-Id so worker log lines share the same id as the
		// control plane log line for this request. Echo's middleware.RequestID
		// on the worker side reuses the inbound header if present.
		if rid := c.Request().Header.Get(echo.HeaderXRequestID); rid != "" {
			r.Header.Set(echo.HeaderXRequestID, rid)
		}

		// Set sandbox JWT auth for the worker
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
	}

	// Serve directly to the client ResponseWriter — no buffering
	proxy.ServeHTTP(c.Response().Writer, c.Request())
	return nil
}

// doWebSocket hijacks the connection and pipes it to the worker.
func (p *SandboxAPIProxy) doWebSocket(c echo.Context, sandboxID, workerURL, token string) error {
	target, err := url.Parse(workerURL)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "invalid worker URL"})
	}

	// Connect to the worker
	workerAddr := target.Host
	if !strings.Contains(workerAddr, ":") {
		if target.Scheme == "https" {
			workerAddr += ":443"
		} else {
			workerAddr += ":80"
		}
	}

	upstream, err := net.DialTimeout("tcp", workerAddr, 5*time.Second)
	if err != nil {
		log.Printf("sandbox-api-proxy: websocket dial failed for sandbox %s (%s): %v", sandboxID, workerAddr, err)
		return c.JSON(http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("sandbox %s: upstream unavailable", sandboxID),
		})
	}
	defer upstream.Close()

	// Hijack client connection
	hijacker, ok := c.Response().Writer.(http.Hijacker)
	if !ok {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "websocket hijack not supported",
		})
	}

	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		log.Printf("sandbox-api-proxy: websocket hijack failed for sandbox %s: %v", sandboxID, err)
		return err
	}
	defer clientConn.Close()

	// Modify the request: strip /api prefix and inject JWT auth
	req := c.Request()
	req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api")
	req.Host = target.Host
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	// Forward the modified request to the upstream worker
	if err := req.Write(upstream); err != nil {
		log.Printf("sandbox-api-proxy: websocket write request failed for sandbox %s: %v", sandboxID, err)
		return nil
	}

	// Flush any buffered client data
	if clientBuf.Reader.Buffered() > 0 {
		buffered := make([]byte, clientBuf.Reader.Buffered())
		n, _ := clientBuf.Read(buffered)
		if n > 0 {
			upstream.Write(buffered[:n])
		}
	}

	// Bidirectional pipe
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		io.Copy(clientConn, upstream)
		if tc, ok := clientConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()

	go func() {
		defer wg.Done()
		io.Copy(upstream, clientConn)
		if tc, ok := upstream.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()

	wg.Wait()
	return nil
}

// tryRecoverOrFail handles the case where a sandbox's worker is gone.
func (p *SandboxAPIProxy) tryRecoverOrFail(c echo.Context, ctx context.Context, sandboxID string, session *db.SandboxSession) error {
	// If the sandbox is mid-migration, don't mark it stopped — the controlplane
	// is about to update the worker_id. Return a temporary error so the client retries.
	if session.MigratingToWorker != "" {
		log.Printf("sandbox-api-proxy: sandbox %s is migrating to %s, returning temporary unavailable", sandboxID, session.MigratingToWorker)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": fmt.Sprintf("sandbox %s is being migrated, retry shortly", sandboxID),
		})
	}

	checkpoint, err := p.store.GetActiveHibernation(ctx, sandboxID)
	if err == nil && checkpoint != nil {
		log.Printf("sandbox-api-proxy: sandbox %s has active hibernation, attempting recovery wake", sandboxID)
		worker, workerURL, err := p.wakeHibernatedSandbox(ctx, sandboxID)
		if err != nil {
			log.Printf("sandbox-api-proxy: recovery wake failed for sandbox %s: %v", sandboxID, err)
			return c.JSON(http.StatusBadGateway, map[string]string{
				"error": fmt.Sprintf("sandbox %s: worker unavailable", sandboxID),
			})
		}

		log.Printf("sandbox-api-proxy: recovery wake succeeded for sandbox %s → worker %s (%s)", sandboxID, worker.ID, workerURL)
		return p.forward(c, sandboxID, workerURL, worker.ID)
	}

	// No hibernation — sandbox is truly gone
	log.Printf("sandbox-api-proxy: sandbox %s has no hibernation and worker is gone, marking stopped", sandboxID)
	errMsg := "worker lost, sandbox not recoverable"
	_ = p.store.UpdateSandboxSessionStatus(ctx, sandboxID, "stopped", &errMsg)

	return c.JSON(http.StatusGone, map[string]string{
		"error": fmt.Sprintf("sandbox %s is no longer available (worker was lost)", sandboxID),
	})
}

// wakeHibernatedSandbox wakes a hibernated sandbox on the least loaded worker.
func (p *SandboxAPIProxy) wakeHibernatedSandbox(ctx context.Context, sandboxID string) (*controlplane.WorkerEntry, string, error) {
	checkpoint, err := p.store.GetActiveHibernation(ctx, sandboxID)
	if err != nil {
		return nil, "", fmt.Errorf("no active hibernation: %w", err)
	}

	region := checkpoint.Region
	worker, grpcClient, err := p.registry.GetLeastLoadedWorker(region)
	if err != nil {
		return nil, "", fmt.Errorf("no workers available in region %s: %w", region, err)
	}

	log.Printf("sandbox-api-proxy: waking sandbox %s on worker %s (region=%s)", sandboxID, worker.ID, region)

	grpcCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	_, err = grpcClient.WakeSandbox(grpcCtx, &pb.WakeSandboxRequest{
		SandboxId:     sandboxID,
		CheckpointKey: checkpoint.HibernationKey,
		Timeout:       300,
	})
	if err != nil {
		return nil, "", fmt.Errorf("gRPC WakeSandbox failed: %w", err)
	}

	_ = p.store.MarkHibernationRestored(ctx, sandboxID)
	_ = p.store.UpdateSandboxSessionForWake(ctx, sandboxID, worker.ID)
	if worker.GoldenVersion != "" {
		_ = p.store.SetSandboxGoldenVersion(ctx, sandboxID, worker.GoldenVersion)
	}

	if worker.HTTPAddr == "" {
		return nil, "", fmt.Errorf("worker %s has no HTTP address", worker.ID)
	}

	return worker, worker.HTTPAddr, nil
}
