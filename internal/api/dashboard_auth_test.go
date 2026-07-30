package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/auth"
)

func TestSingleTenantDashboardMe(t *testing.T) {
	principal := &auth.SingleTenantPrincipal{
		UserID: uuid.New(),
		OrgID:  uuid.New(),
		Email:  "admin@opencomputer.local",
	}
	server := NewServer(nil, nil, "", &ServerOpts{
		DashboardAuthMode:     "single-tenant",
		SingleTenantPrincipal: principal,
	})

	rec := httptest.NewRecorder()
	server.Echo().ServeHTTP(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/dashboard/me", nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got struct {
		ID           uuid.UUID `json:"id"`
		Email        string    `json:"email"`
		OrgID        uuid.UUID `json:"orgId"`
		AuthMode     string    `json:"authMode"`
		Capabilities struct {
			SignOut       bool `json:"signOut"`
			ManageMembers bool `json:"manageMembers"`
		} `json:"capabilities"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != principal.UserID || got.OrgID != principal.OrgID || got.Email != principal.Email {
		t.Fatalf("identity = %#v, want %#v", got, principal)
	}
	if got.AuthMode != "single-tenant" {
		t.Fatalf("authMode = %q", got.AuthMode)
	}
	if got.Capabilities.SignOut || got.Capabilities.ManageMembers {
		t.Fatalf("single-tenant capabilities unexpectedly enable identity-provider actions: %#v", got.Capabilities)
	}
	if !hasRoute(server, http.MethodPost, "/api/dashboard/sandboxes") {
		t.Fatal("single-tenant dashboard does not expose direct sandbox creation")
	}
}

func TestWorkOSDashboardDoesNotExposeDirectSandboxCreate(t *testing.T) {
	server := NewServer(nil, nil, "", &ServerOpts{
		DashboardAuthMode: "workos",
		WorkOSConfig: &auth.WorkOSConfig{
			APIKey:   "sk_test_local",
			ClientID: "client_test_local",
		},
	})

	if hasRoute(server, http.MethodPost, "/api/dashboard/sandboxes") {
		t.Fatal("WorkOS dashboard unexpectedly exposes direct sandbox creation")
	}
}

func hasRoute(server *Server, method, path string) bool {
	for _, route := range server.Echo().Routes() {
		if route.Method == method && route.Path == path {
			return true
		}
	}
	return false
}
