package auth

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// SingleTenantPrincipal is the persistent local identity used by explicitly
// configured development deployments that do not have an identity provider.
// The deployment owns one local organization; additional authentication
// strategies can map more users into that tenant later.
type SingleTenantPrincipal struct {
	UserID uuid.UUID
	OrgID  uuid.UUID
	Email  string
}

// SingleTenantMiddleware authenticates every dashboard request as one local
// principal. It must only be enabled explicitly on a trusted development
// network; it provides identity context, not user authentication.
func SingleTenantMiddleware(principal SingleTenantPrincipal) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if principal.UserID == uuid.Nil || principal.OrgID == uuid.Nil || principal.Email == "" {
				return c.JSON(http.StatusServiceUnavailable, map[string]string{
					"error": "single-tenant dashboard identity is not configured",
				})
			}

			SetOrgID(c, principal.OrgID)
			SetUserID(c, principal.UserID)
			c.Set("user_email", principal.Email)
			return next(c)
		}
	}
}
