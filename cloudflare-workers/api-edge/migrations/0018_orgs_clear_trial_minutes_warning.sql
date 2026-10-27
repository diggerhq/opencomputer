-- orgs.billing_warning (serverless-agents-ws 086): until Autumn has a trial
-- plan, a new signup has no work-minutes balance, and billingWarning read that
-- as 0 minutes left, so new orgs were told their trial had 0 min of work left.
-- No org can have a real trial_minutes warning before the trial plan exists, so
-- clear them all; the next projection sets the right warning, if any.
UPDATE orgs SET billing_warning = NULL, billing_warning_at = NULL WHERE billing_warning = 'trial_minutes';
