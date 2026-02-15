package auth

import (
	"crypto/subtle"
	"net/http"

	"github.com/labstack/echo/v4"
)

// APIKeyMiddleware validates the X-API-Key header against the configured key.
// If the configured key is empty, authentication is disabled (development mode).
func APIKeyMiddleware(apiKey string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if apiKey == "" {
				return next(c)
			}

			provided := c.Request().Header.Get("X-API-Key")
			if provided == "" {
				provided = c.QueryParam("api_key")
			}

			if provided == "" {
				return c.JSON(http.StatusUnauthorized, map[string]string{
					"error": "missing API key",
				})
			}

			if subtle.ConstantTimeCompare([]byte(provided), []byte(apiKey)) != 1 {
				return c.JSON(http.StatusForbidden, map[string]string{
					"error": "invalid API key",
				})
			}

			return next(c)
		}
	}
}
