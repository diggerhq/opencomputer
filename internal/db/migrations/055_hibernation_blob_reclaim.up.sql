-- Reclaim for hibernation archives.
--
-- Until now the only thing that ever freed a hibernation blob was SUPERSEDE:
-- CreateHibernation expires the previous row for the same sandbox and hands its
-- key back to be deleted. Every other way a hibernation ends its useful life
-- freed nothing.
--
-- Two of those matter, and both are permanent leaks:
--
--   * A WAKE. MarkHibernationRestored stamps restored_at and stops there. The
--     archive is then unreachable — GetActiveHibernation only matches rows with
--     restored_at IS NULL — so it is not a recovery copy, it is garbage that no
--     code path can read.
--
--   * A DESTROY. Nothing looks at hibernations when a sandbox dies, so an
--     archive outlives the sandbox it belongs to indefinitely.
--
-- On prod (2026-08-17) that was ~11 TB of unreachable archives against ~16 TB
-- genuinely live, on a bucket growing ~600 GB/day.
--
-- blob_deleted_at is the reclaim watermark. It records that the object is gone
-- from blob storage, which is what makes the sweep idempotent and resumable: a
-- sweep that dies halfway re-runs without re-deleting, and a delete that fails
-- is simply retried on the next tick. It is deliberately separate from
-- expired_at — expired_at is a statement about the RECORD (this archive no
-- longer represents the sandbox), blob_deleted_at is a statement about the
-- OBJECT (the bytes are gone). Conflating them would make a failed delete
-- indistinguishable from a completed one.
ALTER TABLE sandbox_hibernations ADD COLUMN IF NOT EXISTS blob_deleted_at timestamptz;

-- The sweep scans for un-reclaimed rows and nothing else, so the index carries
-- only those. It empties itself as the backlog drains: once a row is reclaimed
-- it leaves the index for good, which keeps this small forever rather than
-- growing with the table.
CREATE INDEX IF NOT EXISTS idx_hibernations_reclaimable
    ON sandbox_hibernations (hibernated_at)
    WHERE blob_deleted_at IS NULL;
