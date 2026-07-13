-- Two-tier hibernation. The customer-facing sandbox status stays 'hibernated',
-- but internally a hibernated sandbox is one of:
--   'paused' — QMP stop + guest RAM paged out to swap; stays RAM-resident on its
--              worker, unbilled, resumes instantly (QMP cont).
--   'deep'   — savevm'd to the checkpoint store and evicted from the worker.
-- NULL while running. The platform silently promotes paused → deep on idle age
-- (1h) or the per-org paused cap (100), so customers only ever see 'hibernated'.
ALTER TABLE sandbox_sessions ADD COLUMN hibernation_mode TEXT;

-- When the sandbox was paused (NULL unless hibernation_mode = 'paused'). Drives
-- the 1h idle→deep promotion and the oldest-first ordering for the 100-cap.
ALTER TABLE sandbox_sessions ADD COLUMN paused_at TIMESTAMPTZ;

-- The promotion reconciler scans paused rows by org (cap) and by age (1h).
CREATE INDEX idx_sandbox_sessions_paused
    ON sandbox_sessions(org_id, paused_at)
    WHERE hibernation_mode = 'paused';
