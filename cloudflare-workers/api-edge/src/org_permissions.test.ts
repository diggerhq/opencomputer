import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { handleDashboard, type DashboardEnv } from "./dashboard";
import { hashAPIKey } from "./api_keys";

// Org/account permissions: key auth is bound to membership, members manage only
// their own keys, and nobody invites above their own role. Runs the edge's SQL
// against the real schema in node:sqlite (see signup_attribution.test.ts).
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
  constructor(private db: DatabaseSync, readonly sql: string) {}
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

function d1(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

const SECRET = "org-permissions-test-secret";
const ORG = "org-1";

function b64url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function cookieFor(userID: string, orgID = ORG): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    sub: userID, iss: "opensandbox-session", org_id: orgID, user_id: userID, plan: "free",
    iat: 1, exp: Math.floor(Date.now() / 1000) + 600,
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  return `oc_session=${header}.${payload}.${b64url(sig)}`;
}

let db: DatabaseSync;
let env: Env & DashboardEnv;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
let keySeq = 0;

function addUser(id: string, role: string | null, orgID = ORG): void {
  db.prepare(`INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, ?, ?, 0)`).run(id, `${id}@example.com`, id);
  if (role) db.prepare(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, 0)`).run(orgID, id, role);
}

// Inserts a key and returns its plaintext. Plaintexts are unique per test run,
// so the module-level auth cache never answers for a key from an earlier test.
async function addKey(createdBy: string | null, orgID = ORG, expiresAt: number | null = null): Promise<{ id: string; plain: string }> {
  const n = ++keySeq;
  const plain = `osb_perm_test_${n}_${Math.random().toString(36).slice(2)}`;
  const id = `key-${n}`;
  // The computer's keys are minted for one session (keyPrincipal refuses one without).
  db.prepare(
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at, expires_at, session_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, orgID, createdBy, await hashAPIKey(plain), plain.slice(0, 8), `key ${n}`, "sandbox:*", n, expiresAt, createdBy === "computer" ? "cs_0000000000000001" : null);
  return { id, plain };
}

async function dash(userID: string, method: string, sub: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://app.opencomputer.dev/api/dashboard${sub}`, {
    method,
    headers: { cookie: await cookieFor(userID), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleDashboard(req, env, ctx, `/api/dashboard${sub}`);
}

// Any key-authenticated route: 401 means the key was refused.
async function keyStatus(plain: string): Promise<number> {
  const resp = await worker.fetch(
    new Request("https://app.opencomputer.dev/api/managed-agents/agents", { headers: { "X-API-Key": plain } }),
    env,
    ctx,
  );
  return resp.status;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  db = schemaDB();
  db.prepare(`INSERT INTO orgs (id, name, slug, plan, home_cell, owner_user_id, created_at, updated_at) VALUES (?, 'Team', 'team', 'free', 'c1', 'owner-1', 0, 0)`).run(ORG);
  db.prepare(`INSERT INTO orgs (id, name, slug, plan, home_cell, owner_user_id, created_at, updated_at) VALUES ('org-2', 'Other', 'other', 'free', 'c1', 'owner-1', 0, 0)`).run();
  addUser("owner-1", "owner");
  addUser("admin-1", "admin");
  addUser("member-1", "member");
  addUser("member-2", "member");
  env = { OPENCOMPUTER_DB: d1(db), SESSION_JWT_SECRET: SECRET } as unknown as Env & DashboardEnv;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API key auth is bound to membership", () => {
  it("accepts a member's key and refuses it once the membership is gone", async () => {
    const key = await addKey("member-1");
    expect(await keyStatus(key.plain)).not.toBe(401);
    // Removed out of band (no dashboard call, so no cache eviction): a fresh
    // isolate reading D1 must refuse it.
    db.prepare(`DELETE FROM org_memberships WHERE user_id = 'member-1'`).run();
    const other = await addKey("member-1");
    expect(await keyStatus(other.plain)).toBe(401);
  });

  it("refuses a key whose creator is a member of a different org only", async () => {
    addUser("outsider", "owner", "org-2");
    const key = await addKey("outsider", ORG);
    expect(await keyStatus(key.plain)).toBe(401);
  });

  it("keeps org-owned keys working: the computer's and legacy keys with no creator", async () => {
    expect(await keyStatus((await addKey("computer")).plain)).not.toBe(401);
    expect(await keyStatus((await addKey(null)).plain)).not.toBe(401);
  });
});

describe("removing a member", () => {
  it("deletes their keys in that org only and evicts the cached auth at once", async () => {
    addUser("member-1", "member", "org-2");
    const key = await addKey("member-1");
    const elsewhere = await addKey("member-1", "org-2");
    const kept = await addKey("member-2");
    expect(await keyStatus(key.plain)).not.toBe(401); // now cached in this isolate

    const resp = await dash("owner-1", "DELETE", "/org/members/member-1");
    expect(resp.status).toBe(204);

    expect(await keyStatus(key.plain)).toBe(401);
    const ids = (db.prepare(`SELECT id FROM api_keys ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(key.id);
    expect(ids).toContain(elsewhere.id);
    expect(ids).toContain(kept.id);
  });

  it("locks a removed member's dashboard session out of the org", async () => {
    await addKey("member-1");
    db.prepare(`DELETE FROM org_memberships WHERE user_id = 'member-1'`).run();
    expect((await dash("member-1", "GET", "/api-keys")).status).toBe(403);
    expect((await dash("member-1", "POST", "/api-keys", { name: "sneaky" })).status).toBe(403);
    expect((await dash("member-1", "GET", "/org/members")).status).toBe(403);
    // ...but they can still see where they belong and switch away.
    expect((await dash("member-1", "GET", "/orgs")).status).toBe(200);
  });
});

describe("API key management", () => {
  const listIDs = async (userID: string) =>
    ((await (await dash(userID, "GET", "/api-keys")).json()) as { id: string }[]).map((k) => k.id).sort();

  it("lists only a member's own keys, and every key for an admin or owner", async () => {
    const mine = await addKey("member-1");
    const theirs = await addKey("member-2");
    const computer = await addKey("computer", ORG, Math.floor(Date.now() / 1000) + 3600);
    expect(await listIDs("member-1")).toEqual([mine.id]);
    const all = [mine.id, theirs.id, computer.id].sort();
    expect(await listIDs("admin-1")).toEqual(all);
    expect(await listIDs("owner-1")).toEqual(all);
  });

  it("lets a member revoke and rename only their own keys", async () => {
    const mine = await addKey("member-1");
    const theirs = await addKey("member-2");
    expect((await dash("member-1", "DELETE", `/api-keys/${theirs.id}`)).status).toBe(404);
    expect((await dash("member-1", "PATCH", `/api-keys/${theirs.id}`, { name: "x" })).status).toBe(404);
    expect(db.prepare(`SELECT name FROM api_keys WHERE id = ?`).get(theirs.id)).toEqual({ name: expect.stringMatching(/^key /) });

    expect((await dash("member-1", "PATCH", `/api-keys/${mine.id}`, { name: "renamed" })).status).toBe(200);
    expect((await dash("member-1", "DELETE", `/api-keys/${mine.id}`)).status).toBe(204);
    expect(db.prepare(`SELECT id FROM api_keys WHERE id = ?`).get(mine.id)).toBeUndefined();
  });

  it("lets an admin revoke anyone's key, effective at once", async () => {
    const theirs = await addKey("member-2");
    expect(await keyStatus(theirs.plain)).not.toBe(401); // cached
    expect((await dash("admin-1", "DELETE", `/api-keys/${theirs.id}`)).status).toBe(204);
    expect(await keyStatus(theirs.plain)).toBe(401);
  });
});

describe("invitation roles", () => {
  const invite = async (by: string, role?: string) =>
    (await dash(by, "POST", "/org/invitations", { email: `new-${by}-${role}@example.com`, ...(role ? { role } : {}) })).status;

  it("lets a member invite only as member", async () => {
    expect(await invite("member-1")).toBe(201);
    expect(await invite("member-1", "member")).toBe(201);
    expect(await invite("member-1", "admin")).toBe(403);
    expect(await invite("member-1", "owner")).toBe(403);
  });

  it("lets an admin invite members and admins, not owners", async () => {
    expect(await invite("admin-1", "member")).toBe(201);
    expect(await invite("admin-1", "admin")).toBe(201);
    expect(await invite("admin-1", "owner")).toBe(403);
  });

  it("lets an owner invite any role", async () => {
    expect(await invite("owner-1", "admin")).toBe(201);
    expect(await invite("owner-1", "owner")).toBe(201);
  });

  it("records nothing for a refused invitation", async () => {
    await invite("member-1", "owner");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM invitations`).get()).toEqual({ n: 0 });
  });
});
