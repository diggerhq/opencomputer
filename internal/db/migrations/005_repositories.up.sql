-- Repositories table for the standalone git server.
-- Each repository belongs to an org and holds a bare git repo on disk + async S3 backup.
CREATE TABLE repositories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    default_branch  TEXT NOT NULL DEFAULT 'main',
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    last_push_at    TIMESTAMPTZ,
    last_backup_at  TIMESTAMPTZ,
    backup_key      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- Unique constraint: one active repo per org per slug
CREATE UNIQUE INDEX idx_repos_org_slug ON repositories(org_id, slug) WHERE deleted_at IS NULL;

-- Index for listing repos by org
CREATE INDEX idx_repos_org ON repositories(org_id) WHERE deleted_at IS NULL;
