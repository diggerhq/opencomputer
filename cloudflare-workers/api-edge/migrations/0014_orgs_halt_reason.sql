-- orgs.halt_reason (serverless-agents-ws 086, step 4): why is_halted is set, so
-- each surface shows the right paywall. trial_minutes | trial_days |
-- trial_tokens | credits_empty | payment | lapsed for orgs on work minutes;
-- credits_exhausted for credit-only orgs (the pre-086 rule, which keeps paid
-- orgs on the fallback model). NULL when not halted, or halted before 0014.
ALTER TABLE orgs ADD COLUMN halt_reason TEXT;
