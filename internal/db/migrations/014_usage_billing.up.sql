-- Usage billing: track per-sandbox vCPU-seconds and GB-seconds for elastic billing
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS vcpu_seconds DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS gb_seconds   DOUBLE PRECISION NOT NULL DEFAULT 0;
