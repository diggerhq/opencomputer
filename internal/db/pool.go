package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

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

// CountPooled returns the number of parked pooled boxes for (region, template).
func (s *Store) CountPooled(ctx context.Context, region, template string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sandbox_sessions WHERE status='pooled' AND region=$1 AND template=$2`,
		region, template,
	).Scan(&n)
	return n, err
}

// CountPooledOnWorker returns the number of parked pooled boxes on a specific
// worker for a template — the per-worker refill reconciler's gap signal.
func (s *Store) CountPooledOnWorker(ctx context.Context, workerID, template string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sandbox_sessions WHERE status IN ('pooled','edge_reserved') AND worker_id=$1 AND template=$2`,
		workerID, template,
	).Scan(&n)
	return n, err
}

// ListPooledOnWorker returns the pooled sandbox IDs parked on a worker. Used to
// wipe the pool when a worker is drained — pooled boxes are disposable (generic,
// no customer data), so they are destroyed rather than migrated/hibernated, and
// must not block the worker's termination.
func (s *Store) ListPooledOnWorker(ctx context.Context, workerID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT sandbox_id FROM sandbox_sessions WHERE status IN ('pooled','edge_reserved') AND worker_id=$1`, workerID)
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

// WipePooled marks a pooled box stopped (worker drain). Guarded on the parked
// statuses (pooled / edge_reserved) so a box claimed in the meantime is never
// clobbered.
func (s *Store) WipePooled(ctx context.Context, sandboxID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sandbox_sessions SET status='stopped', stopped_at=now(), hibernation_mode=NULL
		 WHERE sandbox_id=$1 AND status IN ('pooled','edge_reserved')`, sandboxID)
	return err
}

// ReservePooledForEdge flips up to n pooled boxes to status='edge_reserved' and
// returns them — the edge PoolStock Durable Object's restock call. Reserved
// boxes are invisible to ClaimPooledSession (which filters status='pooled'), so
// the edge and CP claim paths can never hand the same box to two customers.
// A reservation that is never claimed is returned to the pool by
// ReleaseStaleEdgeReservations (updated_at is bumped by the status trigger).
func (s *Store) ReservePooledForEdge(ctx context.Context, region, template string, n int) ([]ClaimedBox, error) {
	rows, err := s.pool.Query(ctx,
		`UPDATE sandbox_sessions SET status='edge_reserved'
		 WHERE sandbox_id IN (
		     SELECT sandbox_id FROM sandbox_sessions
		     WHERE status='pooled' AND region=$1 AND template=$2
		     ORDER BY started_at ASC
		     LIMIT $3 FOR UPDATE SKIP LOCKED
		 )
		 RETURNING sandbox_id, worker_id`,
		region, template, n,
	)
	if err != nil {
		return nil, fmt.Errorf("reserve pooled for edge: %w", err)
	}
	defer rows.Close()
	var boxes []ClaimedBox
	for rows.Next() {
		var b ClaimedBox
		if err := rows.Scan(&b.SandboxID, &b.WorkerID); err != nil {
			return nil, err
		}
		boxes = append(boxes, b)
	}
	return boxes, rows.Err()
}

// ClaimReservedSession binds a specific edge_reserved box to a customer —
// the finalize half of an edge claim (the edge already returned the 201; this
// is the async bookkeeping). Mirrors ClaimPooledSession's rebind but by
// sandbox_id: the status guard means a stale-reservation reap or a worker
// drain in the window loses the race cleanly (we error, the caller marks the
// customer-visible session failed).
func (s *Store) ClaimReservedSession(ctx context.Context, sandboxID string, orgID uuid.UUID, userID *uuid.UUID, config, metadata json.RawMessage, secretStoreID *uuid.UUID) (*ClaimedBox, error) {
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
		 WHERE sandbox_id = $6 AND status = 'edge_reserved'
		 RETURNING sandbox_id, worker_id`,
		orgID, userID, secretStoreID, config, metadata, sandboxID,
	).Scan(&box.SandboxID, &box.WorkerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPoolEmpty
	}
	if err != nil {
		return nil, fmt.Errorf("claim reserved session: %w", err)
	}
	return &box, nil
}

// ReleaseEdgeReservations returns specific edge_reserved boxes to the pool.
// ONLY safe for boxes the edge explicitly discarded from its stock BEFORE
// handing them to any customer — a popped entry has a minted sandbox token in
// the wild, and a re-pooled box with a live foreign token would be a
// cross-tenant hole. The status guard skips anything already claimed.
func (s *Store) ReleaseEdgeReservations(ctx context.Context, sandboxIDs []string) (int, error) {
	if len(sandboxIDs) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE sandbox_sessions SET status='pooled'
		 WHERE sandbox_id = ANY($1) AND status='edge_reserved'`,
		sandboxIDs,
	)
	if err != nil {
		return 0, fmt.Errorf("release edge reservations: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// ListStaleEdgeReservations returns edge_reserved boxes older than ttl — the
// destroy-backstop reaper's input. Unlike ReleaseEdgeReservations these are
// DESTROYED, not re-pooled: the CP can't prove the edge never minted a token
// for them (a dead Durable Object can't release its stock), and a re-issued
// box with a live foreign token would be cross-tenant access. Remanufacture
// is cheap; the hole is not.
func (s *Store) ListStaleEdgeReservations(ctx context.Context, ttl time.Duration) ([]ClaimedBox, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT sandbox_id, worker_id FROM sandbox_sessions
		 WHERE status='edge_reserved' AND updated_at < now() - $1::interval`,
		fmt.Sprintf("%d seconds", int(ttl.Seconds())),
	)
	if err != nil {
		return nil, fmt.Errorf("list stale edge reservations: %w", err)
	}
	defer rows.Close()
	var boxes []ClaimedBox
	for rows.Next() {
		var b ClaimedBox
		if err := rows.Scan(&b.SandboxID, &b.WorkerID); err != nil {
			return nil, err
		}
		boxes = append(boxes, b)
	}
	return boxes, rows.Err()
}
