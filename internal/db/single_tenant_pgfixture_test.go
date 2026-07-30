//go:build pgfixture

// Integration coverage for single-tenant bootstrap. Run against a disposable
// Postgres database with:
//
//	TEST_DATABASE_URL=postgres://user:pass@localhost:5432/dbname?sslmode=disable \
//	  go test -tags=pgfixture ./internal/db -run SingleTenant -v
package db

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestEnsureSingleTenantPrincipalEnforcesProPlan_pgfixture(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()
	suffix := uuid.New().String()
	slug := "single-tenant-" + suffix
	email := "admin-" + suffix + "@example.test"

	org, user, err := store.EnsureSingleTenantPrincipal(
		ctx,
		"Single Tenant Test",
		slug,
		email,
		"Local Admin",
	)
	if err != nil {
		t.Fatalf("first bootstrap: %v", err)
	}
	if org.Plan != "pro" {
		t.Fatalf("first bootstrap plan = %q, want pro", org.Plan)
	}

	if err := store.UpdateOrgPlan(ctx, org.ID, "free"); err != nil {
		t.Fatalf("reset plan to free: %v", err)
	}

	reloadedOrg, reloadedUser, err := store.EnsureSingleTenantPrincipal(
		ctx,
		"Single Tenant Test",
		slug,
		email,
		"Local Admin",
	)
	if err != nil {
		t.Fatalf("second bootstrap: %v", err)
	}
	if reloadedOrg.ID != org.ID || reloadedUser.ID != user.ID {
		t.Fatalf(
			"bootstrap identity changed: org %s -> %s, user %s -> %s",
			org.ID,
			reloadedOrg.ID,
			user.ID,
			reloadedUser.ID,
		)
	}
	if reloadedOrg.Plan != "pro" {
		t.Fatalf("second bootstrap plan = %q, want pro", reloadedOrg.Plan)
	}

	persisted, err := store.GetOrg(ctx, org.ID)
	if err != nil {
		t.Fatalf("reload persisted org: %v", err)
	}
	if persisted.Plan != "pro" {
		t.Fatalf("persisted plan = %q, want pro", persisted.Plan)
	}
}
