package db

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// PausedRef identifies a paused sandbox the promotion reconciler should deep-
// hibernate, along with the worker that currently holds its RAM.
type PausedRef struct {
	SandboxID string
	OrgID     uuid.UUID
	WorkerID  string
}

// SetSandboxPaused transitions a running sandbox into the RAM-resident paused
// tier: customer-visible status stays "hibernated", hibernation_mode becomes
// "paused", paused_at is stamped. CAS on status='running' so a concurrent
// stop/deep-hibernate/terminate wins cleanly. Returns whether a row changed.
//
// Paused = UNBILLED (the usage ticker skips paused boxes, so it never refreshes
// the open scale_events row again). So — like every other transition that leaves
// UpdateSandboxSessionStatus's inline close-out (see
// closeOpenScaleEventsForSandboxes) — this must close the open billing row in
// the SAME tx. Every pause path funnels through here (customer hibernate,
// idle-timeout, migrate re-pause), so this is the one chokepoint. Missing it
// left a scale_events row open on every pause since the pause tier shipped,
// over-counting the usage chart and OVER-BILLING legacy (scale-event) orgs for
// boxes that should be free. Resume re-opens a fresh row via the ticker's next
// tick, so this only needs to close.
func (s *Store) SetSandboxPaused(ctx context.Context, sandboxID string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE sandbox_sessions
		    SET status = 'hibernated', hibernation_mode = 'paused', paused_at = now()
		  WHERE sandbox_id = $1 AND status = 'running'`, sandboxID)
	if err != nil {
		return false, err
	}
	changed := tag.RowsAffected() > 0

	// Only close on a real running→paused transition; a no-op CAS (already
	// paused/terminal) must not touch a row a concurrent winner may own.
	if changed {
		if err := closeOpenScaleEventsForSandboxes(ctx, tx, []string{sandboxID}); err != nil {
			return false, fmt.Errorf("close scale events: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit tx: %w", err)
	}
	return changed, nil
}

// SetSandboxResumed transitions a paused sandbox back to running (QMP cont on
// its existing worker — worker_id is unchanged). Clears the paused markers.
func (s *Store) SetSandboxResumed(ctx context.Context, sandboxID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sandbox_sessions
		    SET status = 'running', hibernation_mode = NULL, paused_at = NULL
		  WHERE sandbox_id = $1`, sandboxID)
	return err
}

// SetSandboxDeep marks a paused sandbox as deep-hibernated (savevm'd + evicted).
// status stays "hibernated"; only the internal tier changes. CAS on
// hibernation_mode='paused' so it no-ops if the box already resumed or was
// promoted by another reconciler pass.
func (s *Store) SetSandboxDeep(ctx context.Context, sandboxID string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sandbox_sessions
		    SET hibernation_mode = 'deep', paused_at = NULL
		  WHERE sandbox_id = $1 AND hibernation_mode = 'paused'`, sandboxID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// CountPausedByOrg returns how many paused (RAM-resident) sandboxes an org has.
func (s *Store) CountPausedByOrg(ctx context.Context, orgID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM sandbox_sessions
		  WHERE org_id = $1 AND hibernation_mode = 'paused'`, orgID).Scan(&n)
	return n, err
}

// ListPausedToPromote returns paused sandboxes that should be promoted to deep
// hibernation, either because they've been paused longer than ageCutoff (idle
// too long) or because their org is over the per-org paused cap (the oldest
// excess, oldest-first). One row per sandbox even if it matches both.
func (s *Store) ListPausedToPromote(ctx context.Context, ageCutoff time.Time, orgCap int) ([]PausedRef, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT sandbox_id, org_id, worker_id FROM (
		     SELECT sandbox_id, org_id, worker_id, paused_at,
		            row_number() OVER (PARTITION BY org_id ORDER BY paused_at ASC) AS rn,
		            count(*)     OVER (PARTITION BY org_id)                        AS cnt
		       FROM sandbox_sessions
		      WHERE hibernation_mode = 'paused'
		 ) t
		 WHERE paused_at < $1                       -- idle longer than the age cutoff
		    OR (cnt > $2 AND rn <= cnt - $2)        -- oldest excess over the per-org cap
		 ORDER BY paused_at ASC`, ageCutoff, orgCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var refs []PausedRef
	for rows.Next() {
		var r PausedRef
		if err := rows.Scan(&r.SandboxID, &r.OrgID, &r.WorkerID); err != nil {
			return nil, err
		}
		refs = append(refs, r)
	}
	return refs, rows.Err()
}
