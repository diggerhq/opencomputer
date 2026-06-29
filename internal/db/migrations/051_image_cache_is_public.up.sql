-- Make specific named snapshots shareable across orgs.
--
-- Background (prod SEV): runtime brain/hands images (runtime-claude-*,
-- runtime-codex-*, hands-base-*) are stored as named snapshots in image_cache,
-- all owned by the platform org. Before act-as-org ownership shipped
-- (2026-06-28) every session provisioned under the platform org, so the
-- org-scoped snapshot lookup (GetImageCacheByName: WHERE org_id=$1 AND name=$2)
-- found them. With act-as-org, sessions provision under the CUSTOMER org, and
-- that lookup returns "snapshot not found" -> provision_failed for every org
-- except the one that owns the snapshots.
--
-- is_public lets the resolve/fork path fall back to a shared snapshot when the
-- requesting org doesn't own one, mirroring templates.is_public and
-- sandbox_checkpoints.is_public. Management endpoints (get/list/delete/patch)
-- stay strictly org-scoped; only the owner may mutate, delete, or publish.
ALTER TABLE image_cache
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- Backfill: publish the platform runtime/hands snapshots so customer-org
-- provisions can fork them. Scoped by name pattern; idempotent and a no-op on
-- cells that don't host these snapshots (only azure-us-east-2-a does today).
-- Future runtime versions are published explicitly via the publish endpoint
-- (POST /api/snapshots/:name/publish) by the build tooling.
UPDATE image_cache
  SET is_public = true
  WHERE name LIKE 'runtime-%' OR name LIKE 'hands-%';
