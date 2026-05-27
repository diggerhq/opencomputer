-- Post-cutover: secret_stores moved to D1 (authoritative). The cell-PG FK
-- from sandbox_sessions.secret_store_id → secret_stores(id) now rejects every
-- INSERT for sandboxes bound to a D1-managed store, because those stores
-- don't (and won't) exist in cell PG.
--
-- The failure was masked by `_, _ = s.store.CreateSandboxSessionWithStatus(...)`
-- in createSandboxRemote — D1 got the sandbox row from the edge, cell PG got
-- nothing, and every subsequent kill/hibernate/exec call 404'd via
-- GetSandboxSession. Confirmed by reproducing the INSERT manually:
--   ERROR: insert or update on table "sandbox_sessions" violates foreign key
--   constraint "sandbox_sessions_secret_store_id_fkey"
--
-- Dropping the FK is the right call: cell PG is no longer authoritative for
-- secret_stores, the column is informational (used by ListRunningSandboxesByStore
-- for fan-out, which can tolerate stale ids), and the alternative (mirroring
-- every D1 store into every cell PG) defeats the whole edge-first cutover.
ALTER TABLE sandbox_sessions
  DROP CONSTRAINT IF EXISTS sandbox_sessions_secret_store_id_fkey;
