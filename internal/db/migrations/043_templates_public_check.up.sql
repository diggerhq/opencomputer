-- 043_templates_public_check
--
-- The `templates` table has had a nullable `org_id` and an `is_public`
-- boolean since 001_initial without an explicit invariant tying them
-- together. The intent — `is_public` templates have no org, private
-- templates do — was only encoded in convention. Without a CHECK
-- constraint, any future INSERT or UPDATE that gets the pair wrong
-- silently slips through, and queries that forget to filter by org
-- can leak or hide rows.
--
-- This migration:
--   1. Surfaces any existing rows that violate the invariant (so an
--      operator can see and reconcile them before the constraint is
--      enforced). We do NOT auto-rewrite — silent data mutation on a
--      multi-tenant table is worse than a noisy migration failure.
--   2. Adds the CHECK constraint.
--
-- Refs #299.

DO $$
DECLARE
    bad_count INTEGER;
BEGIN
    SELECT count(*) INTO bad_count
    FROM templates
    WHERE (is_public = true  AND org_id IS NOT NULL)
       OR (is_public = false AND org_id IS NULL);

    IF bad_count > 0 THEN
        RAISE EXCEPTION
            'templates: % row(s) violate the public/org_id invariant. Resolve before applying this migration. '
            'Public templates must have org_id IS NULL; private templates must have org_id IS NOT NULL.',
            bad_count;
    END IF;
END$$;

ALTER TABLE templates
    ADD CONSTRAINT templates_public_org_id_check
    CHECK (
        (is_public = true  AND org_id IS NULL) OR
        (is_public = false AND org_id IS NOT NULL)
    );

COMMENT ON CONSTRAINT templates_public_org_id_check ON templates IS
    'Tenancy invariant: public templates have no org owner; private templates must.';
