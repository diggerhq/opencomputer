DROP INDEX IF EXISTS idx_sandbox_sessions_running_end_at;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS end_at;
