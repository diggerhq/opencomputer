-- Phase 7: Autumn billing — per-org billing_provider selector on D1.
--
-- The edge is authoritative for billing_provider: signup sets it, the cutover
-- backfill flips existing orgs, and the cap-token carries it to each cell's
-- Postgres mirror (like `plan`). The create/wake gates + the dashboard billing
-- read it directly from D1, so this column MUST exist before the new api-edge
-- code is deployed.
--
-- Apply with:
--   wrangler d1 execute opencomputer-dev --remote --file cloudflare-workers/schema_phase7.sql
--
-- SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so this is one-shot like the
-- earlier phases.
--
-- ROLLOUT ORDER MATTERS. Run this migration BEFORE deploying the new api-edge
-- code: loadOrgPolicy + GET /api/dashboard/billing now SELECT billing_provider
-- for every org, and a missing column makes those reads error for ALL orgs
-- (not just Autumn ones).
--
--   'legacy' — in-house pipeline (CreditAccount DO / usage_reporter).
--   'autumn' — Autumn owns the credit ledger, metering, top-ups, concurrency.
--
-- Defaults to 'legacy' so every existing org is unaffected until explicitly
-- flipped. Mirrors internal/db/migrations/047 on the cell.
ALTER TABLE orgs ADD COLUMN billing_provider TEXT NOT NULL DEFAULT 'legacy';

-- Cutover backfill / dashboard reads filter on it; partial index keeps the
-- "which orgs are on Autumn" sweep tight while almost everyone is still legacy.
CREATE INDEX IF NOT EXISTS idx_orgs_billing_provider ON orgs(billing_provider) WHERE billing_provider = 'autumn';

-- Per-org watermark (unix seconds) for the edge autumn meter loop: the end of
-- the last fully-tracked 5-minute bucket. 0 = unseeded; the first cron sight
-- seeds it to "now" and bills forward only (never retroactively charges usage
-- accrued before the org moved to Autumn). This is the edge-native replacement
-- for the cell's orgs.last_usage_synced_at — billing is one place (the edge),
-- off usage_samples, not per-cell.
ALTER TABLE orgs ADD COLUMN autumn_usage_watermark INTEGER NOT NULL DEFAULT 0;
