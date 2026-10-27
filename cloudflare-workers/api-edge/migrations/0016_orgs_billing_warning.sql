-- orgs.billing_warning (serverless-agents-ws 086, step 4): the limit an org is
-- about to hit, so each surface warns before the stop. trial_minutes |
-- trial_days | trial_tokens | allowance_80 | credits_low | payment_failed; NULL
-- when none is near or the org is halted (halt_reason says why).
-- orgs.billing_warning_at: when the current run of warnings began; it holds
-- while any warning stands and clears with it, so a surface can tell each
-- reason once per run.
ALTER TABLE orgs ADD COLUMN billing_warning TEXT;
ALTER TABLE orgs ADD COLUMN billing_warning_at INTEGER;
