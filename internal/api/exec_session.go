package api

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

func (s *Server) createExecSession(c echo.Context) error {
	if s.execSessionManager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")

	var req types.ExecSessionCreateRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	if req.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "cmd is required",
		})
	}

	var session *sandbox.ExecSessionHandle

	routeOp := func(_ context.Context) error {
		var err error
		session, err = s.execSessionManager.CreateSession(id, req)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execSessionCreate", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.JSON(http.StatusCreated, types.ExecSessionInfo{
		SessionID: session.ID,
		SandboxID: id,
		Command:   session.Command,
		Args:      session.Args,
		Running:   true,
		StartedAt: session.StartedAt.Format(time.RFC3339),
	})
}

func (s *Server) listExecSessions(c echo.Context) error {
	if s.execSessionManager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	sessions := s.execSessionManager.ListSessions(id)

	if sessions == nil {
		sessions = []types.ExecSessionInfo{}
	}

	return c.JSON(http.StatusOK, sessions)
}

func (s *Server) execSessionWebSocket(c echo.Context) error {
	if s.execSessionManager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	sessionID := c.Param("sessionID")

	session, err := s.execSessionManager.GetSession(sessionID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": err.Error(),
		})
	}

	if session.SandboxID != id {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "session not found"})
	}

	if s.router != nil {
		s.router.Touch(id)
	}

	ws, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return err
	}
	defer ws.Close()

	if session.Scrollback == nil {
		// No scrollback (shouldn't happen with Firecracker sessions, but handle gracefully)
		ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "no scrollback"),
			time.Now().Add(time.Second))
		return nil
	}

	// Send scrollback snapshot
	snapshot := session.Scrollback.Snapshot()
	for _, chunk := range snapshot {
		msg := make([]byte, 1+len(chunk.Data))
		msg[0] = chunk.Stream // 1=stdout, 2=stderr
		copy(msg[1:], chunk.Data)
		if err := ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			return nil
		}
	}

	// Send scrollback_end marker (0x04)
	if err := ws.WriteMessage(websocket.BinaryMessage, []byte{0x04}); err != nil {
		return nil
	}

	// Subscribe for live output
	sub := session.Scrollback.Subscribe()
	defer session.Scrollback.Unsubscribe(sub)

	// Read stdin from WebSocket (0x00 prefix)
	wsDone := make(chan struct{})
	go func() {
		defer close(wsDone)
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(raw) < 1 {
				continue
			}
			if raw[0] == 0x00 && len(raw) > 1 && session.StdinWriter != nil {
				session.StdinWriter.Write(raw[1:])
			}
			if s.router != nil {
				s.router.Touch(id)
			}
		}
	}()

	// Send live output and exit code
	for {
		select {
		case chunk, ok := <-sub:
			if !ok {
				return nil
			}
			msg := make([]byte, 1+len(chunk.Data))
			msg[0] = chunk.Stream
			copy(msg[1:], chunk.Data)
			if err := ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return nil
			}
			if s.router != nil {
				s.router.Touch(id)
			}

		case <-session.Done:
			// Drain remaining
			for {
				select {
				case chunk := <-sub:
					msg := make([]byte, 1+len(chunk.Data))
					msg[0] = chunk.Stream
					copy(msg[1:], chunk.Data)
					_ = ws.WriteMessage(websocket.BinaryMessage, msg)
				default:
					goto sendExit
				}
			}
		sendExit:
			// Send exit code: 0x03 + 4-byte big-endian exit code
			exitMsg := make([]byte, 5)
			exitMsg[0] = 0x03
			exitCode := 0
			if session.ExitCode != nil {
				exitCode = *session.ExitCode
			}
			binary.BigEndian.PutUint32(exitMsg[1:], uint32(int32(exitCode)))
			_ = ws.WriteMessage(websocket.BinaryMessage, exitMsg)

			ws.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(time.Second))
			return nil

		case <-wsDone:
			return nil
		}
	}
}

func (s *Server) execRun(c echo.Context) error {
	id := c.Param("id")

	var req types.ProcessConfig
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	if req.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "cmd is required",
		})
	}

	// Server mode: route exec to the worker that owns this sandbox via gRPC
	if s.workerRegistry != nil {
		return s.execRunRemote(c, id, req)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	return respondExecWithHeartbeat(c, func(ctx context.Context) (*types.ProcessResult, error) {
		var result *types.ProcessResult
		op := func(ctx context.Context) error {
			var err error
			result, err = s.manager.Exec(ctx, id, req)
			return err
		}
		if s.router != nil {
			if err := s.router.Route(ctx, id, "execRun", op); err != nil {
				return nil, err
			}
		} else {
			if err := op(ctx); err != nil {
				return nil, err
			}
		}
		return result, nil
	})
}

// Heartbeat tunables (vars, not consts, so tests can shrink them).
var (
	// execHeartbeatGrace is how long we wait for a fast command before
	// committing to a chunked, heartbeat-kept-alive response. The vast majority
	// of commands finish within this window and return with normal status codes.
	execHeartbeatGrace = 20 * time.Second
	// execHeartbeatInterval must stay under Cloudflare's ~100s origin-idle
	// ceiling (a 524 fires if the origin sends no bytes for that long).
	execHeartbeatInterval = 25 * time.Second
)

// respondExecWithHeartbeat runs a synchronous exec and writes its ProcessResult,
// but keeps the HTTP connection warm for long commands so Cloudflare's ~100s
// origin-idle timeout (524) never fires. Fast commands (< execHeartbeatGrace)
// return with normal status codes. For a long command it commits a chunked 200
// and emits whitespace heartbeats every execHeartbeatInterval; leading
// whitespace is valid JSON, so the ProcessResult still decodes unchanged on the
// client. Once committed the status can't signal failure, so a work() error is
// surfaced as a ProcessResult with ExitCode -1 — strictly better than the 524
// it replaces. (The streaming/WebSocket exec session already has a 30s keepalive
// ticker; this brings synchronous exec/run to parity.)
func respondExecWithHeartbeat(c echo.Context, work func(context.Context) (*types.ProcessResult, error)) error {
	type outcome struct {
		res *types.ProcessResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		r, e := work(c.Request().Context())
		done <- outcome{r, e}
	}()

	select {
	case o := <-done:
		if o.err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": o.err.Error()})
		}
		return c.JSON(http.StatusOK, o.res)
	case <-time.After(execHeartbeatGrace):
	}

	resp := c.Response()
	resp.Header().Set("Content-Type", "application/json")
	resp.WriteHeader(http.StatusOK)
	resp.Flush()

	ticker := time.NewTicker(execHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := resp.Write([]byte(" ")); err != nil {
				return nil // client/edge went away — nothing more to do
			}
			resp.Flush()
		case o := <-done:
			res := o.res
			if o.err != nil {
				res = &types.ProcessResult{ExitCode: -1, Stderr: "exec error: " + o.err.Error()}
			}
			body, err := json.Marshal(res)
			if err != nil {
				body = []byte(`{"exitCode":-1,"stderr":"exec: result marshal failed"}`)
			}
			_, _ = resp.Write(body)
			resp.Flush()
			return nil
		}
	}
}

// execRunRemote routes an exec/run request to the worker via gRPC.
func (s *Server) execRunRemote(c echo.Context, sandboxID string, req types.ProcessConfig) error {
	orgID, _ := auth.GetOrgID(c)

	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}
	if session.OrgID != orgID {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}
	if session.Status == "migrating" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "sandbox is migrating, retry shortly",
		})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": fmt.Sprintf("worker unavailable: %v", err),
		})
	}

	// timeout == 0 means no timeout: the command runs unbounded (bounded only by
	// the client connection / sandbox lifetime) and the heartbeat keeps the edge
	// connection alive. An explicit positive timeout is still honored.
	timeout := int32(req.Timeout)

	return respondExecWithHeartbeat(c, func(ctx context.Context) (*types.ProcessResult, error) {
		grpcCtx := ctx
		if timeout > 0 {
			var cancel context.CancelFunc
			grpcCtx, cancel = context.WithTimeout(ctx, time.Duration(timeout+5)*time.Second)
			defer cancel()
		}

		resp, err := client.ExecCommand(grpcCtx, &pb.ExecCommandRequest{
			SandboxId: sandboxID,
			Command:   req.Command,
			Args:      req.Args,
			Envs:      req.Env,
			Cwd:       req.Cwd,
			Timeout:   timeout,
		})
		if err != nil {
			return nil, err
		}
		return &types.ProcessResult{
			ExitCode: int(resp.ExitCode),
			Stdout:   resp.Stdout,
			Stderr:   resp.Stderr,
		}, nil
	})
}

func (s *Server) killExecSession(c echo.Context) error {
	if s.execSessionManager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	sessionID := c.Param("sessionID")

	var body struct {
		Signal int `json:"signal"`
	}
	_ = c.Bind(&body) // optional body

	if body.Signal == 0 {
		body.Signal = 9 // SIGKILL default
	}

	routeOp := func(_ context.Context) error {
		return s.execSessionManager.KillSession(sessionID, body.Signal)
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execSessionKill", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.NoContent(http.StatusNoContent)
}
