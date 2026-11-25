-- The Mac app's sign-in (tracks and threads, spec 18.7 and 20): an
-- authorization code with PKCE, then a refresh token per device. Codes and
-- tokens are stored as SHA-256 hex, never as themselves.
CREATE TABLE IF NOT EXISTS app_auth_codes (
  code_hash      TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_devices (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS app_devices_member ON app_devices (org_id, user_id);
