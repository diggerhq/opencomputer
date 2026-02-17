-- Checkpoint storage for hibernated sandboxes
CREATE TABLE sandbox_checkpoints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sandbox_id      TEXT NOT NULL,
    org_id          UUID NOT NULL REFERENCES orgs(id),
    checkpoint_key  TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    region          TEXT NOT NULL,
    template        TEXT NOT NULL,
    sandbox_config  JSONB NOT NULL DEFAULT '{}',
    hibernated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at     TIMESTAMPTZ,
    expired_at      TIMESTAMPTZ
);

CREATE INDEX idx_checkpoints_sandbox ON sandbox_checkpoints(sandbox_id);
CREATE INDEX idx_checkpoints_org ON sandbox_checkpoints(org_id);
CREATE UNIQUE INDEX idx_checkpoints_active ON sandbox_checkpoints(sandbox_id) WHERE restored_at IS NULL AND expired_at IS NULL;
