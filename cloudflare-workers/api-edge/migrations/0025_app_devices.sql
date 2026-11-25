-- The Mac app's sign-ins (tracks and threads spec 34.3): one row per device,
-- holding the hash of its refresh token. Deleting the row revokes the device.
-- code_id is the authorization code the row was made from, so a code is
-- spent once.
CREATE TABLE app_devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  code_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX app_devices_member ON app_devices (org_id, user_id);
