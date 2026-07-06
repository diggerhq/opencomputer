-- Phase 11: two-tier hibernation on sandboxes_index (cross-cell paused cap).
--
-- sandboxes_index.status stays customer-facing (running | hibernated | stopped).
-- hibernation_mode is the internal tier, mirrored from the cell:
--   'paused' — RAM-resident on its worker (instant resume, unbilled)
--   'deep'   — savevm'd + evicted to a checkpoint
--   NULL     — running
-- Only D1 has the org-global, cross-cell view (an org is best-effort single
-- cell, not guaranteed), so the api-edge uses this column to enforce the
-- per-org paused cap. events-ingest maintains it on paused/hibernated/woke.
--
-- Apply with:
--   wrangler d1 execute opencomputer-prod --remote --file cloudflare-workers/schema_phase11_paused_hibernation_mode.sql
--
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS, so this is one-shot.
ALTER TABLE sandboxes_index ADD COLUMN hibernation_mode TEXT;

-- The cap enforcer scans an org's paused rows oldest-first. last_event_at is
-- ~the pause time, so it doubles as the promotion ordering key.
CREATE INDEX IF NOT EXISTS idx_sandboxes_paused
  ON sandboxes_index(org_id, last_event_at)
  WHERE hibernation_mode = 'paused';
