// Org's tables (spec 35.1), as `migrate` steps. Never reorder or edit a step that has shipped; add one.
// Beyond the spec's columns: `meta.org` (the organization's id, learned from the object's name or
// the first principal), `session.create_hash` (the create body's hash, for 37.2's "idempotent on
// id with the body's hash"), `session.owner_name`, `owner_email` (the API's `Session.owner`),
// `session.last_active_at` (the summary's `lastActiveAt`, else the creation time: a column so the list
// orders by it), `meta.api_access_default` (the default access of sessions not from Slack, spec 36.2;
// NULL is `owner`) and `meta.slack_access_default` (who drives a new Slack session: `open`, everyone in
// its thread, or `owner`; NULL is `open`).

import type { Sql } from "../../durable/sql.js";
import { alarms } from "../../durable/alarms.js";

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

/** The tables. One step until the first deploy: the steps before it were folded in, as nothing had stored them yet. */
const TABLES = [
  `CREATE TABLE meta (k INTEGER PRIMARY KEY CHECK (k = 1), version INTEGER NOT NULL, occ INTEGER NOT NULL,
     floor INTEGER NOT NULL DEFAULT 0, admins TEXT NOT NULL DEFAULT '[]', knowledge TEXT, org TEXT,
     api_access_default TEXT, slack_access_default TEXT)`,
  `INSERT INTO meta (k, version, occ) VALUES (1, 0, 0)`,
  `CREATE TABLE session (id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_name TEXT, owner_email TEXT, origin TEXT NOT NULL, slack_thread_key TEXT,
     machine TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
     title TEXT, title_by TEXT, former_titles TEXT NOT NULL DEFAULT '[]',
     writers TEXT NOT NULL DEFAULT '"members"', aside TEXT, metadata TEXT,
     blocked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL,
     create_hash TEXT, ${FEED}, last_active_at INTEGER)`,
  `CREATE INDEX session_owner ON session (owner)`,
  `CREATE INDEX session_slack ON session (slack_thread_key) WHERE slack_thread_key IS NOT NULL`,
  `CREATE INDEX session_active ON session (last_active_at)`,
  `CREATE INDEX session_created ON session (created_at)`,
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
  ...FEED_KINDS.map((table) => `CREATE INDEX ${table}_feed ON ${table} (version, audience)`),
];

export const STEPS: ((sql: Sql) => void)[] = [
  (sql) => {
    for (const statement of TABLES) sql.exec(statement);
    // Ageing starts (it re-arms itself); the knowledge repository setting is carried over, once, from the
    // retired Work board, and the default access settings from the Computer that held them (`accessDefault`, `apiAccessDefault`).
    alarms.set(sql, "age", 0);
    alarms.set(sql, "board", 0);
    alarms.set(sql, "accessCarry", 0);
  },
  // Attachments (work 126, section 5): the rows of what people upload for a message. Not in the feed;
  // the objects are in the attachments' store (attachments/store.ts), keyed `<org>/<session>/<id>` (org/attachments.ts).
  attachmentTable,
];

/** The attachment table (step 2); `IF NOT EXISTS` so `completeFolded` gives it to a store whose count skips the step. */
function attachmentTable(sql: Sql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS attachment (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, by TEXT NOT NULL,
       name TEXT NOT NULL, mimetype TEXT NOT NULL, bytes INTEGER NOT NULL,
       state TEXT NOT NULL, etag TEXT, turn_id TEXT, message_id TEXT,
       created_at INTEGER NOT NULL, state_at INTEGER NOT NULL)`,
  );
  sql.exec("CREATE INDEX IF NOT EXISTS attachment_session ON attachment (session_id)");
  sql.exec("CREATE INDEX IF NOT EXISTS attachment_state ON attachment (state, state_at)");
}

/**
 * A store whose steps ran before they were folded into one (a development stack deployed between the
 * two): its count (6 or 8) says nothing is left to apply, so it is given what it lacks: the
 * `meta.slack_access_default` column and the carry-over the last folded steps held, when it stopped
 * before them, and the attachment table (step 2, added after the fold). A no-op on every other store.
 */
export function completeFolded(sql: Sql): void {
  if (!sql.exec<{ name: string }>("PRAGMA table_info(meta)").some((column) => column.name === "slack_access_default")) {
    sql.exec("ALTER TABLE meta ADD COLUMN slack_access_default TEXT");
    alarms.set(sql, "accessCarry", 0);
  }
  if (!sql.exec<{ name: string }>("PRAGMA table_info(attachment)").length) attachmentTable(sql);
}
