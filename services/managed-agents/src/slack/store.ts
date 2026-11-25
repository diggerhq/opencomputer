// The Slack actor's storage (tracks and threads, spec 35.4): Computer's Slack tables unchanged,
// its settings, and the added `link`, `thread` and `meta`. Slack's event ids go to the shared
// module's `idem`, so `slack_events` is not here.

import type { Sql } from "../actor/index.js";
import { CROCKFORD } from "../computer/session-ids.js";

export const STEPS: ((sql: Sql) => void)[] = [
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
  // The import's cursor: the next page of Computer's export.
  (sql) => sql.exec("ALTER TABLE meta ADD COLUMN import_after TEXT"),
];

export const settings = {
  get(sql: Sql, key: string): string | undefined {
    return sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)[0]?.value;
  },
  put(sql: Sql, key: string, value: string): void {
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  },
  drop(sql: Sql, key: string): void {
    sql.exec("DELETE FROM settings WHERE key = ?", key);
  },
};

export const threads = {
  sessionOf(sql: Sql, key: string): string | undefined {
    return sql.exec<{ session_id: string }>("SELECT session_id FROM thread WHERE key = ?", key)[0]?.session_id;
  },
  keyOf(sql: Sql, sessionId: string): string | undefined {
    return sql.exec<{ key: string }>("SELECT key FROM thread WHERE session_id = ?", sessionId)[0]?.key;
  },
  put(sql: Sql, key: string, sessionId: string): void {
    sql.exec("INSERT INTO thread (key, session_id) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", key, sessionId);
  },
};

export const links = {
  memberOf(sql: Sql, slackUser: string): string | undefined {
    return sql.exec<{ member: string }>("SELECT member FROM link WHERE slack_user = ?", slackUser)[0]?.member;
  },
  put(sql: Sql, slackUser: string, member: string): void {
    sql.exec("INSERT INTO link (slack_user, member) VALUES (?, ?) ON CONFLICT(slack_user) DO UPDATE SET member = excluded.member", slackUser, member);
  },
};

async function crockford(text: string, n: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let out = "";
  for (let i = 0; i < n; i++) out += CROCKFORD[digest[i]! & 31];
  return out;
}

/** A Slack thread's session id, made from its key so a retry makes the same one: `cs_` + 16. */
export const sessionIdFor = async (key: string): Promise<string> => `cs_${await crockford(`slack-thread\0${key}`, 16)}`;

/** A Slack message's turn id: `tn_` + 12 of the hash of its thread key and ts. */
export const turnIdFor = async (key: string, ts: string): Promise<string> => `tn_${await crockford(`${key}\0${ts}`, 12)}`;

/** An interaction's entry id (an answer or a dismiss), from Slack's own id for it. */
export const entryIdFor = async (prefix: string, id: string): Promise<string> => `${prefix}_${await crockford(id, 12)}`;
