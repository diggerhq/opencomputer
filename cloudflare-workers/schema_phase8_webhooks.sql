-- Phase 8: sandbox lifecycle webhooks (all-Svix-at-edge).
-- api-edge owns /api/webhooks management; the index below maps OC destination
-- ids ↔ Svix endpoints. events-ingest reads orgs.has_webhooks as the dormancy
-- gate (skip the Svix call entirely for orgs with no webhooks).
-- See .agents/work/sandbox-webhooks-rearchitecture.md §8.

-- Coarse dormancy flag: true once an org has ≥1 live destination.
ALTER TABLE orgs ADD COLUMN has_webhooks INTEGER NOT NULL DEFAULT 0;

-- Webhook destinations (the OC↔Svix mapping; secrets live in Svix, not here).
CREATE TABLE IF NOT EXISTS webhook_destinations (
  id               TEXT PRIMARY KEY,            -- 'whk_' + random hex
  org_id           TEXT NOT NULL,
  svix_app_id      TEXT NOT NULL,               -- Svix app id (uid = org_id)
  svix_endpoint_id TEXT NOT NULL,               -- Svix endpoint id
  url              TEXT NOT NULL,
  event_types      TEXT NOT NULL DEFAULT '[]',  -- JSON array; [] = all types
  sandbox_id       TEXT,                        -- NULL = org-wide; else Svix channel scope
  name             TEXT,
  disabled         INTEGER NOT NULL DEFAULT 0,  -- mirrors the Svix endpoint disabled flag
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER                      -- soft-delete; history stays in Svix
);

CREATE INDEX IF NOT EXISTS webhook_dest_org_idx
  ON webhook_destinations (org_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_dest_svix_ep_idx
  ON webhook_destinations (svix_endpoint_id);

-- Create idempotency: a (org, Idempotency-Key) → destination map so a retried
-- POST /api/webhooks returns the SAME destination instead of a duplicate. The
-- PK makes the claim atomic; a concurrent loser deletes its just-created dup and
-- returns the winner's row (see api-edge createWebhook).
CREATE TABLE IF NOT EXISTS webhook_idempotency (
  org_id          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  destination_id  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (org_id, idempotency_key)
);
