-- orgs.usage_plan — the org's active Autumn usage plan: 'base' | 'pro' | 'max'.
--
-- Projected from Autumn by syncAutumnToD1 alongside is_halted, so the
-- managed-agent credit gate can tell paid orgs from free ones without an
-- Autumn round trip. A halted paid org (pro/max) keeps running managed agents
-- on the open-weight fallback model; a halted base org hard-stops and must
-- upgrade. Rows default to 'base' until their next projection, which keeps an
-- unprojected org on the stricter free-tier behavior.
ALTER TABLE orgs ADD COLUMN usage_plan TEXT NOT NULL DEFAULT 'base';
