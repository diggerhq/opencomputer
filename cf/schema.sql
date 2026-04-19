-- D1 schema for OpenComputer's Cloudflare edge.
--
-- Phase 1 ships only the `events` table — it's the sink the events-ingest
-- Worker writes to as event batches arrive from regional CPs.
-- Phases 2/3 will add orgs, users, sandboxes_index, sandboxes_hibernated,
-- usage_snapshots, etc., once the CreditAccount DO and api-edge Worker land.
--
-- Apply with: wrangler d1 execute <DB_NAME> --file=./schema.sql [--remote]

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,   -- event UUID minted by the worker publisher
  cell_id     TEXT NOT NULL,      -- e.g. "dev-cell-a", "aws-useast1-cell-a"
  type        TEXT NOT NULL,      -- "usage_tick", "created", "command", "pty_start", etc.
  org_id      TEXT,               -- enriched by the CP forwarder; nullable in case of unknown sandbox
  sandbox_id  TEXT,
  user_id     TEXT,               -- reserved for future enrichment
  worker_id   TEXT,
  ts          INTEGER NOT NULL,   -- unix milliseconds
  payload     TEXT NOT NULL       -- JSON blob from the worker envelope
);

CREATE INDEX IF NOT EXISTS idx_events_org_ts     ON events(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_sandbox_ts ON events(sandbox_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_cell_ts    ON events(cell_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts    ON events(type, ts DESC);

-- Phase 2 tables --------------------------------------------------------------

-- Minimal orgs mirror. The CF-authoritative design eventually owns the full
-- WorkOS-linked orgs table; in CF-parallel mode this is just enough to answer
-- "is org X on free or pro plan?" when admin flows (stripe webhook, mark-pro)
-- update plan state. Rows are created lazily when api-edge or the Stripe
-- webhook needs them.
CREATE TABLE IF NOT EXISTS orgs (
  id                     TEXT PRIMARY KEY,
  plan                   TEXT NOT NULL DEFAULT 'free',  -- "free" | "pro"
  home_cell              TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- Global sandbox index. Populated by the events-ingest Worker on `created`
-- events and updated on `destroyed`/`hibernated`/`woke`. The CreditAccount
-- DO reads this to discover which cells to fan halt/resume dispatches to.
CREATE TABLE IF NOT EXISTS sandboxes_index (
  id              TEXT PRIMARY KEY,      -- sandbox_id
  org_id          TEXT NOT NULL,
  user_id         TEXT,
  cell_id         TEXT NOT NULL,
  worker_id       TEXT,
  status          TEXT NOT NULL,         -- running | hibernated | stopped | error
  template_id     TEXT,
  created_at      INTEGER NOT NULL,
  last_event_at   INTEGER,
  stopped_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_org_status ON sandboxes_index(org_id, status);
CREATE INDEX IF NOT EXISTS idx_sandboxes_cell       ON sandboxes_index(cell_id, status);
CREATE INDEX IF NOT EXISTS idx_sandboxes_active     ON sandboxes_index(org_id) WHERE status = 'running';

-- Periodic snapshot of CreditAccount DO state. Not authoritative — the DO is.
-- Useful for parity checks against PG's orgs.free_credits_remaining_cents
-- while running in CF-parallel mode.
CREATE TABLE IF NOT EXISTS credit_account_snapshots (
  org_id                TEXT PRIMARY KEY,
  plan                  TEXT NOT NULL,
  balance_cents         INTEGER NOT NULL,
  lifetime_spent_cents  INTEGER NOT NULL,
  status                TEXT NOT NULL,
  halted_at             INTEGER,
  updated_at            INTEGER NOT NULL
);
