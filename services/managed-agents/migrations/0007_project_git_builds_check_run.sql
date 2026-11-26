-- The GitHub check run tracking a build, when the installation grants
-- checks:write. Null for builds queued before check runs existed or where
-- the permission is missing; state transitions only mirror onto non-null ids.
ALTER TABLE project_git_builds ADD COLUMN check_run_id INTEGER;
