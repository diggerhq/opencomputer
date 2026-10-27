-- Billing webhook state (serverless-agents-ws 086, funnel events).
-- orgs.payment_past_due_at: set when Autumn reports a subscription past due,
-- cleared when it recovers or the org drops to no paid plan; a paid plan that
-- ends while it is set lapsed rather than was cancelled.
-- autumn_webhook_deliveries: Svix message ids whose funnel events were sent, so
-- a redelivery does not count them twice.
ALTER TABLE orgs ADD COLUMN payment_past_due_at INTEGER;
CREATE TABLE IF NOT EXISTS autumn_webhook_deliveries (
  svix_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
