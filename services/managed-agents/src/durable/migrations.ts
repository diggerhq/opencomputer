// Ordered schema steps, each run once per object (spec 36.7, D21), over `Sql`. The kit's own tables
// (alarms, owed calls, idempotency) come first, so step 0 of an actor may already use them.

import type { Sql } from "./sql.js";

const TABLES = `
CREATE TABLE IF NOT EXISTS _migrations (k INTEGER PRIMARY KEY CHECK (k = 1), applied INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _alarm (purpose TEXT PRIMARY KEY, at INTEGER, firing INTEGER);
CREATE TABLE IF NOT EXISTS _owed (n INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, key TEXT UNIQUE, call TEXT NOT NULL,
  body TEXT, at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, schedule TEXT, last_error TEXT);
CREATE INDEX IF NOT EXISTS _owed_grp ON _owed (grp, n);
CREATE TABLE IF NOT EXISTS _dead (n INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, call TEXT NOT NULL, body TEXT,
  tries INTEGER NOT NULL, last_error TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _idem (key TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS _idem_expires ON _idem (expires);
`;

/**
 * Apply the steps not yet applied, in order, each in its own transaction with the count. The
 * module's own tables come first, so step 0 of an actor may already use them. Never reorder or
 * edit a step that has shipped; add one.
 */
export function migrate(sql: Sql, steps: ((sql: Sql) => void)[]): void {
  for (const statement of TABLES.split(";")) if (statement.trim()) sql.exec(statement);
  const applied = sql.exec<{ applied: number }>("SELECT applied FROM _migrations WHERE k = 1")[0]?.applied ?? 0;
  for (let index = applied; index < steps.length; index += 1) {
    sql.transaction(() => {
      steps[index]!(sql);
      sql.exec("INSERT INTO _migrations (k, applied) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET applied = excluded.applied", index + 1);
    });
  }
}
