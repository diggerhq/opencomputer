package main

// oc_exec.go — long-running exec sessions with a live output stream.
//
// The difference from /oc/run is duration. A run is one command, buffered, one
// reply — fine for the overwhelming majority of what a sandbox is asked to do,
// and useless for `npm run dev`, a training job, or anything a customer wants
// to watch. A session starts a process, keeps it alive across disconnects, and
// streams its output to whoever is attached.
//
// Same shape as the PTY bridge next door, and for the same reason: the gRPC
// stream stays inside the guest, and the customer's side speaks a small JSON
// frame format the proxy can carry. Opened on attach, closed on detach.
//
// The scrollback is the agent's, not ours. It replays what a process has
// already printed when a client attaches, then sends SCROLLBACK_END to mark the
// boundary between history and live output — which is also what makes /result
// below possible without a worker holding a buffer.

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

const (
	ocExecCreate = ocPrefix + "exec/create"
	ocExecAttach = ocPrefix + "exec/attach"
	ocExecList   = ocPrefix + "exec/list"
	ocExecKill   = ocPrefix + "exec/kill"
	ocExecResult = ocPrefix + "exec/result"
)

// execSessionRequest is the body of the unary exec-session endpoints.
type execSessionRequest struct {
	SessionID             string            `json:"sessionId,omitempty"`
	Command               string            `json:"cmd,omitempty"`
	Args                  []string          `json:"args,omitempty"`
	Env                   map[string]string `json:"envs,omitempty"`
	Cwd                   string            `json:"cwd,omitempty"`
	TimeoutSec            int32             `json:"timeoutSec,omitempty"`
	MaxRunAfterDisconnect int32             `json:"maxRunAfterDisconnect,omitempty"`
	Signal                int32             `json:"signal,omitempty"`
}

// execFrame is one message from the session's output stream.
//
// The stream field is the whole reason this is framed rather than raw: stdout
// and stderr arrive interleaved on one connection and a customer redirecting
// one but not the other needs them told apart. `scrollbackEnd` marks where
// replayed history stops and live output starts, which is what lets a client
// render "catching up" distinctly from "watching".
type execFrame struct {
	Stream   string `json:"stream,omitempty"` // stdout | stderr | exit | scrollbackEnd
	Data     string `json:"data,omitempty"`   // base64
	ExitCode int32  `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

func streamName(t pb.ExecSessionOutput_Type) string {
	switch t {
	case pb.ExecSessionOutput_STDOUT:
		return "stdout"
	case pb.ExecSessionOutput_STDERR:
		return "stderr"
	case pb.ExecSessionOutput_EXIT:
		return "exit"
	case pb.ExecSessionOutput_SCROLLBACK_END:
		return "scrollbackEnd"
	}
	return "stdout"
}

func (s *server) registerOCExec(mux *http.ServeMux) {
	mux.HandleFunc(ocExecCreate, s.ocExecCreate)
	mux.HandleFunc(ocExecAttach, s.ocExecAttach)
	mux.HandleFunc(ocExecList, s.ocExecList)
	mux.HandleFunc(ocExecKill, s.ocExecKill)
	mux.HandleFunc(ocExecResult, s.ocExecResult)
}

func (s *server) ocExecCreate(w http.ResponseWriter, r *http.Request) {
	var req execSessionRequest
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		http.Error(w, "cmd is required", http.StatusBadRequest)
		return
	}
	withAgent(w, "exec/create", func(c pb.SandboxAgentClient) error {
		resp, err := c.ExecSessionCreate(r.Context(), &pb.ExecSessionCreateRequest{
			Command:               req.Command,
			Args:                  req.Args,
			Envs:                  req.Env,
			Cwd:                   req.Cwd,
			TimeoutSeconds:        req.TimeoutSec,
			MaxRunAfterDisconnect: req.MaxRunAfterDisconnect,
		})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessionId": resp.SessionId})
		return nil
	})
}

func (s *server) ocExecList(w http.ResponseWriter, r *http.Request) {
	withAgent(w, "exec/list", func(c pb.SandboxAgentClient) error {
		resp, err := c.ExecSessionList(r.Context(), &pb.ExecSessionListRequest{})
		if err != nil {
			return err
		}
		out := make([]map[string]any, 0, len(resp.Sessions))
		for _, sess := range resp.Sessions {
			out = append(out, map[string]any{
				"sessionId":       sess.SessionId,
				"command":         sess.Command,
				"args":            sess.Args,
				"running":         sess.Running,
				"exitCode":        sess.ExitCode,
				"startedAt":       sess.StartedAt,
				"attachedClients": sess.AttachedClients,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
		return nil
	})
}

func (s *server) ocExecKill(w http.ResponseWriter, r *http.Request) {
	var req execSessionRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "exec/kill", func(c pb.SandboxAgentClient) error {
		if _, err := c.ExecSessionKill(r.Context(), &pb.ExecSessionKillRequest{
			SessionId: req.SessionID, Signal: req.Signal,
		}); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	})
}

// ocExecResult reports a session's output so far WITHOUT holding a stream open.
//
// This is the async-poll path: start something, come back later, ask what
// happened. The worker-backed fleet answers it from a buffer the worker keeps;
// there is no worker here, so it is synthesised from the agent's own scrollback
// — attach, read the replay, stop at SCROLLBACK_END. That marker is what makes
// this terminate: without it there is no way to tell "this is history" from
// "the process is quiet right now", and the poll would hang until timeout.
func (s *server) ocExecResult(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "sessionId is required", http.StatusBadRequest)
		return
	}
	withAgent(w, "exec/result", func(c pb.SandboxAgentClient) error {
		ctx, cancel := contextWithTimeout(r, 30*time.Second)
		defer cancel()
		stream, err := c.ExecSessionAttach(ctx)
		if err != nil {
			return err
		}
		if err := stream.Send(&pb.ExecSessionInput{SessionId: sessionID}); err != nil {
			return err
		}
		// Half-close immediately: this is a read-only look at the session, and
		// leaving the send side open would keep it counted as an attached
		// client, which changes when the agent tears a finished session down.
		_ = stream.CloseSend()

		var stdout, stderr []byte
		running := true
		var exitCode *int32
		for {
			out, rerr := stream.Recv()
			if rerr != nil {
				if rerr == io.EOF {
					break
				}
				return rerr
			}
			switch out.Type {
			case pb.ExecSessionOutput_STDOUT:
				stdout = append(stdout, out.Data...)
			case pb.ExecSessionOutput_STDERR:
				stderr = append(stderr, out.Data...)
			case pb.ExecSessionOutput_EXIT:
				running = false
				code := out.ExitCode
				exitCode = &code
			case pb.ExecSessionOutput_SCROLLBACK_END:
				// Everything before this is history; everything after is live
				// output we are not here to wait for.
				goto done
			}
		}
	done:
		body := map[string]any{"running": running, "stdout": stdout, "stderr": stderr}
		if exitCode != nil {
			body["exitCode"] = *exitCode
		}
		writeJSON(w, http.StatusOK, body)
		return nil
	})
}

// ocExecAttach bridges a customer WebSocket to a session's output stream.
//
//	/oc/exec/attach?sessionId=…
func (s *server) ocExecAttach(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "sessionId is required", http.StatusBadRequest)
		return
	}
	client, err := agentClient()
	if err != nil {
		http.Error(w, "agent unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}

	ws, err := (&websocket.Upgrader{
		ReadBufferSize:  32 * 1024,
		WriteBufferSize: 32 * 1024,
		CheckOrigin:     func(*http.Request) bool { return true },
	}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	stream, err := client.ExecSessionAttach(r.Context())
	if err != nil {
		_ = ws.WriteJSON(execFrame{Stream: "exit", Error: "attach: " + err.Error()})
		return
	}
	// Session id on the first message, per the proto.
	if err := stream.Send(&pb.ExecSessionInput{SessionId: sessionID}); err != nil {
		_ = ws.WriteJSON(execFrame{Stream: "exit", Error: "attach: " + err.Error()})
		return
	}

	// One writer. gorilla allows exactly one concurrent writer and both halves
	// below can produce one.
	var writeMu sync.Mutex
	send := func(f execFrame) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return ws.WriteJSON(f)
	}

	done := make(chan struct{})

	// agent -> customer
	go func() {
		defer close(done)
		for {
			out, rerr := stream.Recv()
			if rerr != nil {
				if rerr != io.EOF && !strings.Contains(rerr.Error(), "context canceled") {
					_ = send(execFrame{Stream: "exit", Error: rerr.Error()})
				}
				return
			}
			f := execFrame{Stream: streamName(out.Type), ExitCode: out.ExitCode}
			if len(out.Data) > 0 {
				f.Data = b64(out.Data)
			}
			if err := send(f); err != nil {
				return
			}
			if out.Type == pb.ExecSessionOutput_EXIT {
				return
			}
		}
	}()

	// customer -> agent (stdin)
	for {
		select {
		case <-done:
			return
		default:
		}
		_, msg, rerr := ws.ReadMessage()
		if rerr != nil {
			// Detach, do NOT kill: a session outlives its clients by design —
			// that is what maxRunAfterDisconnect is for. Closing the send side
			// tells the agent this client is gone without touching the process.
			_ = stream.CloseSend()
			<-done
			return
		}
		var f clientFrame
		if err := json.Unmarshal(msg, &f); err != nil {
			continue
		}
		if f.Data == "" {
			continue
		}
		data, derr := unb64(f.Data)
		if derr != nil {
			continue
		}
		if err := stream.Send(&pb.ExecSessionInput{SessionId: sessionID, Stdin: data}); err != nil {
			<-done
			return
		}
	}
}
