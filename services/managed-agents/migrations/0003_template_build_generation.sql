-- Template cache identity: source commit + compiler/bundle generation.
-- Existing rows were built before per-artifact model declarations (generation 1).
ALTER TABLE template_versions ADD COLUMN build_generation INTEGER NOT NULL DEFAULT 1;

DROP INDEX template_versions_repository_commit;

CREATE UNIQUE INDEX template_versions_repository_commit_generation
  ON template_versions(repository_full_name, commit_sha, build_generation);
