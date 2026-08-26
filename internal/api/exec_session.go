package api

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
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

	// MicroVM-backed sandboxes are served in-process, checked before the worker
	// dispatch below for the same reason as in execRunAsyncRoute: their
	// worker_id names no registered worker, so execRunRemote can only fail with
	// "no gRPC connection to worker microvm:<id>".
	if mgr, ok := s.execManagerFor(id); ok {
		return s.execRunMicrovm(c, mgr, id, req)
	}

	// Server mode: route exec to the worker that owns this sandbox via gRPC
	if s.workerRegistry != nil {
		return s.execRunRemote(c, id, req)
	}

	// POST /exec/run is the synchronous one-shot endpoint, kept for SDK versions
	// that predate the async flow. Newer SDKs POST /exec/run-async, which returns
	// a handle immediately and is polled via /result (see execRunAsyncRoute).
	// managerFor, not s.manager: on a control plane serving a registered backend
	// s.manager is nil, and reading it directly answers "not available in
	// server-only mode" for a sandbox that is running fine.
	mgr := s.managerFor(c)
	if mgr == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	var result *types.ProcessResult

	routeOp := func(ctx context.Context) error {
		var err error
		result, err = mgr.Exec(ctx, id, req)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execRun", routeOp); err != nil {
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

	return c.JSON(http.StatusOK, result)
}

// execHoldMs reads a hold duration override (milliseconds) from env, falling
// back to def. "0" disables the hold. Default-on so the fast-exec path needs
// no config; the env exists as an escape hatch.
func execHoldMs(env string, def time.Duration) time.Duration {
	if v := os.Getenv(env); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms >= 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return def
}

// awaitExecDone polls for command completion (in addition to selecting on Done)
// so a laggy/absent Done close can't pin the hold for its full window when the
// command has finished. Twin of the worker HTTPServer.awaitExecDone; see it for
// the rationale. GetResult is a cheap in-map read for a live session.
func (s *Server) awaitExecDone(ctx context.Context, id, sessionID string, hold time.Duration) (*types.ExecSessionResult, bool) {
	if res, err := s.execSessionManager.GetResult(id, sessionID); err == nil && !res.Running {
		return res, true
	}
	var doneCh <-chan struct{}
	if sess, err := s.execSessionManager.GetSession(sessionID); err == nil {
		doneCh = sess.Done
	}
	deadline := time.NewTimer(hold)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-doneCh:
			res, err := s.execSessionManager.GetResult(id, sessionID)
			if err == nil && !res.Running {
				return res, true
			}
			doneCh = nil
		case <-tick.C:
			if res, err := s.execSessionManager.GetResult(id, sessionID); err == nil && !res.Running {
				return res, true
			}
		case <-deadline.C:
			return nil, false
		case <-ctx.Done():
			return nil, false
		}
	}
}

// execRunAsyncRoute handles POST /exec/run-async — the async exec entrypoint.
// It binds the request and dispatches a background exec session, returning a
// handle immediately. Newer SDKs poll GET /exec/:execId/result for completion;
// POST /exec/run stays synchronous for older SDKs.
func (s *Server) execRunAsyncRoute(c echo.Context) error {
	id := c.Param("id")

	var req types.ProcessConfig
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if req.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "cmd is required"})
	}
	// MicroVM-backed sandboxes are served in-process by the awsvm manager
	// instead of being dispatched to a worker. Checked before the
	// execSessionManager guard because that manager is part of the worker path
	// and is legitimately nil on a MicroVM-only cell.
	if mgr, ok := s.execManagerFor(id); ok {
		return s.execRunMicrovm(c, mgr, id, req)
	}
	if s.execSessionManager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}
	return s.execRunAsync(c, id, req)
}

// execRunMicrovm runs a command on a MicroVM-backed sandbox and answers inline.
//
// The async/poll ladder exists because the worker path could not answer within
// one request. Here it can: the agent tunnel is already open, so a command is a
// single ~83ms round trip. Returning the completed ExecRunResult directly lets
// the SDK short-circuit its poll loop — the same contract as the worker path's
// inline-hold fast path, reached without the hold.
func (s *Server) execRunMicrovm(c echo.Context, mgr sandbox.Manager, sandboxID string, req types.ProcessConfig) error {
	res, err := mgr.Exec(c.Request().Context(), sandboxID, req)
	if err != nil {
		log.Printf("microvm: exec %s failed: %v", sandboxID, err)
		return respondManagerErr(c, err)
	}
	if s.router != nil {
		s.router.Touch(sandboxID) // keep the idle timer honest, as the worker path does
	}
	return c.JSON(http.StatusOK, types.ExecRunResult{
		Running:  false,
		ExitCode: &res.ExitCode,
		Stdout:   res.Stdout,
		Stderr:   res.Stderr,
	})
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

	timeout := int32(req.Timeout)
	if timeout <= 0 {
		timeout = 30
	}

	grpcCtx, cancel := context.WithTimeout(c.Request().Context(), time.Duration(timeout+5)*time.Second)
	defer cancel()

	resp, err := client.ExecCommand(grpcCtx, &pb.ExecCommandRequest{
		SandboxId: sandboxID,
		Command:   req.Command,
		Args:      req.Args,
		Envs:      req.Env,
		Cwd:       req.Cwd,
		Timeout:   timeout,
	})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, &types.ProcessResult{
		ExitCode: int(resp.ExitCode),
		Stdout:   resp.Stdout,
		Stderr:   resp.Stderr,
	})
}

// execRunAsync runs a command as a background exec session and returns a handle
// immediately. Mirrors createExecSession but maps the ProcessConfig shape and
// returns an ExecRunResponse. The command keeps running independent of this
// connection; the result persists on the worker (scrollback + exit code, with
// the agent's 5-min post-exit retention) and is fetched via execResult.
func (s *Server) execRunAsync(c echo.Context, id string, req types.ProcessConfig) error {
	sreq := types.ExecSessionCreateRequest{
		Command: req.Command,
		Args:    req.Args,
		Env:     req.Env,
		Cwd:     req.Cwd,
		Timeout: req.Timeout,
	}

	// Exec is half of TTI and was the only leg with no per-step timing, so a
	// burst that degraded here looked the same as one that degraded in create.
	// `enter` separates "this handler is slow" from "the queue is upstream".
	tr := newExecTrace()
	tr.setSandboxID(id)
	defer tr.emit()

	var session *sandbox.ExecSessionHandle

	routeOp := func(_ context.Context) error {
		var err error
		session, err = s.execSessionManager.CreateSession(id, sreq)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execRun", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
	}
	// Everything up to here is route + CreateSession — the dial/bind to the box.
	tr.mark("session")

	// Fast-exec fold: hold the response briefly and, if the command exits inside
	// the window, return the legacy inline result shape (no execId). The SDK's
	// run() short-circuits on that shape, so short commands cost one round trip
	// instead of run-async + a result poll (and its 200/400ms retry ladder).
	// session.Done closes only after consumeExecOutput has captured ExitCode,
	// so the GetResult read below is final. Truncated output falls through to
	// the handle shape — ProcessResult can't carry the truncated flag.
	if hold := execHoldMs("OPENSANDBOX_EXEC_INLINE_HOLD_MS", 400*time.Millisecond); hold > 0 {
		res, ok := s.awaitExecDone(c.Request().Context(), id, session.ID, hold)
		// `hold` is the command actually running when it lands well under the
		// budget, and the full hold budget when it does not — so a value pinned
		// at the budget means the fold MISSED and the client fell onto its poll.
		tr.mark("hold")
		if ok && res.ExitCode != nil && !res.Truncated {
			tr.mark("inline")
			return c.JSON(http.StatusOK, types.ProcessResult{
				ExitCode: *res.ExitCode,
				Stdout:   string(res.Stdout),
				Stderr:   string(res.Stderr),
			})
		}
		tr.mark("holdmiss")
	}

	return c.JSON(http.StatusAccepted, types.ExecRunResponse{
		ExecID:    session.ID,
		Running:   true,
		StartedAt: session.StartedAt.Format(time.RFC3339),
	})
}

// execResult returns the current state of an async exec/run session — the
// load-bearing poll endpoint behind SDK exec.run(). Long-polls: a still-running
// command holds the response up to OPENSANDBOX_EXEC_RESULT_HOLD_MS (default
// 500ms) before answering, so fast commands land on the first poll. The result
// is read straight from the in-VM agent (authoritative), so a dropped worker
// attach stream can't leave it stuck reporting running:true forever.
func (s *Server) execResult(c echo.Context) error {
	if s.execSessionManager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	sessionID := c.Param("sessionID")

	// A poll only happens when the inline fold missed, so these lines appearing
	// at all is itself the signal — and their count says how deep the SDK's
	// retry ladder went.
	tr := newTrace("resulttrace")
	tr.setSandboxID(id)
	defer tr.emit()

	var res *types.ExecSessionResult

	routeOp := func(_ context.Context) error {
		var err error
		res, err = s.execSessionManager.GetResult(id, sessionID)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execResult", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
	}

	// Long-poll: if the command is still running, hold until it exits (or the
	// hold elapses) and re-read, so the SDK's first poll catches commands that
	// outran the run-async inline hold instead of falling onto its 200/400ms
	// retry ladder. Done closes only after ExitCode is captured, so the re-read
	// is final. Route already ensured the sandbox is running; the re-read is a
	// local scrollback+exit-code snapshot, no re-route needed.
	tr.mark("read")
	if res.Running {
		if hold := execHoldMs("OPENSANDBOX_EXEC_RESULT_HOLD_MS", 500*time.Millisecond); hold > 0 {
			if res2, ok := s.awaitExecDone(c.Request().Context(), id, sessionID, hold); ok {
				res = res2
			}
			tr.mark("longpoll")
			if s.router != nil {
				s.router.Touch(id) // the hold was interaction; keep the idle timer honest
			}
		}
	}

	return c.JSON(http.StatusOK, types.ExecRunResult{
		Running:   res.Running,
		ExitCode:  res.ExitCode,
		Stdout:    string(res.Stdout),
		Stderr:    string(res.Stderr),
		Truncated: res.Truncated,
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
