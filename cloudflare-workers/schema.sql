-- D1 schema for OpenSandbox global layer.
-- Apply with: wrangler d1 execute opencomputer-dev --file cloudflare-workers/schema.sql

-- Identity ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orgs (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  plan                   TEXT NOT NULL,         -- "free" | "pro"
  home_cell              TEXT NOT NULL,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  workos_org_id          TEXT UNIQUE,
  is_personal            INTEGER NOT NULL DEFAULT 0,
  owner_user_id          TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  workos_user_id  TEXT UNIQUE,
  name            TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_memberships (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,       -- "owner" | "admin" | "member"
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON org_memberships(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  created_by  TEXT,
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  name        TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT 'sandbox:*',
  last_used   INTEGER,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org  ON api_keys(org_id);

-- Global catalog ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS templates (
  id               TEXT PRIMARY KEY,
  org_id           TEXT,                          -- NULL = public template
  name             TEXT NOT NULL,
  tag              TEXT NOT NULL DEFAULT 'latest',
  template_type    TEXT NOT NULL DEFAULT 'dockerfile',
  image_ref        TEXT,
  rootfs_s3_key    TEXT,
  workspace_s3_key TEXT,
  dockerfile       TEXT,
  is_public        INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ready',
  cells_available  TEXT NOT NULL DEFAULT '[]',    -- JSON array
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_unique ON templates(org_id, name, tag);
CREATE INDEX IF NOT EXISTS idx_templates_public ON templates(is_public) WHERE is_public = 1;

-- Global secret stores (CPs fetch via HMAC at sandbox-create time;
-- regional CP never persists a copy).
CREATE TABLE IF NOT EXISTS secret_stores (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  name             TEXT NOT NULL,
  egress_allowlist TEXT NOT NULL DEFAULT '[]',    -- JSON array
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_stores_unique ON secret_stores(org_id, name);
CREATE INDEX IF NOT EXISTS idx_secret_stores_org ON secret_stores(org_id);

CREATE TABLE IF NOT EXISTS secret_store_entries (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  encrypted_value BLOB NOT NULL,                  -- AES-GCM, key in CF secret
  allowed_hosts   TEXT NOT NULL DEFAULT '[]',     -- JSON array
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_entries_unique ON secret_store_entries(store_id, name);
CREATE INDEX IF NOT EXISTS idx_secret_entries_store ON secret_store_entries(store_id);

-- Cell registry ----------------------------------------------------------
-- One row per regional control plane. The edge Worker uses base_url to:
--   - proxy POST /api/sandboxes  → {base_url}/internal/sandboxes/create
--   - dispatch admin callbacks   → {base_url}/admin/halt-org, /admin/resume-org
--   - 307-redirect dumb clients  → {base_url}/api/sandboxes/{id}/...
-- (In production the public 307 target and the internal edge→CP URL may
--  diverge — e.g. an internal-only hostname for /internal/*. Split into two
--  columns then; one URL is enough while every cell exposes both on one host.)
-- orgs.home_cell, sandboxes_index.cell_id, and events.cell_id all reference
-- cell_id here, but D1 has no cross-table FKs so it's by convention.
CREATE TABLE IF NOT EXISTS cells (
  cell_id     TEXT PRIMARY KEY,                  -- "{cloud}-{region}-cell-{slot}"
  cloud       TEXT NOT NULL,                     -- "azure" | "aws" | "gcp"
  region      TEXT NOT NULL,
  base_url    TEXT NOT NULL,                     -- regional CP base URL (scheme+host[:port])
  status      TEXT NOT NULL DEFAULT 'active',    -- active | draining | down
  -- Capacity-aware placement (updated by cell_capacity events; see
  -- internal/controlplane/capacity_reporter.go + events-ingest worker).
  -- The CP aggregates per-worker memory pressure from WorkerEntry. A cell is
  -- placement-eligible iff available_workers > 0 AND capacity_updated_at is
  -- within the freshness window (~120s). NULL/stale capacity_updated_at ⇒ the
  -- reporting CP is dead, treat the cell as unhealthy regardless of `status`.
  --
  -- "available" = worker where committed_memory_mb/total_memory_mb < 85%.
  -- Single-worker-below-threshold is the right gate because a sandbox lands
  -- on one worker, not striped across workers — aggregating across the cell
  -- would wrongly skip a cell with 1 free worker and 9 loaded ones.
  healthy_workers     INTEGER NOT NULL DEFAULT 0,  -- alive workers in this cell
  available_workers   INTEGER NOT NULL DEFAULT 0,  -- workers under the mem threshold
  running_sandboxes   INTEGER NOT NULL DEFAULT 0,  -- observability only, not in placement
  capacity_updated_at INTEGER,
  created_at  INTEGER NOT NULL
);

-- Global sandbox index (cross-region routing and listing) -----------------

CREATE TABLE IF NOT EXISTS sandboxes_index (
  id            TEXT PRIMARY KEY,                 -- sandbox_id
  org_id        TEXT NOT NULL,
  user_id       TEXT,
  cell_id       TEXT NOT NULL,
  worker_id     TEXT,
  status        TEXT NOT NULL,                    -- running | hibernated | stopped | error
  template_id   TEXT,
  created_at    INTEGER NOT NULL,
  last_event_at INTEGER,
  stopped_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_org_status ON sandboxes_index(org_id, status);
CREATE INDEX IF NOT EXISTS idx_sandboxes_cell       ON sandboxes_index(cell_id, status);
CREATE INDEX IF NOT EXISTS idx_sandboxes_active     ON sandboxes_index(org_id) WHERE status = 'running';

-- Events (audit + query) -------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,                    -- event UUID from worker
  cell_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  org_id     TEXT,
  sandbox_id TEXT,
  user_id    TEXT,
  worker_id  TEXT,
  ts         INTEGER NOT NULL,                    -- unix ms
  payload    TEXT NOT NULL                        -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_org_ts     ON events(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_sandbox_ts ON events(sandbox_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_cell_ts    ON events(cell_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts    ON events(type, ts DESC);

-- Billing (pro tier) ------------------------------------------------------

-- Raw per-tick resource samples for pro orgs — the edge analog of the cell's
-- `sandbox_scale_events`. events-ingest writes one row per pro `usage_tick`;
-- the rollup cron aggregates these into `usage_snapshots` (memory_gb_seconds
-- per hourly bucket) and meters them to Stripe.
--
-- `id` is the originating event UUID, so the INSERT can use ON CONFLICT(id)
-- DO NOTHING for the same at-least-once dedup the `events` table relies on —
-- the CP forwarder retries batches, and additive billing must not double-count.
-- Rows are disposable once rolled up (see rolled_up flag); kept short-lived,
-- independent of the `events` audit log's retention.
CREATE TABLE IF NOT EXISTS usage_samples (
  id          TEXT PRIMARY KEY,                  -- originating event UUID
  org_id      TEXT NOT NULL,
  sandbox_id  TEXT NOT NULL,
  memory_mb   INTEGER NOT NULL,
  cpu_count   INTEGER NOT NULL,
  interval_s  INTEGER NOT NULL,                  -- seconds this sample covers
  ts          INTEGER NOT NULL,                  -- unix ms (tick emit time)
  cell_id     TEXT NOT NULL,
  rolled_up   INTEGER NOT NULL DEFAULT 0
);
-- Rollup cron scans unrolled samples ordered by time; partial index keeps it
-- tight as rolled-up rows accumulate before cleanup.
CREATE INDEX IF NOT EXISTS idx_usage_samples_unrolled ON usage_samples(org_id, ts) WHERE rolled_up = 0;

CREATE TABLE IF NOT EXISTS usage_snapshots (
  org_id            TEXT NOT NULL,
  snapshot_ts       INTEGER NOT NULL,             -- hourly bucket (unix s)
  cpu_seconds       INTEGER NOT NULL,
  wall_seconds      INTEGER NOT NULL,
  memory_gb_seconds REAL NOT NULL,
  sandbox_count     INTEGER NOT NULL,
  cost_cents        INTEGER NOT NULL,
  reported_to_stripe INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, snapshot_ts)
);
CREATE INDEX IF NOT EXISTS idx_usage_unreported ON usage_snapshots(reported_to_stripe, org_id) WHERE reported_to_stripe = 0;

-- Billing outbox — one row per Stripe meter event the rollup cron will ship.
-- The edge analog of the cell's `billable_events`. Meter-grained (not one row
-- per org/hour like usage_snapshots) because legacy orgs bill one meter event
-- PER memory tier, while unified orgs bill a single flat overage meter — a
-- per-org/hour row can't hold the legacy per-tier breakdown.
--
-- `id` is deterministic: "{org}:{bucket_start}:{meter_event_name}". That makes
-- the whole rollup idempotent — re-running a bucket recomputes identical ids,
-- so ON CONFLICT(id) DO NOTHING drops the dup, and it doubles as the Stripe
-- meter-event Identifier (Stripe dedups the same identifier within 24h). So a
-- crash anywhere in roll→send→mark is safe to replay.
--
-- `value` units depend on billing_mode: unified=GB-seconds (float), legacy=
-- seconds at that tier (integer, the unit the cell's per-tier meter expects).
CREATE TABLE IF NOT EXISTS usage_meter_events (
  id                TEXT PRIMARY KEY,             -- {org}:{bucket_start}:{meter_event_name}
  org_id            TEXT NOT NULL,
  meter_event_name  TEXT NOT NULL,                -- Stripe meter event_name
  value             REAL NOT NULL,                -- GB-seconds (unified) | seconds (legacy tier)
  billing_mode      TEXT NOT NULL,                -- 'legacy' | 'unified' (for the parity diff)
  bucket_start      INTEGER NOT NULL,             -- unix s (inclusive)
  bucket_end        INTEGER NOT NULL,             -- unix s (exclusive); meter event timestamp
  state             TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'shadow'
  stripe_identifier TEXT,                         -- echoed back by Stripe on send
  created_at        INTEGER NOT NULL,
  sent_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meter_events_pending ON usage_meter_events(state, bucket_start) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_meter_events_org_bucket ON usage_meter_events(org_id, bucket_start);

-- Stripe price catalog — the resolved metered Price IDs the edge attaches when
-- it provisions a pro subscription. The catalog is GLOBAL (one Stripe account,
-- same prices for every cell), so it's written by a single deploy-time step
-- (cmd/ensure-products), NOT by per-cell publishing — 40 cells must not each
-- race to write it. The edge reads every row and attaches each price_id as a
-- subscription item (mirrors the CP's CreateSubscription).
--   key: "tier_1024".."tier_65536" | "overage" | "reserved" | "disk_overage"
CREATE TABLE IF NOT EXISTS billing_prices (
  key        TEXT PRIMARY KEY,
  price_id   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_subscription_items (
  org_id          TEXT NOT NULL,
  tier            TEXT NOT NULL,                  -- e.g. "memory" | "cpu"
  stripe_item_id  TEXT NOT NULL,
  price_id        TEXT NOT NULL,
  PRIMARY KEY (org_id, tier)
);
