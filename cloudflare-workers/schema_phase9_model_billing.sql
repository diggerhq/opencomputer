-- Phase 9: Token / model-usage billing — managed OpenRouter keys + per-org state.
--
-- Adds the edge-native state for billing an org's LLM token usage out of the same
-- Autumn `credits` pool as compute (design: .agents/work/token-billing.md). The
-- edge provisions one OpenRouter key per managed org, meters its spend, and pushes
-- the cap to mirror the shared balance; this schema holds the per-key ledger + the
-- per-org provisioning state.
--
-- EDGE-ONLY (D1), unlike billing_provider (phase 7 / migration 047, which mirrors
-- to each cell's Postgres via the cap-token). The Go cell holds no OpenRouter or
-- Autumn client and never gates on model-billing state, so there is deliberately
-- NO cell-PG mirror migration for these.
--
-- Apply with:
--   wrangler d1 execute opencomputer-dev  --remote --file cloudflare-workers/schema_phase9_model_billing.sql
--   wrangler d1 execute opencomputer-prod --remote --file cloudflare-workers/schema_phase9_model_billing.sql
--
-- SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so the ALTERs are one-shot like the
-- earlier phases. Run BEFORE deploying api-edge code that reads these columns.

-- Per-org provisioning state machine (token-billing §5.1). Drives off→provisioning
-- →active (or error). `active` ⇒ Managed is offered + resolvable for the org.
--   'off'          — not enabled (default; all existing orgs unaffected).
--   'provisioning' — OR key being minted + bound to a sessions-api credential.
--   'active'       — a managed credential is bound; Managed available.
--   'error'        — provisioning failed after bounded retries (alert; stays off).
ALTER TABLE orgs ADD COLUMN model_billing_status TEXT NOT NULL DEFAULT 'off';

-- Markup applied to OpenRouter cost before debiting Autumn, in basis points
-- (0 = at-cost; 2000 = +20%). Per-org override of an env default. BOTH the debit
-- and the cap-push math depend on it (token-billing §7). See §9.2 for why
-- at-cost (0) loses ~5% to OR's credit-purchase fee.
ALTER TABLE orgs ADD COLUMN model_markup_bps INTEGER NOT NULL DEFAULT 0;

-- Partial index: the "which orgs run Managed" sweep stays tight while almost
-- everyone is still 'off'.
CREATE INDEX IF NOT EXISTS idx_orgs_model_billing_active
  ON orgs(model_billing_status) WHERE model_billing_status = 'active';

-- One row per provisioned OpenRouter key (token-billing §4). Normally one 'active'
-- per org; ≥1 transiently during a rotation. Per-key watermark so each key's spend
-- is debited independently until it quiesces, and so the in-flight debit interval
-- is durable across cron crashes (persist-before-track, §5.4/§7).
--
-- The plaintext OR key is NEVER stored here — only the non-secret hash + the
-- sessions-api credential id that points at the sealed secret (Infisical).
CREATE TABLE IF NOT EXISTS managed_model_keys (
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

-- The hot lookups: an org's active key (resolve/cap) and its still-draining
-- superseded/deleting keys (poll until quiesced).
CREATE INDEX IF NOT EXISTS idx_managed_model_keys_org_status
  ON managed_model_keys(org_id, status);

-- AT MOST ONE active key per org. Without this, two concurrent enable calls/retries
-- (getResumableRow → insertRow with no txn) could mint two active OR keys + two
-- managed credentials. The unique partial index makes the losing insert fail; the
-- provisioning driver catches it and adopts the winner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_model_keys_one_active
  ON managed_model_keys(org_id) WHERE status = 'active';
