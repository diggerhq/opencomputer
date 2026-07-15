-- Current OpenComputer D1 schema snapshot.
--
-- This file is intentionally NOT a Wrangler migration. It lives outside
-- migrations_dir, so Wrangler ignores it during CI and production deploys.
--
-- Use only when bootstrapping a brand-new D1 database, then run:
--   npx wrangler d1 migrations apply <database-name> --remote -c <wrangler-config>
--
-- Do not apply this file to an existing prod/dev database.

CREATE TABLE agent_subscriptions (
  id             TEXT PRIMARY KEY,                  -- D1-local UUID
  org_id         TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  feature        TEXT NOT NULL,                     -- "telegram", "premium-tools", etc.
  status         TEXT NOT NULL DEFAULT 'active',    -- active | cancelled
  stripe_item_id TEXT,                               -- Stripe Subscription Item ID
  created_at     INTEGER NOT NULL,
  cancelled_at   INTEGER
);

CREATE TABLE api_keys (
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

CREATE TABLE billing_prices (key TEXT PRIMARY KEY, price_id TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE cells (
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
, accepts_new_orgs INTEGER NOT NULL DEFAULT 0);

CREATE TABLE checkpoints_index (
  id               TEXT PRIMARY KEY,
  sandbox_id       TEXT NOT NULL,
  org_id           TEXT NOT NULL,
  owner_cell_id    TEXT NOT NULL,
  s3_url           TEXT NOT NULL,
  size_bytes       INTEGER,
  golden_hash      TEXT NOT NULL,
  workspace_size   INTEGER,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  replicated_to    TEXT NOT NULL DEFAULT '[]'
, name TEXT, status TEXT NOT NULL DEFAULT 'ready', error_msg TEXT, failed_at INTEGER, kind TEXT NOT NULL DEFAULT 'full');

CREATE TABLE events (
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

CREATE TABLE golden_versions (
  hash             TEXT PRIMARY KEY,
  canonical_url    TEXT NOT NULL,
  size_bytes       INTEGER,
  cells_available  TEXT NOT NULL DEFAULT '[]',
  ami_version      TEXT,
  created_at       INTEGER NOT NULL,
  retired_at       INTEGER
);

CREATE TABLE images_index (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_cell_id TEXT NOT NULL, content_hash TEXT NOT NULL, checkpoint_id TEXT, name TEXT, manifest TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);

CREATE TABLE invitations (
  id           TEXT PRIMARY KEY,                    -- D1-local UUID
  org_id       TEXT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',      -- "owner" | "admin" | "member"
  invited_by   TEXT,                                 -- user_id of the inviter
  workos_invitation_id TEXT,                         -- WorkOS Invitation.id (null until WorkOS call succeeds)
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | accepted | revoked | expired
  token        TEXT UNIQUE,                          -- short opaque accept token (not currently used; WorkOS owns the flow)
  expires_at   INTEGER,                              -- unix s; null = no expiry
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE managed_model_keys (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL,
  or_key_hash            TEXT,          -- OpenRouter key hash (non-secret); null between insert + create
  managed_credential_id  TEXT,          -- sessions-api credential row id (the sealed key); null until bound
  operation_id           TEXT,          -- idempotency id for the edge→sessions-api bind hand-off (§5.1/§6.7.5)
  status                 TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleting')),
  committed_micro        INTEGER NOT NULL DEFAULT 0,  -- OR usage already debited to Autumn (micro-USD watermark)
  pending_from_micro     INTEGER,       -- the single in-flight debit interval [from,to), immutable until committed
  pending_to_micro       INTEGER,
  pending_idem           TEXT,          -- "model_spend:<org>:<from>:<to>" — stable across retries
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  created_at             INTEGER NOT NULL,            -- unix seconds
  superseded_at          INTEGER
);

CREATE TABLE org_memberships (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,       -- "owner" | "admin" | "member"
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE org_subscription_items (
  org_id          TEXT NOT NULL,
  tier            TEXT NOT NULL,                  -- e.g. "memory" | "cpu"
  stripe_item_id  TEXT NOT NULL,
  price_id        TEXT NOT NULL,
  PRIMARY KEY (org_id, tier)
);

CREATE TABLE orgs (
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
, is_halted INTEGER NOT NULL DEFAULT 0, halted_at INTEGER, custom_domain TEXT, cf_hostname_id TEXT, domain_verification_status TEXT NOT NULL DEFAULT 'none', domain_ssl_status TEXT NOT NULL DEFAULT 'none', verification_txt_name TEXT, verification_txt_value TEXT, ssl_txt_name TEXT, ssl_txt_value TEXT, free_credits_remaining_cents INTEGER NOT NULL DEFAULT 500, credit_balance_cents INTEGER NOT NULL DEFAULT 0, max_concurrent_sandboxes INTEGER NOT NULL DEFAULT 50, max_sandbox_timeout_sec INTEGER NOT NULL DEFAULT 3600, max_disk_mb INTEGER NOT NULL DEFAULT 0, max_memory_gb INTEGER NOT NULL DEFAULT 0, billing_mode TEXT NOT NULL DEFAULT 'unified', last_usage_reported_at INTEGER NOT NULL DEFAULT 0, billing_provider TEXT NOT NULL DEFAULT 'legacy', autumn_usage_watermark INTEGER NOT NULL DEFAULT 0, has_webhooks INTEGER NOT NULL DEFAULT 0, model_billing_status TEXT NOT NULL DEFAULT 'off', model_markup_bps INTEGER NOT NULL DEFAULT 0, autumn_concurrency_override INTEGER);

CREATE TABLE sandboxes_index (
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
, cpu_count INTEGER, memory_mb INTEGER);

CREATE TABLE secret_store_entries (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  encrypted_value BLOB NOT NULL,                  -- AES-GCM, key in CF secret
  allowed_hosts   TEXT NOT NULL DEFAULT '[]',     -- JSON array
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE secret_stores (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  name             TEXT NOT NULL,
  egress_allowlist TEXT NOT NULL DEFAULT '[]',    -- JSON array
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE templates (
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
, canonical_rootfs_url TEXT, canonical_workspace_url TEXT);

CREATE TABLE usage_meter_events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, meter_event_name TEXT NOT NULL, value REAL NOT NULL,
  billing_mode TEXT NOT NULL, bucket_start INTEGER NOT NULL, bucket_end INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', stripe_identifier TEXT, created_at INTEGER NOT NULL, sent_at INTEGER);

CREATE TABLE usage_samples (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, sandbox_id TEXT NOT NULL,
  memory_mb INTEGER NOT NULL, cpu_count INTEGER NOT NULL, interval_s INTEGER NOT NULL,
  ts INTEGER NOT NULL, cell_id TEXT NOT NULL, rolled_up INTEGER NOT NULL DEFAULT 0);

CREATE TABLE usage_snapshots (
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

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  workos_user_id  TEXT UNIQUE,
  name            TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE webhook_destinations (
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

CREATE TABLE webhook_idempotency (
  org_id          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  destination_id  TEXT NOT NULL,
  created_at      INTEGER NOT NULL, request_hash TEXT,
  PRIMARY KEY (org_id, idempotency_key)
);

CREATE INDEX idx_agent_subs_org ON agent_subscriptions(org_id);

CREATE UNIQUE INDEX idx_agent_subs_unique ON agent_subscriptions(org_id, agent_id, feature);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

CREATE INDEX idx_api_keys_org  ON api_keys(org_id);

CREATE INDEX idx_checkpoints_expires  ON checkpoints_index(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX idx_checkpoints_org      ON checkpoints_index(org_id);

CREATE INDEX idx_checkpoints_owner    ON checkpoints_index(owner_cell_id);

CREATE INDEX idx_checkpoints_sandbox  ON checkpoints_index(sandbox_id);

CREATE INDEX idx_events_cell_ts    ON events(cell_id, ts DESC);

CREATE INDEX idx_events_org_ts     ON events(org_id, ts DESC);

CREATE INDEX idx_events_sandbox_ts ON events(sandbox_id, ts DESC);

CREATE INDEX idx_events_type_ts    ON events(type, ts DESC);

CREATE INDEX idx_golden_versions_active
  ON golden_versions(created_at) WHERE retired_at IS NULL;

CREATE INDEX idx_images_org_created ON images_index(org_id, created_at DESC);

CREATE INDEX idx_invitations_email ON invitations(email);

CREATE INDEX idx_invitations_org_status ON invitations(org_id, status);

CREATE UNIQUE INDEX idx_managed_model_keys_one_active ON managed_model_keys(org_id) WHERE status='active';

CREATE INDEX idx_managed_model_keys_org_status
  ON managed_model_keys(org_id, status);

CREATE INDEX idx_memberships_user ON org_memberships(user_id);

CREATE INDEX idx_meter_events_org_bucket ON usage_meter_events(org_id, bucket_start);

CREATE INDEX idx_meter_events_pending ON usage_meter_events(state, bucket_start) WHERE state = 'pending';

CREATE INDEX idx_orgs_billing_provider ON orgs(billing_provider) WHERE billing_provider = 'autumn';

CREATE INDEX idx_orgs_halted ON orgs(is_halted) WHERE is_halted = 1;

CREATE INDEX idx_orgs_model_billing_active
  ON orgs(model_billing_status) WHERE model_billing_status = 'active';

CREATE INDEX idx_sandboxes_active     ON sandboxes_index(org_id) WHERE status = 'running';

CREATE INDEX idx_sandboxes_cell       ON sandboxes_index(cell_id, status);

CREATE INDEX idx_sandboxes_org_status ON sandboxes_index(org_id, status);

CREATE INDEX idx_secret_entries_store ON secret_store_entries(store_id);

CREATE UNIQUE INDEX idx_secret_entries_unique ON secret_store_entries(store_id, name);

CREATE INDEX idx_secret_stores_org ON secret_stores(org_id);

CREATE UNIQUE INDEX idx_secret_stores_unique ON secret_stores(org_id, name);

CREATE INDEX idx_templates_public ON templates(is_public) WHERE is_public = 1;

CREATE UNIQUE INDEX idx_templates_unique ON templates(org_id, name, tag);

CREATE INDEX idx_usage_samples_unrolled ON usage_samples(org_id, ts) WHERE rolled_up = 0;

CREATE INDEX idx_usage_unreported ON usage_snapshots(reported_to_stripe, org_id) WHERE reported_to_stripe = 0;

CREATE INDEX webhook_dest_org_idx
  ON webhook_destinations (org_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX webhook_dest_svix_ep_idx
  ON webhook_destinations (svix_endpoint_id);
