package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

func TestSingleTenantMiddlewareSetsIdentity(t *testing.T) {
	principal := SingleTenantPrincipal{
		UserID: uuid.New(),
		OrgID:  uuid.New(),
		Email:  "admin@opencomputer.local",
	}

	e := echo.New()
	e.GET("/me", func(c echo.Context) error {
		orgID, ok := GetOrgID(c)
		if !ok {
			t.Fatal("org context was not set")
		}
		userID := GetUserID(c)
		return c.JSON(http.StatusOK, map[string]interface{}{
			"orgId":  orgID,
			"userId": userID,
			"email":  c.Get("user_email"),
		})
	}, SingleTenantMiddleware(principal))

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/me", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got struct {
		OrgID  uuid.UUID  `json:"orgId"`
		UserID *uuid.UUID `json:"userId"`
		Email  string     `json:"email"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.OrgID != principal.OrgID || got.UserID == nil || *got.UserID != principal.UserID || got.Email != principal.Email {
		t.Fatalf("identity = %#v, want principal %#v", got, principal)
	}
}

func TestSingleTenantMiddlewareRejectsIncompletePrincipal(t *testing.T) {
	e := echo.New()
	e.GET("/", func(c echo.Context) error {
		return c.NoContent(http.StatusNoContent)
	}, SingleTenantMiddleware(SingleTenantPrincipal{}))

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}
