ALTER TABLE sandbox_checkpoints
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'full';

ALTER TABLE sandbox_checkpoints
  ADD CONSTRAINT sandbox_checkpoints_kind_check
  CHECK (kind IN ('full', 'disk_only'));

ALTER TABLE sandbox_checkpoints
  ADD COLUMN IF NOT EXISTS promotion_status TEXT,
  ADD COLUMN IF NOT EXISTS promoted_checkpoint_id TEXT,
  ADD COLUMN IF NOT EXISTS promoted_rootfs_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS promoted_workspace_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS promoted_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promotion_error TEXT;

ALTER TABLE sandbox_checkpoints
  ADD CONSTRAINT sandbox_checkpoints_promotion_status_check
  CHECK (promotion_status IS NULL OR promotion_status IN ('pending', 'processing', 'ready', 'failed'));
