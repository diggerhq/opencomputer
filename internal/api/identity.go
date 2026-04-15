package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
)

// getMe returns the identity (org and optional user) associated with the
// current API key. Downstream services use this to resolve key → owner.
func (s *Server) getMe(c echo.Context) error {
	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	resp := map[string]interface{}{
		"org_id": orgID.String(),
	}

	if userID := auth.GetUserID(c); userID != nil {
		resp["user_id"] = userID.String()
	}

	return c.JSON(http.StatusOK, resp)
}
