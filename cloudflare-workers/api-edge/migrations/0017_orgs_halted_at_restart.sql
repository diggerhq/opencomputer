-- orgs.halted_at (serverless-agents-ws 086): from this release it holds while an
-- org stays halted, and blue parks an unpaid computer 7 days after it. Before,
-- each projection re-stamped it, so a halted org's stamp is only its last
-- projection and may be weeks old. Restart the clock for orgs halted now, so
-- their 7 days begin at this release, not at a stale stamp. CI applies this
-- before the Worker deploy; the old Worker re-stamps forward until then, which
-- only moves the clock later.
UPDATE orgs SET halted_at = unixepoch() WHERE is_halted = 1;
