-- Durable owner/admin alerts for exposed Agent Hook credentials.
-- The security event is server-authored and deliberately carries no reported
-- token, repository/location metadata, request body, or arbitrary copy.

CREATE TABLE IF NOT EXISTS agent_security_notifications (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  hook_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind = 'secret_exposure'),
  occurred_at       INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  acknowledged_at   INTEGER,
  acknowledged_by   TEXT,
  CHECK (
    substr(id, 1, 4) = 'hse_' AND length(id) = 28 AND
    substr(id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    substr(agent_id, 1, 4) = 'agt_' AND length(agent_id) = 28 AND
    substr(agent_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    substr(hook_id, 1, 3) = 'hk_' AND length(hook_id) = 27 AND
    substr(hook_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (acknowledged_at IS NULL AND acknowledged_by IS NULL) OR
    (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_security_notifications_org_ack
  ON agent_security_notifications (
    org_id,
    acknowledged_at,
    occurred_at DESC,
    id DESC
  );
