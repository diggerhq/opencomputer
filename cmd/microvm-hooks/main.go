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

	// runCmdPath executes one command and returns its result as ordinary JSON.
	// Must match internal/awsvmlite.
	runCmdPath = "/osb/run"
)

// runCmdRequest / runCmdResponse are the whole protocol of the direct exec path.
//
// PLAIN HTTP ON PURPOSE. Everything else in this file exists to carry gRPC into
// the guest: the agent bridge, the WebSocket tunnel, the h2c handler. All of it
// is there because gRPC reports its status in HTTP/2 trailers and Lambda's proxy
// strips them, so a gRPC reply arrives with the command already executed and the
// result missing.
//
// A JSON request/response has no trailers to lose. That single difference
// removes the entire tunnel tier — no WebSocket, no persistent channel, no
// keepalive, no re-dial, no Durable Object holding a socket open — and with it
// every failure mode that tier has: measured on dev the same day this was
// written, a box answering /healthz in 90ms with agentUp=true was simultaneously
// logged by the control plane as tunnel-less with re-dial timing out at 30s.
//
// One command, buffered output, one reply — and deliberately nothing more, so
// that the path a customer's exec takes stays this short.
//
// The richer operations do NOT need the tunnel either, which was not obvious
// when this was written: see oc.go, where files and stats reach the agent over
// loopback gRPC and cross the proxy as plain JSON. What still belongs on the
// agent path is only what needs a bidirectional stream — PTY and exec sessions.
// The field names mirror types.ProcessConfig so the control plane forwards a
// customer's exec request without reshaping it.
type runCmdRequest struct {
	Cmd string `json:"cmd"`
	// Args, when present, makes Cmd an executable rather than a shell string —
	// the same rule the agent's exec follows.
	//
	// Carried as real fields rather than folded into one shell string on the
	// host, because building `cd %s && export %s=%s; %s` puts three separate
	// quoting problems on the exec hot path: a path with a space, a value with a
	// quote, and a command the customer wrote for a shell that isn't this one.
	// exec.Cmd already has Dir and Env, and they cannot be escaped wrong.
	Args []string          `json:"args,omitempty"`
	Env  map[string]string `json:"envs,omitempty"`
	Cwd  string            `json:"cwd,omitempty"`
	// TimeoutSec bounds the command. Zero means runCmdDefaultTimeout.
	TimeoutSec int `json:"timeoutSec,omitempty"`
}

type runCmdResponse struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	// TimedOut distinguishes "the command was killed at the deadline" from "the
	// command exited non-zero", which are the same exit status otherwise.
	TimedOut bool `json:"timedOut,omitempty"`
}

const (
	runCmdDefaultTimeout = 30 * time.Second
	runCmdMaxTimeout     = 10 * time.Minute
	// runCmdMaxOutput caps each stream. Buffered in memory and returned in a
	// JSON body, so an unbounded `cat /dev/urandom` would otherwise take the
	// guest's memory and the reply with it.
	runCmdMaxOutput = 1 << 20 // 1 MiB per stream
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
		// The binding, reported so the CP's existing keepalive sweep can learn
		// who owns each box WITHOUT the edge telling it. That makes host-side
		// bookkeeping self-healing: a finalize message that never arrives is
		// reconciled on the next touch instead of stranding the box.
		claimedBy, claimedAt := boxClaim.current()
		h := map[string]any{
			"agentUp":    agentUp(),
			"agentPid":   pid,
			"agentAddr":  agentAddr,
			"microvmId":  id,
			"ranRunHook": id != "",
			"uptimeSec":  int(time.Since(startedAt).Seconds()),
			"claimed":    claimedBy != "",
		}
		if claimedBy != "" {
			h["claimedBy"] = claimedBy
			h["claimedAtUnix"] = claimedAt.Unix()
		}
		_ = json.NewEncoder(w).Encode(h)
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

	// Direct exec. Registered before the catch-all below because ServeMux picks
	// the longest matching pattern — without an explicit entry this path would
	// be forwarded to osb-agent's gRPC listener, which answers a JSON POST with
	// 415 and no explanation.
	mux.HandleFunc(runCmdPath, s.handleRunCmd)
	// Edge claim. See claim.go: the box is the only authority on who owns it,
	// so these are the endpoints that actually decide it.
	mux.HandleFunc(claimPath, s.handleClaim)
	mux.HandleFunc(claimAndRunPath, s.handleClaimAndRun)

	// The /oc front door: the four paths above under their new prefix, plus
	// files, stats, reboot and customer-port proxying. See oc.go — all of it
	// reaches the agent over LOOPBACK gRPC, which is why it can offer the full
	// agent API on a path that deliberately cannot carry gRPC through the
	// proxy. Registered before the catch-all for the same longest-match reason.
	s.registerOC(mux)

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
// handleRunCmd runs one command and returns its result as JSON.
//
// See runCmdRequest for why this exists alongside the agent bridge rather than
// through it.
//
// A command that fails is NOT an HTTP error: a non-zero exit is a perfectly
// ordinary result and the caller needs the output either way. Only a malformed
// request or a failure to start the process gets a 4xx/5xx, so the caller can
// tell "your command exited 1" from "the sandbox could not run it".
func (s *server) handleRunCmd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req runCmdRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Cmd) == "" {
		http.Error(w, "cmd is required", http.StatusBadRequest)
		return
	}

	out, err := runCmd(r.Context(), req)
	if err != nil {
		// Never started: no binary, no fork, nothing to report an exit code for.
		http.Error(w, "could not start command: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(out)
}

// runCmd executes one command and reports the result.
//
// Split out of handleRunCmd so /osb/claim-and-run runs commands through the
// EXACT same path rather than a second copy that can drift — the fused endpoint
// differs from the plain one only in what it does before the command, never in
// how the command runs.
//
// A non-nil error means the command never started (no binary, fork failure).
// That is the only case a caller has to decide about; a command that ran and
// exited non-zero is a result, and comes back in the response with its code.
func runCmd(reqCtx context.Context, req runCmdRequest) (runCmdResponse, error) {
	timeout := runCmdDefaultTimeout
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
		if timeout > runCmdMaxTimeout {
			timeout = runCmdMaxTimeout
		}
	}
	// Bound by the request's context too, so a caller that gives up does not
	// leave the command running in the guest.
	ctx, cancel := context.WithTimeout(reqCtx, timeout)
	defer cancel()

	// `sh -lc` matches what the agent's exec does, so a command behaves the same
	// on both paths — the login shell sources the same profile chain and finds
	// the same PATH. With explicit args the command is an executable instead,
	// which is also what the agent does.
	started := time.Now()
	name, args := "/bin/sh", []string{"-lc", req.Cmd}
	if len(req.Args) > 0 {
		name, args = req.Cmd, req.Args
	}
	cmd := exec.CommandContext(ctx, name, args...)

	// RUN AS THE SANDBOX USER, NOT AS US.
	//
	// This process is PID 1 and therefore root. Without this the customer's
	// commands inherited that — measured on dev before this existed:
	//
	//	uid=0(root) gid=0(root)   HOME=/root   pwd=/
	//
	// against uid=1000 in /home/sandbox on the QEMU fleet and on the agent
	// path, which sets the same credential (internal/agent/exec.go).
	//
	// Three things broke because of it, and none of them announced itself:
	//
	//	the sandbox was root      a privilege boundary the QEMU fleet has and
	//	                          this runtime silently did not
	//	secrets were readable     the in-guest proxy keeps plaintext in THIS
	//	                          process's memory, which is safe only because
	//	                          the customer is unprivileged (oc_secrets.go)
	//	checkpoints missed work   cwd was /, and the workspace archive covers
	//	                          /home/sandbox — so anything written to a
	//	                          relative path was outside every checkpoint
	// Only root can hand a child a different uid. In the guest this process IS
	// root (PID 1), so this always applies there; the check exists because the
	// unit tests run it as an ordinary user, where the setuid would fail the
	// fork outright and turn every test into "operation not permitted".
	if os.Geteuid() == 0 {
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: sandboxUID, Gid: sandboxGID},
		}
	}
	cmd.Dir = req.Cwd
	if cmd.Dir == "" {
		// Not "" (which inherits /): a relative path from a customer has to
		// land in the workspace, both because that is where they expect it and
		// because that is what a checkpoint captures. Guarded on existence so
		// the tests, which have no /home/sandbox, still run.
		if st, err := os.Stat(sandboxHomeDir); err == nil && st.IsDir() {
			cmd.Dir = sandboxHomeDir
		}
	}
	// The guest's environment, then the sandbox's, then this request's — see
	// buildEnv. Never nil now: the user identity below always has to be stated,
	// because os.Environ() is ROOT's and would otherwise tell the customer's
	// shell that HOME is /root.
	cmd.Env = buildEnv(req.Env)
	var stdout, stderr cappedBuffer
	stdout.limit, stderr.limit = runCmdMaxOutput, runCmdMaxOutput
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	runErr := cmd.Run()
	resp := runCmdResponse{
		Stdout:     stdout.String(),
		Stderr:     stderr.String(),
		DurationMs: time.Since(started).Milliseconds(),
		TimedOut:   ctx.Err() != nil,
	}
	switch {
	case runErr == nil:
		resp.ExitCode = 0
	case cmd.ProcessState != nil:
		// Ran and exited non-zero — a result, not an error.
		resp.ExitCode = cmd.ProcessState.ExitCode()
	default:
		return runCmdResponse{}, runErr
	}
	return resp, nil
}

// cappedBuffer accumulates up to limit bytes and silently discards the rest.
//
// Discarding rather than erroring is deliberate: a command that prints more than
// the cap has still done its work, and failing the whole call over trailing
// output would turn a successful build into an error. The caller sees a
// truncated stream, which is the same contract every log tail has.
type cappedBuffer struct {
	buf   []byte
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - len(b.buf); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		b.buf = append(b.buf, p[:room]...)
	}
	// Always report the full length: an io.Writer that under-reports makes
	// os/exec treat a capped stream as a short write and fail the command.
	return len(p), nil
}

func (b *cappedBuffer) String() string { return string(b.buf) }

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
