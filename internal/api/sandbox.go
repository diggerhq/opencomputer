package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func (s *Server) createSandbox(c echo.Context) error {
	var cfg types.SandboxConfig
	if err := c.Bind(&cfg); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	sb, err := s.manager.Create(c.Request().Context(), cfg)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
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

	return c.JSON(http.StatusOK, sb)
}

func (s *Server) killSandbox(c echo.Context) error {
	id := c.Param("id")

	if err := s.manager.Kill(c.Request().Context(), id); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
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
