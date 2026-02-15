package api

import (
	"net/http"

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

	result, err := s.manager.Exec(c.Request().Context(), id, cfg)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, result)
}
