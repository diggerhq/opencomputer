-- Phase 5: home-cell onboarding gate moves from the edge `CELLS` env var to a
-- column on the D1 `cells` table.
--
-- Why: `pickHomeCell` used a hardcoded, deploy-time `CELLS` allowlist that had
-- to be kept in sync with the `cells` table by hand. It drifted — prod shipped
-- `CELLS = ""`, so every new org since ~2026-05-27 got an empty `home_cell`.
-- Making onboarding-eligibility a property of the cell row removes the second
-- source of truth: it can't drift from `cells` because it IS `cells`, and
-- opening a cell to new signups becomes a row toggle instead of a deploy.
--
-- Apply with:
--   wrangler d1 execute opencomputer-dev --remote --file cloudflare-workers/schema_phase5.sql
--
-- SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so this ALTER fails on re-run —
-- one-shot, like the earlier phases.
--
-- ROLLOUT ORDER MATTERS. Run this migration AND open the onboarding cell(s)
-- (step 2 below) BEFORE deploying the new api-edge code. The new pickHomeCell
-- reads `accepts_new_orgs`; if you deploy code while every cell still has the
-- default 0, new orgs get an empty home_cell during the gap.

-- 1. Schema: the onboarding gate. Default 0 = a cell does NOT adopt new orgs
--    until explicitly opened. Distinct from `status` (routing of existing
--    orgs / pins / failover), so a cell can be active+routable without
--    onboarding new signups (e.g. a brand-new cell still under validation).
ALTER TABLE cells ADD COLUMN accepts_new_orgs INTEGER NOT NULL DEFAULT 0;

-- 2. Open the cell(s) that SHOULD onboard new orgs. Run the line for your env;
--    the other is a harmless no-op (cell_id won't match).
--      prod:  UPDATE cells SET accepts_new_orgs = 1 WHERE cell_id = 'azure-us-east-2-a';
--      dev:   UPDATE cells SET accepts_new_orgs = 1 WHERE cell_id = 'azure-westus2-cell-a';

-- 3. Backfill orgs that were created with an empty home_cell during the drift
--    window, pointing them at the de-facto cell (prod: azure-us-east-2-a).
--    Run per env:
--      UPDATE orgs SET home_cell = 'azure-us-east-2-a'
--       WHERE home_cell IS NULL OR home_cell = '';
