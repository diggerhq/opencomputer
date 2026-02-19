package api

import (
	"context"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func (s *Server) runCommand(c echo.Context) error {
	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")

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

	var result *types.ProcessResult
	var execErr error

	start := time.Now()

	routeOp := func(ctx context.Context) error {
		result, execErr = s.manager.Exec(ctx, id, cfg)
		return execErr
	}

	// Route through sandbox router (handles auto-wake, rolling timeout reset)
	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "exec", routeOp); err != nil {
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

	durationMs := int(time.Since(start).Milliseconds())

	// Log command to per-sandbox SQLite
	if s.sandboxDBs != nil {
		sdb, dbErr := s.sandboxDBs.Get(id)
		if dbErr == nil {
			stdoutLen := len(result.Stdout)
			stderrLen := len(result.Stderr)
			_ = sdb.LogCommand(cfg.Command, cfg.Args, cfg.Cwd, result.ExitCode, durationMs, stdoutLen, stderrLen)
		}
	}

	return c.JSON(http.StatusOK, result)
}
