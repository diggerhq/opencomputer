DROP INDEX IF EXISTS idx_image_cache_public_name;

ALTER TABLE image_cache
  DROP COLUMN IF EXISTS is_public;
