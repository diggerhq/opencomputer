package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
)

// dashboardMe returns the current authenticated user info.
func (s *Server) dashboardMe(c echo.Context) error {
	userID := c.Get("user_id")
	email := c.Get("user_email")
	orgID, _ := auth.GetOrgID(c)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":    userID,
		"email": email,
		"orgId": orgID,
	})
}

// dashboardSessions returns session history for the authenticated org.
func (s *Server) dashboardSessions(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
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

// dashboardListAPIKeys returns all API keys for the authenticated org.
func (s *Server) dashboardListAPIKeys(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	keys, err := s.store.ListAPIKeys(c.Request().Context(), orgID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, keys)
}

// dashboardCreateAPIKey creates a new API key for the authenticated org.
func (s *Server) dashboardCreateAPIKey(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body",
		})
	}
	if req.Name == "" {
		req.Name = "Untitled"
	}

	// Get user ID if available
	var createdBy *uuid.UUID
	if uid, ok := c.Get("user_id").(uuid.UUID); ok {
		createdBy = &uid
	}

	plainKey, err := auth.GenerateAPIKey()
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to generate key",
		})
	}

	hash := db.HashAPIKey(plainKey)
	prefix := plainKey[:8]

	apiKey, err := s.store.CreateAPIKey(c.Request().Context(), orgID, createdBy, hash, prefix, req.Name, []string{"sandbox:*"})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	// Return the key with the plaintext key (only shown once)
	return c.JSON(http.StatusCreated, map[string]interface{}{
		"id":        apiKey.ID,
		"name":      apiKey.Name,
		"key":       plainKey,
		"keyPrefix": apiKey.KeyPrefix,
		"createdAt": apiKey.CreatedAt,
	})
}

// dashboardDeleteAPIKey revokes an API key.
func (s *Server) dashboardDeleteAPIKey(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	keyID, err := uuid.Parse(c.Param("keyId"))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid key ID",
		})
	}

	if err := s.store.DeleteAPIKey(c.Request().Context(), keyID); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}

// dashboardGetOrg returns the authenticated org info.
func (s *Server) dashboardGetOrg(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	org, err := s.store.GetOrg(c.Request().Context(), orgID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, org)
}

// dashboardUpdateOrg updates the org name.
func (s *Server) dashboardUpdateOrg(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := c.Bind(&req); err != nil || req.Name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "name is required",
		})
	}

	org, err := s.store.UpdateOrg(c.Request().Context(), orgID, req.Name)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusOK, org)
}
