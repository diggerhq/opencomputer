//go:build pgfixture

// Resolve-path semantics for shared named snapshots. Runs only under
// `go test -tags=pgfixture` against a real Postgres pointed at by
// TEST_DATABASE_URL. Proves the act-as-org SEV fix: a customer org can fork a
// public platform snapshot it does not own, the org's own row still wins when
// both exist, and publish/unpublish is strictly owner-scoped.
//
// Run locally:
//
//	TEST_DATABASE_URL=postgres://user:pass@localhost:5432/dbname?sslmode=disable \
//	  go test -tags=pgfixture ./internal/db/ -run ResolveImageCache -v
package db

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// seedNamedSnapshot inserts a ready named snapshot owned by orgID. is_public
// defaults to false (set via SetImageCachePublicByName in the test).
func seedNamedSnapshot(t *testing.T, store *Store, orgID uuid.UUID, name, contentHash string) {
	t.Helper()
	cp := uuid.New()
	if _, err := store.pool.Exec(context.Background(),
		`INSERT INTO image_cache (id, org_id, content_hash, checkpoint_id, name, manifest, status)
		 VALUES ($1, $2, $3, NULL, $4, $5, 'ready')`,
		cp, orgID, contentHash, name, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("seed snapshot %q for %s: %v", name, orgID, err)
	}
}

func TestResolveImageCacheByName_PublicFallback(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()

	owner := seedOrgWithCap(t, store, 64)     // platform org that owns the snapshot
	requester := seedOrgWithCap(t, store, 64) // customer org (act-as-org)
	const name = "runtime-claude-pgfixture"

	seedNamedSnapshot(t, store, owner, name, "hash-owner-"+uuid.NewString())

	// Private: a non-owner cannot resolve it (this was the SEV).
	if _, err := store.ResolveImageCacheByName(ctx, requester, name); err == nil {
		t.Fatalf("expected not-found resolving private snapshot as non-owner")
	}
	// Owner can always resolve their own, public or not.
	if _, err := store.ResolveImageCacheByName(ctx, owner, name); err != nil {
		t.Fatalf("owner resolve of own private snapshot: %v", err)
	}

	// Publish, then the non-owner resolves it and gets the owner's row.
	if err := store.SetImageCachePublicByName(ctx, owner, name, true); err != nil {
		t.Fatalf("publish: %v", err)
	}
	got, err := store.ResolveImageCacheByName(ctx, requester, name)
	if err != nil {
		t.Fatalf("non-owner resolve of public snapshot: %v", err)
	}
	if got.OrgID != owner {
		t.Fatalf("expected owner's row %s, got %s", owner, got.OrgID)
	}

	// Org's own row wins over a public one with the same name.
	seedNamedSnapshot(t, store, requester, name, "hash-req-"+uuid.NewString())
	got, err = store.ResolveImageCacheByName(ctx, requester, name)
	if err != nil {
		t.Fatalf("resolve with own + public present: %v", err)
	}
	if got.OrgID != requester {
		t.Fatalf("expected requester's own row %s to win, got %s", requester, got.OrgID)
	}

	// Unpublish removes the fallback for non-owners; the owner still resolves it.
	if err := store.SetImageCachePublicByName(ctx, owner, name, false); err != nil {
		t.Fatalf("unpublish: %v", err)
	}
	stranger := seedOrgWithCap(t, store, 64)
	if _, err := store.ResolveImageCacheByName(ctx, stranger, name); err == nil {
		t.Fatalf("expected not-found after unpublish for a stranger org")
	}
}

func TestSetImageCachePublicByName_OwnerScoped(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()

	owner := seedOrgWithCap(t, store, 64)
	other := seedOrgWithCap(t, store, 64)
	const name = "runtime-codex-pgfixture"
	seedNamedSnapshot(t, store, owner, name, "hash-"+uuid.NewString())

	// A non-owner cannot publish someone else's snapshot.
	if err := store.SetImageCachePublicByName(ctx, other, name, true); err == nil {
		t.Fatalf("expected error publishing a snapshot not owned by org")
	}
	// And it stays unresolvable for a non-owner.
	if _, err := store.ResolveImageCacheByName(ctx, other, name); err == nil {
		t.Fatalf("expected snapshot to remain private after failed publish")
	}
}
