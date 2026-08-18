package awsvm

import (
	"context"
	"crypto/tls"
	"fmt"
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
func dialAgent(endpoint string, port int32, token tokenProvider) (*agentConn, error) {
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
		// Keepalive without permit-without-stream: an idle sandbox should be
		// allowed to go idle and suspend, which is exactly how this backend
		// stops billing compute for it. Pinging a suspended box would defeat
		// the idle policy and keep it needlessly RUNNING.
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                60 * time.Second,
			Timeout:             20 * time.Second,
			PermitWithoutStream: false,
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
	a, err := dialAgent(endpoint, c.cfg.AgentPort, func(ctx context.Context) (string, error) {
		return c.AuthToken(ctx, microvmID)
	})
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
}

func newAgentPool() *agentPool {
	return &agentPool{conns: make(map[string]*agentConn)}
}

// get returns the cached channel for a sandbox, dialing if needed.
func (p *agentPool) get(sandboxID, endpoint string, port int32, token tokenProvider) (*agentConn, error) {
	p.mu.Lock()
	if c, ok := p.conns[sandboxID]; ok {
		p.mu.Unlock()
		return c, nil
	}
	p.mu.Unlock()

	c, err := dialAgent(endpoint, port, token)
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

func (p *agentPool) closeAll() {
	p.mu.Lock()
	conns := p.conns
	p.conns = make(map[string]*agentConn)
	p.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}
