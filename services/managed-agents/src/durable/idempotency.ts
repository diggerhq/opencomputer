// Idempotency (spec 36.7, D21): the same key answers the same result; another request under it is a conflict.

import type { Sql } from "./sql.js";

export const idem = {
  /** What was stored under `key`: its result when the hash is the same, a conflict when it is not, null when nothing (or expired). */
  get(sql: Sql, key: string, hash: string): { result: unknown } | { conflict: true } | null {
    const row = sql.exec<{ hash: string; result: string | null }>("SELECT hash, result FROM _idem WHERE key = ? AND expires > ?", key, Date.now())[0];
    if (!row) return null;
    if (row.hash !== hash) return { conflict: true };
    return { result: row.result === null ? undefined : JSON.parse(row.result) };
  },
  put(sql: Sql, key: string, hash: string, result: unknown, ttlMs: number): void {
    const now = Date.now();
    sql.exec("DELETE FROM _idem WHERE expires <= ?", now);
    sql.exec(
      "INSERT INTO _idem (key, hash, result, expires) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, result = excluded.result, expires = excluded.expires",
      key,
      hash,
      result === undefined ? null : JSON.stringify(result),
      now + ttlMs,
    );
  },
};
