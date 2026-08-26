package awsvm

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/opensandbox/opensandbox/internal/wsconn"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// agent.go — talking to osb-agent inside a MicroVM.
//
// This is the load-bearing assumption of the whole backend. In the QEMU world
// the host reaches the agent over a private virtio-serial/vsock channel it owns
// end to end. Here there is no host: the only way in is Lambda's public HTTPS
// endpoint for that MicroVM, which proxies to a guest port when the request
// carries a JWE in X-aws-proxy-auth and the port in X-aws-proxy-port.
//
// Plain gRPC over that proxy does NOT work, and this is the file where that was
// found. The proxy speaks HTTP/2, but it strips HTTP/2 trailers — and gRPC
// delivers grpc-status in trailers. The result is the worst possible failure
// mode: the RPC reaches the agent, the command runs in the guest, and the client
// then reports "server closed the stream without sending trailers" with no
// result. Confirmed by round-tripping an unannounced trailer through the proxy
// (lost) versus the same exchange against a local Go server (preserved), so it
// is the platform and not our stack.
//
// Two further constraints found the same way, both load-bearing:
//   - The proxy forwards ONLY to the port declared in the image's hook config.
//     A second listener is unreachable: gRPC to the agent's own port returned
//     502 while the identical call to the declared port was answered.
//   - Requests do arrive intact in every other respect, and WebSockets pass
//     through cleanly, which is what makes the tunnel below possible.
//
// So the agent protocol IS reused unchanged — every RPC, streaming included —
// but carried inside a WebSocket where the proxy cannot see or discard the
// trailers. The token comes from a provider function rather than a fixed string
// because tokens expire after at most 60 minutes and a long-lived sandbox will
// outlive several of them.

// tokenProvider returns a currently-valid JWE for a MicroVM. Called on every
// RPC, so it must be cheap on the hit path (Client.AuthToken caches).
type tokenProvider func(ctx context.Context) (string, error)

// agentConn is one MicroVM's agent channel.
type agentConn struct {
	conn   *grpc.ClientConn
	client pb.SandboxAgentClient
}

// agentTunnelPath is the guest WebSocket endpoint carrying gRPC. Must match
// cmd/microvm-hooks.
const agentTunnelPath = "/osb/agent-grpc"

// AgentTunnelPath exposes the tunnel path to callers outside this package that
// dial the same endpoint themselves — see Manager.DirectInfo.
const AgentTunnelPath = agentTunnelPath

// dialAgent opens a gRPC channel to the agent behind a MicroVM endpoint.
//
// The channel runs over a WebSocket rather than straight HTTP/2, because
// Lambda's proxy strips HTTP/2 trailers and gRPC carries its status there — so
// direct gRPC executes the command in the guest and then loses the result.
// Inside a WebSocket the proxy forwards opaque frames and the gRPC stream,
// trailers included, survives untouched. See internal/wsconn.
//
// Deliberately NOT grpc.WithBlock(): the endpoint is a public TLS service that
// may be mid-resume, and blocking here would put connection setup on the
// caller's critical path. gRPC connects lazily on the first RPC, and if the box
// is suspended, Lambda holds that request while it auto-resumes.
// holdIdle selects the keepalive contract for a channel, and the two callers
// want opposite things from it.
//
// A CUSTOMER sandbox should be allowed to fall idle and suspend — that is how
// this backend stops billing compute for a box nobody is using — so its channel
// must not ping when there are no active RPCs.
//
// POOL STOCK is the exact inverse: the pool's whole job is to keep a box warm
// and reachable so the first exec doesn't pay a handshake, and it pays for that
// on purpose. With PermitWithoutStream false, a stocked channel emits nothing
// between the pool's 30s application pings, so a transport that dies in between
// is discovered only by a ping that then has to rebuild it inside pingTimeout
// (3s) — which is far less than a WebSocket upgrade plus guest attach. Two of
// those in a row retire the channel, and gRPC's reconnect backoff climbs toward
// ~2 minutes, so the box stays cold. Measured consequence: 96% of edge reserves
// found warm_tunnel=false despite every box having been dialled successfully at
// manufacture (7456 launches, zero pre-dial failures).
type holdIdle bool

const (
	idleMaySuspend holdIdle = false // customer sandboxes
	idleKeepWarm   holdIdle = true  // pool stock
)

func dialAgent(endpoint string, port int32, token tokenProvider, hold holdIdle) (*agentConn, error) {
	if endpoint == "" {
		return nil, fmt.Errorf("awsvm: empty MicroVM endpoint")
	}
	host := hostOnly(endpoint)

	// The proxy authenticates the WebSocket handshake, so the auth headers ride
	// on the upgrade rather than on each RPC. Per-RPC metadata would never be
	// seen by the proxy at all — it only sees the opaque tunnel.
	dialTunnel := func(ctx context.Context, _ string) (net.Conn, error) {
		v, err := token(ctx)
		if err != nil {
			return nil, fmt.Errorf("awsvm: auth token: %w", err)
		}
		hdr := http.Header{}
		hdr.Set("X-aws-proxy-auth", v)
		hdr.Set("X-aws-proxy-port", fmt.Sprintf("%d", port))

		d := &websocket.Dialer{
			HandshakeTimeout: 20 * time.Second,
			TLSClientConfig:  &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12},
			ReadBufferSize:   64 * 1024,
			WriteBufferSize:  64 * 1024,
		}
		ws, resp, err := d.DialContext(ctx, "wss://"+host+agentTunnelPath, hdr)
		if err != nil {
			if resp != nil {
				return nil, fmt.Errorf("awsvm: agent tunnel handshake to %s (http %d): %w", host, resp.StatusCode, err)
			}
			return nil, fmt.Errorf("awsvm: agent tunnel handshake to %s: %w", host, err)
		}
		return wsconn.New(ws), nil
	}

	conn, err := grpc.NewClient(host+":443",
		// The tunnel already runs over TLS to the proxy; inside it we speak
		// cleartext HTTP/2 to the guest's loopback agent.
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(dialTunnel),
		// The guest can return large file reads; match the QEMU path's ceiling
		// so behaviour doesn't silently differ between backends.
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(256*1024*1024),
			grpc.MaxCallSendMsgSize(256*1024*1024),
		),
		// See holdIdle: pool stock keeps its transport alive between pings,
		// customer sandboxes are allowed to fall idle and suspend.
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                60 * time.Second,
			Timeout:             20 * time.Second,
			PermitWithoutStream: bool(hold),
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("awsvm: dial agent at %s: %w", host, err)
	}
	return &agentConn{conn: conn, client: pb.NewSandboxAgentClient(conn)}, nil
}

// DialAgentConnected dials the agent tunnel and waits until the channel is
// actually READY, rather than returning a lazy channel that would do the real
// work on the first RPC. That distinction is the whole point: gRPC connects on
// demand by default, so a "pre-dialled" channel that was never forced open
// would still hand the full handshake cost to the first exec.
func (c *Client) DialAgentConnected(ctx context.Context, microvmID, endpoint string) (*agentConn, error) {
	// Pool stock: hold the transport open between the pool's 30s pings.
	a, err := dialAgent(endpoint, c.cfg.AgentPort, func(ctx context.Context) (string, error) {
		return c.AuthToken(ctx, microvmID)
	}, idleKeepWarm)
	if err != nil {
		return nil, err
	}

	a.conn.Connect()
	for {
		s := a.conn.GetState()
		if s == connectivity.Ready {
			return a, nil
		}
		if !a.conn.WaitForStateChange(ctx, s) {
			_ = a.Close()
			return nil, fmt.Errorf("awsvm: agent tunnel to %s not ready: %w", microvmID, ctx.Err())
		}
	}
}

func (a *agentConn) Close() error {
	if a == nil || a.conn == nil {
		return nil
	}
	return a.conn.Close()
}

// hostOnly strips scheme and any trailing path from an endpoint so it can be
// used as a gRPC dial target and TLS server name.
func hostOnly(endpoint string) string {
	h := endpoint
	for _, prefix := range []string{"https://", "http://"} {
		if len(h) > len(prefix) && h[:len(prefix)] == prefix {
			h = h[len(prefix):]
			break
		}
	}
	for i := 0; i < len(h); i++ {
		if h[i] == '/' {
			return h[:i]
		}
	}
	return h
}

// agentPool keeps one channel per sandbox. gRPC channels are expensive to build
// relative to an exec (TLS handshake + HTTP/2 setup), and the benchmark's shape
// — create, exec, destroy — would otherwise pay that handshake on the one call
// that gets measured.
type agentPool struct {
	mu    sync.Mutex
	conns map[string]*agentConn
	// failures counts CONSECUTIVE failed keepalive pings per sandbox. Reset by
	// any success, and by dropping the channel. See pingTracked.
	failures map[string]int
}

func newAgentPool() *agentPool {
	return &agentPool{conns: make(map[string]*agentConn), failures: make(map[string]int)}
}

// get returns the cached channel for a sandbox, dialing if needed.
func (p *agentPool) get(sandboxID, endpoint string, port int32, token tokenProvider) (*agentConn, error) {
	p.mu.Lock()
	if c, ok := p.conns[sandboxID]; ok {
		// A cached channel is only useful if it is still usable. Serving one
		// that has been shut down is a permanent, silent break: every exec on
		// that sandbox returns "grpc: the client connection is closing" in
		// milliseconds and nothing ever re-dials, because this map hit is what
		// suppresses the dial. Shutdown is terminal in gRPC — it never
		// reconnects — so drop it and fall through to a fresh dial. Any other
		// state (Idle, Connecting, TransientFailure) does recover on its own
		// and must be left alone, or a blip would churn channels under load.
		if c.conn == nil || c.conn.GetState() == connectivity.Shutdown {
			delete(p.conns, sandboxID)
			p.mu.Unlock()
			_ = c.Close()
		} else {
			p.mu.Unlock()
			return c, nil
		}
	} else {
		p.mu.Unlock()
	}

	// Reaching here on a claimed box means the pre-dialled tunnel did not
	// survive to the first exec, which is exactly the ~330ms TTI penalty we are
	// hunting. Logged so the cold path is visible instead of merely slow.
	log.Printf("awsvm: agent COLD DIAL for %s (%s) — no warm tunnel in pool", sandboxID, endpoint)
	// Customer sandbox: let it fall idle and suspend.
	c, err := dialAgent(endpoint, port, token, idleMaySuspend)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	// Another goroutine may have dialed while we were: keep theirs, drop ours,
	// so a burst of concurrent execs on one box converges to a single channel.
	if existing, ok := p.conns[sandboxID]; ok {
		p.mu.Unlock()
		_ = c.Close()
		return existing, nil
	}
	p.conns[sandboxID] = c
	p.mu.Unlock()
	return c, nil
}

// put installs an already-dialled channel for a sandbox — used by the claim
// path to adopt the tunnel the pool established while the box waited in stock.
func (p *agentPool) put(sandboxID string, c *agentConn) {
	p.mu.Lock()
	old := p.conns[sandboxID]
	p.conns[sandboxID] = c
	p.mu.Unlock()
	if old != nil && old != c {
		_ = old.Close()
	}
}

// drop closes and forgets a sandbox's channel — on destroy, or after an error
// that suggests the endpoint is gone.
func (p *agentPool) drop(sandboxID string) {
	p.mu.Lock()
	c := p.conns[sandboxID]
	delete(p.conns, sandboxID)
	p.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

// warm reconnects the channels of the given sandboxes if they have gone idle.
// Returns how many needed it.
//
// Used for boxes reserved to the edge but not yet claimed by a customer: they
// are warm stock, so keeping their tunnel established is the whole point, and
// none of the idle-suspend reasoning that justifies PermitWithoutStream:false
// applies to a box with no customer on it yet.
//
// Connect() rather than a probe RPC: it restores the transport without touching
// the guest, so nothing that watches for sandbox activity can mistake it for
// any.
func (p *agentPool) warm(sandboxIDs map[string]struct{}) int {
	p.mu.Lock()
	conns := make([]*agentConn, 0, len(sandboxIDs))
	for id := range sandboxIDs {
		if c, ok := p.conns[id]; ok && c.conn != nil {
			conns = append(conns, c)
		}
	}
	p.mu.Unlock()

	// Only Idle is re-warmable here. Connect() is a no-op on a conn already in
	// TransientFailure — it is retrying on gRPC's own backoff, which grows toward
	// ~2 minutes — so counting those as "re-warmed" reports work that did not
	// happen. Healing them is pingTracked's job: it retires the channel so the
	// next get() re-dials.
	n := 0
	for _, c := range conns {
		switch c.conn.GetState() {
		case connectivity.Ready, connectivity.Connecting, connectivity.Shutdown, connectivity.TransientFailure:
		default: // Idle
			c.conn.Connect()
			n++
		}
	}
	return n
}

// detach removes a sandbox's channel WITHOUT closing it, handing ownership to
// the caller. drop() is the closing variant; this exists for the one case where
// the channel outlives the binding — an edge reservation returning to stock.
func (p *agentPool) detach(sandboxID string) *agentConn {
	p.mu.Lock()
	c := p.conns[sandboxID]
	delete(p.conns, sandboxID)
	p.mu.Unlock()
	return c
}

func (p *agentPool) closeAll() {
	p.mu.Lock()
	conns := p.conns
	p.conns = make(map[string]*agentConn)
	p.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// --- keepalive ---
//
// Pool boxes are idle by definition: they exist so that nobody has to wait for
// one. But AWS SUSPENDS an idle MicroVM, and the next payload pays the resume —
// measured at ~1s on the first exec against a box that has been sitting, and
// paid identically by the control-plane path and by the edge's direct path,
// because it is the platform waking the VM rather than anything in our
// transport. An overnight gap suspends the entire pool.
//
// A Ping is real guest traffic, so it resets the idle timer in a way that a
// merely-open connection does not. It also keeps the AWS proxy's own connection
// to the guest port attached, which is the OTHER thing a first payload pays for
// (the WebSocket 101 comes from the proxy; the proxy only dials the guest when
// payload first arrives).

// A dead box must not be allowed to starve a live one of its keepalive.
//
// These two numbers together bound how long a maintenance tick can take, and
// the worst case is every box failing: len(stock)/pingConcurrency * pingTimeout.
// At 16/5s that is 130/16*5 = ~41s for a 130-box pool — longer than the 30s
// tick period, so the tick overruns, the NEXT tick starts late, and the boxes
// that were still healthy miss their keepalive and go idle too. That is not a
// hypothetical: dev decayed 130 → 75 → 55 → 30 live tunnels over ten minutes
// while the tick timestamps drifted off their 30s cadence, each dead box paying
// a full 5s timeout and dragging the healthy ones down with it.
//
// At 64/3s the same all-dead pool costs 130/64*3 = ~6s, comfortably inside the
// period. The timeout is still many times a healthy ping (single-digit ms
// through an established tunnel), so it only bites on boxes that are already
// gone.
const (
	pingConcurrency = 64
	pingTimeout     = 3 * time.Second
)

func (a *agentConn) ping(ctx context.Context) error {
	if a == nil || a.client == nil {
		return nil
	}
	_, err := a.client.Ping(ctx, &pb.PingRequest{})
	return err
}

// proxyTouchPath is the guest endpoint the idle-timer touch requests. Served by
// cmd/microvm-hooks on the declared hook port; cheap, side-effect free, and it
// answers from the guest rather than the proxy, so a 200 also proves the whole
// path is intact.
const proxyTouchPath = "/healthz"

// proxyTouchTimeout bounds one touch. Deliberately generous relative to how long
// /healthz takes (single-digit ms): if the box has ALREADY suspended, this
// request is what wakes it, and Lambda holds it for the length of a snapshot
// restore. Timing out at a "reasonable" few seconds would abort our own resume
// and leave the box suspended, which is the failure this exists to prevent.
const proxyTouchTimeout = 30 * time.Second

// proxyTouchClient is shared so touches reuse TCP/TLS connections instead of
// paying a fresh handshake per box per tick.
var proxyTouchClient = &http.Client{
	Timeout: proxyTouchTimeout,
	Transport: &http.Transport{
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
	},
}

// proxyTouch sends one real HTTP request through a MicroVM's proxy endpoint, to
// reset AWS's idle timer.
//
// This exists because our agent keepalive CANNOT do it, by construction. AWS
// defines idleness as "no inbound traffic through the MicroVM proxy endpoint"
// for maxIdleDurationSeconds — and the keepalive sends HTTP/2 PINGs INSIDE an
// already-established WebSocket. Those are bytes on a connection the proxy
// forwards opaquely; they are not new inbound requests, and they do not count.
// The evidence is unambiguous: stocked boxes with a keepalive pinging them every
// 30s still suspended at exactly the 15-minute idle window, then answered every
// subsequent exec with 502, then were terminated 30 minutes later.
//
// So the touch has to be a fresh request at the proxy's own layer. It is the
// only thing in this package that AWS's idle accounting can actually see.
//
// A non-2xx is returned as an error but is NOT proof the box is bad: a 502 here
// means the proxy could not reach the guest AT THIS MOMENT, which includes a box
// mid-resume. Callers log it; nothing evicts on it.
func proxyTouch(ctx context.Context, endpoint string, port int32, token tokenProvider) error {
	if endpoint == "" {
		return fmt.Errorf("awsvm: empty MicroVM endpoint")
	}
	v, err := token(ctx)
	if err != nil {
		return fmt.Errorf("awsvm: auth token: %w", err)
	}
	host := hostOnly(endpoint)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+proxyTouchPath, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-aws-proxy-auth", v)
	req.Header.Set("X-aws-proxy-port", fmt.Sprintf("%d", port))

	resp, err := proxyTouchClient.Do(req)
	if err != nil {
		return fmt.Errorf("awsvm: idle touch %s: %w", host, err)
	}
	// Drain before closing or the connection cannot be reused, which would turn
	// every touch into a fresh TLS handshake.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("awsvm: idle touch %s: http %d", host, resp.StatusCode)
	}
	return nil
}

// warmShellTimeout bounds the manufacture-time warm-up. Generous, because it
// runs on a box nobody is waiting for and the whole point is to absorb a slow
// first shell rather than skip it.
const warmShellTimeout = 20 * time.Second

// warmShell runs one throwaway command so the customer's first exec doesn't
// have to be the one that pays for a cold box.
//
// Every exec arrives as `/bin/sh -lc <cmd>`, and on a box that has never run one
// the login shell has to fault in the shell itself and source the whole profile
// chain. Measured on dev across 6 fresh boxes: the FIRST exec costs 928ms median
// even when the command is `true`, while the second is 143ms — and `node -v`
// against a warm shell is 144ms, indistinguishable. So the ~800ms is entirely
// first-shell startup, not the command, and it is paid exactly once per box.
//
// Paying it here means it lands on a pool box during manufacture instead of on
// a customer's first command. `node --version` is folded in because it is the
// default template's runtime and costs another ~100ms cold; the `|| true` keeps
// this correct on an image without node, where warming the shell is still the
// point.
func (a *agentConn) warmShell(ctx context.Context) error {
	if a == nil || a.client == nil {
		return nil
	}
	_, err := a.client.Exec(ctx, &pb.ExecRequest{
		Command:        "/bin/sh",
		Args:           []string{"-lc", "node --version >/dev/null 2>&1 || true"},
		TimeoutSeconds: int32(warmShellTimeout / time.Second),
	})
	return err
}

// pingEach pings every channel and returns the outcome per index (nil = ok),
// bounded so a large pool cannot open hundreds of concurrent RPCs on a
// maintenance tick.
//
// Per-index rather than a bare tally because the caller has to be able to act on
// a specific box: a channel that keeps failing has to be retired and re-dialled,
// and that is impossible if all the tick knows is how many failed. Returning the
// error rather than a bool matters for the same reason — "75 failed" with the
// cause discarded is a number nobody can act on, which is exactly how a pool
// decaying to a third of its tunnels stayed invisible in the log.
func pingEach(ctx context.Context, conns []*agentConn) []error {
	errs := make([]error, len(conns))
	if len(conns) == 0 {
		return errs
	}
	sem := make(chan struct{}, pingConcurrency)
	var wg sync.WaitGroup
	for i, c := range conns {
		wg.Add(1)
		// Each goroutine owns its own slot, so no lock is needed.
		go func(i int, c *agentConn) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			pctx, cancel := context.WithTimeout(ctx, pingTimeout)
			defer cancel()
			errs[i] = c.ping(pctx)
		}(i, c)
	}
	wg.Wait()
	return errs
}

// pingAll is the tally-only form, for callers with nothing to heal.
func pingAll(ctx context.Context, conns []*agentConn) (ok, failed int) {
	for _, err := range pingEach(ctx, conns) {
		if err != nil {
			failed++
		} else {
			ok++
		}
	}
	return ok, failed
}

// pingTracked pings the channels held for the given sandbox ids (edge
// reservations, which are the boxes customers actually claim) and RETIRES any
// that keep failing.
//
// Same defect, same fix, as Pool.warmTunnels — see maxAgentPingFailures. A
// channel that has gone bad was never replaced here either: warm() could only
// call Connect(), which does nothing to a conn already in TransientFailure, and
// get() explicitly leaves every non-Shutdown state alone on the theory that it
// "does recover on its own". Measured on dev, it does not: a 130-box pool decayed
// to 5 live tunnels and stayed there.
//
// This path matters more than stock's, not less. These boxes are one claim away
// from a customer, so a dead channel here IS the cold dial on someone's first
// exec. Dropping the entry closes the channel and forgets it, which is exactly
// what get() needs to re-dial with a freshly minted token.
func (p *agentPool) pingTracked(ctx context.Context, sandboxIDs map[string]struct{}) (ok, failed, retired int, sample error) {
	p.mu.Lock()
	ids := make([]string, 0, len(sandboxIDs))
	conns := make([]*agentConn, 0, len(sandboxIDs))
	for id := range sandboxIDs {
		if c, found := p.conns[id]; found && c.conn != nil {
			ids = append(ids, id)
			conns = append(conns, c)
		}
	}
	p.mu.Unlock()

	errs := pingEach(ctx, conns)

	type doomedConn struct {
		id   string
		conn *agentConn
	}
	var doomed []doomedConn
	p.mu.Lock()
	for i, err := range errs {
		id := ids[i]
		if err == nil {
			delete(p.failures, id)
			ok++
			continue
		}
		failed++
		if sample == nil {
			sample = err
		}
		p.failures[id]++
		if p.failures[id] >= maxAgentPingFailures {
			doomed = append(doomed, doomedConn{id: id, conn: conns[i]})
			delete(p.failures, id)
		}
	}
	// A sandbox that stops being reserved while mid-failure would otherwise leave
	// its count behind forever. Bounded cleanup, since the caller passes the full
	// current set every tick.
	for id := range p.failures {
		if _, still := sandboxIDs[id]; !still {
			delete(p.failures, id)
		}
	}
	p.mu.Unlock()

	// Retire only the exact channel that failed. A plain drop() would close
	// whatever the map holds NOW, and if the box was claimed between the ping and
	// here, put() has already installed a fresh channel for its new owner —
	// closing that would hand the customer a broken tunnel instead of healing one.
	for _, d := range doomed {
		if p.dropIf(d.id, d.conn) {
			retired++
		}
	}
	return ok, failed, retired, sample
}

// dropIf closes and forgets a sandbox's channel only if it is still the one the
// caller expects. Reports whether it did.
func (p *agentPool) dropIf(sandboxID string, want *agentConn) bool {
	p.mu.Lock()
	c, found := p.conns[sandboxID]
	if !found || c != want {
		p.mu.Unlock()
		return false
	}
	delete(p.conns, sandboxID)
	p.mu.Unlock()
	_ = c.Close()
	return true
}
