-- Phase 10: Autumn per-org concurrency override.
--
-- Autumn normally projects orgs.max_concurrent_sandboxes from the customer's
-- active Autumn concurrency product:
--   base=5, concurrency_pro=100, concurrency_pro_plus=600,
--   concurrency_pro_plus_plus=1000.
--
-- Some migrated customers need a bespoke limit that should survive Autumn
-- balance/concurrency projection. NULL means "follow Autumn plan"; a positive
-- integer pins orgs.max_concurrent_sandboxes to that value whenever projection
-- runs.
--
-- Apply with:
--   wrangler d1 execute opencomputer-prod --remote --file cloudflare-workers/schema_phase10_autumn_concurrency_override.sql
--
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS, so this is one-shot.
ALTER TABLE orgs ADD COLUMN autumn_concurrency_override INTEGER;

