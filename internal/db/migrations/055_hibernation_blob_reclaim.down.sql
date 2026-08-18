DROP INDEX IF EXISTS idx_hibernations_reclaimable;
ALTER TABLE sandbox_hibernations DROP COLUMN IF EXISTS blob_deleted_at;
