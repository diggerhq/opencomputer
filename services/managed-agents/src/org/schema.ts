// Org's tables (spec 35.1), as `migrate` steps. Never reorder or edit a step that has shipped; add one.
// Beyond the spec's columns: `meta.org` (the organization's id, learned from the object's name or
// the first principal), `session.create_hash` (the create body's hash, for 37.2's "idempotent on
// id with the body's hash") and `session.owner_name`, `owner_email` (the API's `Session.owner`).

import type { Sql } from "../actor/sql.js";

/** The tables whose rows are in the feed, each with its key columns. `id` in a feed row is the last of them. */
export const FEED_TABLES = {
  session: ["id"],
  place: ["session_id"],
  track: ["id"],
  result: ["id"],
  proposal: ["id"],
  doc: ["track_id"],
  read: ["member", "session_id"],
  pref: ["member", "key"],
  machine: ["id"],
  op: ["id"],
} as const satisfies Record<string, readonly string[]>;
export type FeedTable = keyof typeof FEED_TABLES;
export const FEED_KINDS = Object.keys(FEED_TABLES) as FeedTable[];

const FEED = "version INTEGER NOT NULL, audience TEXT NOT NULL";

const V0 = [
  `CREATE TABLE meta (k INTEGER PRIMARY KEY CHECK (k = 1), version INTEGER NOT NULL, occ INTEGER NOT NULL,
     floor INTEGER NOT NULL DEFAULT 0, admins TEXT NOT NULL DEFAULT '[]', knowledge TEXT,
     adopted INTEGER NOT NULL DEFAULT 0, adopt_after TEXT, adopted_at INTEGER, org TEXT)`,
  `INSERT INTO meta (k, version, occ) VALUES (1, 0, 0)`,
  `CREATE TABLE session (id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_name TEXT, owner_email TEXT, origin TEXT NOT NULL, slack_thread_key TEXT,
     machine TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
     title TEXT, title_by TEXT, former_titles TEXT NOT NULL DEFAULT '[]',
     writers TEXT NOT NULL DEFAULT '"members"', aside TEXT, metadata TEXT,
     blocked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL,
     create_hash TEXT, ${FEED})`,
  `CREATE INDEX session_owner ON session (owner)`,
  `CREATE INDEX session_slack ON session (slack_thread_key) WHERE slack_thread_key IS NOT NULL`,
  `CREATE TABLE place (session_id TEXT PRIMARY KEY, track_id TEXT, position INTEGER NOT NULL, placed_by TEXT NOT NULL,
     parent_session TEXT, done_at INTEGER, outcome TEXT, done_by TEXT, keep INTEGER NOT NULL DEFAULT 0,
     brought_back_at INTEGER, earlier_at INTEGER, ready_seq INTEGER, ready_what TEXT, ready_result TEXT, attention TEXT,
     ${FEED})`,
  `CREATE INDEX place_track ON place (track_id)`,
  `CREATE INDEX place_parent ON place (parent_session) WHERE parent_session IS NOT NULL`,
  `CREATE TABLE track (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT, name_by TEXT, former_names TEXT NOT NULL DEFAULT '[]',
     stand TEXT, stand_at INTEGER, agent_session TEXT NOT NULL, position INTEGER NOT NULL,
     keep INTEGER NOT NULL DEFAULT 0, done_at INTEGER, outcome TEXT, created_by TEXT NOT NULL, ${FEED})`,
  `CREATE INDEX track_agent ON track (agent_session)`,
  `CREATE TABLE result (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT,
     state TEXT, state_at INTEGER, meta TEXT, ${FEED}, UNIQUE (session_id, kind, ref))`,
  `CREATE INDEX result_ref ON result (kind, ref)`,
  `CREATE TABLE proposal (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, by TEXT NOT NULL, what TEXT,
     args TEXT, state TEXT NOT NULL, at_seq INTEGER, ${FEED})`,
  `CREATE INDEX proposal_target ON proposal (target, state)`,
  `CREATE TABLE doc (track_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, text TEXT NOT NULL, spans TEXT NOT NULL, ${FEED})`,
  `CREATE TABLE doc_rev (track_id TEXT, rev INTEGER, by TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (track_id, rev))`,
  `CREATE TABLE review (result_id TEXT PRIMARY KEY, head TEXT NOT NULL, parts TEXT NOT NULL)`,
  `CREATE TABLE read (member TEXT, session_id TEXT, read_seq INTEGER NOT NULL, ${FEED}, PRIMARY KEY (member, session_id))`,
  `CREATE TABLE pref (member TEXT, key TEXT, value TEXT NOT NULL, ${FEED}, PRIMARY KEY (member, key))`,
  `CREATE TABLE machine (id TEXT PRIMARY KEY, state TEXT NOT NULL, revision INTEGER NOT NULL, ${FEED})`,
  `CREATE TABLE op (id TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
     inverse TEXT, fields TEXT NOT NULL, session_id TEXT, track_id TEXT, at_seq INTEGER, undone_by TEXT, ${FEED})`,
  `CREATE INDEX op_session ON op (session_id)`,
  `CREATE INDEX op_track ON op (track_id)`,
  `CREATE TABLE gone (kind TEXT, id TEXT, audience TEXT, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, id, audience))`,
  `CREATE INDEX gone_version ON gone (version, audience)`,
  `CREATE TABLE occurrence (n INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, session_id TEXT, track_id TEXT,
     by TEXT, at INTEGER NOT NULL, audience TEXT NOT NULL)`,
  `CREATE TABLE client (principal TEXT, client_id TEXT, last_mutation INTEGER NOT NULL DEFAULT 0,
     errors TEXT NOT NULL DEFAULT '[]', seen_at INTEGER NOT NULL, PRIMARY KEY (principal, client_id))`,
  `CREATE INDEX client_id ON client (client_id)`,
  ...FEED_KINDS.map((table) => `CREATE INDEX ${table}_feed ON ${table} (version, audience)`),
];

/** `session.last_active_at`: the summary's `lastActiveAt` (else the creation time), a column so the list orders by it. */
const V1 = [
  `ALTER TABLE session ADD COLUMN last_active_at INTEGER`,
  `UPDATE session SET last_active_at = created_at`,
  `CREATE INDEX session_active ON session (last_active_at)`,
  `CREATE INDEX session_created ON session (created_at)`,
];

/** Customer webhooks are gone: a poke owed to Delivery(webhook) is dropped, not retried forever. */
const V2 = [`DELETE FROM _owed WHERE grp = 'poke:webhook'`];

/** A mutation's `Idempotency-Key` names it, for members too: the per-client numbering is gone. */
const V3 = [`DROP TABLE client`];

/** `meta.api_access_default`: the organization's default access for sessions not from Slack (spec 36.2); NULL is `owner`. */
const V4 = [`ALTER TABLE meta ADD COLUMN api_access_default TEXT`];

const run = (statements: string[]) => (sql: Sql) => statements.forEach((statement) => sql.exec(statement));
export const STEPS: ((sql: Sql) => void)[] = [run(V0), run(V1), run(V2), run(V3), run(V4)];
