// Command microvm-hooks is the entrypoint for our AWS Lambda MicroVM image.
//
// Lambda MicroVMs drives an image through HTTP lifecycle hooks rather than
// letting the guest come up on its own schedule, and it forwards NO customer
// traffic until /run returns 200. That gate is worth having: on the QEMU
// backend, "is the agent ready yet" is something we poll for and occasionally
// get wrong (the wake-404 strandings, "agent not available"), whereas here the
// platform simply holds traffic until we say so.
//
// This process is PID 1 in the MicroVM. It:
//   - starts osb-agent as a child, listening on TCP (Lambda's proxy can only
//     reach a guest TCP port; there is no virtio-serial or vsock here)
//   - serves the six lifecycle hooks Lambda calls
//   - reaps orphaned children, because being PID 1 means every process the
//     customer leaves behind reparents here, and unreaped zombies eat the
//     sandbox's pid budget until fork() starts failing
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/opensandbox/opensandbox/internal/wsconn"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

const (
	// hookPath is the prefix Lambda calls; the port is declared on the image.
	hookPath = "/aws/lambda-microvms/runtime/v1/"

	// agentAddr is where osb-agent listens for gRPC.
	//
	// Nothing outside the guest reaches this port. Lambda's proxy forwards only
	// to the port declared in the image's hook configuration (hookAddr below);
	// requests aimed at any other port return 502 even while that port is
	// happily accepting connections inside the guest. Verified directly: with
	// the agent listening here, a gRPC call to 8081 got a proxy 502 while the
	// identical call to 8080 reached our own mux and was answered by it.
	//
	// So this stays loopback-only — it is reached exclusively through the
	// in-guest bridge on the hook port.
	agentAddr = "127.0.0.1:8081"

	// agentDialAddr is how this process reaches the agent, for health checks and
	// for the bridge. Same address; named separately because agentAddr is the
	// bind string and this is the dial string, and they are only incidentally
	// equal.
	agentDialAddr = "127.0.0.1:8081"

	// hookAddr is where Lambda reaches these hooks.
	hookAddr = ":8080"

	// agentTunnelPath is the WebSocket endpoint carrying gRPC to the agent.
	// Must match internal/awsvm's dialer.
	agentTunnelPath = "/osb/agent-grpc"
)

// runPayload is the body Lambda POSTs to /run. runHookPayload is per-MicroVM
// (up to 16KB) and is how a pooled box learns which customer it now belongs to
// — the native equivalent of our PrepareResume env/secret injection.
type runPayload struct {
	MicrovmID      string `json:"microvmId"`
	RunHookPayload string `json:"runHookPayload"`
}

type server struct {
	mu       sync.Mutex
	agentCmd *exec.Cmd
	// microvmID is learned at /run and only used for logging; the agent itself
	// is told nothing about identity, exactly as on the QEMU backend.
	microvmID string
}

// startedAt is stamped at process start, which happens during the image BUILD.
// Every MicroVM resumes from that snapshot, so a large uptime on a freshly
// launched box is expected and is itself a useful signal that we are looking at
// a restored snapshot rather than a fresh boot.
var startedAt = time.Now()

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("microvm-hooks: starting (pid=%d)", os.Getpid())

	startReaper()

	s := &server{}
	if err := s.startAgent(); err != nil {
		log.Fatalf("microvm-hooks: start agent: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc(hookPath+"ready", s.handleReady)
	mux.HandleFunc(hookPath+"validate", s.handleValidate)
	mux.HandleFunc(hookPath+"run", s.handleRun)
	mux.HandleFunc(hookPath+"suspend", s.handleSuspend)
	mux.HandleFunc(hookPath+"resume", s.handleResume)
	mux.HandleFunc(hookPath+"terminate", s.handleTerminate)
	// /healthz reports the guest's own view of itself, and is reachable through
	// Lambda's proxy on the hook port. That matters for diagnosis: runtime logs
	// from a MicroVM do not reach the image's CloudWatch group (only build-time
	// logs do), so without this there is no way to tell "the agent died after
	// the snapshot" apart from "the proxy cannot speak to the agent's port".
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		cmd, id := s.agentCmd, s.microvmID
		s.mu.Unlock()
		pid := 0
		if cmd != nil && cmd.Process != nil {
			pid = cmd.Process.Pid
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agentUp":    agentUp(),
			"agentPid":   pid,
			"agentAddr":  agentAddr,
			"microvmId":  id,
			"ranRunHook": id != "",
			"uptimeSec":  int(time.Since(startedAt).Seconds()),
		})
	})

	// Diagnostic: emit an UNANNOUNCED HTTP/2 trailer, the way gRPC sends
	// grpc-status. If this trailer does not survive the trip to a client, then
	// gRPC cannot work through Lambda's proxy no matter how the guest is
	// arranged — which is a very different problem from our own bridge dropping
	// it, and the two are indistinguishable from the gRPC error alone.
	mux.HandleFunc("/trailer-test", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(http.TrailerPrefix+"X-Osb-Trailer", "present")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "body\n")
	})

	// Diagnostic: echo over a WebSocket. Trailers do not survive the proxy, so
	// gRPC cannot run over plain HTTP here; carrying it inside a WebSocket is
	// the way to keep the agent's whole API intact. That only works if the
	// proxy passes an upgrade through and does not buffer the stream, which is
	// what this measures.
	mux.HandleFunc("/ws-test", func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{
			CheckOrigin: func(*http.Request) bool { return true },
		}).Upgrade(w, r, nil)
		if err != nil {
			log.Printf("microvm-hooks: /ws-test upgrade failed: %v", err)
			return
		}
		defer c.Close()
		for {
			mt, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			if err := c.WriteMessage(mt, msg); err != nil {
				return
			}
		}
	})

	// The agent tunnel: a WebSocket carrying osb-agent's gRPC verbatim.
	//
	// Lambda's proxy strips HTTP/2 trailers, and gRPC puts its status there, so
	// forwarding gRPC as ordinary HTTP/2 loses every RPC result even though the
	// command runs. Inside a WebSocket the proxy sees opaque frames and never
	// touches the HTTP/2 stream within, so trailers arrive intact.
	//
	// This is a byte splice, not an HTTP proxy: whatever gRPC writes goes to the
	// agent unchanged. That is exactly why it preserves semantics an HTTP-level
	// proxy could not — and why osb-agent needs no change at all.
	mux.HandleFunc(agentTunnelPath, s.handleAgentTunnel)

	// Everything that is not a hook is forwarded to osb-agent.
	//
	// This exists because Lambda's proxy forwards guest traffic ONLY to the port
	// declared in the image's hook configuration. A second listener is simply
	// unreachable: the agent is demonstrably listening on 8081 and requests to
	// it still come back 502, while the identical request to 8080 arrives. So
	// the agent cannot have its own port, and rather than teach osb-agent to
	// share this one — it is the same binary the QEMU backend runs, and forking
	// its listener setup per backend is how drift starts — we bridge to it here.
	//
	// gRPC itself passes through the proxy unharmed; that was verified by
	// sending a real gRPC call to this port and watching it arrive intact (the
	// mux answered 404 rather than the proxy answering 502).
	mux.Handle("/", agentReverseProxy())

	// h2c: serve cleartext HTTP/2 as well as HTTP/1.1. gRPC requires HTTP/2, and
	// the proxy's hop into the guest is cleartext, so without this the agent
	// bridge would only ever see HTTP/1.1 and gRPC could not work.
	handler := h2c.NewHandler(mux, &http2.Server{})

	log.Printf("microvm-hooks: serving hooks + agent bridge on %s (agent at %s)", hookAddr, agentAddr)
	if err := http.ListenAndServe(hookAddr, handler); err != nil {
		log.Fatalf("microvm-hooks: serve: %v", err)
	}
}

// agentReverseProxy bridges proxied traffic on the hook port to osb-agent's
// gRPC listener, speaking h2c upstream because gRPC needs HTTP/2.
func agentReverseProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "http"
			r.Out.URL.Host = agentDialAddr
			// Preserve the gRPC method path exactly; any rewriting here turns
			// into an Unimplemented that looks like an agent bug.
			r.Out.Host = agentDialAddr
		},
		Transport: &http2.Transport{
			// Cleartext HTTP/2 to a loopback listener: no TLS to negotiate, and
			// nothing to protect against on the guest's own loopback.
			AllowHTTP: true,
			DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, addr)
			},
		},
		// Flush every write instead of buffering. gRPC streaming (and our exec
		// output streaming) deadlocks if the proxy holds frames waiting for a
		// buffer to fill.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("microvm-hooks: agent bridge error: %v", err)
			http.Error(w, "agent unreachable", http.StatusBadGateway)
		},
	}
}

// startAgent launches osb-agent as a child process in TCP listen mode.
func (s *server) startAgent() error {
	cmd := exec.Command("/usr/local/bin/osb-agent")
	cmd.Env = append(os.Environ(), "OSB_AGENT_LISTEN_TCP="+agentAddr)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	s.mu.Lock()
	s.agentCmd = cmd
	s.mu.Unlock()

	// A dead agent is a dead sandbox; log it loudly rather than leaving the box
	// serving hooks while nothing can exec.
	go func() {
		err := cmd.Wait()
		log.Printf("microvm-hooks: WARNING osb-agent exited: %v", err)
	}()
	log.Printf("microvm-hooks: osb-agent started (pid=%d)", cmd.Process.Pid)
	return nil
}

// handleAgentTunnel upgrades to a WebSocket and splices it to osb-agent's gRPC
// listener, so a gRPC client on the other side talks to the real agent with its
// framing — and its trailers — preserved end to end.
func (s *server) handleAgentTunnel(w http.ResponseWriter, r *http.Request) {
	ws, err := (&websocket.Upgrader{
		ReadBufferSize:  64 * 1024,
		WriteBufferSize: 64 * 1024,
		// The proxy is the only route in and it has already authenticated the
		// caller's port-scoped token, so there is no origin to check against.
		CheckOrigin: func(*http.Request) bool { return true },
	}).Upgrade(w, r, nil)
	if err != nil {
		log.Printf("microvm-hooks: agent tunnel upgrade failed: %v", err)
		return
	}
	defer ws.Close()

	agent, err := net.DialTimeout("tcp", agentDialAddr, 5*time.Second)
	if err != nil {
		log.Printf("microvm-hooks: agent tunnel dial %s: %v", agentDialAddr, err)
		return
	}
	defer agent.Close()

	tunnel := wsconn.New(ws)
	// Copy both directions and stop as soon as either side finishes; leaving the
	// second copy running would pin a goroutine and a socket per dead tunnel.
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(agent, tunnel); done <- struct{}{} }()
	go func() { _, _ = io.Copy(tunnel, agent); done <- struct{}{} }()
	<-done
}

// agentUp reports whether the agent is accepting connections.
func agentUp() bool {
	conn, err := net.DialTimeout("tcp", agentDialAddr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// handleReady is called during the image BUILD, after ENTRYPOINT starts. 200
// tells Lambda to snapshot; 503 means retry. Return 503 immediately rather than
// holding the request open — a held request that outlives the timeout kills the
// whole build.
func (s *server) handleReady(w http.ResponseWriter, _ *http.Request) {
	if !agentUp() {
		http.Error(w, "agent not listening yet", http.StatusServiceUnavailable)
		return
	}
	log.Printf("microvm-hooks: /ready ok — agent listening, safe to snapshot")
	w.WriteHeader(http.StatusOK)
}

// handleValidate runs on a fresh MicroVM started from the newly built image.
//
// It is also a performance lever, not just a correctness check: Lambda tracks
// which regions of the snapshot get touched while serving this hook and
// prefetches them at run time. So exercising the real exec path here is the
// direct analogue of our golden-snapshot warm-up — the work we do in this
// handler is what makes the customer's FIRST exec fast.
func (s *server) handleValidate(w http.ResponseWriter, _ *http.Request) {
	if !agentUp() {
		http.Error(w, "agent not listening yet", http.StatusServiceUnavailable)
		return
	}
	// Warm the AGENT's exec path, not just the binaries.
	//
	// Running these straight from this process (as an earlier version did) warms
	// /bin/sh and node but leaves osb-agent's own exec machinery untouched, and
	// that machinery is what a customer's first command actually goes through.
	// Measured cost of skipping it: a flat ~800ms on the first exec of every VM,
	// independent of the command — /bin/true was as slow as node -v — versus
	// ~80ms once those pages are resident. Driving the real RPC here folds that
	// into the image build, where Lambda records the touched snapshot regions and
	// prefetches them at run time.
	conn, err := grpc.NewClient(agentDialAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Printf("microvm-hooks: /validate agent dial: %v", err)
		w.WriteHeader(http.StatusOK)
		return
	}
	defer conn.Close()
	client := pb.NewSandboxAgentClient(conn)

	for _, cmd := range []string{
		"true",
		"command -v node >/dev/null && node -v || true",
		"command -v python3 >/dev/null && python3 --version || true",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		resp, err := client.Exec(ctx, &pb.ExecRequest{
			Command:        "/bin/sh",
			Args:           []string{"-c", cmd},
			TimeoutSeconds: 15,
		})
		cancel()
		if err != nil {
			log.Printf("microvm-hooks: /validate agent exec %q: %v", cmd, err)
			continue
		}
		log.Printf("microvm-hooks: /validate agent %q → %s", cmd, strings.TrimSpace(resp.Stdout))
	}
	w.WriteHeader(http.StatusOK)
}

// handleRun is called when a MicroVM starts from the image snapshot. Customer
// traffic begins only after this returns 200, which makes it the natural place
// to bind per-sandbox state.
func (s *server) handleRun(w http.ResponseWriter, r *http.Request) {
	var p runPayload
	if body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024)); err == nil && len(body) > 0 {
		if err := json.Unmarshal(body, &p); err != nil {
			log.Printf("microvm-hooks: /run payload not JSON (%v) — continuing", err)
		}
	}
	s.mu.Lock()
	s.microvmID = p.MicrovmID
	s.mu.Unlock()

	// The agent must be live before we let traffic in; this is the gate that
	// replaces the QEMU backend's polling for agent readiness.
	deadline := time.Now().Add(20 * time.Second)
	for !agentUp() {
		if time.Now().After(deadline) {
			log.Printf("microvm-hooks: /run FAILED — agent never came up")
			http.Error(w, "agent did not start", http.StatusServiceUnavailable)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	log.Printf("microvm-hooks: /run ok (microvm=%s payloadBytes=%d)", p.MicrovmID, len(p.RunHookPayload))
	w.WriteHeader(http.StatusOK)
}

// handleSuspend runs before Lambda snapshots for a suspend. AWS captures memory
// and disk itself, so unlike our QEMU path there is no fsfreeze to coordinate
// and no torn-snapshot class of bug to defend against.
func (s *server) handleSuspend(w http.ResponseWriter, _ *http.Request) {
	log.Printf("microvm-hooks: /suspend")
	w.WriteHeader(http.StatusOK)
}

// handleResume runs after a suspended MicroVM is restored, before it returns to
// RUNNING. Anything that cannot survive a snapshot boundary is re-established
// here — the counterpart of our PrepareResume.
func (s *server) handleResume(w http.ResponseWriter, _ *http.Request) {
	if !agentUp() {
		// The agent survives inside the snapshot, so this should not happen;
		// if it does, say so rather than admitting traffic to a dead box.
		log.Printf("microvm-hooks: /resume WARNING agent not listening after restore")
		http.Error(w, "agent not listening after resume", http.StatusServiceUnavailable)
		return
	}
	log.Printf("microvm-hooks: /resume ok")
	w.WriteHeader(http.StatusOK)
}

func (s *server) handleTerminate(w http.ResponseWriter, _ *http.Request) {
	log.Printf("microvm-hooks: /terminate")
	w.WriteHeader(http.StatusOK)
}

// startReaper drains SIGCHLD. As PID 1 we inherit every orphan the customer's
// commands leave behind; without wait4 they linger as zombies holding pid-budget
// slots until fork() fails with "resource temporarily unavailable" on a box that
// looks idle. Same reasoning as the agent's own reaper on the QEMU backend.
func startReaper() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGCHLD)
	go func() {
		for range ch {
			for {
				var ws syscall.WaitStatus
				pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
				if pid <= 0 || err != nil {
					break
				}
			}
		}
	}()
}
