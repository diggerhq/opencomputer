-- A hard deadline stamped on the row when a sandbox is placed, so that a row
-- outliving its host is not something anyone has to notice.
--
-- The problem this solves: a managed host can be destroyed by its provider with
-- no callback to us — AWS terminates every MicroVM at a hard 8h cap regardless
-- of what we do. Nothing tells the control plane. Until something sweeps, the
-- row still says `running`, so the sandbox counts against the org's concurrency
-- limit and shows as live in the dashboard. Correctness therefore depended on a
-- reaper having run recently, and a reaper that fails, falls behind, or skips a
-- row (as one did — see awsvm.ErrNotFound) leaks that row permanently.
--
-- With a deadline on the row, a reader can settle the question itself:
--
--     status = 'running' AND (end_at IS NULL OR end_at > now())
--
-- No sweep required. The reconciler stops being what makes the state correct
-- and becomes only what frees the row sooner.
--
-- NULL means "no known deadline" and is the default, so every existing row and
-- every QEMU sandbox is unaffected: a QEMU VM has no provider-imposed lifetime,
-- and inventing one here would start expiring live sandboxes. Only runtimes
-- that actually know their host's death time stamp this.
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;

-- Partial index: every gated read is "running rows for an org", and the
-- deadline check rides along on it. Restricted to running rows because
-- terminal rows are never asked this question and they are the bulk of the
-- table.
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_running_end_at
  ON sandbox_sessions (org_id, end_at)
  WHERE status = 'running';
