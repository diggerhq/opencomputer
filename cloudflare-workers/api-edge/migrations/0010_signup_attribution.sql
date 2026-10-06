-- Sign-up attribution (.agents/design/signup-attribution.md, C4).
--
-- One row per user the WorkOS callback (browser or CLI) genuinely created,
-- written by recordSignupAttribution in src/attribution.ts from the `oc_attr`
-- first/last-touch cookie. Existing users are not backfilled. Timestamps are
-- unix seconds, matching the rest of this schema.

CREATE TABLE signup_attribution (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  entry          TEXT NOT NULL,            -- browser | cli | invite
  channel        TEXT NOT NULL,            -- see Channel
  first_source   TEXT, first_medium TEXT, first_campaign TEXT, first_term TEXT, first_content TEXT,
  first_referrer TEXT, first_landing TEXT, first_touch_at INTEGER,
  last_source    TEXT, last_medium  TEXT, last_campaign  TEXT, last_term  TEXT, last_content  TEXT,
  last_referrer  TEXT, last_landing  TEXT, last_touch_at  INTEGER,
  gclid          TEXT, fbclid TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_signup_attribution_created ON signup_attribution(created_at);
