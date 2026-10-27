-- orgs.trial_started_at (serverless-agents-ws 086, step 8): every free org gets
-- the 7-day trial from launch day, as new signups do. Autumn attaches `trial`
-- to each base customer after this runs; the edge keeps them on the credit rule
-- until it is attached, so the stamp alone changes nothing. Paid orgs (pro,
-- max) and legacy billing are left alone.
UPDATE orgs SET trial_started_at = unixepoch()
 WHERE billing_provider = 'autumn' AND usage_plan = 'base';
