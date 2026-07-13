//go:build pgfixture

// SetSandboxPaused must close the open sandbox_scale_events billing row in the
// same tx. Paused is UNBILLED and the usage ticker stops refreshing the row, so
// a left-open row accrues phantom GB-hours forever — the pause-tier billing leak
// that over-counted the usage chart and over-billed legacy (scale-event) orgs.
//
// Run locally:
//
//	TEST_DATABASE_URL=postgres://user:pass@localhost:5432/dbname?sslmode=disable \
//	  go test -tags=pgfixture ./internal/db/ -run PausedScaleEvent -v
package db

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestSetSandboxPausedClosesOpenScaleEvent(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()
	org := uuid.New()
	sb := "sb-pause-" + org.String()[:8]
	cfg := json.RawMessage(`{}`)

	if _, err := store.CreateSandboxSessionWithStatus(
		ctx, sb, org, nil, "base", "test", "w-test", cfg, cfg, "running", nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Open a billing row — what the usage ticker does each tick for a running box.
	if err := store.RecordScaleEvent(ctx, sb, org.String(), 4096, 0, 0); err != nil {
		t.Fatalf("RecordScaleEvent: %v", err)
	}
	if got := openScaleEvents(t, store, sb); got != 1 {
		t.Fatalf("precondition: want 1 open scale event, got %d", got)
	}

	// Pause: must flip the session AND close the open billing row.
	changed, err := store.SetSandboxPaused(ctx, sb)
	if err != nil {
		t.Fatalf("SetSandboxPaused: %v", err)
	}
	if !changed {
		t.Fatalf("SetSandboxPaused: want changed=true on running->paused")
	}
	if got := openScaleEvents(t, store, sb); got != 0 {
		t.Errorf("after pause: want 0 open scale events (closed), got %d — phantom billing leak", got)
	}

	// Session reflects the paused tier.
	var status, mode string
	if err := store.pool.QueryRow(ctx,
		`SELECT status, COALESCE(hibernation_mode, '') FROM sandbox_sessions WHERE sandbox_id = $1`, sb,
	).Scan(&status, &mode); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if status != "hibernated" || mode != "paused" {
		t.Errorf("session state = (%s,%s), want (hibernated,paused)", status, mode)
	}

	// Idempotent CAS: a second pause is a no-op (already paused) — no error, and
	// it must not touch a row a concurrent stop/terminate may own.
	changed2, err := store.SetSandboxPaused(ctx, sb)
	if err != nil {
		t.Fatalf("SetSandboxPaused (repeat): %v", err)
	}
	if changed2 {
		t.Errorf("SetSandboxPaused on already-paused box: want changed=false")
	}
}

func openScaleEvents(t *testing.T, store *Store, sandboxID string) int {
	t.Helper()
	var n int
	if err := store.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sandbox_scale_events WHERE sandbox_id = $1 AND ended_at IS NULL`, sandboxID,
	).Scan(&n); err != nil {
		t.Fatalf("count open scale events: %v", err)
	}
	return n
}
