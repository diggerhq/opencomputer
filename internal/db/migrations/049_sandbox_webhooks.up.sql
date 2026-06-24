-- Sandbox lifecycle webhooks (all-Svix-at-edge). The CP's only webhook state is a
-- transient outbox: CP-origin transitions INSERT here in-tx; the relay publishes
-- each row to the cell stream (→ edge → Svix) and deletes it. Destination
-- management + delivery state live at the edge (Svix + the D1 index), not here.
-- See .agents/work/sandbox-webhooks-rearchitecture.md.
CREATE TABLE IF NOT EXISTS sandbox_lifecycle_events (
    id         TEXT        PRIMARY KEY,                 -- stable/deterministic event id (dedupe key)
    seq        BIGSERIAL   NOT NULL,                    -- FIFO ordering for the relay drain
    org_id     UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    sandbox_id TEXT        NOT NULL,
    type       TEXT        NOT NULL,                    -- public type, e.g. 'sandbox.stopped'
    data       JSONB       NOT NULL DEFAULT '{}',
    ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sandbox_lifecycle_events_seq_idx ON sandbox_lifecycle_events (seq);
