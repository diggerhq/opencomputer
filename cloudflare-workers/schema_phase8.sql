-- Phase 8: checkpoint kind in the global D1 checkpoint index.
--
-- The dashboard reads /checkpoints from checkpoints_index, not directly from
-- each cell's Postgres sandbox_checkpoints table. Disk-only checkpoints need
-- their kind mirrored here so the dashboard can distinguish them from full
-- checkpoints.
--
-- Apply before deploying api-edge/events-ingest code that reads or writes this
-- column:
--   wrangler d1 execute opencomputer-dev --remote --file cloudflare-workers/schema_phase8.sql
--
-- SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so this is one-shot like the
-- earlier phase files.

ALTER TABLE checkpoints_index ADD COLUMN kind TEXT NOT NULL DEFAULT 'full';
