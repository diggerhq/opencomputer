package api

import (
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// microvm_direct.go — hands the edge what it needs to talk to a MicroVM without
// going through this process.
//
// Every exec today travels edge → (CF tunnel) → control plane → agent tunnel →
// guest, and the control plane leg alone is the majority of time-to-first-exec
// because the CP lives in a different region from the boxes. Nothing about that
// leg is load-bearing: a MicroVM's endpoint is a public TLS host and its
// credential is a plain, port-scoped header token, so the edge can hold the
// agent tunnel itself and the CP drops out of the data path entirely.
//
// This route exists to measure that claim before building on it. It is
// read-only and mints nothing the CP does not already mint for its own dials.

// microvmDirectInfo handles GET /internal/microvm/direct/:id.
func (s *Server) microvmDirectInfo(c echo.Context) error {
	if s.microvm == nil || s.microvm.manager == nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "microvm backend not enabled on this cell"})
	}
	endpoint, token, port, err := s.microvm.manager.DirectInfo(c.Request().Context(), c.Param("id"))
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": err.Error()})
	}
	return c.JSON(http.StatusOK, map[string]any{
		"endpoint": endpoint,
		"token":    token,
		"port":     port,
		"path":     awsvm.AgentTunnelPath,
	})
}
