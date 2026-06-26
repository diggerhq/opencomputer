ALTER TABLE sandbox_checkpoints
  DROP CONSTRAINT IF EXISTS sandbox_checkpoints_promotion_status_check;

ALTER TABLE sandbox_checkpoints
  DROP COLUMN IF EXISTS promotion_error,
  DROP COLUMN IF EXISTS promoted_at,
  DROP COLUMN IF EXISTS promoted_size_bytes,
  DROP COLUMN IF EXISTS promoted_workspace_s3_key,
  DROP COLUMN IF EXISTS promoted_rootfs_s3_key,
  DROP COLUMN IF EXISTS promoted_checkpoint_id,
  DROP COLUMN IF EXISTS promotion_status;

ALTER TABLE sandbox_checkpoints
  DROP CONSTRAINT IF EXISTS sandbox_checkpoints_kind_check;

ALTER TABLE sandbox_checkpoints
  DROP COLUMN IF EXISTS kind;
