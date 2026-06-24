// Package cellevents is a tiny helper for XADDing sandbox lifecycle events
// to a cell's events stream. Lives in its own package so both worker and
// control-plane code can publish without pulling in the full controlplane
// graph (compute, nats, echo, …).
package cellevents

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// LifecycleEvent is a fully-specified sandbox lifecycle event for the cell
// stream. Used by the webhook lifecycle-outbox relay, where the CP knows the
// stable (deterministic) event id and the clean public event data up front —
// unlike PublishLifecycle, which generates a random id and a {reason}-only
// payload for best-effort reconciliation emits.
type LifecycleEvent struct {
	// ID is the stable, deterministic event id (the webhook dedupe key and the
	// Svix Idempotency-Key downstream). Required.
	ID string
	// Type is the internal stream event type (created, stopped, woke, migrated,
	// scaled, forked, preview_url_changed, …) — mapped to the public
	// sandbox.* type at the edge.
	Type string
	// SandboxID is required.
	SandboxID string
	OrgID     uuid.UUID
	WorkerID  string
	// Data is the PUBLIC event.data contract (clean camelCase, e.g.
	// {cpuCount,memoryMB} for scaled). nil → {}.
	Data map[string]any
	// Ts is the event time; zero → now.
	Ts time.Time
}

// PublishLifecycleEvent XADDs a fully-specified lifecycle event (stable id +
// typed public data) to the cell's events stream. The webhook re-architecture
// (.agents/work/sandbox-webhooks-rearchitecture.md) drains the in-tx
// lifecycle_outbox through here so CP-origin events reach the edge → Svix on the
// same stream worker-origin events already use. Returns true if the XADD landed.
func PublishLifecycleEvent(ctx context.Context, rdb *redis.Client, cellID string, ev LifecycleEvent) bool {
	if rdb == nil || cellID == "" || ev.SandboxID == "" || ev.ID == "" {
		return false
	}
	ts := ev.Ts
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	data := ev.Data
	if data == nil {
		data = map[string]any{}
	}
	envelope := map[string]any{
		"id":         ev.ID,
		"type":       ev.Type,
		"sandbox_id": ev.SandboxID,
		"org_id":     ev.OrgID.String(),
		"worker_id":  ev.WorkerID,
		"cell_id":    cellID,
		"payload":    data,
		"timestamp":  ts.UTC().Format(time.RFC3339Nano),
	}
	return xaddEvent(ctx, rdb, cellID, ev.Type, ev.SandboxID, envelope)
}

// PublishLifecycle XADDs a sandbox lifecycle event (`stopped`, `hibernated`,
// `migrated`, `woke`, `running`, `created`) to the cell's events stream.
// Used for state changes where the canonical worker-side per-sandbox SQLite
// path didn't run — CP-side orphan sweeps, the maintenance loop's dead-worker
// reconciler, worker startup / reconnect reconciliation.
//
// Retries up to 3 times with a short backoff so a Redis hiccup doesn't
// permanently drop the event. Returns true if the XADD landed on some
// attempt; false if all three failed (caller logs the failure context).
func PublishLifecycle(ctx context.Context, rdb *redis.Client, cellID, eventType, sandboxID, workerID string, orgID uuid.UUID, reason string) bool {
	if rdb == nil || cellID == "" || sandboxID == "" {
		return false
	}
	envelope := map[string]any{
		"id":         uuid.NewString(),
		"type":       eventType,
		"sandbox_id": sandboxID,
		"org_id":     orgID.String(),
		"worker_id":  workerID,
		"cell_id":    cellID,
		"payload":    map[string]any{"reason": reason},
		"timestamp":  time.Now().UTC().Format(time.RFC3339Nano),
	}
	return xaddEvent(ctx, rdb, cellID, eventType, sandboxID, envelope)
}

// xaddEvent marshals the envelope and XADDs it to events:{cellID}, retrying up
// to 3 times with backoff. Shared by PublishLifecycle and PublishLifecycleEvent.
func xaddEvent(ctx context.Context, rdb *redis.Client, cellID, eventType, sandboxID string, envelope map[string]any) bool {
	body, err := json.Marshal(envelope)
	if err != nil {
		log.Printf("cellevents: marshal %s: %v", eventType, err)
		return false
	}
	stream := "events:" + cellID
	backoff := 200 * time.Millisecond
	for attempt := 1; attempt <= 3; attempt++ {
		xaddCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err := rdb.XAdd(xaddCtx, &redis.XAddArgs{
			Stream: stream,
			MaxLen: 100000,
			Approx: true,
			Values: map[string]any{"event": string(body)},
		}).Err()
		cancel()
		if err == nil {
			return true
		}
		log.Printf("cellevents: %s sandbox=%s attempt %d/3 failed: %v", eventType, sandboxID, attempt, err)
		if attempt < 3 {
			select {
			case <-ctx.Done():
				return false
			case <-time.After(backoff):
			}
			backoff *= 2
		}
	}
	return false
}
