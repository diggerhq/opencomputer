-- All-Svix-at-edge: webhook destination management + delivery state moved to the
-- edge (api-edge → Svix, D1 index). The CP keeps only sandbox_lifecycle_events as
-- the transient outbox (relay → cell stream → edge). Drop the now-unused CP tables
-- created by migration 049. See .agents/work/sandbox-webhooks-rearchitecture.md.
DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS webhook_idempotency_keys CASCADE;
DROP TABLE IF EXISTS webhook_destinations CASCADE;
