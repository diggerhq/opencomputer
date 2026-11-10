-- Analytics counts created sessions unless the runtime proves that no useful
-- work occurred because the managed model balance was exhausted.
ALTER TABLE session_creations ADD COLUMN countable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_creations ADD COLUMN exclusion_reason TEXT;
ALTER TABLE session_creations ADD COLUMN outcome_at TEXT;

CREATE INDEX session_creations_countable_created_at
  ON session_creations(countable, created_at);
