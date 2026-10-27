-- lifecycle_emails (serverless-agents-ws 088): one row per org and Loops event
-- (`trial_low`, `trial_ended`) once it has been sent, so webhook retries, the
-- billing clock and concurrent projections send each one at most once. The
-- INSERT OR IGNORE that writes the row is the claim.
CREATE TABLE IF NOT EXISTS lifecycle_emails (
  org_id TEXT NOT NULL,
  event TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, event)
);
