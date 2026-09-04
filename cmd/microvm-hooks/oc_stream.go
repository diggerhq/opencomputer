package main

// oc_stream.go — PTY and streaming exec, over one WebSocket per session.
//
// These are the two things the direct path could not do, because both are
// bidirectional streams and the whole design is one request in, one reply out.
//
// The tunnel that carries them ALREADY EXISTS in this image: handleAgentTunnel
// splices a WebSocket to the agent's gRPC listener, and it works through the
// proxy. What made it a liability on the agent path was not the tunnel — it was
// that the tunnel was ALWAYS ON: one pre-dialed channel per box, keepalives, a
// re-dial ladder, and a Durable Object holding sockets open, all of it decaying
// whether or not anyone was using it. Measured consequence: a box answering
// /healthz in 90ms while the control plane logged it as tunnel-less.
//
// So these endpoints translate instead. The customer's side is a plain
// WebSocket carrying our own small frame format; the gRPC stream to the agent
// lives entirely inside the guest, for exactly as long as the session does, and
// nothing survives it. Create and exec never touch any of this.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

const (
	ocPTYCreate = ocPrefix + "pty/create"
	ocPTYAttach = ocPrefix + "pty/attach"
	ocPTYResize = ocPrefix + "pty/resize"
	ocPTYKill   = ocPrefix + "pty/kill"
)

// ptyRequest is the JSON body of the unary PTY endpoints. One shape for all
// three, matching the agent's proto fields.
type ptyRequest struct {
	SessionID string `json:"sessionId,omitempty"`
	Cols      int32  `json:"cols,omitempty"`
	Rows      int32  `json:"rows,omitempty"`
	Shell     string `json:"shell,omitempty"`
}

// clientFrame is what the customer's side sends over the attach socket.
//
// A framed protocol rather than raw bytes because a PTY needs an out-of-band
// resize: a terminal that cannot be resized renders every full-screen program
// wrong the moment the window changes. Raw bytes would have no room to say so.
type clientFrame struct {
	Data string `json:"data,omitempty"` // base64 stdin
	Cols int32  `json:"cols,omitempty"`
	Rows int32  `json:"rows,omitempty"`
}

// serverFrame is what goes back.
type serverFrame struct {
	Data     string `json:"data,omitempty"` // base64 stdout
	Exited   bool   `json:"exited,omitempty"`
	ExitCode int32  `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

func (s *server) registerOCStream(mux *http.ServeMux) {
	mux.HandleFunc(ocPTYCreate, s.ocPTYCreate)
	mux.HandleFunc(ocPTYAttach, s.ocPTYAttach)
	mux.HandleFunc(ocPTYResize, s.ocPTYResize)
	mux.HandleFunc(ocPTYKill, s.ocPTYKill)
	s.registerOCExec(mux)
	mux.HandleFunc(ocWorkspaceExport, s.ocWorkspaceExport)
	mux.HandleFunc(ocWorkspaceImport, s.ocWorkspaceImport)
}

func (s *server) ocPTYCreate(w http.ResponseWriter, r *http.Request) {
	var req ptyRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "pty/create", func(c pb.SandboxAgentClient) error {
		resp, err := c.PTYCreate(r.Context(), &pb.PTYCreateRequest{
			Cols: req.Cols, Rows: req.Rows, Shell: req.Shell,
		})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessionId": resp.SessionId})
		return nil
	})
}

func (s *server) ocPTYResize(w http.ResponseWriter, r *http.Request) {
	var req ptyRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "pty/resize", func(c pb.SandboxAgentClient) error {
		if _, err := c.PTYResize(r.Context(), &pb.PTYResizeRequest{
			SessionId: req.SessionID, Cols: req.Cols, Rows: req.Rows,
		}); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	})
}

func (s *server) ocPTYKill(w http.ResponseWriter, r *http.Request) {
	var req ptyRequest
	if !decode(w, r, &req) {
		return
	}
	withAgent(w, "pty/kill", func(c pb.SandboxAgentClient) error {
		if _, err := c.PTYKill(r.Context(), &pb.PTYKillRequest{SessionId: req.SessionID}); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	})
}

// ocPTYAttach bridges a customer WebSocket to the agent's PTYAttach stream.
//
//	/oc/pty/attach?sessionId=…
//
// The gRPC stream is opened here, inside the guest, and closed when the socket
// closes. Nothing outside the box ever speaks gRPC, so the proxy's trailer
// stripping is irrelevant — the status of this stream is the WebSocket's own
// close, which the proxy does forward.
func (s *server) ocPTYAttach(w http.ResponseWriter, r *http.Request) {
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
		// The proxy is the only route in and it has already authenticated the
		// caller's token, so there is no origin to check against.
		CheckOrigin: func(*http.Request) bool { return true },
	}).Upgrade(w, r, nil)
	if err != nil {
		log.Printf("microvm-hooks: pty attach upgrade: %v", err)
		return
	}
	defer ws.Close()

	// Bound to the request context so the stream dies with the socket rather
	// than leaking a goroutine and a PTY per disconnect.
	stream, err := client.PTYAttach(r.Context())
	if err != nil {
		_ = ws.WriteJSON(serverFrame{Error: "pty attach: " + err.Error()})
		return
	}

	// The session id rides on the first message, per the proto. Sent before any
	// customer input so the agent knows which PTY this is even if the customer
	// types nothing.
	if err := stream.Send(&pb.PTYInput{SessionId: sessionID}); err != nil {
		_ = ws.WriteJSON(serverFrame{Error: "pty attach: " + err.Error()})
		return
	}

	// One writer goroutine. gorilla/websocket permits exactly one concurrent
	// writer, and both directions below can produce a write — a mutex is the
	// difference between a working terminal and a corrupted frame under load.
	var writeMu sync.Mutex
	send := func(f serverFrame) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return ws.WriteJSON(f)
	}

	done := make(chan struct{})

	// agent -> customer
	go func() {
		defer close(done)
		for {
			out, err := stream.Recv()
			if err != nil {
				if err != io.EOF && !strings.Contains(err.Error(), "context canceled") {
					_ = send(serverFrame{Error: err.Error()})
				}
				return
			}
			f := serverFrame{Exited: out.Exited, ExitCode: out.ExitCode}
			if len(out.Data) > 0 {
				f.Data = b64(out.Data)
			}
			if err := send(f); err != nil {
				return
			}
			if out.Exited {
				return
			}
		}
	}()

	// customer -> agent
	for {
		select {
		case <-done:
			return
		default:
		}
		_, msg, err := ws.ReadMessage()
		if err != nil {
			_ = stream.CloseSend()
			<-done
			return
		}
		var f clientFrame
		if err := json.Unmarshal(msg, &f); err != nil {
			continue // a malformed frame is not worth killing a terminal over
		}
		in := &pb.PTYInput{SessionId: sessionID, Cols: f.Cols, Rows: f.Rows}
		if f.Data != "" {
			data, derr := unb64(f.Data)
			if derr != nil {
				continue
			}
			in.Stdin = data
		}
		if err := stream.Send(in); err != nil {
			<-done
			return
		}
	}
}
