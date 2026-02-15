package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/template"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// templateDeps holds template-related dependencies injected into the server.
type templateDeps struct {
	registry *template.Registry
	builder  *template.Builder
}

// SetTemplateDeps sets the template dependencies on the server.
func (s *Server) SetTemplateDeps(registry *template.Registry, builder *template.Builder) {
	s.templates = &templateDeps{
		registry: registry,
		builder:  builder,
	}
}

func (s *Server) buildTemplate(c echo.Context) error {
	if s.templates == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "template service not configured",
		})
	}

	var req types.TemplateBuildRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	if req.Name == "" || req.Dockerfile == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "name and dockerfile are required",
		})
	}

	tmpl, err := s.templates.builder.Build(c.Request().Context(), req.Dockerfile, req.Name)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusCreated, tmpl)
}

func (s *Server) listTemplates(c echo.Context) error {
	if s.templates == nil {
		return c.JSON(http.StatusOK, []types.Template{})
	}

	return c.JSON(http.StatusOK, s.templates.registry.List())
}

func (s *Server) getTemplate(c echo.Context) error {
	if s.templates == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "template service not configured",
		})
	}

	name := c.Param("name")
	tmpl, err := s.templates.registry.Get(name)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, tmpl)
}

func (s *Server) deleteTemplate(c echo.Context) error {
	if s.templates == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "template service not configured",
		})
	}

	name := c.Param("name")
	if err := s.templates.registry.Delete(name); err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}
