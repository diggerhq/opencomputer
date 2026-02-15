package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func (s *Server) createSandbox(c echo.Context) error {
	var cfg types.SandboxConfig
	if err := c.Bind(&cfg); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	ctx := c.Request().Context()

	// Check org quota if PG is available
	orgID, hasOrg := auth.GetOrgID(c)
	if hasOrg && s.store != nil {
		org, err := s.store.GetOrg(ctx, orgID)
		if err == nil {
			count, err := s.store.CountActiveSandboxes(ctx, orgID)
			if err == nil && count >= org.MaxConcurrentSandboxes {
				return c.JSON(http.StatusTooManyRequests, map[string]string{
					"error": "concurrent sandbox limit reached",
				})
			}
		}
	}

	sb, err := s.manager.Create(ctx, cfg)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	// Initialize per-sandbox SQLite if available
	if s.sandboxDBs != nil {
		sdb, err := s.sandboxDBs.Get(sb.ID)
		if err == nil {
			_ = sdb.LogEvent("created", map[string]string{
				"sandbox_id": sb.ID,
				"template":   cfg.Template,
			})
		}
	}

	// Issue sandbox-scoped JWT and connectURL only in server mode (separate worker).
	// In combined mode the SDK already talks to the right server, so no redirect needed.
	if s.jwtIssuer != nil && s.mode == "server" {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 300
		}
		token, err := s.jwtIssuer.IssueSandboxToken(orgID, sb.ID, s.workerID, time.Duration(timeout)*time.Second)
		if err == nil {
			sb.Token = token
		}
		if s.httpAddr != "" {
			sb.ConnectURL = s.httpAddr
		}
	}

	// Write session record to PG if available
	if s.store != nil && hasOrg {
		cfgJSON, _ := json.Marshal(cfg)
		metadataJSON, _ := json.Marshal(cfg.Metadata)
		region := s.region
		if region == "" {
			region = "local"
		}
		workerID := s.workerID
		if workerID == "" {
			workerID = "w-local-1"
		}
		template := cfg.Template
		if template == "" {
			template = "base"
		}
		_, _ = s.store.CreateSandboxSession(ctx, sb.ID, orgID, nil, template, region, workerID, cfgJSON, metadataJSON)
	}

	return c.JSON(http.StatusCreated, sb)
}

func (s *Server) getSandbox(c echo.Context) error {
	id := c.Param("id")

	sb, err := s.manager.Get(c.Request().Context(), id)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": err.Error(),
		})
	}

	// Attach connectURL for discovery only in server mode (separate worker)
	if s.jwtIssuer != nil && s.httpAddr != "" && s.mode == "server" {
		sb.ConnectURL = s.httpAddr

		orgID, hasOrg := auth.GetOrgID(c)
		if hasOrg {
			token, err := s.jwtIssuer.IssueSandboxToken(orgID, id, s.workerID, 24*time.Hour)
			if err == nil {
				sb.Token = token
			}
		}
	}

	return c.JSON(http.StatusOK, sb)
}

func (s *Server) killSandbox(c echo.Context) error {
	id := c.Param("id")

	if err := s.manager.Kill(c.Request().Context(), id); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	// Update session in PG
	if s.store != nil {
		_ = s.store.UpdateSandboxSessionStatus(c.Request().Context(), id, "stopped", nil)
	}

	// Clean up SQLite
	if s.sandboxDBs != nil {
		_ = s.sandboxDBs.Remove(id)
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) listSandboxes(c echo.Context) error {
	sandboxes, err := s.manager.List(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, sandboxes)
}

func (s *Server) setTimeout(c echo.Context) error {
	id := c.Param("id")

	var req types.TimeoutRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	if req.Timeout <= 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "timeout must be positive",
		})
	}

	if err := s.manager.SetTimeout(c.Request().Context(), id, req.Timeout); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}

// listSessions returns session history from PostgreSQL.
func (s *Server) listSessions(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "session history requires database configuration",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	status := c.QueryParam("status")
	sessions, err := s.store.ListSandboxSessions(c.Request().Context(), orgID, status, 100, 0)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, sessions)
}
