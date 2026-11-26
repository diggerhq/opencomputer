// Many timers on an actor's one alarm (spec 36.7, D21): named due times folded into a single setAlarm.

import type { Sql } from "./sql.js";

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
