import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrKey,
  deleteOrKey,
  getOrKey,
  OpenRouterError,
  patchOrKey,
} from "./openrouter";
import {
  disableManagedBilling,
  enableManagedBilling,
  type ManagedModelKeyRow,
  type ModelBillingEnv,
  ownerIdForOrg,
} from "./model_billing";

// ── in-memory D1 fake tailored to model_billing's queries ───────────────────

interface OrgRow {
  id: string;
  billing_provider: string;
  model_billing_status: string;
  model_markup_bps: number;
}

class FakeDb {
  orgs = new Map<string, OrgRow>();
  keys: ManagedModelKeyRow[] = [];

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(
    private db: FakeDb,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    if (s.includes("FROM orgs")) {
      return (this.db.orgs.get(this.args[0] as string) ?? null) as T | null;
    }
    if (s.includes("FROM managed_model_keys")) {
      const orgId = this.args[0] as string;
      let rows = this.db.keys.filter((k) => k.org_id === orgId && k.status === "active");
      if (s.includes("or_key_hash IS NOT NULL")) {
        rows = rows.filter((k) => k.or_key_hash !== null && k.managed_credential_id !== null);
      }
      rows.sort((a, b) => b.created_at - a.created_at);
      return (rows[0] ?? null) as T | null;
    }
    return null;
  }

  // getAllKeyRows uses .all() (no status filter).
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM managed_model_keys")) {
      const orgId = this.args[0] as string;
      return { results: this.db.keys.filter((k) => k.org_id === orgId) as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<void> {
    const s = this.sql;
    if (s.startsWith("UPDATE orgs SET model_billing_status")) {
      const org = this.db.orgs.get(this.args[1] as string);
      if (org) org.model_billing_status = this.args[0] as string;
      return;
    }
    if (s.startsWith("INSERT INTO managed_model_keys")) {
      const [id, org_id, operation_id, created_at] = this.args as [string, string, string, number];
      this.db.keys.push({
        id,
        org_id,
        or_key_hash: null,
        managed_credential_id: null,
        operation_id,
        status: "active",
        committed_micro: 0,
        pending_from_micro: null,
        pending_to_micro: null,
        pending_idem: null,
        attempts: 0,
        last_error: null,
        created_at,
        superseded_at: null,
      });
      return;
    }
    if (s.startsWith("DELETE FROM managed_model_keys")) {
      const orgId = this.args[0] as string;
      this.db.keys = this.db.keys.filter((k) => k.org_id !== orgId);
      return;
    }
    if (s.startsWith("UPDATE managed_model_keys SET")) {
      // parse "SET a = ?1, b = ?2 WHERE id = ?N"
      const setClause = s.slice(s.indexOf("SET ") + 4, s.indexOf(" WHERE"));
      const cols = setClause.split(",").map((c) => c.trim().split(" ")[0]);
      const id = this.args[this.args.length - 1] as string;
      const row = this.db.keys.find((k) => k.id === id);
      if (row) cols.forEach((c, i) => ((row as unknown as Record<string, unknown>)[c] = this.args[i]));
      return;
    }
    throw new Error(`FakeStmt: unhandled run() sql: ${s}`);
  }
}

// ── fetch router: OpenRouter + Autumn + sessions-api ────────────────────────

interface RouterOpts {
  remainingCredits?: number; // Autumn balance
  lookupCredId?: string | null; // GET /internal/managed-credential result
  createdHash?: string;
}

function makeFetch(opts: RouterOpts = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });

    // Autumn getAutumnCustomer
    if (url.includes("/customers/")) {
      return new Response(
        JSON.stringify({ id: "x", balances: { credits: { remaining: opts.remainingCredits ?? 5 } } }),
        { status: 200 },
      );
    }
    // OpenRouter create / get / patch / delete keys
    if (url.includes("/keys")) {
      if (method === "POST") {
        return new Response(
          JSON.stringify({ key: "sk-or-test-PLAINTEXT", data: { hash: opts.createdHash ?? "hash-abc", limit: body?.limit, usage: 0, disabled: false } }),
          { status: 200 },
        );
      }
      if (method === "DELETE") return new Response("", { status: 200 });
      if (method === "PATCH") return new Response(JSON.stringify({ data: { hash: "hash-abc", limit: body?.limit } }), { status: 200 });
      return new Response(JSON.stringify({ data: { hash: "hash-abc", usage: 0.5, limit: 5, disabled: false } }), { status: 200 });
    }
    // sessions-api hand-off
    if (url.includes("/internal/managed-credential")) {
      if (method === "POST") return new Response(JSON.stringify({ managed_credential_id: "cred_bound" }), { status: 200 });
      if (method === "DELETE") return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
      // GET lookup
      return new Response(JSON.stringify({ managed_credential_id: opts.lookupCredId ?? null }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { spy, calls };
}

function makeEnv(db: FakeDb): ModelBillingEnv {
  return {
    OPENCOMPUTER_DB: db as unknown as D1Database,
    OPENROUTER_PROVISIONING_KEY: "or-mgmt-key",
    OPENROUTER_BASE_URL: "https://or.test/api/v1",
    AUTUMN_SECRET_KEY: "autumn-key",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
    SESSIONS_API_URL: "https://sa.test",
    OC_MANAGED_CRED_HMAC_SECRET: "hmac-secret",
  };
}

function seedOrg(db: FakeDb, over: Partial<OrgRow> = {}): string {
  const id = over.id ?? "org1";
  db.orgs.set(id, {
    id,
    billing_provider: "autumn",
    model_billing_status: "off",
    model_markup_bps: 0,
    ...over,
  });
  return id;
}

afterEach(() => vi.unstubAllGlobals());

describe("openrouter client", () => {
  it("createOrKey sends name+limit+null reset, returns plaintext once", async () => {
    const { spy, calls } = makeFetch();
    vi.stubGlobal("fetch", spy);
    const out = await createOrKey(makeEnv(new FakeDb()), { name: "oc-org-x", limitUsd: 4.2 });
    expect(out.key).toBe("sk-or-test-PLAINTEXT");
    expect(out.data.hash).toBe("hash-abc");
    expect(calls[0].body).toMatchObject({ name: "oc-org-x", limit: 4.2, limit_reset: null });
  });

  it("getOrKey unwraps data envelope", async () => {
    vi.stubGlobal("fetch", makeFetch().spy);
    const k = await getOrKey(makeEnv(new FakeDb()), "hash-abc");
    expect(k.usage).toBe(0.5);
  });

  it("patchOrKey maps limitUsd→limit", async () => {
    const { spy, calls } = makeFetch();
    vi.stubGlobal("fetch", spy);
    await patchOrKey(makeEnv(new FakeDb()), "hash-abc", { limitUsd: 9 });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toMatchObject({ limit: 9 });
  });

  it("deleteOrKey swallows 404", async () => {
    const spy = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    await expect(deleteOrKey(makeEnv(new FakeDb()), "h")).resolves.toBeUndefined();
  });

  it("throws OpenRouterError with op+status on failure", async () => {
    const spy = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", spy);
    await expect(getOrKey(makeEnv(new FakeDb()), "h")).rejects.toMatchObject({
      name: "OpenRouterError",
      op: "get_key",
      status: 401,
    });
  });
});

describe("enableManagedBilling state machine", () => {
  it("off → active: mints key, binds credential, flips org", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db);
    const { spy, calls } = makeFetch({ remainingCredits: 5 });
    vi.stubGlobal("fetch", spy);

    const res = await enableManagedBilling(makeEnv(db), orgId);

    expect(res).toEqual({ status: "active", credentialId: "cred_bound" });
    expect(db.orgs.get(orgId)!.model_billing_status).toBe("active");
    const row = db.keys.find((k) => k.org_id === orgId)!;
    expect(row.or_key_hash).toBe("hash-abc");
    expect(row.managed_credential_id).toBe("cred_bound");

    // OR key created with limit = remaining/(1+markup) = 5/1 = 5
    const create = calls.find((c) => c.url.endsWith("/keys") && c.method === "POST")!;
    expect(create.body).toMatchObject({ name: `oc-org-${orgId}`, limit: 5 });
    // hand-off carries owner=oc-org:..., provider openrouter, the plaintext + ids
    const bind = calls.find((c) => c.url.includes("/internal/managed-credential") && c.method === "POST")!;
    expect(bind.body).toMatchObject({
      owner_id: ownerIdForOrg(orgId),
      provider: "openrouter",
      key: "sk-or-test-PLAINTEXT",
      or_key_hash: "hash-abc",
    });
    expect((bind.body as { operation_id: string }).operation_id).toMatch(/^op_/);
  });

  it("applies markup to the initial cap (remaining / (1+bps))", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { model_markup_bps: 2000 }); // +20%
    const { spy, calls } = makeFetch({ remainingCredits: 6 });
    vi.stubGlobal("fetch", spy);

    await enableManagedBilling(makeEnv(db), orgId);
    const create = calls.find((c) => c.url.endsWith("/keys") && c.method === "POST")!;
    expect((create.body as { limit: number }).limit).toBeCloseTo(6 / 1.2, 5); // 5.0
  });

  it("refuses non-autumn orgs", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { billing_provider: "legacy" });
    vi.stubGlobal("fetch", makeFetch().spy);
    await expect(enableManagedBilling(makeEnv(db), orgId)).rejects.toThrow(/not autumn/);
    expect(db.orgs.get(orgId)!.model_billing_status).not.toBe("active");
  });

  it("is idempotent: a complete active row re-call mints nothing new", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { model_billing_status: "active" });
    db.keys.push({
      id: "mmk_1", org_id: orgId, or_key_hash: "hash-old", managed_credential_id: "cred_old",
      operation_id: "op_1", status: "active", committed_micro: 0, pending_from_micro: null,
      pending_to_micro: null, pending_idem: null, attempts: 0, last_error: null, created_at: 1, superseded_at: null,
    });
    const { spy, calls } = makeFetch();
    vi.stubGlobal("fetch", spy);

    const res = await enableManagedBilling(makeEnv(db), orgId);
    expect(res).toEqual({ status: "active", credentialId: "cred_old" });
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/keys"))).toBeUndefined(); // no new key
    expect(db.keys.length).toBe(1);
  });

  it("lost-bind recovery: adopts an already-bound credential without recreating", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { model_billing_status: "provisioning" });
    db.keys.push({
      id: "mmk_1", org_id: orgId, or_key_hash: "hash-x", managed_credential_id: null,
      operation_id: "op_1", status: "active", committed_micro: 0, pending_from_micro: null,
      pending_to_micro: null, pending_idem: null, attempts: 0, last_error: null, created_at: 1, superseded_at: null,
    });
    const { spy, calls } = makeFetch({ lookupCredId: "cred_recovered" });
    vi.stubGlobal("fetch", spy);

    const res = await enableManagedBilling(makeEnv(db), orgId);
    expect(res.status).toBe("active");
    expect(db.keys[0].managed_credential_id).toBe("cred_recovered");
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/keys"))).toBeUndefined(); // no recreate
    expect(calls.find((c) => c.url.includes("/internal/managed-credential") && c.method === "GET")).toBeTruthy();
  });

  it("lost-bind recovery: deletes the orphan key + recreates when no credential is bound", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { model_billing_status: "provisioning" });
    db.keys.push({
      id: "mmk_1", org_id: orgId, or_key_hash: "hash-orphan", managed_credential_id: null,
      operation_id: "op_1", status: "active", committed_micro: 0, pending_from_micro: null,
      pending_to_micro: null, pending_idem: null, attempts: 0, last_error: null, created_at: 1, superseded_at: null,
    });
    const { spy, calls } = makeFetch({ lookupCredId: null, createdHash: "hash-new" });
    vi.stubGlobal("fetch", spy);

    const res = await enableManagedBilling(makeEnv(db), orgId);
    expect(res.status).toBe("active");
    expect(calls.find((c) => c.method === "DELETE")).toBeTruthy(); // orphan deleted
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/keys"))).toBeTruthy(); // recreated
    expect(db.keys[0].or_key_hash).toBe("hash-new");
    expect(db.keys[0].managed_credential_id).toBe("cred_bound");
  });
});

describe("disableManagedBilling (rollback / hard offboard)", () => {
  it("deletes the OR key, revokes the sessions-api credential, drops rows, flips off", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { model_billing_status: "active" });
    db.keys.push({
      id: "mmk_1", org_id: orgId, or_key_hash: "hash-live", managed_credential_id: "cred_live",
      operation_id: "op_1", status: "active", committed_micro: 0, pending_from_micro: null,
      pending_to_micro: null, pending_idem: null, attempts: 0, last_error: null, created_at: 1, superseded_at: null,
    });
    const { spy, calls } = makeFetch();
    vi.stubGlobal("fetch", spy);

    await disableManagedBilling(makeEnv(db), orgId);

    expect(calls.find((c) => c.method === "DELETE" && c.url.includes("/keys/"))).toBeTruthy(); // OR key deleted
    expect(calls.find((c) => c.method === "DELETE" && c.url.includes("/internal/managed-credential"))).toBeTruthy(); // credential revoked
    expect(db.keys.length).toBe(0); // rows dropped
    expect(db.orgs.get(orgId)!.model_billing_status).toBe("off"); // flipped off
  });

  it("is a no-op-safe toggle when nothing is provisioned", async () => {
    const db = new FakeDb();
    const orgId = seedOrg(db, { model_billing_status: "off" });
    const { spy } = makeFetch();
    vi.stubGlobal("fetch", spy);
    await disableManagedBilling(makeEnv(db), orgId);
    expect(db.orgs.get(orgId)!.model_billing_status).toBe("off");
  });
});
