-- Two-tier hibernation: surface the internal hibernation tier in the D1
-- cross-cell index so the api-edge paused-cap enforcer (and the dashboard's
-- cross-cell view) can see it. Mirrors sandbox_sessions.hibernation_mode in each
-- cell's Postgres (internal/db/migrations/052_paused_hibernation_mode). The
-- customer-facing status stays 'hibernated'; hibernation_mode is
-- 'paused' | 'deep' | NULL (running).
ALTER TABLE sandboxes_index ADD COLUMN hibernation_mode TEXT;

-- runPausedCapEnforcer scans an org's paused rows oldest-first to promote the
-- excess to deep hibernation, so index paused rows by (org, age).
CREATE INDEX IF NOT EXISTS idx_sandboxes_paused
  ON sandboxes_index(org_id, last_event_at)
  WHERE hibernation_mode = 'paused';
