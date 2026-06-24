package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Sandbox lifecycle webhooks — CP source layer. All-Svix-at-edge: the CP only
// CAPTURES lifecycle events into the outbox (sandbox_lifecycle_events); the relay
// publishes them to the cell stream and the edge delivers via Svix. Destination
// management + delivery state live at the edge (Svix + D1), not here.
// See .agents/work/sandbox-webhooks-rearchitecture.md.

// ---------------------------------------------------------------------------
// Lifecycle events (the in-tx outbox capture)
// ---------------------------------------------------------------------------

// LifecycleEvent is one canonical sandbox lifecycle moment.
type LifecycleEvent struct {
	ID        string // deterministic (once-only) or unique (recurring) event id
	OrgID     uuid.UUID
	SandboxID string
	Type      string          // public type, e.g. "sandbox.stopped"
	Data      json.RawMessage // event-specific, camelCase; nil → {}
	Ts        time.Time       // zero → now()
}

// recordLifecycleEvent inserts a lifecycle event into the outbox within the given
// tx. ON CONFLICT (id) DO NOTHING makes re-records idempotent. CP-origin callers
// use this inside their existing transaction for in-tx durability.
func recordLifecycleEvent(ctx context.Context, tx pgx.Tx, ev LifecycleEvent) error {
	// All-Svix-at-edge: the CP records every CP-origin lifecycle event to the
	// outbox unconditionally; the relay publishes them to the cell stream and the
	// EDGE applies the dormancy gate (orgs.has_webhooks in D1) before calling
	// Svix. No CP-side gate — the CP no longer knows which orgs have webhooks; that
	// index lives at the edge. The outbox is a transient queue (the relay deletes
	// rows after publishing), so it stays bounded.
	if len(ev.Data) == 0 {
		ev.Data = json.RawMessage("{}")
	}
	ts := ev.Ts
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO sandbox_lifecycle_events (id, org_id, sandbox_id, type, data, ts)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (id) DO NOTHING`,
		ev.ID, ev.OrgID, ev.SandboxID, ev.Type, string(ev.Data), ts)
	if err != nil {
		return fmt.Errorf("record lifecycle event: %w", err)
	}
	return nil
}

// RecordLifecycleEvent records a lifecycle event in its own transaction (used by
// CP-origin callers that don't already hold one).
func (s *Store) RecordLifecycleEvent(ctx context.Context, ev LifecycleEvent) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := recordLifecycleEvent(ctx, tx, ev); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// recordOrphanStoppedTx records sandbox.stopped (reason crash) for sandboxes
// moved to a terminal failure state OUTSIDE UpdateSandboxSessionStatus (migration
// failure, orphan/dead-worker sweeps), within the caller's tx so the event is
// durable with the state change. The id matches the normal stopped id so a
// sandbox can never get two stopped events.
func recordOrphanStoppedTx(ctx context.Context, tx pgx.Tx, orphans []OrphanedSandbox) error {
	for _, o := range orphans {
		if o.OrgID == uuid.Nil || o.SandboxID == "" {
			continue
		}
		if err := recordLifecycleEvent(ctx, tx, LifecycleEvent{
			ID:        o.SandboxID + ":sandbox.stopped",
			OrgID:     o.OrgID,
			SandboxID: o.SandboxID,
			Type:      "sandbox.stopped",
			Data:      json.RawMessage(`{"reason":"crash"}`),
		}); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Outbox drain (CP relay → cell stream)
// ---------------------------------------------------------------------------

// LifecycleOutboxRow is a lifecycle event drained from the outbox for publishing
// to the cell stream.
type LifecycleOutboxRow struct {
	ID        string
	OrgID     uuid.UUID
	SandboxID string
	Type      string
	Data      json.RawMessage
	Ts        time.Time
}

// DrainLifecycleOutbox returns up to `batch` lifecycle events (oldest first by
// seq). The relay publishes these to the events:{cell} stream, then deletes them
// via DeleteLifecycleOutbox. The outbox is a transient queue — the stream + edge
// + Svix are the durable downstream (and dedupe on the stable event id), so rows
// don't need to be retained.
func (s *Store) DrainLifecycleOutbox(ctx context.Context, batch int) ([]LifecycleOutboxRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, org_id, sandbox_id, type, data, ts
		   FROM sandbox_lifecycle_events
		  ORDER BY seq
		  LIMIT $1`, batch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LifecycleOutboxRow
	for rows.Next() {
		var r LifecycleOutboxRow
		var data []byte
		if err := rows.Scan(&r.ID, &r.OrgID, &r.SandboxID, &r.Type, &data, &r.Ts); err != nil {
			return nil, err
		}
		r.Data = json.RawMessage(data)
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteLifecycleOutbox removes the given events after they've been published to
// the stream. A row left behind (delete fails) is harmlessly re-published next
// tick — the edge and Svix dedupe on the stable event id.
func (s *Store) DeleteLifecycleOutbox(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx,
		`DELETE FROM sandbox_lifecycle_events WHERE id = ANY($1)`, ids)
	return err
}
