package api

// exec_session_managed.go — exec sessions for a backend the control plane holds.
//
// Same shape as pty_managed.go, and it reuses its splice: a session's stream and
// a terminal's differ in what the frames MEAN, not in how they travel, and the
// control plane is deliberately not in the business of understanding either.
// Both sides — the customer's SDK and the guest — already agree on the format;
// anything interpreted here would be a second implementation of it, on the path
// where a bug shows up as garbled output rather than an error.

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/awsvmlite"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// execSessionBackend is implemented by a backend that runs sessions itself.
type execSessionBackend interface {
	ExecSessionCreate(ctx context.Context, sandboxID string, req awsvmlite.ExecSessionRequest) (string, error)
	ExecSessionList(ctx context.Context, sandboxID string) ([]awsvmlite.ExecSessionInfo, error)
	ExecSessionKill(ctx context.Context, sandboxID, sessionID string, signal int32) error
	ExecSessionGetResult(ctx context.Context, sandboxID, sessionID string) (*awsvmlite.ExecSessionResult, error)
	DialExecSession(ctx context.Context, sandboxID, sessionID string) (*websocket.Conn, error)
}

func (s *Server) execSessionBackendFor(ctx context.Context, sandboxID string) (execSessionBackend, bool) {
	b, _, ok := s.backendFor(ctx, sandboxID)
	if !ok {
		return nil, false
	}
	eb, ok := b.(execSessionBackend)
	return eb, ok
}

// dispatchExecSession serves a session route locally when a managed backend
// holds the sandbox, and otherwise falls through — to the worker proxy in
// server mode, or to the existing local handler on a cell that has a session
// manager of its own.
func (s *Server) dispatchExecSession(local, fallback echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if _, ok := s.execSessionBackendFor(c.Request().Context(), c.Param("id")); ok {
			return local(c)
		}
		return fallback(c)
	}
}

func (s *Server) createExecSessionManaged(c echo.Context) error {
	id := c.Param("id")
	b, ok := s.execSessionBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "exec sessions are not supported for this sandbox"})
	}
	var req types.ExecSessionCreateRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if req.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "cmd is required"})
	}
	sessionID, err := b.ExecSessionCreate(c.Request().Context(), id, awsvmlite.ExecSessionRequest{
		Command:               req.Command,
		Args:                  req.Args,
		Env:                   req.Env,
		Cwd:                   req.Cwd,
		TimeoutSec:            int32(req.Timeout),
		MaxRunAfterDisconnect: int32(req.MaxRunAfterDisconnect),
	})
	if err != nil {
		return respondFSErr(c, err)
	}
	return c.JSON(http.StatusCreated, types.ExecSessionInfo{SessionID: sessionID, SandboxID: id, Command: req.Command, Args: req.Args, Running: true})
}

func (s *Server) listExecSessionsManaged(c echo.Context) error {
	id := c.Param("id")
	b, ok := s.execSessionBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "exec sessions are not supported for this sandbox"})
	}
	sessions, err := b.ExecSessionList(c.Request().Context(), id)
	if err != nil {
		return respondFSErr(c, err)
	}
	out := make([]types.ExecSessionInfo, 0, len(sessions))
	for _, sess := range sessions {
		info := types.ExecSessionInfo{
			SessionID:       sess.SessionID,
			SandboxID:       id,
			Command:         sess.Command,
			Args:            sess.Args,
			Running:         sess.Running,
			AttachedClients: sess.AttachedClients,
		}
		if sess.StartedAt > 0 {
			info.StartedAt = time.Unix(sess.StartedAt, 0).UTC().Format(time.RFC3339)
		}
		// Only meaningful once the process has exited; reporting 0 for a running
		// command reads as "succeeded".
		if !sess.Running {
			code := int(sess.ExitCode)
			info.ExitCode = &code
		}
		out = append(out, info)
	}
	// A bare array, matching the worker-backed handler
	// (exec_session.go's listExecSessions). The SDK types this response as
	// ExecSessionInfo[] and does no unwrapping, so wrapping it in
	// {"sessions": …} made exec.list() return an object where the caller — and
	// TypeScript — expected a list. Every .find/.filter on it silently blew up,
	// and only on this runtime.
	if out == nil {
		// Never null: `for (const s of null)` is a crash, whereas an empty list
		// is the honest answer for a sandbox with no sessions.
		out = []types.ExecSessionInfo{}
	}
	return c.JSON(http.StatusOK, out)
}

func (s *Server) killExecSessionManaged(c echo.Context) error {
	id, sessionID := c.Param("id"), c.Param("sessionID")
	b, ok := s.execSessionBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "exec sessions are not supported for this sandbox"})
	}
	var signal int32
	if raw := c.QueryParam("signal"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			signal = int32(n)
		}
	}
	if err := b.ExecSessionKill(c.Request().Context(), id, sessionID, signal); err != nil {
		return respondFSErr(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

func (s *Server) execResultManaged(c echo.Context) error {
	id, sessionID := c.Param("id"), c.Param("sessionID")
	b, ok := s.execSessionBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "exec sessions are not supported for this sandbox"})
	}
	res, err := b.ExecSessionGetResult(c.Request().Context(), id, sessionID)
	if err != nil {
		return respondFSErr(c, err)
	}
	out := types.ExecSessionResult{
		Running: res.Running,
		Stdout:  res.Stdout,
		Stderr:  res.Stderr,
	}
	if res.ExitCode != nil {
		code := int(*res.ExitCode)
		out.ExitCode = &code
	}
	return c.JSON(http.StatusOK, out)
}

// execSessionWebSocketManaged splices the customer's socket to the session's.
//
// Dial before upgrade, for the same reason as the PTY path: a 101 cannot be
// retracted, so a box that refuses has to be reportable as an ordinary status.
func (s *Server) execSessionWebSocketManaged(c echo.Context) error {
	id, sessionID := c.Param("id"), c.Param("sessionID")
	b, ok := s.execSessionBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "exec sessions are not supported for this sandbox"})
	}

	// Not the request context: it dies with the handler, and this socket has to
	// live for the length of the attachment.
	box, err := b.DialExecSession(context.Background(), id, sessionID)
	if err != nil {
		log.Printf("exec session: dial %s/%s: %v", id, sessionID, err)
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "could not attach to the session"})
	}
	defer box.Close()

	client, err := ptyUpgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		log.Printf("exec session: upgrade %s/%s: %v", id, sessionID, err)
		return nil
	}
	defer client.Close()

	// Translated, like the PTY path and for the same reason: the guest frames
	// its output as JSON so stdout and stderr stay distinguishable on one
	// connection, while the customer-facing contract set by the QEMU path is
	// binary — a leading stream byte, 0x04 for end-of-scrollback, 0x03 plus a
	// big-endian exit code. Same SDK on both runtimes, so the difference must
	// die here rather than reach it.
	done := make(chan struct{}, 2)
	go pumpExecToClient(client, box, done)
	go pumpExecToBox(box, client, done)
	<-done

	// Detaching closes both sockets, which the guest reads as this client
	// leaving. The SESSION is untouched — it outlives its clients by design.
	_ = client.SetReadDeadline(time.Now())
	_ = box.SetReadDeadline(time.Now())
	return nil
}

// execGuestFrame mirrors cmd/microvm-hooks' execFrame — a private copy, because
// it is a wire contract with a separately-deployed binary.
type execGuestFrame struct {
	Stream   string `json:"stream,omitempty"` // stdout | stderr | exit | scrollbackEnd
	Data     string `json:"data,omitempty"`   // base64
	ExitCode int32  `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Stream markers on the customer-facing side. Defined here next to the
// translation that emits them so the two cannot drift apart silently.
const (
	execStreamStdout  byte = 0x01
	execStreamStderr  byte = 0x02
	execStreamExit    byte = 0x03
	execScrollbackEnd byte = 0x04
)

// pumpExecToClient converts the guest's JSON frames into the binary framing the
// SDK decodes.
func pumpExecToClient(client, box *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		_, msg, err := box.ReadMessage()
		if err != nil {
			return
		}
		var f execGuestFrame
		if err := json.Unmarshal(msg, &f); err != nil {
			// Unrecognised: pass it through rather than drop it, so a guest
			// that ever speaks the binary protocol directly still works.
			if err := client.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return
			}
			continue
		}

		switch f.Stream {
		case "stdout", "stderr":
			data, dErr := base64.StdEncoding.DecodeString(f.Data)
			if dErr != nil {
				continue
			}
			marker := execStreamStdout
			if f.Stream == "stderr" {
				marker = execStreamStderr
			}
			out := make([]byte, 1+len(data))
			out[0] = marker
			copy(out[1:], data)
			if err := client.WriteMessage(websocket.BinaryMessage, out); err != nil {
				return
			}
		case "scrollbackEnd":
			if err := client.WriteMessage(websocket.BinaryMessage, []byte{execScrollbackEnd}); err != nil {
				return
			}
		case "exit":
			out := make([]byte, 5)
			out[0] = execStreamExit
			binary.BigEndian.PutUint32(out[1:], uint32(f.ExitCode))
			_ = client.WriteMessage(websocket.BinaryMessage, out)
			// The command is over. Returning closes the socket, which is how
			// the SDK's `done` promise settles.
			return
		}
	}
}

// pumpExecToBox wraps the customer's stdin into the guest's frames.
func pumpExecToBox(box, client *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		_, msg, err := client.ReadMessage()
		if err != nil {
			return
		}
		frame, mErr := json.Marshal(ptyClientFrame{Data: base64.StdEncoding.EncodeToString(msg)})
		if mErr != nil {
			return
		}
		if err := box.WriteMessage(websocket.TextMessage, frame); err != nil {
			return
		}
	}
}
