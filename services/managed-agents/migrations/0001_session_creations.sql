CREATE TABLE session_creations (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX session_creations_created_at
  ON session_creations(created_at);
