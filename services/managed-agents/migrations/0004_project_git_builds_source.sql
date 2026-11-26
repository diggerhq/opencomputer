ALTER TABLE project_git_builds ADD COLUMN installation_id TEXT;
ALTER TABLE project_git_builds ADD COLUMN repository_full_name TEXT;
ALTER TABLE project_git_builds ADD COLUMN source_updated_at TEXT;
