-- The Code.Storage repository holding an organization's automations
-- (work 067), one folder per automation. The computer
-- pushes to it after it deploys; people push to it with `opencomputer push`.
-- It is a copy of the code, not a deployment source.
CREATE TABLE automation_repositories (
  account_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
