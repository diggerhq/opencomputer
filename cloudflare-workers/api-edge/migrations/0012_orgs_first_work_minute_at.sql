-- orgs.first_work_minute_at — when the org's first work minute was tracked to
-- Autumn, in unix seconds (serverless-agents-ws 086, billing.first_work_minute).
-- Set once by the agent runtime usage route; NULL until then.
ALTER TABLE orgs ADD COLUMN first_work_minute_at INTEGER;
