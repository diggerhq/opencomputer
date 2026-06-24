-- Sandbox lifecycle webhooks (.agents/work/sandbox-lifecycle-webhooks.md).
-- Four additive tables; no outbox (the deliveries ledger is the work queue).
-- The feature is dormant until a destination exists, so this migration is safe
-- to apply ahead of the rest of the rollout.

-- Subscriptions.
CREATE TABLE IF NOT EXISTS webhook_destinations (
    id            TEXT        PRIMARY KEY,                  -- 'whk_' + random
    org_id        UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name          TEXT,                                     -- optional; get-or-create idempotency key
    url           TEXT        NOT NULL,                     -- https only; SSRF-validated at write + send
    event_types   TEXT[]      NOT NULL DEFAULT '{}',        -- empty = all; exact ('sandbox.stopped') or prefix ('sandbox.*')
    sandbox_id    TEXT,                                     -- optional: scope to one sandbox (NULL = all org sandboxes)
    -- signing secret, ALWAYS present (auto-generated 'whsec_…' if not supplied), returned ONCE on
    -- create/rotate then write-only. Encrypted via internal/crypto (nonce‖ciphertext bytea).
    secret_enc    BYTEA       NOT NULL,
    enabled       BOOLEAN     NOT NULL DEFAULT true,        -- false = paused (pending rows not claimed)
    created_after_event_seq BIGINT NOT NULL DEFAULT 0,      -- watermark = sandbox_lifecycle_events.seq at
                                                            -- creation (skew-free); 0 = no floor
    deleted_at    TIMESTAMPTZ,                              -- soft-delete tombstone; history retained
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_dest_org_idx
    ON webhook_destinations (org_id) WHERE enabled AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_dest_name_uq
    ON webhook_destinations (org_id, name) WHERE name IS NOT NULL AND deleted_at IS NULL;

-- Canonical lifecycle event store — the merge point for both origins. The single
-- recordLifecycleEvent primitive inserts here (CP in-tx; worker via the stream
-- ingress); the materializer reads it and creates delivery rows. `id` is the
-- deterministic event id (dedupe in one place); `seq` is the monotonic watermark.
CREATE TABLE IF NOT EXISTS sandbox_lifecycle_events (
    id            TEXT        PRIMARY KEY,                  -- deterministic event id
    seq           BIGSERIAL   NOT NULL,                     -- monotonic; the unified watermark
    org_id        UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    sandbox_id    TEXT        NOT NULL,
    type          TEXT        NOT NULL,                     -- public type, e.g. 'sandbox.stopped'
    data          JSONB       NOT NULL DEFAULT '{}',
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    materialized_at TIMESTAMPTZ                             -- NULL until the materializer has created deliveries
);
CREATE INDEX IF NOT EXISTS sandbox_lifecycle_events_unmat_idx
    ON sandbox_lifecycle_events (seq) WHERE materialized_at IS NULL;

-- Delivery ledger (also the work queue).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              TEXT        PRIMARY KEY,                -- 'whd_' + random
    org_id          UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    destination_id  TEXT        NOT NULL REFERENCES webhook_destinations(id) ON DELETE CASCADE,
    event_id        TEXT        NOT NULL,                   -- deterministic; dedup
    event_type      TEXT        NOT NULL,
    payload         JSONB       NOT NULL,                   -- the rendered envelope
    -- pending: scheduled | delivering: claimed, in flight | delivered: 2xx (terminal)
    -- failed: RETRYABLE, carries a future next_attempt_at | dead_letter: TERMINAL (permanent or exhausted)
    -- canceled: TERMINAL (destination soft-deleted while non-terminal)
    status          TEXT        NOT NULL DEFAULT 'pending',
    attempts        INT         NOT NULL DEFAULT 0,         -- lifetime total (audit; never reset)
    retry_count     INT         NOT NULL DEFAULT 0,         -- retry BUDGET vs MAX_ATTEMPTS; reset on manual redeliver
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),     -- the timer (meaningful for pending|failed)
    locked_by       TEXT,
    locked_until    TIMESTAMPTZ,
    response_code   INT,
    error           TEXT,
    last_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ,
    UNIQUE (destination_id, event_id),                      -- idempotent projection
    CHECK (status IN ('pending','delivering','delivered','failed','dead_letter','canceled'))
);
-- The poll query's index: rows that are due.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
    ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS webhook_deliveries_dest_idx
    ON webhook_deliveries (destination_id, created_at DESC);

-- Idempotency-Key storage for POST /api/webhooks. Same (org,key) + same request
-- → replay the stored ORIGINAL RESPONSE (incl. the one-time generated secret);
-- same key + different request → 409. response_enc is the rendered create
-- response, encrypted (it carries the plaintext secret). Prune past a ~24h TTL.
CREATE TABLE IF NOT EXISTS webhook_idempotency_keys (
    org_id         UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key            TEXT        NOT NULL,                    -- caller's Idempotency-Key header
    request_hash   TEXT        NOT NULL,                    -- fingerprint of the create body
    destination_id TEXT        NOT NULL REFERENCES webhook_destinations(id) ON DELETE CASCADE,
    response_enc   BYTEA       NOT NULL,                    -- the original create response (incl. secret), encrypted
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, key)
);
