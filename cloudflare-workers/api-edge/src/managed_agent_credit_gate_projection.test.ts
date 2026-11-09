import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectOrg, selfHealHalt, type AutumnEnv } from "./autumn_webhook";
import { enforceManagedAgentCreditGate } from "./managed_agent_credit_gate";

// 097 step 7.2: projectOrg no longer halts sandbox cells or writes
// max_concurrent_sandboxes. These tests run the managed-agents credit gate end
// to end (gate -> selfHealHalt -> projectOrg -> syncAutumnToD1) against the real
// schema in node:sqlite, with only Autumn's GET customer stubbed, to prove the
// gate still admits an org with credit and blocks one without, and that nothing
// reaches a cell. Same node:sqlite harness as signup_attribution.test.ts.
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, enc: "utf8"): string;
  readdirSync(path: string): string[];
};

class Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
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

function schemaDB(): DatabaseSync {
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

const CELL_URL = "https://cp-us-east-2.example.test";
const AUTUMN_URL = "https://autumn.example.test/v1";

describe("managed-agents credit gate after the projectOrg refactor", () => {
  let db: DatabaseSync;
  let env: AutumnEnv;
  let credits: number;
  let fetches: string[];
  // selfHealHalt keeps a per-org cooldown in module state, so each test uses
  // its own org id.
  let orgID: string;
  let seq = 0;

  const org = () =>
    db.prepare("SELECT is_halted, halt_reason, max_concurrent_sandboxes FROM orgs WHERE id = ?").get(orgID) as {
      is_halted: number;
      halt_reason: string | null;
      max_concurrent_sandboxes: number;
    };

  const gate = () => {
    const pending: Promise<unknown>[] = [];
    const result = enforceManagedAgentCreditGate(
      new Request("https://app.opencomputer.dev/api/managed-agents/sessions", { method: "POST" }),
      env,
      orgID,
      (id) => selfHealHalt(env, id),
      (p) => pending.push(p),
    );
    return result.then(async (r) => (await Promise.all(pending), r));
  };

  beforeEach(() => {
    db = schemaDB();
    orgID = `org-gate-${++seq}`;
    credits = 0;
    fetches = [];
    env = {
      OPENCOMPUTER_DB: { prepare: (sql: string) => new Stmt(db, sql) },
      AUTUMN_SECRET_KEY: "autumn-test",
      AUTUMN_BASE_URL: AUTUMN_URL,
      EVENT_SECRET: "",
      AUTUMN_WEBHOOK_SECRET: "",
    } as unknown as AutumnEnv;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      fetches.push(url);
      if (url === `${AUTUMN_URL}/customers/${orgID}`) {
        // A credit-based plan: no work_minutes balance, so the credits rule decides.
        return Response.json({ id: orgID, subscriptions: [], balances: { credits: { remaining: credits } } });
      }
      return new Response("unexpected", { status: 500 });
    });

    // A cell and a running sandbox: the old projectOrg POSTed /admin/halt-org
    // to the cell on a fresh halt, and synced a concurrency cap onto the org.
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO cells (cell_id, cloud, region, base_url, status, created_at) VALUES ('cell-a', 'azure', 'us-east-2', ?, 'active', ?)",
    ).run(CELL_URL, now);
    db.prepare(
      `INSERT INTO orgs (id, name, slug, plan, home_cell, billing_provider, is_halted, halt_reason,
         max_concurrent_sandboxes, autumn_concurrency_override, created_at, updated_at)
       VALUES (?, 'Ada', ?, 'free', 'cell-a', 'autumn', 0, NULL, 7, 3, ?, ?)`,
    ).run(orgID, orgID, now, now);
    db.prepare(
      "INSERT INTO sandboxes_index (id, org_id, cell_id, status, created_at) VALUES ('sb-1', ?, 'cell-a', 'running', ?)",
    ).run(orgID, now);
  });

  afterEach(() => vi.unstubAllGlobals());

  const halt = (reason = "credits_exhausted") =>
    db.prepare("UPDATE orgs SET is_halted = 1, halted_at = 1, halt_reason = ? WHERE id = ?").run(reason, orgID);

  it("allows a halted org whose Autumn re-check finds credit, and clears the halt", async () => {
    halt();
    credits = 5;
    expect(await gate()).toBeNull();
    expect(fetches).toEqual([`${AUTUMN_URL}/customers/${orgID}`]);
    expect(org()).toMatchObject({ is_halted: 0, halt_reason: null });
  });

  it("blocks a halted org with no credit (402) and keeps it halted", async () => {
    halt();
    credits = 0;
    const resp = await gate();
    expect(resp?.status).toBe(402);
    expect(fetches).toEqual([`${AUTUMN_URL}/customers/${orgID}`]);
    expect(org()).toMatchObject({ is_halted: 1, halt_reason: "credits_exhausted" });
  });

  it("allows an unhalted org without asking Autumn", async () => {
    credits = 0;
    expect(await gate()).toBeNull();
    expect(fetches).toEqual([]);
  });

  it("projects a fresh halt into D1 only, and the gate then blocks", async () => {
    credits = 0;
    await projectOrg(env, orgID);
    expect(org()).toMatchObject({ is_halted: 1, halt_reason: "credits_exhausted" });
    expect((await gate())?.status).toBe(402);
  });

  afterEach(() => {
    // Every Autumn call went to Autumn; nothing went to a cell (no
    // /admin/halt-org or /admin/resume-org), and the sandbox concurrency
    // column was never written.
    expect(fetches.every((url) => url.startsWith(AUTUMN_URL))).toBe(true);
    expect(fetches.some((url) => url.startsWith(CELL_URL) || url.includes("/admin/"))).toBe(false);
    expect(org().max_concurrent_sandboxes).toBe(7);
  });
});
