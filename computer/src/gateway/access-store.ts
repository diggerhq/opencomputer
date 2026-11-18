// Session roles in the gateway's SQLite (work 112): each session's `drivers`
// (a column of `sessions`), the messages held as context from people who
// cannot instruct a session, the requests to drive, and the organization's
// default for new sessions (`settings.accessDefault`).
//
// Invariants:
// - `drivers` is read through decodeDrivers: a session from before this
//   column, or with a value that is neither `'*'` nor a JSON list, reads as
//   its column says (`'*'` by default, `[]` when unreadable); only
//   access-flow.ts's setDrivers and a new session's first write change it;
// - held context is cut to CONTEXT_MAX_CHARS when stored, and read as the
//   newest CONTEXT_MAX_ROWS of the session, oldest first, after that
//   session's rows older than CONTEXT_MAX_AGE_MS are deleted;
// - one request per person per session, ever: a closed one stays, so a
//   declined person is never asked about twice.
//
// SQL only: who may do what is access.ts, what happens is access-flow.ts.

import type { DatabaseSync } from 'node:sqlite';
import {
  type AccessDefault,
  ACCESS_DEFAULT_SETTING,
  CONTEXT_MAX_AGE_MS,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_ROWS,
  decodeDrivers,
  type Drivers,
  encodeDrivers,
  readAccessDefault,
} from '../access.js';

/** One message held as context. */
export interface HeldRow {
  seq: number;
  userId: string;
  ts: string;
  text: string;
  files?: string[];
  at: number;
  /** Rows left out before this one (only on the first row read). */
  skipped?: number;
}

/** A request to drive: `held` is the JSON of the message that asked, as the gateway received it. */
export interface AccessRequest {
  key: string;
  userId: string;
  state: 'open' | 'closed';
  messageTs: string;
  held: string;
  at: number;
}

export class AccessStore {
  constructor(private readonly db: DatabaseSync) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN drivers TEXT NOT NULL DEFAULT '*'`);
    } catch {} // the column exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_context (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL, user_id TEXT NOT NULL, ts TEXT NOT NULL,
        text TEXT NOT NULL, files TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_context_key ON session_context (key, seq);
      CREATE TABLE IF NOT EXISTS access_requests (
        key TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL,
        message_ts TEXT NOT NULL, held TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (key, user_id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  // ---- drivers

  /** A session's `drivers`; `'*'` for a session with no row. */
  drivers(key: string): Drivers {
    const r = this.db.prepare('SELECT drivers FROM sessions WHERE key = ?').get(key) as { drivers: string } | undefined;
    return r ? decodeDrivers(r.drivers) : '*';
  }

  /** The column, as given: callers normalize (access-flow.ts). */
  writeDrivers(key: string, d: Drivers) {
    this.db.prepare('UPDATE sessions SET drivers = ? WHERE key = ?').run(encodeDrivers(d), key);
  }

  // ---- held context

  hold(key: string, userId: string, ts: string, text: string, files: string[] = [], at = Date.now()) {
    this.db
      .prepare('INSERT INTO session_context (key, user_id, ts, text, files, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, userId, ts, text.slice(0, CONTEXT_MAX_CHARS), files.length ? JSON.stringify(files) : null, at);
  }

  /** The session's held messages, oldest first: the newest CONTEXT_MAX_ROWS, after dropping the expired. */
  held(key: string, now = Date.now()): HeldRow[] {
    this.db.prepare('DELETE FROM session_context WHERE key = ? AND at < ?').run(key, now - CONTEXT_MAX_AGE_MS);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM session_context WHERE key = ?').get(key) as { n: number };
    const rows = this.db
      .prepare('SELECT seq, user_id, ts, text, files, at FROM session_context WHERE key = ? ORDER BY seq DESC LIMIT ?')
      .all(key, CONTEXT_MAX_ROWS) as { seq: number; user_id: string; ts: string; text: string; files: string | null; at: number }[];
    const out: HeldRow[] = rows.reverse().map((r) => ({
      seq: r.seq,
      userId: r.user_id,
      ts: r.ts,
      text: r.text,
      ...(r.files ? { files: JSON.parse(r.files) as string[] } : {}),
      at: r.at,
    }));
    if (out.length && n > out.length) out[0].skipped = n - out.length;
    return out;
  }

  /** Held messages that went to the session, by seq. */
  release(seqs: readonly number[]) {
    const del = this.db.prepare('DELETE FROM session_context WHERE seq = ?');
    for (const seq of seqs) del.run(seq);
  }

  /** The held message with this ts (a request's, delivered on Allow). */
  releaseTs(key: string, ts: string) {
    this.db.prepare('DELETE FROM session_context WHERE key = ? AND ts = ?').run(key, ts);
  }

  // ---- requests to drive

  request(key: string, userId: string): AccessRequest | undefined {
    const r = this.db.prepare('SELECT * FROM access_requests WHERE key = ? AND user_id = ?').get(key, userId) as RequestRow | undefined;
    return r ? toRequest(r) : undefined;
  }

  /** The session's open requests, oldest first. */
  openRequests(key: string): AccessRequest[] {
    return (this.db.prepare("SELECT * FROM access_requests WHERE key = ? AND state = 'open' ORDER BY at, rowid").all(key) as unknown as RequestRow[]).map(toRequest);
  }

  putRequest(key: string, userId: string, messageTs: string, held: string, at = Date.now()) {
    this.db
      .prepare("INSERT OR IGNORE INTO access_requests (key, user_id, state, message_ts, held, at) VALUES (?, ?, 'open', ?, ?, ?)")
      .run(key, userId, messageTs, held, at);
  }

  closeRequest(key: string, userId: string) {
    this.db.prepare("UPDATE access_requests SET state = 'closed' WHERE key = ? AND user_id = ?").run(key, userId);
  }

  // ---- the organization's default

  accessDefault(): AccessDefault {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(ACCESS_DEFAULT_SETTING) as { value: string } | undefined;
    return readAccessDefault(r?.value);
  }

  setAccessDefault(d: AccessDefault) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(ACCESS_DEFAULT_SETTING, d);
  }
}

interface RequestRow {
  key: string;
  user_id: string;
  state: string;
  message_ts: string;
  held: string;
  at: number;
}

const toRequest = (r: RequestRow): AccessRequest => ({
  key: r.key,
  userId: r.user_id,
  state: r.state === 'open' ? 'open' : 'closed',
  messageTs: r.message_ts,
  held: r.held,
  at: r.at,
});
