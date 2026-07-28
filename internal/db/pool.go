package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PoolOrgID is the synthetic org that owns pre-warmed pool sandboxes
// (status='pooled'). Seeded by migration 054. Pool boxes are never billed:
// no scale_event is opened at manufacture and usage/quota count only
// status='running' (see CountActiveSandboxes), so a parked box accrues nothing.
var PoolOrgID = uuid.MustParse("00000000-0000-4000-8000-000000000001")

// ErrPoolEmpty is returned by ClaimPooledSession when no pooled box matches the
// requested (region, template) — the caller falls through to a cold golden
// restore. A miss is never worse than the status-quo create.
var ErrPoolEmpty = errors.New("no pooled sandbox available")

// CreatePooledSession inserts a sandbox_sessions row for a freshly manufactured
// pool box: generic, owned by the pool org, status='pooled', bound to no
// customer. Unlike CreateSandboxSessionWithStatus it emits NO sandbox.created
// lifecycle event — a pooled box is invisible to customers until claimed (the
// claim's pending→running promotion emits created/ready).
func (s *Store) CreatePooledSession(ctx context.Context, sandboxID, template, region, workerID string, config json.RawMessage) error {
	if len(config) == 0 {
		config = json.RawMessage(`{}`)
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sandbox_sessions (sandbox_id, org_id, template, region, worker_id, config, metadata, status)
		 VALUES ($1, $2, $3, $4, $5, $6, '{}', 'pooled')`,
		sandboxID, PoolOrgID, template, region, workerID, config,
	)
	if err != nil {
		return fmt.Errorf("create pooled session: %w", err)
	}
	return nil
}

// ClaimedBox identifies a successfully claimed pool box.
type ClaimedBox struct {
	SandboxID string
	WorkerID  string
}

// ClaimPooledSession atomically claims one pooled box matching (region, template)
// for orgID: it rebinds ownership and flips status pooled→pending in a single
// UPDATE. The inner SELECT uses FOR UPDATE SKIP LOCKED so concurrent claims
// (even across control planes) never grab the same box. Returns ErrPoolEmpty
// when none is available. The box is left status='pending'; the caller resumes
// + rebinds it on the worker, then promotes pending→running (which emits
// sandbox.created/ready) — so no lifecycle event fires for a failed claim.
func (s *Store) ClaimPooledSession(ctx context.Context, orgID uuid.UUID, userID *uuid.UUID, region, template string, config, metadata json.RawMessage, secretStoreID *uuid.UUID) (*ClaimedBox, error) {
	if len(config) == 0 {
		config = json.RawMessage(`{}`)
	}
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	var box ClaimedBox
	err := s.pool.QueryRow(ctx,
		`UPDATE sandbox_sessions SET
		     org_id = $1, user_id = $2, secret_store_id = $3, config = $4, metadata = $5,
		     status = 'pending', hibernation_mode = NULL, paused_at = NULL
		 WHERE sandbox_id = (
		     SELECT sandbox_id FROM sandbox_sessions
		     WHERE status = 'pooled' AND region = $6 AND template = $7
		     ORDER BY started_at ASC
		     LIMIT 1 FOR UPDATE SKIP LOCKED
		 )
		 RETURNING sandbox_id, worker_id`,
		orgID, userID, secretStoreID, config, metadata, region, template,
	).Scan(&box.SandboxID, &box.WorkerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPoolEmpty
	}
	if err != nil {
		return nil, fmt.Errorf("claim pooled session: %w", err)
	}
	return &box, nil
}

// CountPooled returns the number of parked pooled boxes for (region, template) —
// the refill reconciler's gap signal.
func (s *Store) CountPooled(ctx context.Context, region, template string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sandbox_sessions WHERE status='pooled' AND region=$1 AND template=$2`,
		region, template,
	).Scan(&n)
	return n, err
}

// ListPooledOnWorker returns the pooled sandbox IDs parked on a worker. Used to
// wipe the pool when a worker is drained — pooled boxes are disposable (generic,
// no customer data), so they are destroyed rather than migrated/hibernated, and
// must not block the worker's termination.
func (s *Store) ListPooledOnWorker(ctx context.Context, workerID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT sandbox_id FROM sandbox_sessions WHERE status='pooled' AND worker_id=$1`, workerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// WipePooled marks a pooled box stopped (worker drain). Guarded on
// status='pooled' so a box claimed in the meantime is never clobbered.
func (s *Store) WipePooled(ctx context.Context, sandboxID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sandbox_sessions SET status='stopped', stopped_at=now(), hibernation_mode=NULL
		 WHERE sandbox_id=$1 AND status='pooled'`, sandboxID)
	return err
}
