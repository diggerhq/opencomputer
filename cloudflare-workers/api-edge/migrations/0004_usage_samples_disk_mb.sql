-- Add disk_mb to usage_samples so the autumn-meter can attribute disk-overage
-- GB-seconds against the running-sandbox billing bucket. Cell emits it in the
-- usage_tick payload, events-ingest lands it in this column, autumn_meter reads
-- it in the per-bucket aggregation. Default 0 = "no disk signal for this tick",
-- which the autumn-meter treats as no overage (matches "free 20GB is included"
-- and prevents pre-migration rows from silently accruing overage).
ALTER TABLE usage_samples ADD COLUMN disk_mb INTEGER NOT NULL DEFAULT 0;
