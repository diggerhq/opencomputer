package api

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// publishCheckpointEvent XADDs a checkpoint lifecycle event to the cell's
// local events:{cell_id} Redis stream so the forwarder + events-ingest
// Worker can keep D1's checkpoints_index in sync. Same envelope shape as
// the sandbox lifecycle events emitted by the worker per-sandbox SQLite +
// the cell_capacity events emitted by controlplane.CapacityReporter.
//
// Event types:
//   checkpoint_ready    — checkpoint upload finished; UPSERT row in D1
//   checkpoint_deleted  — checkpoint dropped from cell PG; DELETE row in D1
//
// Best-effort: failure to XADD is logged but doesn't fail the caller. The
// dashboard cross-cell view runs ~seconds behind cell PG truth as a result;
// per-sandbox listings hit the cell directly via /api/sandboxes/{id}/
// checkpoints so they're always authoritative.
func (s *Server) publishCheckpointEvent(
	ctx context.Context,
	eventType string,
	checkpointID uuid.UUID,
	sandboxID string,
	orgID uuid.UUID,
	workerID string,
	payload map[string]any,
) {
	if s.redisClient == nil || s.cellID == "" {
		return
	}
	envelope := map[string]any{
		"id":         uuid.NewString(),
		"type":       eventType,
		"sandbox_id": sandboxID,
		"org_id":     orgID.String(),
		"worker_id":  workerID,
		"cell_id":    s.cellID,
		"payload":    map[string]any{},
		"timestamp":  time.Now().UTC().Format(time.RFC3339Nano),
	}
	// Merge in the checkpoint-specific payload + always include the
	// checkpoint ID so events-ingest can key on it.
	out := envelope["payload"].(map[string]any)
	out["checkpoint_id"] = checkpointID.String()
	for k, v := range payload {
		out[k] = v
	}

	body, err := json.Marshal(envelope)
	if err != nil {
		log.Printf("publishCheckpointEvent: marshal: %v", err)
		return
	}

	streamKey := "events:" + s.cellID
	xaddCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := s.redisClient.XAdd(xaddCtx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: 100000,
		Approx: true,
		Values: map[string]any{"event": string(body)},
	}).Err(); err != nil {
		log.Printf("publishCheckpointEvent: XADD %s: %v", eventType, err)
	}
}
