// The mechanics every actor shares (spec 36.7, D21): ordered migrations, many timers on the one
// alarm, calls owed after a transaction, idempotency. All of it over `Sql`.

import type { Emitter } from "../telemetry/log-emitter.js";
import { errorText } from "./helpers.js";
import type { Sql } from "../durable/sql.js";

// ---------------------------------------------------------------- migrations

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

// -------------------------------------------------------------------- alarms

const rearm = (sql: Sql) => sql.arm(sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM _alarm")[0]?.at ?? null);

export const alarms = {
  /** Fire `purpose` at `at`; when it is already set, the earlier of the two. */
  set(sql: Sql, purpose: string, at: number): void {
    sql.exec(
      "INSERT INTO _alarm (purpose, at) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET at = MIN(COALESCE(at, excluded.at), excluded.at)",
      purpose,
      Math.floor(at),
    );
    rearm(sql);
  },
  clear(sql: Sql, purpose: string): void {
    sql.exec("DELETE FROM _alarm WHERE purpose = ?", purpose);
    rearm(sql);
  },
  /**
   * The purposes due at `now`, and the actor's alarm re-armed for the next one. A purpose stays
   * due (it is returned again) until `done` is called for it; `run` does both.
   */
  due(sql: Sql, now: number): string[] {
    sql.exec("UPDATE _alarm SET firing = COALESCE(firing, at), at = NULL WHERE at <= ? OR (at IS NULL AND firing IS NOT NULL)", now);
    const due = sql.exec<{ purpose: string }>("SELECT purpose FROM _alarm WHERE firing IS NOT NULL ORDER BY firing, purpose").map((row) => row.purpose);
    rearm(sql);
    return due;
  },
  /** A due purpose's handler returned. Failed: due again in a second, unless it set itself sooner. */
  done(sql: Sql, purpose: string, ok: boolean, now: number): void {
    if (ok) {
      sql.exec("UPDATE _alarm SET firing = NULL WHERE purpose = ?", purpose);
      sql.exec("DELETE FROM _alarm WHERE purpose = ? AND at IS NULL", purpose);
      rearm(sql);
    } else {
      sql.exec("UPDATE _alarm SET firing = NULL WHERE purpose = ?", purpose);
      alarms.set(sql, purpose, now + 1_000);
    }
  },
  /**
   * An actor's whole `alarm()`: every due purpose's handler, each on its own, so one that throws
   * delays only itself. A handler that wants to run again calls `set`. A purpose with no handler is dropped.
   */
  async run(sql: Sql, now: number, handlers: Record<string, () => void | Promise<void>>, failed?: (purpose: string, error: unknown) => void): Promise<void> {
    await Promise.all(
      alarms.due(sql, now).map(async (purpose) => {
        const handler = handlers[purpose];
        if (!handler) return alarms.clear(sql, purpose);
        try {
          await handler();
          alarms.done(sql, purpose, true, Date.now());
        } catch (error) {
          failed?.(purpose, error);
          alarms.done(sql, purpose, false, Date.now());
        }
      }),
    );
  },
};

// ---------------------------------------------------------------- owed calls

/**
 * A call with no schedule of its own: seconds 1, 2, 5, 15, then every 60 for a day. Past it the
 * call goes to the dead list like any other, so one that cannot succeed stops holding its group.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000];
const BACKOFF_REST_MS = 60_000;
const BACKOFF_TRIES = BACKOFF_MS.length + (24 * 60 * 60 * 1_000) / BACKOFF_REST_MS;
const DEAD_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** The alarm purpose owed calls retry on. An actor's `alarm()` maps it to `owed.run`. */
export const OWED_PURPOSE = "owed";

export interface Owed {
  /** Calls of one group go in the order they were added; groups do not wait for each other. */
  group: string;
  /** A slot: a later `add` with this key replaces the row, sent or not. */
  key?: string;
  call: string;
  body?: unknown;
  /** Not before this time (ms). Default: now. */
  at?: number;
  /** The caller's own waits between tries, ms; default about a day (BACKOFF_MS). Past its last step the call goes to the dead list. */
  schedule?: number[];
}

/** A call that ran out of tries (spec 18.6): set aside, its group moved on. */
export interface Dead {
  group: string;
  call: string;
  tries: number;
  lastError: string;
  at: number;
}

interface OwedRow {
  n: number;
  grp: string;
  call: string;
  body: string | null;
  at: number;
  tries: number;
  schedule: string | null;
}

/** The group runs in flight, per actor: a call during one makes that group go round once more. */
const running = new WeakMap<Sql, Map<string, { again: boolean; done: Promise<void> }>>();

export const owed = {
  /** Write the call in the caller's transaction. Call `run` after it commits. */
  add(tx: Sql, o: Owed): void {
    const at = Math.floor(o.at ?? Date.now());
    if (o.key !== undefined) tx.exec("DELETE FROM _owed WHERE key = ?", o.key);
    tx.exec(
      "INSERT INTO _owed (grp, key, call, body, at, schedule) VALUES (?, ?, ?, ?, ?, ?)",
      o.group,
      o.key ?? null,
      o.call,
      o.body === undefined ? null : JSON.stringify(o.body),
      at,
      o.schedule ? JSON.stringify(o.schedule) : null,
    );
    alarms.set(tx, OWED_PURPOSE, at);
  },
  /**
   * A debounced call, in the caller's transaction: while its group's newest call is not yet due and
   * not yet tried, that call takes `merge(its body)` and keeps its time; else this one is added, due at `o.at`.
   */
  debounce(tx: Sql, o: Owed & { at: number }, merge: (pending: unknown) => unknown): void {
    const row = tx.exec<{ n: number; body: string | null; at: number; tries: number }>("SELECT n, body, at, tries FROM _owed WHERE grp = ? ORDER BY n DESC LIMIT 1", o.group)[0];
    if (row && row.tries === 0 && row.at > Date.now()) {
      tx.exec("UPDATE _owed SET body = ? WHERE n = ?", JSON.stringify(merge(row.body === null ? undefined : JSON.parse(row.body))), row.n);
      return;
    }
    owed.add(tx, o);
  },
  /** Drop the rows of a group (its subject is gone) or the row of a key. */
  drop(tx: Sql, which: { group: string } | { key: string }): void {
    if ("group" in which) tx.exec("DELETE FROM _owed WHERE grp = ?", which.group);
    else tx.exec("DELETE FROM _owed WHERE key = ?", which.key);
  },
  /** Whether a call is still owed under this key. */
  has(sql: Sql, key: string): boolean {
    return sql.exec("SELECT 1 FROM _owed WHERE key = ?", key).length > 0;
  },
  /** The groups with a call owed. */
  groups(sql: Sql): string[] {
    return sql.exec<{ grp: string }>("SELECT DISTINCT grp FROM _owed ORDER BY grp").map((row) => row.grp);
  },
  /** What waited for an event (a peer that came back): due now, every group's or one group's. Call `run` after. */
  due(tx: Sql, group?: string): void {
    const now = Date.now();
    if (group === undefined) tx.exec("UPDATE _owed SET at = ? WHERE at > ?", now, now);
    else tx.exec("UPDATE _owed SET at = ? WHERE at > ? AND grp = ?", now, now, group);
    alarms.set(tx, OWED_PURPOSE, now);
  },
  /**
   * Send what is due: each group's calls in order, stopping a group at its first failure; `only`: that
   * group's alone. A call is removed when `send` resolves; a row replaced (by key) while its call was in
   * flight is a new row and is sent again. One run at a time per group: a call during a group's run makes
   * it go round once more, and resolves when that is over. Groups do not wait for each other.
   * A call that goes to the dead list is reported on `emit` as `owed.dead`, at error level, to alert on.
   */
  async run(sql: Sql, send: (call: string, body: unknown) => Promise<void>, now: number, emit: Emitter, only?: string): Promise<void> {
    sql.exec("DELETE FROM _dead WHERE at < ?", now - DEAD_TTL_MS);
    const groups = only === undefined ? owed.groups(sql) : [only];
    await Promise.all(groups.map((group) => runGroup(sql, group, send, now, emit)));
  },
  /** The dead list, oldest first, kept 30 days. */
  dead(sql: Sql): Dead[] {
    return sql
      .exec<{ grp: string; call: string; tries: number; last_error: string; at: number }>("SELECT grp, call, tries, last_error, at FROM _dead ORDER BY n")
      .map((row) => ({ group: row.grp, call: row.call, tries: row.tries, lastError: row.last_error, at: row.at }));
  },
};

function runGroup(sql: Sql, group: string, send: (call: string, body: unknown) => Promise<void>, now: number, emit: Emitter): Promise<void> {
  let groups = running.get(sql);
  if (!groups) running.set(sql, (groups = new Map()));
  const current = groups.get(group);
  if (current) {
    current.again = true;
    return current.done;
  }
  const state = { again: false, done: Promise.resolve() };
  state.done = (async () => {
    try {
      let at = now;
      do {
        state.again = false;
        await sendGroup(sql, group, send, at, emit);
        at = Date.now();
      } while (state.again);
    } finally {
      groups.delete(group);
      const next = sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT at, MIN(n) FROM _owed GROUP BY grp)")[0]?.at;
      if (next !== null && next !== undefined) alarms.set(sql, OWED_PURPOSE, next);
    }
  })();
  groups.set(group, state);
  return state.done;
}

async function sendGroup(sql: Sql, group: string, send: (call: string, body: unknown) => Promise<void>, now: number, emit: Emitter): Promise<void> {
  for (;;) {
    const row = sql.exec<OwedRow>("SELECT n, grp, call, body, at, tries, schedule FROM _owed WHERE grp = ? ORDER BY n LIMIT 1", group)[0];
    if (!row || row.at > now) return;
    try {
      await send(row.call, row.body === null ? undefined : JSON.parse(row.body));
      sql.exec("DELETE FROM _owed WHERE n = ?", row.n);
    } catch (error) {
      const tries = row.tries + 1;
      const schedule = row.schedule ? (JSON.parse(row.schedule) as number[]) : null;
      const wait = schedule ? schedule[tries - 1] : tries < BACKOFF_TRIES ? (BACKOFF_MS[tries - 1] ?? BACKOFF_REST_MS) : undefined;
      if (wait === undefined) {
        const died = sql.transaction(() => {
          // Only if the row is still this one: a replaced slot is a new call.
          if (sql.exec("DELETE FROM _owed WHERE n = ? RETURNING n", row.n).length === 0) return false;
          sql.exec("INSERT INTO _dead (grp, call, body, tries, last_error, at) VALUES (?, ?, ?, ?, ?, ?)", row.grp, row.call, row.body, tries, errorText(error), Date.now());
          return true;
        });
        if (died) emit("owed.dead", { group: row.grp, call: row.call, tries, error: errorText(error) }, "error");
        continue;
      }
      sql.exec("UPDATE _owed SET tries = ?, at = ?, last_error = ? WHERE n = ?", tries, Date.now() + wait, errorText(error), row.n);
      return;
    }
  }
}

// --------------------------------------------------------------- idempotency

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
