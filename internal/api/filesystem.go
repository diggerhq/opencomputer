package api

import (
	"io"
	"net/http"

	"github.com/labstack/echo/v4"
)

func (s *Server) readFile(c echo.Context) error {
	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	content, err := s.manager.ReadFile(c.Request().Context(), id, path)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.String(http.StatusOK, content)
}

func (s *Server) writeFile(c echo.Context) error {
	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "failed to read request body: " + err.Error(),
		})
	}

	if err := s.manager.WriteFile(c.Request().Context(), id, path, string(body)); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) listDir(c echo.Context) error {
	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		path = "/"
	}

	entries, err := s.manager.ListDir(c.Request().Context(), id, path)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, entries)
}

func (s *Server) makeDir(c echo.Context) error {
	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	if err := s.manager.MakeDir(c.Request().Context(), id, path); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) removeFile(c echo.Context) error {
	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	if err := s.manager.Remove(c.Request().Context(), id, path); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}
