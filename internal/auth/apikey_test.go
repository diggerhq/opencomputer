package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestAPIKeyMiddleware_NoKeyConfigured(t *testing.T) {
	e := echo.New()
	e.Use(APIKeyMiddleware(""))
	e.GET("/test", func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with no key configured, got %d", rec.Code)
	}
}

func TestAPIKeyMiddleware_ValidKey(t *testing.T) {
	e := echo.New()
	e.Use(APIKeyMiddleware("secret-key"))
	e.GET("/test", func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-API-Key", "secret-key")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with valid key, got %d", rec.Code)
	}
}

func TestAPIKeyMiddleware_InvalidKey(t *testing.T) {
	e := echo.New()
	e.Use(APIKeyMiddleware("secret-key"))
	e.GET("/test", func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-API-Key", "wrong-key")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403 with invalid key, got %d", rec.Code)
	}
}

func TestAPIKeyMiddleware_MissingKey(t *testing.T) {
	e := echo.New()
	e.Use(APIKeyMiddleware("secret-key"))
	e.GET("/test", func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with missing key, got %d", rec.Code)
	}
}

func TestAPIKeyMiddleware_QueryParam(t *testing.T) {
	e := echo.New()
	e.Use(APIKeyMiddleware("secret-key"))
	e.GET("/test", func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/test?api_key=secret-key", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with key in query param, got %d", rec.Code)
	}
}
