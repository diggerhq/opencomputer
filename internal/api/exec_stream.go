package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

func (s *Server) execStream(c echo.Context) error {
	id := c.Param("id")

	// Server mode: dispatch to worker via gRPC streaming
	if s.workerRegistry != nil {
		return s.execStreamRemote(c, id)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	var cfg types.ProcessConfig
	if err := c.Bind(&cfg); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	if cfg.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "cmd is required",
		})
	}

	// Set SSE headers
	w := c.Response()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.Writer.(http.Flusher)
	if !ok {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
	}

	// Keepalive goroutine — sends SSE comments every 15s to prevent
	// client-side timeouts when the command produces no output.
	var writeMu sync.Mutex
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				writeMu.Lock()
				fmt.Fprintf(w, ": keepalive\n\n")
				flusher.Flush()
				writeMu.Unlock()
			}
		}
	}()

	var exitCode int

	routeOp := func(ctx context.Context) error {
		var err error
		exitCode, err = s.manager.ExecStream(ctx, id, cfg, func(chunk types.ExecOutputChunk) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return writeSSEChunk(w, flusher, chunk.Stream, chunk.Data)
		})
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execStream", routeOp); err != nil {
			close(done)
			writeSSEError(w, flusher, err.Error())
			return nil
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			close(done)
			writeSSEError(w, flusher, err.Error())
			return nil
		}
	}
	close(done)

	// Send exit event
	writeSSEExit(w, flusher, exitCode)
	return nil
}

func (s *Server) execStreamRemote(c echo.Context, sandboxID string) error {
	// Wait for sandbox if it's being created asynchronously
	if v, ok := s.pendingCreates.Load(sandboxID); ok {
		pending := v.(*pendingCreate)
		select {
		case <-pending.ready:
			if pending.err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{
					"error": "sandbox creation failed: " + pending.err.Error(),
				})
			}
			s.pendingCreates.Delete(sandboxID)
		case <-c.Request().Context().Done():
			return c.JSON(http.StatusGatewayTimeout, map[string]string{
				"error": "timed out waiting for sandbox creation",
			})
		}
	}

	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	var cfg types.ProcessConfig
	if err := c.Bind(&cfg); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	if cfg.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "cmd is required",
		})
	}

	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": "sandbox not found",
		})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		log.Printf("exec_stream: worker %s unreachable: %v", session.WorkerID, err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "worker unreachable",
		})
	}

	timeout := 60 * time.Second
	if cfg.Timeout > 0 {
		timeout = time.Duration(cfg.Timeout)*time.Second + 5*time.Second
	}
	grpcCtx, cancel := context.WithTimeout(c.Request().Context(), timeout)
	defer cancel()

	streamClient, err := client.ExecCommandStream(grpcCtx, &pb.ExecCommandRequest{
		SandboxId: sandboxID,
		Command:   cfg.Command,
		Args:      cfg.Args,
		Envs:      cfg.Env,
		Cwd:       cfg.Cwd,
		Timeout:   int32(cfg.Timeout),
	})
	if err != nil {
		log.Printf("exec_stream: gRPC stream failed for %s: %v", sandboxID, err)
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	// Set SSE headers
	w := c.Response()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.Writer.(http.Flusher)
	if !ok {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
	}

	// Keepalive goroutine for the gRPC-proxied stream
	var writeMu sync.Mutex
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				writeMu.Lock()
				fmt.Fprintf(w, ": keepalive\n\n")
				flusher.Flush()
				writeMu.Unlock()
			}
		}
	}()

	for {
		chunk, recvErr := streamClient.Recv()
		if recvErr != nil {
			break
		}
		if chunk.Stream == pb.ExecOutputChunk_EXIT {
			close(done)
			writeSSEExit(w, flusher, int(chunk.ExitCode))
			return nil
		}
		stream := "stdout"
		if chunk.Stream == pb.ExecOutputChunk_STDERR {
			stream = "stderr"
		}
		writeMu.Lock()
		err := writeSSEChunk(w, flusher, stream, chunk.Data)
		writeMu.Unlock()
		if err != nil {
			close(done)
			return nil
		}
	}

	close(done)
	return nil
}

// SSE helpers

func writeSSEChunk(w *echo.Response, flusher http.Flusher, stream string, data []byte) error {
	payload, _ := json.Marshal(map[string]string{"data": string(data)})
	_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", stream, payload)
	if err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func writeSSEExit(w *echo.Response, flusher http.Flusher, exitCode int) {
	payload, _ := json.Marshal(map[string]int{"exit_code": exitCode})
	fmt.Fprintf(w, "event: exit\ndata: %s\n\n", payload)
	flusher.Flush()
}

func writeSSEError(w *echo.Response, flusher http.Flusher, msg string) {
	payload, _ := json.Marshal(map[string]string{"error": msg})
	fmt.Fprintf(w, "event: error\ndata: %s\n\n", payload)
	flusher.Flush()
}
