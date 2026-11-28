-- Time-limited plan promotions (Black Friday 2026, promo id `bfcm2026`): one
-- row per org per promo. A claim is reserved (pending) when the org opens the
-- promo checkout and becomes active once Autumn reports the paid plan; only
-- then is an early slot taken, so abandoned checkouts never use one up. The
-- unique slot index backs the claim cap: two orgs can never hold the same
-- early slot, whatever the interleaving. Purely additive.
CREATE TABLE IF NOT EXISTS promo_claims (
  promo_id       TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  plan           TEXT NOT NULL,                   -- 'pro' | 'max'
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | active | reverted | ended | revert_failed
  early_slot     INTEGER,                         -- 1..cap for the first orgs to activate, else NULL
  months         INTEGER,                         -- promo length, set on activation
  claimed_at     INTEGER NOT NULL,                -- unix seconds, checkout opened
  activated_at   INTEGER,                         -- unix seconds, paid plan seen
  ends_at        INTEGER,                         -- unix seconds, activated_at + months
  checked_at     INTEGER,                         -- unix seconds, last revert sweep look
  revert_attempts INTEGER NOT NULL DEFAULT 0,
  reverted_at    INTEGER,                         -- unix seconds, normal plan scheduled
  PRIMARY KEY (promo_id, org_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_claims_early_slot
  ON promo_claims (promo_id, early_slot) WHERE early_slot IS NOT NULL;

CREATE INDEX IF NOT EXISTS promo_claims_due
  ON promo_claims (promo_id, status, ends_at);
