import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import type { SelfhostSignIn } from "./selfhost";

// The self-hosted gateway (selfhost.ts) on a fresh database built the way serve.mjs builds it: the
// schema snapshot, then every migration. node:sqlite via getBuiltinModule, as in
// agent_feedback.test.ts.

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
  async run(): Promise<{ success: true; meta: object }> {
    this.db.prepare(this.sql).run(...this.args());
    return { success: true, meta: {} };
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const root = process.cwd();
  db.exec(fs.readFileSync(`${root}/schema-snapshots/current_schema.sql`, "utf8"));
  for (const file of fs.readdirSync(`${root}/migrations`).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(`${root}/migrations/${file}`, "utf8"));
  }
  return db;
}

const ORG = "org_selfhost";
const OWNER = "owner@example.com";

function makeEnv(signIn: SelfhostSignIn | null = { clientId: "client_test", apiKey: "sk_test", ownerEmail: "Owner@Example.com" }) {
  const db = freshDb();
  const env = {
    OPENCOMPUTER_DB: {
      prepare: (sql: string) => new Stmt(db, sql),
      batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
    },
    SESSION_JWT_SECRET: "test-secret",
    WORKER_ENV: "selfhost",
    SELFHOST: "1",
    SELFHOST_ORG_ID: ORG,
    SELFHOST_SETUP: { signIn: async () => signIn },
  } as unknown as Env;
  return { env, db };
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const ORIGIN = "https://computer.example.com";

function signInAs(email: string, workosId: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ user: { id: workosId, email, first_name: "P" } })),
  );
}

describe("self-hosted gateway", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends /auth/login to WorkOS with /setup's client ID and the public origin's callback", async () => {
    const { env } = makeEnv();
    const resp = await worker.fetch(new Request(`${ORIGIN}/auth/login`), env, ctx);
    expect(resp.status).toBe(302);
    const to = new URL(resp.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://api.workos.com/user_management/authorize");
    expect(to.searchParams.get("client_id")).toBe("client_test");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
  });

  it("says sign-in isn't set up until /setup has the WorkOS app", async () => {
    const { env } = makeEnv(null);
    const resp = await worker.fetch(new Request(`${ORIGIN}/auth/login`), env, ctx);
    expect(resp.status).toBe(503);
    expect(await resp.text()).toContain("/setup");
  });

  it("makes the owner's email the owner of the one organization, with no personal workspace", async () => {
    const { env, db } = makeEnv();
    signInAs(OWNER, "wos-owner");
    const resp = await worker.fetch(new Request(`${ORIGIN}/auth/callback?code=c1`), env, ctx);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    expect(resp.headers.get("set-cookie")).toMatch(/^oc_session=/);
    expect(db.prepare("SELECT id, billing_provider, is_personal FROM orgs").all()).toEqual([
      { id: ORG, billing_provider: "legacy", is_personal: 0 },
    ]);
    expect(db.prepare("SELECT org_id, role FROM org_memberships").all()).toEqual([{ org_id: ORG, role: "owner" }]);
  });

  it("turns away someone who is neither the owner nor invited", async () => {
    const { env, db } = makeEnv();
    signInAs("stranger@example.com", "wos-stranger");
    const resp = await worker.fetch(new Request(`${ORIGIN}/auth/callback?code=c1`), env, ctx);
    expect(resp.status).toBe(403);
    expect(db.prepare("SELECT count(*) AS n FROM org_memberships").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM orgs WHERE id != ?").get(ORG)).toEqual({ n: 0 });
  });

  it("lets an invited person in as a member", async () => {
    const { env, db } = makeEnv();
    signInAs(OWNER, "wos-owner");
    await worker.fetch(new Request(`${ORIGIN}/auth/callback?code=c1`), env, ctx);
    db.prepare(
      "INSERT INTO invitations (id, org_id, email, role, status, expires_at, created_at) VALUES ('inv-1', ?, 'new@example.com', 'member', 'pending', ?, 1)",
    ).run(ORG, Math.floor(Date.now() / 1000) + 3600);
    signInAs("new@example.com", "wos-new");
    const resp = await worker.fetch(new Request(`${ORIGIN}/auth/callback?code=c2`), env, ctx);
    expect(resp.status).toBe(302);
    expect(db.prepare("SELECT role FROM org_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'new@example.com'").all()).toEqual([
      { role: "member" },
    ]);
  });

  it("answers billing's routes with 404", async () => {
    const { env } = makeEnv();
    for (const path of ["/api/dashboard/billing", "/api/dashboard/billing/autumn", "/api/billing/credits", "/webhooks/stripe", "/webhooks/autumn"]) {
      const resp = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: path.startsWith("/webhooks") ? "POST" : "GET" }), env, ctx);
      expect(resp.status, path).toBe(404);
    }
  });
});
