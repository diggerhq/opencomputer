-- Per-org selector for which billing system is authoritative.
--
--   'legacy' — the in-house pipeline: CreditAccount DO (edge) / UsageReporter
--              (cell) own the credit balance, metering, and halt/resume.
--   'autumn' — Autumn (useautumn.com) owns the credit ledger, usage metering,
--              top-ups, auto-recharge, and the concurrency plans. The cell only
--              measures usage → track(), and projects is_halted / max_concurrent.
--
-- Defaults to 'legacy' so every existing and new org is unaffected until it is
-- explicitly flipped. The move to Autumn is per-org and reversible (flip back to
-- 'legacy'); the final cutover flips the default and migrates the stragglers.
ALTER TABLE orgs ADD COLUMN billing_provider TEXT NOT NULL DEFAULT 'legacy'
    CHECK (billing_provider IN ('legacy', 'autumn'));
