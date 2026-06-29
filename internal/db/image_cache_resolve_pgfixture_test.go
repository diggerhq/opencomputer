//go:build pgfixture

// Resolve-path semantics for shared "catalog" snapshots. Runs only under
// `go test -tags=pgfixture` against a real Postgres pointed at by
// TEST_DATABASE_URL. Proves the act-as-org SEV fix AND its security property:
// a customer org can fork a snapshot the PLATFORM org published, the platform
// row carries a real checkpoint (provision contract), the fallback is anchored
// to the platform org so a look-alike published by any other org cannot hijack
// a predictable runtime name, and an unset platform org fails closed.
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

// seedCheckpoint inserts a minimal ready checkpoint owned by orgID with non-null
// S3 keys, and returns its id. Snapshots must point at a real checkpoint for the
// provision path (resolveSnapshot requires Status=ready + CheckpointID != nil).
func seedCheckpoint(t *testing.T, store *Store, orgID uuid.UUID) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := store.pool.Exec(context.Background(),
		`INSERT INTO sandbox_checkpoints (id, sandbox_id, org_id, name, rootfs_s3_key, workspace_s3_key, status, size_bytes)
		 VALUES ($1, $2, $3, $4, $5, $6, 'ready', 1)`,
		id, "sbx-"+id.String()[:8], orgID, "cp-"+id.String()[:8],
		"rootfs/"+id.String(), "ws/"+id.String()); err != nil {
		t.Fatalf("seed checkpoint for %s: %v", orgID, err)
	}
	return id
}

// seedNamedSnapshot inserts a ready named snapshot owned by orgID, backed by a
// real checkpoint, with the given is_public flag.
func seedNamedSnapshot(t *testing.T, store *Store, orgID uuid.UUID, name string, isPublic bool) {
	t.Helper()
	cpID := seedCheckpoint(t, store, orgID)
	id := uuid.New()
	if _, err := store.pool.Exec(context.Background(),
		`INSERT INTO image_cache (id, org_id, content_hash, checkpoint_id, name, manifest, status, is_public)
		 VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7)`,
		id, orgID, "hash-"+id.String(), cpID, name, json.RawMessage(`{}`), isPublic); err != nil {
		t.Fatalf("seed snapshot %q for %s: %v", name, orgID, err)
	}
}

func TestResolveImageCacheByName_PlatformFallback(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()

	platform := seedOrgWithCap(t, store, 64) // owns the shared catalog
	customer := seedOrgWithCap(t, store, 64) // act-as-org session
	const name = "runtime-claude-pgfixture"

	// Platform owns the snapshot but hasn't published it yet.
	seedNamedSnapshot(t, store, platform, name, false)

	// Private platform snapshot is NOT resolvable by a customer (the SEV state).
	if _, err := store.ResolveImageCacheByName(ctx, customer, platform, name); err == nil {
		t.Fatalf("expected not-found: an unpublished platform snapshot must stay private")
	}
	// Platform resolves its own regardless of is_public, with a real checkpoint.
	got, err := store.ResolveImageCacheByName(ctx, platform, platform, name)
	if err != nil {
		t.Fatalf("platform resolve of own snapshot: %v", err)
	}
	if got.CheckpointID == nil {
		t.Fatalf("resolved snapshot must carry a checkpoint_id for provision")
	}

	// Publish → the customer can fork it and gets the PLATFORM row + checkpoint.
	if err := store.SetImageCachePublicByName(ctx, platform, name, true); err != nil {
		t.Fatalf("publish: %v", err)
	}
	got, err = store.ResolveImageCacheByName(ctx, customer, platform, name)
	if err != nil {
		t.Fatalf("customer resolve of published platform snapshot: %v", err)
	}
	if got.OrgID != platform {
		t.Fatalf("expected platform's row %s, got %s", platform, got.OrgID)
	}
	if got.CheckpointID == nil {
		t.Fatalf("resolved snapshot must carry a checkpoint_id for provision")
	}

	// Fail-closed: with no platform org configured, the fallback is disabled.
	if _, err := store.ResolveImageCacheByName(ctx, customer, uuid.Nil, name); err == nil {
		t.Fatalf("expected not-found when platformOrgID is unset (fallback disabled)")
	}
}

// The security property: two orgs publish a snapshot under the SAME predictable
// name; only the platform org's row is ever served to a third org.
func TestResolveImageCacheByName_NoSpoof(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()

	platform := seedOrgWithCap(t, store, 64)
	attacker := seedOrgWithCap(t, store, 64)
	victim := seedOrgWithCap(t, store, 64)
	const name = "runtime-claude-0.0.10" // a predictable, guessable runtime label

	// Both publish is_public=true under the identical name (allowed: unique per org).
	seedNamedSnapshot(t, store, platform, name, true)
	seedNamedSnapshot(t, store, attacker, name, true)

	// A victim that owns neither must resolve the PLATFORM row, never the attacker's.
	got, err := store.ResolveImageCacheByName(ctx, victim, platform, name)
	if err != nil {
		t.Fatalf("victim resolve: %v", err)
	}
	if got.OrgID != platform {
		t.Fatalf("SPOOF: victim resolved org %s instead of platform %s", got.OrgID, platform)
	}

	// The attacker still resolves its OWN row for itself (own-preference), not the
	// platform's — confirming ordering doesn't leak across orgs.
	got, err = store.ResolveImageCacheByName(ctx, attacker, platform, name)
	if err != nil {
		t.Fatalf("attacker resolve own: %v", err)
	}
	if got.OrgID != attacker {
		t.Fatalf("expected attacker's own row to win for itself, got %s", got.OrgID)
	}
}

func TestSetImageCachePublicByName_OwnerScoped(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()

	platform := seedOrgWithCap(t, store, 64)
	other := seedOrgWithCap(t, store, 64)
	const name = "runtime-codex-pgfixture"
	seedNamedSnapshot(t, store, platform, name, false)

	// A non-owner cannot publish someone else's snapshot (store-level ownership;
	// the API layer additionally restricts publish to the platform org).
	if err := store.SetImageCachePublicByName(ctx, other, name, true); err == nil {
		t.Fatalf("expected error publishing a snapshot not owned by org")
	}
	// And it stays unresolvable for a non-owner.
	if _, err := store.ResolveImageCacheByName(ctx, other, platform, name); err == nil {
		t.Fatalf("expected snapshot to remain private after failed publish")
	}
}
