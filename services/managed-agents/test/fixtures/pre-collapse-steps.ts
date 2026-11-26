// The storage steps of Org, Slack and SessionLog as they were before they were collapsed into one
// initial step each (never deployed to production). Frozen: test/org-schema-collapse.test.ts checks
// that a fresh store ends with the same tables and indexes either way. Do not edit.

import type { Sql } from "../../src/durable/sql.js";
import { alarms } from "../../src/durable/alarms.js";
import { oweProcess } from "../../src/actors/slack/outbox.js";

// ---------------------------------------------------------------- Org (src/actors/org/schema.ts)

const FEED_KINDS = ["session", "place", "track", "result", "proposal", "doc", "read", "pref", "machine", "op"];
const FEED = "version INTEGER NOT NULL, audience TEXT NOT NULL";

const V0 = [
  `CREATE TABLE meta (k INTEGER PRIMARY KEY CHECK (k = 1), version INTEGER NOT NULL, occ INTEGER NOT NULL,
     floor INTEGER NOT NULL DEFAULT 0, admins TEXT NOT NULL DEFAULT '[]', knowledge TEXT, org TEXT)`,
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

/** `meta.slack_access_default`: who drives a new Slack session (`open`: everyone in its thread; `owner`: its owner); NULL is `open`. */
const V5 = [`ALTER TABLE meta ADD COLUMN slack_access_default TEXT`];

const run = (statements: string[]) => (sql: Sql) => statements.forEach((statement) => sql.exec(statement));
export const ORG_STEPS: ((sql: Sql) => void)[] = [
  run(V0),
  run(V1),
  run(V2),
  run(V3),
  // Ageing starts (it re-arms itself), and the knowledge repository setting is carried over, once, from the retired Work board.
  (sql) => {
    alarms.set(sql, "age", 0);
    alarms.set(sql, "board", 0);
  },
  run(V4),
  run(V5),
  // The organization's default access settings are carried over, once, from the Computer that held them (`accessDefault`, `apiAccessDefault`).
  (sql) => alarms.set(sql, "accessCarry", 0),
];

// ---------------------------------------------------------------- Slack (src/actors/slack/schema.ts)

export const SLACK_STEPS: ((sql: Sql) => void)[] = [
  (sql) => {
    for (const statement of `
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people (
        slack_user_id TEXT PRIMARY KEY,
        dir TEXT NOT NULL,
        git_name TEXT NOT NULL,
        git_email TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_messages (message_key TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        last_error TEXT,
        thread_key TEXT,
        started_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS slack_queue_state ON slack_queue (state, available_at);
      CREATE TABLE IF NOT EXISTS install_nonces (nonce_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS join_requests (slack_user_id TEXT PRIMARY KEY, installer_notified INTEGER NOT NULL, notified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (thread_key TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (thread_key, kind));
      CREATE TABLE IF NOT EXISTS billing_warnings (recipient TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (recipient, kind));
      CREATE TABLE IF NOT EXISTS session_context (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL, user_id TEXT NOT NULL, ts TEXT NOT NULL,
        text TEXT NOT NULL, files TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_context_key ON session_context (key, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS session_context_ts ON session_context (key, ts);
      CREATE TABLE IF NOT EXISTS access_requests (
        key TEXT NOT NULL, user_id TEXT NOT NULL,
        state TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        held TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (key, user_id));
      CREATE TABLE IF NOT EXISTS link (slack_user TEXT PRIMARY KEY, member TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS meta (k INTEGER PRIMARY KEY CHECK (k = 1), imported INTEGER NOT NULL DEFAULT 0);
    `.split(";"))
      if (statement.trim()) sql.exec(statement);
  },
  // The message whose status or 👀 a thread shows, so `notify` can take it off.
  (sql) => sql.exec("CREATE TABLE IF NOT EXISTS acks (thread_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, ts TEXT NOT NULL)"),
  // The queue's waiting rows become owed `process` calls, in their order; the queue goes.
  (sql) => {
    for (const row of sql.exec<{ sequence: number; payload: string; thread: string | null }>("SELECT sequence, payload, thread_key AS thread FROM slack_queue WHERE state != 'failed' ORDER BY sequence")) {
      oweProcess(sql, row.thread ?? `seq:${row.sequence}`, JSON.parse(row.payload));
    }
    sql.exec("DROP TABLE slack_queue");
  },
  // The paywall was once per person for ever (`billing_warnings` of kind insufficient_credits); it is now once per
  // thread (`notices` of kind credits) until the organization is admitted again, so those rows go.
  (sql) => sql.exec("DELETE FROM billing_warnings WHERE kind = 'insufficient_credits'"),
];

// ---------------------------------------------------------------- SessionLog (after its production SCHEMA)

export const SESSION_LOG_MIGRATIONS: ((sql: Sql) => void)[] = [
  (sql) => {
    sql.exec(`CREATE TABLE inbox (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      body TEXT NOT NULL, hash TEXT NOT NULL, "by" TEXT NOT NULL, actor TEXT NOT NULL, trace TEXT, at INTEGER NOT NULL,
      state TEXT NOT NULL, result TEXT, error TEXT, done_at INTEGER)`);
    sql.exec("CREATE INDEX inbox_state ON inbox (state, n)");
    sql.exec(`CREATE TABLE access (k INTEGER PRIMARY KEY CHECK (k = 1), owner TEXT NOT NULL, audience TEXT NOT NULL,
      writers TEXT NOT NULL, readers TEXT NOT NULL, machine TEXT NOT NULL, revision INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE occ_pending (epoch INTEGER, seq INTEGER, kind TEXT NOT NULL, "by" TEXT, at INTEGER NOT NULL, PRIMARY KEY (epoch, seq))`);
    for (const column of ["revision", "watched_until", "slot_at", "agent_turns"]) sql.exec(`ALTER TABLE meta ADD COLUMN ${column} INTEGER`);
  },
  // Access's `agents` (spec 40.7): NULL in a row stored before it, which is read from Org again.
  (sql) => sql.exec("ALTER TABLE access ADD COLUMN agents TEXT"),
];
