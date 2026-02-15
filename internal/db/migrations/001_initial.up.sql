-- Organizations
CREATE TABLE orgs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    plan        TEXT NOT NULL DEFAULT 'free',
    max_concurrent_sandboxes INT NOT NULL DEFAULT 5,
    max_sandbox_timeout_sec  INT NOT NULL DEFAULT 3600,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id),
    email       TEXT NOT NULL UNIQUE,
    name        TEXT,
    role        TEXT NOT NULL DEFAULT 'member',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API Keys
CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id),
    created_by  UUID REFERENCES users(id),
    key_hash    TEXT NOT NULL UNIQUE,
    key_prefix  TEXT NOT NULL,
    name        TEXT NOT NULL,
    scopes      TEXT[] NOT NULL DEFAULT '{sandbox:*}',
    last_used   TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- Sandbox Sessions
CREATE TABLE sandbox_sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sandbox_id   TEXT NOT NULL,
    org_id       UUID NOT NULL REFERENCES orgs(id),
    user_id      UUID REFERENCES users(id),
    template     TEXT NOT NULL,
    region       TEXT NOT NULL,
    worker_id    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running',
    config       JSONB NOT NULL DEFAULT '{}',
    metadata     JSONB,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at   TIMESTAMPTZ,
    error_msg    TEXT
);
CREATE INDEX idx_sessions_org ON sandbox_sessions(org_id, status);
CREATE INDEX idx_sessions_sandbox ON sandbox_sessions(sandbox_id);

-- Command Logs (populated from NATS sync)
CREATE TABLE command_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sandbox_id   TEXT NOT NULL,
    command      TEXT NOT NULL,
    args         TEXT[],
    cwd          TEXT,
    exit_code    INT,
    duration_ms  INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cmd_logs_sandbox ON command_logs(sandbox_id, created_at);

-- PTY Session Logs (populated from NATS sync)
CREATE TABLE pty_session_logs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sandbox_id     TEXT NOT NULL,
    pty_session_id TEXT NOT NULL,
    started_at     TIMESTAMPTZ NOT NULL,
    ended_at       TIMESTAMPTZ,
    bytes_in       BIGINT DEFAULT 0,
    bytes_out      BIGINT DEFAULT 0
);

-- Worker Registry
CREATE TABLE workers (
    id              TEXT PRIMARY KEY,
    region          TEXT NOT NULL,
    grpc_addr       TEXT NOT NULL,
    http_addr       TEXT NOT NULL,
    capacity        INT NOT NULL,
    current_count   INT NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'healthy',
    last_heartbeat  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workers_region ON workers(region, status);

-- Templates
CREATE TABLE templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID REFERENCES orgs(id),
    name        TEXT NOT NULL,
    tag         TEXT NOT NULL DEFAULT 'latest',
    image_ref   TEXT NOT NULL,
    dockerfile  TEXT,
    is_public   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, name, tag)
);
