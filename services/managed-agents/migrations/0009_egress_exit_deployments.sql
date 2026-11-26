-- Deployments whose tool sandboxes leave through a fixed egress exit
-- (work 073). Exits poll their region's rows through
-- /internal/egress/policy. `exit_id` is what the exit knows a deployment by
-- (exitIdentity in src/egress-exit.ts); `egress` is the deployment's
-- allowlist as JSON, NULL for an open network.
CREATE TABLE egress_exit_deployments (
  account_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  exit_id TEXT NOT NULL UNIQUE,
  exit_region TEXT NOT NULL,
  egress TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, deployment_id)
);
CREATE INDEX egress_exit_deployments_region ON egress_exit_deployments (exit_region);
