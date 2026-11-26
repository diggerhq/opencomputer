CREATE TABLE project_git_sources (
  project_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  github_installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  repository_full_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  previews_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX project_git_sources_repository
  ON project_git_sources(github_installation_id, repository_id);

CREATE TABLE project_git_builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  alias TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  pull_request_number INTEGER,
  pull_request_title TEXT,
  pull_request_url TEXT,
  state TEXT NOT NULL,
  trigger_run_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX project_git_builds_project
  ON project_git_builds(project_id, created_at DESC);

CREATE INDEX project_git_builds_alias
  ON project_git_builds(project_id, alias, created_at DESC);
