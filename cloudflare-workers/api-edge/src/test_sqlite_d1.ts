// Test support: the edge's D1 as node:sqlite over the real schema (the
// snapshot, then every migration statement it does not already contain), as
// signup_attribution.test.ts builds it. Only tests import this.

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };

class Stmt {
  private params: unknown[] = [];
  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {}
  bind(...p: unknown[]): this {
    this.params = p;
    return this;
  }
  private args(): unknown[] {
    return this.params.map((v) => (v === undefined ? null : v));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const out = this.db.prepare(this.sql).run(...this.args()) as { changes?: number | bigint };
    return { success: true, meta: { changes: Number(out?.changes ?? 0) } };
  }
}

export function schemaDB(): DatabaseSync {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const fs = process.getBuiltinModule("node:fs") as {
    readFileSync(path: string, enc: "utf8"): string;
    readdirSync(path: string): string[];
  };
  const db = new DatabaseSync(":memory:");
  const root = process.cwd();
  db.exec(fs.readFileSync(`${root}/schema-snapshots/current_schema.sql`, "utf8"));
  for (const file of fs.readdirSync(`${root}/migrations`).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(`${root}/migrations/${file}`, "utf8").replace(/^\s*--.*$/gm, "");
    for (const statement of sql.split(/;\s*$/m).filter((s) => s.trim())) {
      try {
        db.exec(statement);
      } catch (err) {
        if (!/already exists|duplicate column/.test(String(err))) throw err;
      }
    }
  }
  return db;
}

/** A D1Database over a node:sqlite database. */
export function d1Of(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}
