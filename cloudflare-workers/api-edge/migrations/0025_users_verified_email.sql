-- The email WorkOS said was verified at the person's latest login, else NULL.
-- The computer links a dashboard user to the Slack member with this email
-- (serverless-agents-ws work 083, auto-link); an unverified email never links.
ALTER TABLE users ADD COLUMN verified_email TEXT;
