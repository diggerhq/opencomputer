package api

import (
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func (s *Server) runCommand(c echo.Context) error {
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

	start := time.Now()
	result, err := s.manager.Exec(c.Request().Context(), id, cfg)
	durationMs := int(time.Since(start).Milliseconds())

	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

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
