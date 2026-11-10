import { DatabaseSync } from "node:sqlite";

/** Durable Object SQL storage, as much of it as the computer modules use, on node:sqlite. */
export function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  const cursor = (rows: unknown[], rowsWritten: number) =>
    Object.assign(rows[Symbol.iterator](), { rowsWritten, toArray: () => rows });
  return {
    exec(query: string, ...binds: unknown[]) {
      if (!binds.length && query.includes(";") && /CREATE/i.test(query)) {
        db.exec(query);
        return cursor([], 0);
      }
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) return cursor(statement.all(...(binds as never[])) as unknown[], 0);
      const result = statement.run(...(binds as never[]));
      return cursor([], Number(result.changes));
    },
  } as unknown as SqlStorage;
}
