// Session roles (work 112): what the computer's Durable Object stores about
// who may drive a Slack session. `sessions.drivers`, the context held from
// people who cannot instruct a session (`session_context`), requests to drive
// (`access_requests`), and the organization's default for new sessions
// (`accessDefault` in `settings`). SQL only; access-flow.ts decides.

import {
  ACCESS_DEFAULT_SETTING,
  type AccessDefault,
  CONTEXT_MAX_AGE_MS,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_ROWS,
  type Drivers,
  decodeDrivers,
  encodeDrivers,
  readAccessDefault,
} from "./access.js";

/** One message held as context, oldest first; `skipped` on the first when older rows were left out. */
export interface HeldMessage {
  seq: number;
  userId: string;
  ts: string;
  text: string;
  files: string[];
  skipped?: number;
}

/** A request to drive. `held`: the message that asked, as the gateway received it (JSON). */
export type AccessRequest = {
  key: string;
  userId: string;
  state: "open" | "closed";
  messageTs: string;
  held: string;
  at: number;
};

export class AccessStore {
  constructor(private readonly sql: SqlStorage) {
    // The `sessions` table is the Durable Object's; sessions from before work 112 read '*'.
    try {
      sql.exec("ALTER TABLE sessions ADD COLUMN drivers TEXT NOT NULL DEFAULT '*'");
    } catch {
      // Already there.
    }
    sql.exec(`
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
    `);
  }

  // ---------------------------------------------------------------- drivers

  /** A session's `drivers`; undefined when there is no such session. */
  drivers(key: string): Drivers | undefined {
    const row = [...this.sql.exec<{ drivers: string | null }>("SELECT drivers FROM sessions WHERE runner_key = ?", key)][0];
    return row ? decodeDrivers(row.drivers) : undefined;
  }

  /** Only `AccessFlow.setDrivers` and session creation write this. */
  writeDrivers(key: string, drivers: Drivers): void {
    this.sql.exec("UPDATE sessions SET drivers = ? WHERE runner_key = ?", encodeDrivers(drivers), key);
  }

  accessDefault(): AccessDefault {
    return readAccessDefault([...this.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", ACCESS_DEFAULT_SETTING)][0]?.value);
  }

  setAccessDefault(value: AccessDefault): void {
    this.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ACCESS_DEFAULT_SETTING,
      value,
    );
  }

  // ---------------------------------------------------------------- context

  /** True when this call held it: a message already held (a retried job) is not held, or acted on, again. */
  hold(key: string, m: { userId: string; ts: string; text: string; files: string[] }, now = Date.now()): boolean {
    return this.sql.exec(
      "INSERT OR IGNORE INTO session_context (key, user_id, ts, text, files, at) VALUES (?, ?, ?, ?, ?, ?)",
      key,
      m.userId,
      m.ts,
      m.text.slice(0, CONTEXT_MAX_CHARS),
      m.files.length ? JSON.stringify(m.files) : null,
      now,
    ).rowsWritten > 0;
  }

  /** The newest CONTEXT_MAX_ROWS, oldest first, after this session's rows older than CONTEXT_MAX_AGE_MS are deleted. */
  held(key: string, now = Date.now()): HeldMessage[] {
    this.sql.exec("DELETE FROM session_context WHERE key = ? AND at < ?", key, now - CONTEXT_MAX_AGE_MS);
    const total = [...this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM session_context WHERE key = ?", key)][0]?.n ?? 0;
    const rows = [...this.sql.exec<{ seq: number; userId: string; ts: string; text: string; files: string | null }>(
      "SELECT seq, user_id AS userId, ts, text, files FROM session_context WHERE key = ? ORDER BY seq DESC LIMIT ?",
      key,
      CONTEXT_MAX_ROWS,
    )].reverse();
    const messages = rows.map((r): HeldMessage => ({ seq: r.seq, userId: r.userId, ts: r.ts, text: r.text, files: decodeFiles(r.files) }));
    const skipped = total - messages.length;
    if (skipped > 0 && messages[0]) messages[0] = { ...messages[0], skipped };
    return messages;
  }

  /** Rows delivered with a message. */
  forget(seqs: readonly number[]): void {
    for (const seq of seqs) this.sql.exec("DELETE FROM session_context WHERE seq = ?", seq);
  }

  /** A held message that is delivered as itself (an allowed request). */
  forgetMessage(key: string, ts: string): void {
    this.sql.exec("DELETE FROM session_context WHERE key = ? AND ts = ?", key, ts);
  }

  // ---------------------------------------------------------------- requests

  request(key: string, userId: string): AccessRequest | undefined {
    return [...this.sql.exec<AccessRequest>(
      "SELECT key, user_id AS userId, state, message_ts AS messageTs, held, at FROM access_requests WHERE key = ? AND user_id = ?",
      key,
      userId,
    )][0];
  }

  openRequests(key: string): AccessRequest[] {
    return [...this.sql.exec<AccessRequest>(
      "SELECT key, user_id AS userId, state, message_ts AS messageTs, held, at FROM access_requests WHERE key = ? AND state = 'open' ORDER BY at, rowid",
      key,
    )];
  }

  /**
   * True when this call added it: the row is the guard against a second
   * request, so it is written before the request is posted (`messageTs` '').
   */
  addRequest(key: string, userId: string, held: string, now = Date.now()): boolean {
    return this.sql.exec("INSERT OR IGNORE INTO access_requests (key, user_id, state, message_ts, held, at) VALUES (?, ?, 'open', '', ?, ?)", key, userId, held, now).rowsWritten > 0;
  }

  /** The request's post, once Slack has it. */
  postedRequest(key: string, userId: string, messageTs: string): void {
    this.sql.exec("UPDATE access_requests SET message_ts = ? WHERE key = ? AND user_id = ?", messageTs, key, userId);
  }

  /** A request whose post failed: gone, so the next mention asks again. */
  deleteRequest(key: string, userId: string): void {
    this.sql.exec("DELETE FROM access_requests WHERE key = ? AND user_id = ?", key, userId);
  }

  /** True when this call closed it: one of two overlapping clicks acts. */
  closeRequest(key: string, userId: string): boolean {
    return this.sql.exec("UPDATE access_requests SET state = 'closed' WHERE key = ? AND user_id = ? AND state = 'open'", key, userId).rowsWritten > 0;
  }
}

function decodeFiles(text: string | null): string[] {
  try {
    const v: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}
