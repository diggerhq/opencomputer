-- orgs.trial_started_at — when the org's work-minute trial began, in unix
-- seconds (serverless-agents-ws 086). Autumn attaches the `trial` plan to every
-- customer created at signup, so it is set with the org row; the edge ends the
-- trial on day 7. NULL for orgs that never had one (legacy billing, or created
-- before the trial launched, which get a backdated start at launch).
ALTER TABLE orgs ADD COLUMN trial_started_at INTEGER;
