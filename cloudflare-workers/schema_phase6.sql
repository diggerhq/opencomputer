-- Phase 6: checkpoint failure details in the global D1 checkpoint index.
--
-- The edge dashboard reads /checkpoints from checkpoints_index, not from each
-- cell's local Postgres. Before this phase, failed async checkpoints stayed in
-- cell PG only, so the dashboard could show "No checkpoints yet" while
-- `oc checkpoint list` showed a failed checkpoint with an error reason.
--
-- Apply before deploying api-edge/events-ingest/control-plane code that reads
-- or writes these columns:
--   wrangler d1 execute opencomputer-dev --remote --file cloudflare-workers/schema_phase6.sql
--
-- SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so this ALTER fails on re-run —
-- one-shot, like earlier phase files.

ALTER TABLE checkpoints_index ADD COLUMN name TEXT;
ALTER TABLE checkpoints_index ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE checkpoints_index ADD COLUMN error_msg TEXT;
ALTER TABLE checkpoints_index ADD COLUMN failed_at INTEGER;
