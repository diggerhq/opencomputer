package main

// oc.go — the guest's front door.
//
// Lambda's proxy forwards guest traffic ONLY to the port declared in the
// image's hook configuration (8080). A second listener is unreachable: the
// agent listens on 8081 and requests to it come back 502 while the identical
// request to 8080 arrives (see the note on agentAddr). So everything a customer
// can reach — exec, files, stats, reboot, and their own HTTP servers — has to
// enter here and be fanned out inside the guest.
//
// WHY THIS CAN EXIST AT ALL. The direct path deliberately gave up files, stats
// and everything else because gRPC reports status in HTTP/2 trailers and the
// proxy strips them. But that is a property of the PROXY HOP, not of the agent:
// inside the guest, loopback gRPC to 127.0.0.1:8081 works perfectly, and
// handleValidate has been driving real Exec RPCs over it since the image was
// first built. So the trailer problem is bypassed by never carrying gRPC across
// the proxy — the caller speaks plain JSON to this process, and this process
// speaks gRPC to the agent over loopback.
//
// The result is that the direct path keeps its one-request exec and still
// reaches the agent's full API, with no tunnel, no WebSocket, no persistent
// channel and no keepalive. None of these handlers is on the create or exec hot
// path: exec is still runCmdPath, answered without touching any of this.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// The /oc prefix. The older /osb paths stay registered as aliases (see
// registerOC) because the running fleet and the deployed control plane both
// speak them, and a rename that requires a lockstep image + control-plane
// deploy buys nothing. New work goes here; /osb is retired once no deployed
// control plane sends it.
const (
	ocPrefix = "/oc/"

	ocRunPath       = ocPrefix + "run"
	ocClaimPath     = ocPrefix + "claim"
	ocClaimRunPath  = ocPrefix + "claim-and-run"
	ocAgentGRPCPath = ocPrefix + "agent-grpc"

	ocFSPrefix   = ocPrefix + "fs/"
	ocStatsPath  = ocPrefix + "stats"
	ocRebootPath = ocPrefix + "reboot"

	// ocPortPrefix proxies to a port the customer is listening on inside the
	// guest: /oc/port/3000/some/path reaches 127.0.0.1:3000/some/path.
	ocPortPrefix = ocPrefix + "port/"
)

// fsMaxInline bounds a buffered read or write. Anything larger belongs on the
// streaming endpoints, which never hold the whole file in memory — on a box
// this small, one careless 2 GB read would OOM the guest and take the agent
// with it.
const fsMaxInline = 32 << 20 // 32 MiB

// registerOC wires the front door onto the hook mux.
//
// Registered on BOTH prefixes for the four paths that already exist, so an
// image carrying this code serves a control plane that speaks either. ServeMux
// picks the longest matching pattern, so every one of these wins over the
// catch-all bridge to the agent — without an explicit entry a JSON POST would
// be forwarded to the agent's gRPC listener, which answers 415 and no
// explanation.
func (s *server) registerOC(mux *http.ServeMux) {
	// Aliases for the existing surface.
	mux.HandleFunc(ocRunPath, s.handleRunCmd)
	mux.HandleFunc(ocClaimPath, s.handleClaim)
	mux.HandleFunc(ocClaimRunPath, s.handleClaimAndRun)
	mux.HandleFunc(ocAgentGRPCPath, s.handleAgentTunnel)

	// Filesystem, bridged to the agent over loopback gRPC.
	mux.HandleFunc(ocFSPrefix+"read", s.ocFSRead)
	mux.HandleFunc(ocFSPrefix+"write", s.ocFSWrite)
	mux.HandleFunc(ocFSPrefix+"list", s.ocFSList)
	mux.HandleFunc(ocFSPrefix+"mkdir", s.ocFSMkdir)
	mux.HandleFunc(ocFSPrefix+"rm", s.ocFSRemove)
	mux.HandleFunc(ocFSPrefix+"exists", s.ocFSExists)
	mux.HandleFunc(ocFSPrefix+"stat", s.ocFSStat)
	mux.HandleFunc(ocFSPrefix+"download", s.ocFSDownload)
	mux.HandleFunc(ocFSPrefix+"upload", s.ocFSUpload)

	mux.HandleFunc(ocStatsPath, s.ocStats)
	mux.HandleFunc(ocEnvsPath, s.ocSetEnvs)
	mux.HandleFunc(ocSecretsPath, s.ocSetSecrets)
	mux.HandleFunc(ocSecretsUpdatePath, s.ocUpdateSecret)
	// PTY, streaming exec and the workspace archive. Separated only because
	// they are streams rather than request/reply — see oc_stream.go.
	s.registerOCStream(mux)
	mux.HandleFunc(ocRebootPath, s.ocReboot)
	mux.HandleFunc(ocPortPrefix, s.ocPort)
}

// ── agent client ────────────────────────────────────────────────────────────

// agentConn is one lazily-dialled loopback gRPC connection, shared by every
// handler here.
//
// Lazy, not created at startup, because this process starts during the image
// BUILD and every box resumes from a snapshot taken then: a connection
// established before the snapshot would be restored into every box that ever
// runs, having been idle across a snapshot boundary. Dialling on first use puts
// it safely after /resume.
//
// Shared, not per-request, because a file op should not pay a handshake — and
// reset on failure, because the agent can be restarted underneath us by
// /oc/reboot, which invalidates whatever we were holding.
var agentConn struct {
	mu   sync.Mutex
	conn *grpc.ClientConn
}

func agentClient() (pb.SandboxAgentClient, error) {
	agentConn.mu.Lock()
	defer agentConn.mu.Unlock()
	if agentConn.conn == nil {
		c, err := grpc.NewClient(agentDialAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return nil, fmt.Errorf("dial agent: %w", err)
		}
		agentConn.conn = c
	}
	return pb.NewSandboxAgentClient(agentConn.conn), nil
}

// resetAgentClient drops the shared connection so the next caller redials.
// Called when the agent is deliberately restarted.
func resetAgentClient() {
	agentConn.mu.Lock()
	defer agentConn.mu.Unlock()
	if agentConn.conn != nil {
		_ = agentConn.conn.Close()
		agentConn.conn = nil
	}
}

// ── plumbing ────────────────────────────────────────────────────────────────

// ocRequest is the request body every buffered filesystem endpoint accepts.
// One shape for all of them: the control plane sends the same JSON regardless
// of the operation, and the fields it does not need are simply absent.
type ocRequest struct {
	Path    string `json:"path"`
	Content []byte `json:"content,omitempty"`
	Mode    uint32 `json:"mode,omitempty"`
}

// decode reads a JSON body, bounded. Returns false having already answered.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, fsMaxInline)).Decode(dst); err != nil {
		http.Error(w, "bad request body: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

// fail turns an agent error into an HTTP status.
//
// The mapping is the point: the control plane cannot see gRPC codes from out
// here, so a missing file and a broken agent would otherwise be the same 500
// and the SDK would retry the one that will never succeed. NotFound in
// particular has to survive — "file does not exist" is a normal answer to a
// read, not a fault.
func fail(w http.ResponseWriter, op string, err error) {
	code := http.StatusInternalServerError
	switch status.Code(err) {
	case codes.NotFound:
		code = http.StatusNotFound
	case codes.InvalidArgument:
		code = http.StatusBadRequest
	case codes.PermissionDenied:
		code = http.StatusForbidden
	case codes.AlreadyExists:
		code = http.StatusConflict
	case codes.Unavailable:
		// The agent is not answering. Retryable, and distinct from a bad
		// request — this is the code that says "ask again", so a transient
		// agent restart does not surface to a customer as a failed write.
		code = http.StatusServiceUnavailable
	case codes.ResourceExhausted:
		code = http.StatusInsufficientStorage
	}
	log.Printf("microvm-hooks: %s: %v", op, err)
	http.Error(w, err.Error(), code)
}

// withAgent runs fn against the agent, answering the request on any failure to
// obtain a client. Every filesystem handler is this plus one RPC.
func withAgent(w http.ResponseWriter, op string, fn func(pb.SandboxAgentClient) error) {
	c, err := agentClient()
	if err != nil {
		fail(w, op, status.Error(codes.Unavailable, err.Error()))
		return
	}
	if err := fn(c); err != nil {
		fail(w, op, err)
	}
}

// fsTimeout bounds a buffered filesystem call. Generous relative to a local
// file operation, so only a genuinely wedged agent trips it.
const fsTimeout = 60 * time.Second

// ── filesystem ──────────────────────────────────────────────────────────────

func (s *server) ocFSRead(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/read", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		resp, err := c.ReadFile(ctx, &pb.ReadFileRequest{Path: req.Path})
		if err != nil {
			return err
		}
		// Bytes, not a string: the control plane's ReadFile returns a string,
		// but encoding/json handles []byte as base64, which round-trips binary
		// content that a string field would corrupt.
		writeJSON(w, http.StatusOK, map[string]any{"content": resp.Content})
		return nil
	})
}

func (s *server) ocFSWrite(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/write", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		_, err := c.WriteFile(ctx, &pb.WriteFileRequest{
			Path: req.Path, Content: req.Content, Mode: req.Mode,
		})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	})
}

func (s *server) ocFSList(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/list", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		resp, err := c.ListDir(ctx, &pb.ListDirRequest{Path: req.Path})
		if err != nil {
			return err
		}
		// Shaped as types.EntryInfo so the control plane can unmarshal it
		// directly rather than translating a second wire format.
		out := make([]map[string]any, 0, len(resp.Entries))
		for _, e := range resp.Entries {
			out = append(out, map[string]any{
				"name": e.Name, "isDir": e.IsDir, "size": e.Size, "path": e.Path,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": out})
		return nil
	})
}

func (s *server) ocFSMkdir(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/mkdir", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		if _, err := c.MakeDir(ctx, &pb.MakeDirRequest{Path: req.Path}); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	})
}

func (s *server) ocFSRemove(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/rm", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		if _, err := c.Remove(ctx, &pb.RemoveRequest{Path: req.Path}); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	})
}

func (s *server) ocFSExists(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/exists", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		resp, err := c.Exists(ctx, &pb.ExistsRequest{Path: req.Path})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"exists": resp.Exists})
		return nil
	})
}

func (s *server) ocFSStat(w http.ResponseWriter, r *http.Request) {
	var req ocRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "fs/stat", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), fsTimeout)
		defer cancel()
		resp, err := c.Stat(ctx, &pb.StatRequest{Path: req.Path})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name": resp.Name, "isDir": resp.IsDir, "size": resp.Size,
			"mode": resp.Mode, "modTime": resp.ModTime, "path": resp.Path,
		})
		return nil
	})
}

// ── streaming filesystem ────────────────────────────────────────────────────
//
// Streamed as ordinary HTTP bodies. Only TRAILERS die on the proxy hop; a body
// passes through untouched, which is what makes a large file transfer possible
// on this path at all. Neither of these buffers the file.

// ocFSDownload streams a file out. GET /oc/fs/download?path=...
func (s *server) ocFSDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	withAgent(w, "fs/download", func(c pb.SandboxAgentClient) error {
		stream, err := c.ReadFileStream(r.Context(), &pb.ReadFileStreamRequest{Path: path})
		if err != nil {
			return err
		}
		// Headers are committed on the FIRST chunk, not before: an error on the
		// opening read is a real status code (404 for a missing file), whereas
		// writing the header first would force every failure to look like a
		// truncated 200.
		wrote := false
		for {
			chunk, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				if !wrote {
					return err
				}
				// Mid-stream failure. The status is already 200 and the body is
				// short; nothing can be signalled except to stop and log, which
				// is why the length header below matters to the caller.
				log.Printf("microvm-hooks: fs/download %s: truncated: %v", path, err)
				return nil
			}
			if !wrote {
				w.Header().Set("Content-Type", "application/octet-stream")
				if chunk.TotalSize > 0 {
					w.Header().Set("Content-Length", strconv.FormatInt(chunk.TotalSize, 10))
				}
				w.WriteHeader(http.StatusOK)
				wrote = true
			}
			if _, err := w.Write(chunk.Data); err != nil {
				return nil // client hung up
			}
		}
		if !wrote {
			// A zero-byte file still needs a response.
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(http.StatusOK)
		}
		return nil
	})
}

// ocFSUpload streams a file in. PUT /oc/fs/upload?path=...&mode=...
func (s *server) ocFSUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	mode := uint32(0)
	if m := r.URL.Query().Get("mode"); m != "" {
		if parsed, err := strconv.ParseUint(m, 8, 32); err == nil {
			mode = uint32(parsed)
		}
	}
	withAgent(w, "fs/upload", func(c pb.SandboxAgentClient) error {
		stream, err := c.WriteFileStream(r.Context())
		if err != nil {
			return err
		}
		// path and mode ride on the first message only, per the proto.
		buf := make([]byte, 256<<10)
		first := true
		for {
			n, rerr := r.Body.Read(buf)
			if n > 0 {
				msg := &pb.WriteFileStreamRequest{Data: buf[:n]}
				if first {
					msg.Path, msg.Mode, first = path, mode, false
				}
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
			if errors.Is(rerr, io.EOF) {
				break
			}
			if rerr != nil {
				_, _ = stream.CloseAndRecv()
				return status.Error(codes.Canceled, "upload body: "+rerr.Error())
			}
		}
		if first {
			// Empty body: the agent has still not been told the path, so send
			// one empty message carrying it or the file is never created.
			if err := stream.Send(&pb.WriteFileStreamRequest{Path: path, Mode: mode}); err != nil {
				return err
			}
		}
		resp, err := stream.CloseAndRecv()
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"bytesWritten": resp.BytesWritten})
		return nil
	})
}

// ── stats ───────────────────────────────────────────────────────────────────

func (s *server) ocStats(w http.ResponseWriter, r *http.Request) {
	withAgent(w, "stats", func(c pb.SandboxAgentClient) error {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		resp, err := c.Stats(ctx, &pb.StatsRequest{})
		if err != nil {
			return err
		}
		// Field names match sandbox.SandboxStats so the control plane
		// unmarshals straight into it.
		writeJSON(w, http.StatusOK, map[string]any{
			"cpuPercent": resp.CpuPercent,
			"memUsage":   resp.MemUsage,
			"memLimit":   resp.MemLimit,
			"netInput":   resp.NetInput,
			"netOutput":  resp.NetOutput,
			"pids":       resp.Pids,
		})
		return nil
	})
}

// ── reboot ──────────────────────────────────────────────────────────────────

// ocReboot restarts the sandbox's workload in place.
//
// NOT A KERNEL RESTART, and the difference is worth stating because it is the
// one place this runtime cannot match QEMU. There is no way to restart a
// MicroVM's guest kernel: the box is a snapshot restored by the service, and
// the only "restart" the service offers is launching a different box. The old
// agent-tunnel path implemented reboot as exactly that — export the workspace,
// launch a replacement, import, terminate the original — which costs a ~3.3s
// floor plus the size of the workspace, and silently loses anything the
// customer installed outside /home/sandbox.
//
// This does the thing customers actually want from a reboot — nothing of mine
// is running any more, and the tools are back to a known state — without moving
// any data: kill everything the sandbox user owns, then restart the agent, so
// no process, no shell state and no listening port survives. The disk is
// untouched, so /home/sandbox and anything installed at runtime both persist,
// which is MORE than the old path preserved rather than less.
func (s *server) ocReboot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// The customer's processes, killed by walking /proc rather than shelling
	// out to pkill.
	//
	// pkill IS NOT IN THIS IMAGE. The base is al2023-minimal and the Dockerfile
	// installs nodejs, python3, tar, gzip, ca-certificates and shadow-utils —
	// procps-ng is not among them, so `pkill` (and `ps`, and `pgrep`) exit with
	// "executable file not found". The earlier version of this handler swallowed
	// that as a non-fatal error and went on to report a successful reboot that
	// had killed nothing at all. Found on dev by asking a rebooted sandbox
	// whether its processes were still running.
	//
	// Reading /proc has no such dependency, and is what pkill would have done.
	if n := killSandboxProcesses(); n > 0 {
		log.Printf("microvm-hooks: reboot: killed %d sandbox process(es)", n)
	}

	// Then the agent, so its own state — env set via SetEnvs, open PTYs, exec
	// sessions — goes too. Restarting it is what makes this a reboot rather
	// than a kill.
	s.mu.Lock()
	cmd := s.agentCmd
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	// Drop the pooled connection before the new agent comes up; it points at a
	// listener that no longer exists.
	resetAgentClient()

	// cmd.Wait is already owned by the goroutine in startAgent, so the exit is
	// reaped there. Give the listener a moment to actually go away before
	// rebinding, or the new agent races the old one for the port.
	deadline := time.Now().Add(10 * time.Second)
	for agentUp() && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}

	if err := s.startAgent(); err != nil {
		log.Printf("microvm-hooks: reboot: restart agent: %v", err)
		http.Error(w, "reboot: agent did not restart: "+err.Error(), http.StatusInternalServerError)
		return
	}
	for !agentUp() && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !agentUp() {
		// Say so rather than reporting a reboot that left the box unusable.
		http.Error(w, "reboot: agent did not come back", http.StatusInternalServerError)
		return
	}
	// The agent is new and its env map is empty. Without this, PTY and exec
	// sessions after a reboot see none of the sandbox's variables while
	// /oc/run commands still do — see reapplyEnvsToAgent.
	reapplyEnvsToAgent(r.Context())

	log.Printf("microvm-hooks: reboot ok")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── customer ports ──────────────────────────────────────────────────────────

// ocPort proxies to a port the customer is listening on inside the guest.
//
//	/oc/port/3000/api/users  ->  127.0.0.1:3000/api/users
//
// This is the only way a customer's own server is reachable. Lambda's proxy
// forwards solely to the hook port, so a preview URL cannot simply name the
// customer's port the way it does on QEMU, where the host publishes one — the
// fan-out has to happen in here.
//
// WebSocket and SSE both work: the reverse proxy passes an upgrade through, and
// FlushInterval -1 stops it buffering an event stream into silence.
func (s *server) ocPort(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, ocPortPrefix)
	portStr, tail, _ := strings.Cut(rest, "/")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		http.Error(w, "bad port in path: expected /oc/port/<port>/...", http.StatusBadRequest)
		return
	}
	// Refuse our own ports. Proxying to the hook port is an infinite loop that
	// takes the box's only listener down with it, and the agent's port is not
	// the customer's to reach — it is the whole trust boundary of this design.
	if port == 8080 || port == 8081 {
		http.Error(w, "port is reserved", http.StatusForbidden)
		return
	}

	target := &url.URL{Scheme: "http", Host: "127.0.0.1:" + portStr}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = "/" + tail
			pr.Out.URL.RawQuery = r.URL.RawQuery
			pr.Out.Host = target.Host
			pr.SetXForwarded()
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			// A connection refused here almost always means the customer's
			// server is not listening yet, which is a normal state during
			// startup and worth distinguishing from a broken sandbox.
			log.Printf("microvm-hooks: port %d: %v", port, err)
			http.Error(w, fmt.Sprintf("nothing is listening on port %d", port), http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
}
