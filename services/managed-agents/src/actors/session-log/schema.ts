// SessionLog's storage. `SCHEMA` is the tables production stores already have (work 084), applied
// as before on every start; `MIGRATIONS` are the tables of spec 35.2 after them. Never edit a step; add one.

import type { Sql } from "../../durable/sql.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  turn_id TEXT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT,
  data TEXT,
  blob TEXT
);
CREATE INDEX IF NOT EXISTS events_turn ON events (turn_id, seq);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  usage TEXT
);
CREATE INDEX IF NOT EXISTS turns_seq ON turns (seq);
CREATE INDEX IF NOT EXISTS turns_status ON turns (status, seq);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_seq ON asks (seq);
CREATE INDEX IF NOT EXISTS asks_status ON asks (status, seq);
CREATE TABLE IF NOT EXISTS tools (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  end_seq INTEGER,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result_seq INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subagents_running ON subagents (status, seq);
CREATE INDEX IF NOT EXISTS subagents_ended ON subagents (end_seq);
CREATE INDEX IF NOT EXISTS subagents_seq ON subagents (seq);
CREATE TABLE IF NOT EXISTS meta (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  organization_id TEXT,
  session_id TEXT,
  log_epoch INTEGER NOT NULL,
  epoch_start_seq INTEGER NOT NULL,
  ack INTEGER NOT NULL,
  synced_at TEXT,
  state TEXT NOT NULL,
  summary TEXT NOT NULL
);
`;

/**
 * The inbox, the access the log holds (`agents`, spec 40.7: the session that started it and its
 * track's agent) and the occurrences waiting to go to Org, with `meta`'s added columns. One step
 * until the first deploy: the steps before it were folded in, as nothing had stored them yet.
 */
export const MIGRATIONS: ((sql: Sql) => void)[] = [
  (sql) => {
    sql.exec(`CREATE TABLE inbox (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      body TEXT NOT NULL, hash TEXT NOT NULL, "by" TEXT NOT NULL, actor TEXT NOT NULL, trace TEXT, at INTEGER NOT NULL,
      state TEXT NOT NULL, result TEXT, error TEXT, done_at INTEGER)`);
    sql.exec("CREATE INDEX inbox_state ON inbox (state, n)");
    sql.exec(`CREATE TABLE access (k INTEGER PRIMARY KEY CHECK (k = 1), owner TEXT NOT NULL, audience TEXT NOT NULL,
      writers TEXT NOT NULL, readers TEXT NOT NULL, machine TEXT NOT NULL, revision INTEGER NOT NULL, agents TEXT)`);
    sql.exec(`CREATE TABLE occ_pending (epoch INTEGER, seq INTEGER, kind TEXT NOT NULL, "by" TEXT, at INTEGER NOT NULL, PRIMARY KEY (epoch, seq))`);
    for (const column of ["revision", "watched_until", "slot_at", "agent_turns"]) sql.exec(`ALTER TABLE meta ADD COLUMN ${column} INTEGER`);
  },
];
