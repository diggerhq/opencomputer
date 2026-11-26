// The Slack actor's storage (tracks and threads, spec 35.4): Computer's Slack tables unchanged,
// its settings, and the added `link`, `thread`, `meta` and `acks` (the message whose status or 👀 a
// thread shows, so `notify` can take it off). Slack's event ids go to the shared module's `idem`, so
// `slack_events` is not here, and its queue is owed `process` calls, so `slack_queue` is not either.
// One step until the first deploy: the steps before it were folded in, as nothing had stored them yet.

import { type Sql } from "../../durable/sql.js";

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
      CREATE TABLE IF NOT EXISTS acks (thread_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, ts TEXT NOT NULL);
    `.split(";"))
      if (statement.trim()) sql.exec(statement);
  },
];
