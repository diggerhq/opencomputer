-- Cached GitHub installation repository listings. Listing mints an
-- installation token and pages GitHub on every call, which is the Settings
-- page's slowest load. Rows are refreshed after a short TTL and purged by
-- installation_repositories/repository/installation webhook events.
CREATE TABLE project_git_repo_cache (
  github_installation_id INTEGER NOT NULL,
  page INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (github_installation_id, page)
);
