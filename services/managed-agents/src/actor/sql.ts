// The storage every actor's logic runs on (tracks and threads, spec 36.1 and 36.7): SQL, a
// transaction, and the actor's one alarm. Nothing in src/actor/ touches a Durable Object directly,
// so the same code runs over any SQLite.

export interface Sql {
  /** Run one statement; its rows, all of them. */
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[];
  /** Run `fn` in one transaction; a throw rolls it back. */
  transaction<T>(fn: () => T): T;
  /** Set the actor's one alarm to `at` (ms), or clear it. Only `alarms` calls this. */
  arm(at: number | null): void;
}

/** The `Sql` of a Durable Object's storage. Make one per object and keep it. */
export function sqlOf(storage: DurableObjectStorage): Sql {
  return {
    exec: <T>(query: string, ...params: unknown[]) => storage.sql.exec(query, ...(params as never[])).toArray() as T[],
    transaction: (fn) => storage.transactionSync(fn),
    arm: (at) => void (at === null ? storage.deleteAlarm() : storage.setAlarm(Math.max(at, 1))),
  };
}
