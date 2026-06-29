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
-- is_public lets the resolve/fork path fall back to a snapshot published by the
-- platform org, mirroring templates.is_public and sandbox_checkpoints.is_public.
-- The fallback is anchored to a trusted owner in code (ResolveImageCacheByName:
-- is_public AND org_id = <platform org>), so this flag alone does NOT open a
-- snapshot to the world — it only makes it eligible when the platform org owns
-- it. Management endpoints (get/list/delete/patch) stay strictly org-scoped.
--
-- No data backfill here on purpose: which org is "the platform org" is
-- environment-specific (prod vs dev), so blindly publishing every runtime-%/
-- hands-% row would expose any customer-owned look-alike. Existing platform
-- snapshots are published as a one-time, platform-org-scoped cutover step (see
-- the PR), and future versions via POST /api/snapshots/:name/publish.
ALTER TABLE image_cache
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- Index the fork fallback path: WHERE name = $3 AND is_public = true AND
-- org_id = $2. The existing unique index (org_id, name) serves the org-scoped
-- branch; this partial index serves the public branch and stays tiny (only
-- catalog rows).
CREATE INDEX IF NOT EXISTS idx_image_cache_public_name
  ON image_cache(name) WHERE is_public = true;
