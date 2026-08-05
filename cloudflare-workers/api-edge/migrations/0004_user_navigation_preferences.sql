-- Keep advanced navigation out of the default experience for new users.
-- Existing users retain both advanced navigation sections after this migration.

ALTER TABLE users
  ADD COLUMN durable_sessions_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users
  ADD COLUMN infrastructure_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET durable_sessions_enabled = 1,
    infrastructure_enabled = 1;
