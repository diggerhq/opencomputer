-- Multi-org CLI login (work 075).
--
-- users.last_org_id: the org the user last chose in the dashboard switcher.
-- `opencomputer login` binds to it by default when the user is still a member.
--
-- api_keys.cli_login: 1 for keys minted by `opencomputer login` (or by
-- `opencomputer org switch`). Only these may be exchanged for a key in another
-- of the creator's orgs; dashboard and CI keys stay bound to their org.
ALTER TABLE users ADD COLUMN last_org_id TEXT;
ALTER TABLE api_keys ADD COLUMN cli_login INTEGER NOT NULL DEFAULT 0;
