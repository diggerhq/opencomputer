-- Pre-warmed sandbox pool support.
--
-- Pool boxes are generic, golden-restored, RAM-resident-paused sandboxes with
-- status='pooled', owned by a synthetic "System Warm Pool" org, bound to no
-- customer. They exist to be CLAIMED atomically by a new-create request (resume
-- + rebind), bypassing the ~260ms cold golden restore. They are never billed:
-- no scale_event is opened at manufacture, and usage/quota only count
-- status='running' (see CountActiveSandboxes), so a parked pooled box accrues
-- nothing to anyone. Billing starts only at claim, for the claiming org.
--
-- The FK sandbox_sessions.org_id -> orgs(id) requires a real row for the pool
-- org, seeded here with a fixed sentinel UUID.
INSERT INTO orgs (id, name, slug, plan)
VALUES ('00000000-0000-4000-8000-000000000001', 'System Warm Pool', 'system-warm-pool', 'system')
ON CONFLICT (id) DO NOTHING;

-- Fast path for claim (pick oldest pooled box by region+template) and for the
-- refill reconciler's per-(region,template) counts. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_pooled
    ON sandbox_sessions (region, template, started_at)
    WHERE status = 'pooled';
