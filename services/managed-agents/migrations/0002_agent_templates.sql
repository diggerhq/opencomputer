CREATE TABLE template_registrations (
  id TEXT PRIMARY KEY,
  repository_url TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  state TEXT NOT NULL,
  trigger_run_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX template_registrations_repository
  ON template_registrations(repository_full_name);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  mirror_repo_id TEXT NOT NULL,
  template_json TEXT NOT NULL,
  agents_json TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (registration_id) REFERENCES template_registrations(id)
);

CREATE UNIQUE INDEX template_versions_repository_commit
  ON template_versions(repository_full_name, commit_sha);

CREATE TABLE template_installations (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_agent_id TEXT NOT NULL,
  project_repo_id TEXT,
  state TEXT NOT NULL,
  trigger_run_id TEXT,
  error_stage TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (version_id) REFERENCES template_versions(id)
);

CREATE UNIQUE INDEX template_installations_idempotency
  ON template_installations(account_id, idempotency_key);
