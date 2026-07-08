DROP INDEX IF EXISTS idx_sandbox_sessions_paused;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS paused_at;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS hibernation_mode;
