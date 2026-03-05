package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func (s *HTTPServer) execStream(c echo.Context) error {
	id := c.Param("id")

	var cfg types.ProcessConfig
	if err := c.Bind(&cfg); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if cfg.Command == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "cmd is required"})
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

	// Start keepalive goroutine — sends SSE comments every 15s to prevent
	// client-side timeouts when the command produces no output (e.g. npm install).
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
			return workerWriteSSEChunk(w, flusher, chunk.Stream, chunk.Data)
		})
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "execStream", routeOp); err != nil {
			close(done)
			workerWriteSSEError(w, flusher, err.Error())
			return nil
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			close(done)
			workerWriteSSEError(w, flusher, err.Error())
			return nil
		}
	}
	close(done)

	// Send exit event
	workerWriteSSEExit(w, flusher, exitCode)
	return nil
}

func workerWriteSSEChunk(w *echo.Response, flusher http.Flusher, stream string, data []byte) error {
	payload, _ := json.Marshal(map[string]string{"data": string(data)})
	_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", stream, payload)
	if err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func workerWriteSSEExit(w *echo.Response, flusher http.Flusher, exitCode int) {
	payload, _ := json.Marshal(map[string]int{"exit_code": exitCode})
	fmt.Fprintf(w, "event: exit\ndata: %s\n\n", payload)
	flusher.Flush()
}

func workerWriteSSEError(w *echo.Response, flusher http.Flusher, msg string) {
	payload, _ := json.Marshal(map[string]string{"error": msg})
	fmt.Fprintf(w, "event: error\ndata: %s\n\n", payload)
	flusher.Flush()
}
