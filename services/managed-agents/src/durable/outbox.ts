// Calls owed after a transaction (spec 36.7, D21): written in the transaction, sent after it commits,
// retried on the alarm, set aside on the dead list when they run out of tries.

import type { Emitter } from "../telemetry/log-emitter.js";
import { alarms } from "./alarms.js";
import type { Sql } from "./sql.js";

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
      const step = schedule ? schedule[tries - 1] : tries < BACKOFF_TRIES ? (BACKOFF_MS[tries - 1] ?? BACKOFF_REST_MS) : undefined;
      // A peer that said when to come back (a rate limit's Retry-After) is not asked sooner; the schedule still ends the call.
      const wait = step === undefined ? undefined : Math.max(step, retryAfterOf(error));
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

/**
 * A failed call that should not be tried again before `retryAfterMs` (Slack's Retry-After on a 429): thrown by `send`,
 * it waits at least that long, still within its schedule.
 */
export class RetryAfter extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

const retryAfterOf = (error: unknown): number => (error instanceof RetryAfter && Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0);

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);
