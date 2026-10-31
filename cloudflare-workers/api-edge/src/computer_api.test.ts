// The computer's session API at the edge (work 084): which routes are open,
// what the assertion says about the key, the wire Worker for workspace files,
// CORS, and telling blue about created and revoked keys.
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index";
import { hashAPIKey } from "./api_keys";
import { computerApiFamily, isComputerApiRoute } from "./computer_api";
import { computerApiRouteFamily } from "./computer_telemetry";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://app.opencomputer.dev";
const BLUE = "https://managedagents.test";
const WIRE = "https://wire.test";

interface KeyRow {
  id: string;
  name: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private readonly db: FakeDB,
    private readonly sql: string,
  ) {}
  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    this.db.reads.push({ sql: this.sql, args: this.args });
    if (this.sql.includes("FROM api_keys k")) {
      const row = this.db.keys.get(String(this.args[0]));
      if (!row) return null;
      return {
        org_id: ORG,
        created_by: USER,
        expires_at: row.expires_at,
        session_key: null,
        key_id: row.id,
        key_hash: this.args[0],
        key_name: row.name,
        key_scopes: row.scopes,
        key_created_at: row.created_at,
        user_name: "Igor",
        user_email: "igor@example.com",
        role: "admin",
      } as T;
    }
    if (this.sql.includes("SELECT role FROM org_memberships")) {
      return { role: "owner" } as T;
    }
    if (this.sql.includes("SELECT id FROM api_keys WHERE key_hash")) {
      const row = this.db.keys.get(String(this.args[0]));
      return (row ? { id: row.id } : null) as T | null;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    this.db.executed.push({ sql: this.sql, args: this.args });
    return { meta: { changes: 1 } };
  }
}

class FakeDB {
  keys = new Map<string, KeyRow>();
  reads: { sql: string; args: unknown[] }[] = [];
  executed: { sql: string; args: unknown[] }[] = [];
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
  async batch(stmts: FakeStatement[]) {
    return Promise.all(stmts.map((s) => s.run()));
  }
}

function testEnv(db: FakeDB, extra: Partial<Record<string, unknown>> = {}): Env {
  return {
    OPENCOMPUTER_DB: db,
    SESSIONS_KV: {},
    CREDIT_ACCOUNT: {},
    SESSION_JWT_SECRET: "test-session-secret",
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    STRIPE_API_KEY: "",
    WORKER_ENV: "test",
    CF_ADMIN_SECRET: "",
    STRIPE_WEBHOOK_SECRET: "",
    EVENT_SECRET: "",
    SECRET_ENCRYPTION_KEY: "",
    MANAGED_AGENTS_API_URL: BLUE,
    OC_MANAGED_AGENTS_SECRET: "assert-secret",
    WIRE_HTTP_URL: WIRE,
    COMPUTER_ENABLED_FOR_ALL: "true",
    ...extra,
  } as unknown as Env;
}

function testCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

let keySeq = 0;
// The isolate's auth cache outlives a test, so every test gets its own key.
async function addKey(db: FakeDB, overrides: Partial<KeyRow> = {}): Promise<string> {
  keySeq += 1;
  const key = `osb_test_${keySeq}_${crypto.randomUUID().replace(/-/g, "")}`;
  db.keys.set(await hashAPIKey(key), {
    id: `key-${keySeq}`,
    name: "laptop",
    scopes: "sandbox:*,computer:read",
    created_at: 1_790_000_000,
    expires_at: null,
    ...overrides,
  });
  return key;
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sessionCookie(secret = "test-session-secret"): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const input =
    b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))) +
    "." +
    b64url(
      enc.encode(
        JSON.stringify({
          iss: "opensandbox-session",
          sub: USER,
          iat: now,
          exp: now + 3600,
          org_id: ORG,
          user_id: USER,
          plan: "free",
        }),
      ),
    );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `oc_session=${input}.${b64url(sig)}`;
}

// An act-as-org provisioning token (sessions-api): the project-scoped credential.
async function provisionToken(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const input =
    b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))) +
    "." +
    b64url(
      enc.encode(
        JSON.stringify({
          iss: "sessions-api",
          aud: "opencomputer-api",
          scope: "sandbox-provision",
          org_id: ORG,
          iat: now,
          exp: now + 600,
        }),
      ),
    );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(
    atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
  ) as Record<string, unknown>;
}

function api(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}/api/managed-agents/computer${path}`, init);
}

function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call] as [string | URL, RequestInit];
  return { url: String(url), init, headers: new Headers(init.headers) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("computer API allowlist", () => {
  it.each([
    ["GET", "/computer/me"],
    ["POST", "/computer/tickets"],
    ["GET", "/computer/sessions"],
    ["POST", "/computer/sessions"],
    ["GET", "/computer/sessions/cs_01h"],
    ["PATCH", "/computer/sessions/cs_01h"],
    ["GET", "/computer/sessions/cs_01h/capabilities"],
    ["POST", "/computer/sessions/cs_01h/interrupt"],
    ["POST", "/computer/sessions/cs_01h/compact"],
    ["POST", "/computer/sessions/cs_01h/suspend"],
    ["POST", "/computer/sessions/cs_01h/resume"],
    ["GET", "/computer/sessions/cs_01h/turns"],
    ["POST", "/computer/sessions/cs_01h/turns"],
    ["GET", "/computer/sessions/cs_01h/turns/tn_1"],
    ["POST", "/computer/sessions/cs_01h/turns/tn_1/cancel"],
    ["GET", "/computer/sessions/cs_01h/events"],
    ["GET", "/computer/sessions/cs_01h/asks"],
    ["GET", "/computer/sessions/cs_01h/asks/toolu_1"],
    ["POST", "/computer/sessions/cs_01h/asks/toolu_1/answer"],
    ["POST", "/computer/sessions/cs_01h/asks/toolu_1/dismiss"],
    ["GET", "/computer/sessions/cs_01h/subagents"],
    ["GET", "/computer/sessions/cs_01h/subagents/sa_01h"],
    ["POST", "/computer/sessions/cs_01h/subagents/sa_01h/stop"],
    ["GET", "/computer/secrets"],
    ["PUT", "/computer/sessions/cs_01h/secrets/API_KEY"],
    ["DELETE", "/computer/me/secrets/API_KEY"],
    ["PUT", "/computer/organization/secrets/API_KEY"],
    ["GET", "/computer/service-connections"],
    ["POST", "/computer/service-connections"],
    ["DELETE", "/computer/service-connections"],
    ["GET", "/computer/sessions/cs_01h/workspace/archive"],
    ["PUT", "/computer/sessions/cs_01h/workspace/archive"],
    ["GET", "/computer/sessions/cs_01h/workspace/file"],
    ["GET", "/computer/sessions/cs_01h/workspace/files"],
  ])("allows %s %s", (method, suffix) => {
    expect(isComputerApiRoute(method, suffix)).toBe(true);
  });

  it.each([
    // Blue's internal key sync is the edge's to call, never a client's.
    ["POST", "/computer/keys/sync"],
    ["POST", "/computer/keys/revoke"],
    ["DELETE", "/computer/sessions/cs_01h"],
    ["PUT", "/computer/sessions/cs_01h/workspace/file"],
    ["POST", "/computer/sessions/cs_01h/turns/tn_1"],
    ["GET", "/computer/sessions/../me"],
    ["GET", "/computer/sessions/.hidden"],
    ["GET", "/computer/sessions/a%2Fb"],
    ["GET", "/computer/sessions/cs_01h/unknown"],
    ["POST", "/computer/slack/install"],
    ["PUT", "/computer/service-connections"],
  ])("refuses %s %s", (method, suffix) => {
    expect(isComputerApiRoute(method, suffix)).toBe(false);
  });

  it("serves the API mount only", () => {
    expect(computerApiFamily.apiOnly).toBe(true);
    expect(computerApiFamily.dashboardOnly).toBe(false);
  });

  it("answers 404 in the documented shape and never calls blue for an unlisted route", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/keys/sync", { method: "POST", headers: { "x-api-key": key }, body: "{}" }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "not_found", retryable: false });
    expect(String(body.error.requestId)).toMatch(/^req_[0-9a-z]{16}$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 unauthenticated without a credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(api("/me"), testEnv(new FakeDB()), testCtx().ctx);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 when x-api-key and Bearer name different keys", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const res = await worker.fetch(
      api("/me", { headers: { "x-api-key": key, authorization: "Bearer osb_other" } }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.status).toBe(401);
  });

  it("answers 404 to an organization the computer is not rolled out to", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/me", { headers: { "x-api-key": key } }),
      testEnv(db, { COMPUTER_ENABLED_FOR_ALL: undefined, COMPUTER_ENABLED_ORGS: "org_other" }),
      testCtx().ctx,
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a project-scoped credential with 403 project_key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const token = await provisionToken("provision-secret");
    const res = await worker.fetch(
      api("/me", { headers: { authorization: `Bearer ${token}` } }),
      testEnv(new FakeDB(), { OC_PROVISION_SECRET: "provision-secret" }),
      testCtx().ctx,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "forbidden", reason: "project_key", retryable: false });
    expect(body.error.message).toEqual(expect.any(String));
    expect(body.error.requestId).toMatch(/^req_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a key's missing scope to blue, passing its 403 through", async () => {
    const db = new FakeDB();
    const key = await addKey(db, { scopes: "sandbox:*" });
    const refusal = {
      error: { code: "forbidden", reason: "missing_scope", message: "Needs computer:write.", requestId: "req_blue", retryable: false },
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(refusal, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{}" }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(refusal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("computer API rate limit", () => {
  it("limits per key id and answers 429 with Retry-After and retryAfterMs", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const limit = vi.fn().mockResolvedValue({ success: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/me", { headers: { "x-api-key": key } }),
      testEnv(db, { COMPUTER_API_RATE_LIMIT: { limit } }),
      testCtx().ctx,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 60_000 });
    expect(body.error.requestId).toMatch(/^req_/);
    expect(limit).toHaveBeenCalledWith({ key: db.keys.get(await hashAPIKey(key))!.id });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a key under the limit, and fails open when the limiter errors", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    for (const limit of [
      vi.fn().mockResolvedValue({ success: true }),
      vi.fn().mockRejectedValue(new Error("limiter down")),
    ]) {
      const res = await worker.fetch(
        api("/me", { headers: { "x-api-key": key } }),
        testEnv(db, { COMPUTER_API_RATE_LIMIT: { limit } }),
        testCtx().ctx,
      );
      expect(res.status).toBe(200);
      expect(limit).toHaveBeenCalledTimes(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not count dashboard sessions", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    const res = await worker.fetch(
      api("/me", { headers: { cookie: await sessionCookie() } }),
      testEnv(new FakeDB(), { COMPUTER_API_RATE_LIMIT: { limit } }),
      testCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("computer API proxy to blue", () => {
  it("forwards a key's call to /v1/computer with key claims, headers both ways", async () => {
    const db = new FakeDB();
    const key = await addKey(db, { expires_at: 1_800_000_000 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"sessions":[],"nextCursor":null}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "server-timing": "blue;dur=3",
          "x-request-id": "req_0123456789abcdef",
          "x-opc-latest": "0.9.0",
          etag: '"v1"',
          "retry-after": "1",
          "set-cookie": "nope=1",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions?limit=5", {
        headers: {
          authorization: `Bearer ${key}`,
          "idempotency-key": "idem-1",
          "user-agent": "opc/0.9.0",
          "x-request-id": "client-req-1",
          "if-none-match": '"v0"',
          "x-opencomputer-surface": "dashboard",
          "x-opencomputer-agent-token": "forged",
        },
      }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [], nextCursor: null });
    for (const [name, value] of [
      ["server-timing", "blue;dur=3"],
      ["x-request-id", "req_0123456789abcdef"],
      ["x-opc-latest", "0.9.0"],
      ["etag", '"v1"'],
      ["retry-after", "1"],
    ]) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(res.headers.get("set-cookie")).toBeNull();

    const { url, headers } = sent(fetchMock);
    expect(url).toBe(`${BLUE}/v1/computer/sessions?limit=5`);
    expect(headers.get("idempotency-key")).toBe("idem-1");
    expect(headers.get("user-agent")).toBe("opc/0.9.0");
    expect(headers.get("x-request-id")).toBe("client-req-1");
    expect(headers.get("if-none-match")).toBe('"v0"');
    // The edge says which contract; a client's own value never passes.
    expect(headers.get("x-opencomputer-surface")).toBe("api");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();

    const payload = claims(headers.get("x-opencomputer-agent-token") ?? "");
    expect(payload).toMatchObject({
      iss: "opencomputer-edge",
      aud: "managedagents",
      org_id: ORG,
      user_id: USER,
      role: "admin",
      key_id: `key-${keySeq}`,
      key_hash: await hashAPIKey(key),
      key_name: "laptop",
      key_kind: "user",
      key_scopes: ["sandbox:*", "computer:read"],
      key_expires_at: new Date(1_800_000_000 * 1000).toISOString(),
      key_created_at: new Date(1_790_000_000 * 1000).toISOString(),
      user_name: "Igor",
      user_email: "igor@example.com",
    });
    expect(JSON.stringify(payload)).not.toContain(key);
  });

  it("puts key_expires_at null on a key that never expires", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await worker.fetch(api("/me", { headers: { "x-api-key": key } }), testEnv(db), testCtx().ctx);
    const payload = claims(sent(fetchMock).headers.get("x-opencomputer-agent-token") ?? "");
    expect(payload.key_expires_at).toBeNull();
    expect(Object.hasOwn(payload, "key_expires_at")).toBe(true);
  });

  it("lets blue mint the request id when the client sent none", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await worker.fetch(api("/me", { headers: { "x-api-key": key } }), testEnv(db), testCtx().ctx);
    expect(sent(fetchMock).headers.get("x-request-id")).toBeNull();
  });

  it("asserts a dashboard session with no key claims", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sessions: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions", { headers: { cookie: await sessionCookie() } }),
      testEnv(new FakeDB()),
      testCtx().ctx,
    );
    expect(res.status).toBe(200);
    const { url, headers } = sent(fetchMock);
    expect(url).toBe(`${BLUE}/v1/computer/sessions`);
    expect(headers.get("x-opencomputer-surface")).toBe("api");
    const payload = claims(headers.get("x-opencomputer-agent-token") ?? "");
    expect(payload).toMatchObject({ org_id: ORG, user_id: USER, role: "admin" });
    for (const claim of Object.keys(payload)) {
      expect(claim.startsWith("key_")).toBe(false);
    }
    expect(payload.user_name).toBeUndefined();
    expect(payload.user_email).toBeUndefined();
  });

  it("refuses a cookie's unsafe call from another origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions", {
        method: "POST",
        headers: { cookie: await sessionCookie(), origin: "https://evil.sb.opencomputer.dev" },
        body: "{}",
      }),
      testEnv(new FakeDB()),
      testCtx().ctx,
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams a long-poll body both ways", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const encoder = new TextEncoder();
    let pushLater!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"turn.started"}\n'));
        pushLater = () => {
          controller.enqueue(encoder.encode('{"type":"turn.completed"}\n'));
          controller.close();
        };
      },
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(ReadableStream);
      return new Response(upstreamBody, { headers: { "content-type": "application/x-ndjson" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions/cs_1/turns", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('{"input":"hi"}'));
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
      testEnv(db),
      testCtx().ctx,
    );
    const reader = res.body!.getReader();
    // The first event arrives before upstream has finished.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('{"type":"turn.started"}\n');
    pushLater();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('{"type":"turn.completed"}\n');
  });

  it("returns a 304 with no body", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"v1"' } })));
    const res = await worker.fetch(
      api("/sessions/cs_1", { headers: { "x-api-key": key, "if-none-match": '"v1"' } }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"');
  });

  it("keeps the dashboard mount's computer list on the dashboard family", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/dashboard/managed-agents/computer/sessions`, {
        headers: { cookie: await sessionCookie(), "x-opencomputer-surface": "api" },
      }),
      testEnv(new FakeDB()),
      testCtx().ctx,
    );
    expect(res.status).toBe(200);
    const { url, headers } = sent(fetchMock);
    expect(url).toBe(`${BLUE}/v1/computer/sessions`);
    expect(headers.get("x-opencomputer-surface")).toBeNull();
  });
});

describe("workspace files go to the wire Worker", () => {
  it("forwards the caller's own Authorization and streams the archive up and down", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(ReadableStream);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/x-tar", etag: '"a"', "x-request-id": "req_x" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions/cs_1/workspace/archive?path=src", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/x-tar",
          "content-encoding": "gzip",
          "idempotency-key": "idem-2",
          "x-request-id": "client-2",
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([9, 9]));
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.headers.get("etag")).toBe('"a"');
    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe(`${WIRE}/v1/sessions/cs_1/workspace/archive?path=src`);
    expect(init.method).toBe("PUT");
    expect(headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(headers.get("content-type")).toBe("application/x-tar");
    expect(headers.get("content-encoding")).toBe("gzip");
    expect(headers.get("idempotency-key")).toBe("idem-2");
    expect(headers.get("x-request-id")).toBe("client-2");
    expect(headers.get("x-opencomputer-agent-token")).toBeNull();
  });

  it("forwards x-api-key as sent and defaults to wire.opencomputer.dev", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn().mockResolvedValue(new Response("hello"));
    vi.stubGlobal("fetch", fetchMock);
    await worker.fetch(
      api("/sessions/cs_1/workspace/file?path=README.md", { headers: { "x-api-key": key } }),
      testEnv(db, { WIRE_HTTP_URL: undefined }),
      testCtx().ctx,
    );
    const { url, headers } = sent(fetchMock);
    expect(url).toBe("https://wire.opencomputer.dev/v1/sessions/cs_1/workspace/file?path=README.md");
    expect(headers.get("x-api-key")).toBe(key);
  });

  it("forwards accept-encoding so the archive can come back compressed", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "content-type": "application/x-tar", "content-encoding": "zstd" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions/cs_1/workspace/archive", {
        headers: { "x-api-key": key, "accept-encoding": "zstd, gzip" },
      }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(sent(fetchMock).headers.get("accept-encoding")).toBe("zstd, gzip");
    expect(res.headers.get("content-encoding")).toBe("zstd");
  });

  it("refuses a dashboard session with key_required", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions/cs_1/workspace/files", { headers: { cookie: await sessionCookie() } }),
      testEnv(new FakeDB()),
      testCtx().ctx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "forbidden", reason: "key_required", retryable: false });
    expect(body.error.requestId).toMatch(/^req_/);
    expect(body.error.message).toEqual(expect.any(String));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown key before reaching the wire Worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api("/sessions/cs_1/workspace/files", { headers: { "x-api-key": "osb_unknown" } }),
      testEnv(new FakeDB()),
      testCtx().ctx,
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("computer API CORS", () => {
  it("answers a dashboard preflight", async () => {
    const res = await worker.fetch(
      api("/sessions", {
        method: "OPTIONS",
        headers: { origin: ORIGIN, "access-control-request-method": "POST" },
      }),
      testEnv(new FakeDB()),
      testCtx().ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, idempotency-key, x-request-id, if-none-match",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PATCH, PUT, DELETE");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("allows a configured extra origin and ignores others", async () => {
    const env = testEnv(new FakeDB(), { COMPUTER_API_CORS_ORIGINS: "https://dash.example.com" });
    const ok = await worker.fetch(
      api("/me", { method: "OPTIONS", headers: { origin: "https://dash.example.com" } }),
      env,
      testCtx().ctx,
    );
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
    const no = await worker.fetch(
      api("/me", { method: "OPTIONS", headers: { origin: "https://evil.example.com" } }),
      env,
      testCtx().ctx,
    );
    expect(no.status).toBe(204);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("exposes the API's headers on responses", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { headers: { "server-timing": "x;dur=1" } })));
    const res = await worker.fetch(
      api("/me", { headers: { "x-api-key": key, origin: ORIGIN } }),
      testEnv(db),
      testCtx().ctx,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "server-timing, x-request-id, x-opc-latest, retry-after, etag",
    );
    expect(res.headers.get("server-timing")).toBe("x;dur=1");
  });
});

describe("key create and revoke tell blue", () => {
  it("syncs a dashboard-created key by hash, never the key", async () => {
    const db = new FakeDB();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/dashboard/api-keys`, {
        method: "POST",
        headers: { cookie: await sessionCookie(), "content-type": "application/json" },
        body: JSON.stringify({ name: "ci" }),
      }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string; createdAt: string };
    await settle();
    const syncCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/computer/keys/sync"));
    expect(syncCalls).toHaveLength(1);
    const init = syncCalls[0][1] as RequestInit;
    expect(String(syncCalls[0][0])).toBe(`${BLUE}/v1/computer/keys/sync`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      key: {
        id: created.id,
        hash: await hashAPIKey(created.key),
        name: "ci",
        kind: "user",
        scopes: ["sandbox:*"],
        expiresAt: null,
        createdAt: created.createdAt,
        userId: USER,
      },
    });
    expect(String(init.body)).not.toContain(created.key);
    const token = claims(new Headers(init.headers).get("x-opencomputer-agent-token") ?? "");
    expect(token).toMatchObject({ org_id: ORG, user_id: USER, aud: "managedagents" });
  });

  it("reports a dashboard revoke by key id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/dashboard/api-keys/key-9`, {
        method: "DELETE",
        headers: { cookie: await sessionCookie() },
      }),
      testEnv(new FakeDB()),
      ctx,
    );
    expect(res.status).toBe(204);
    await settle();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BLUE}/v1/computer/keys/revoke`);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ keyId: "key-9" });
  });

  it("reports a CLI revoke by key id", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/auth/cli/credential`, { method: "DELETE", headers: { "x-api-key": key } }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(204);
    await settle();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BLUE}/v1/computer/keys/revoke`);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ keyId: `key-${keySeq}` });
  });

  it("keeps the revoke when blue fails, and logs it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/dashboard/api-keys/key-9`, {
        method: "DELETE",
        headers: { cookie: await sessionCookie() },
      }),
      testEnv(new FakeDB()),
      ctx,
    );
    expect(res.status).toBe(204);
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("computer_keys.revoke_failed"));
  });

  it("skips the sync without MANAGED_AGENTS_API_URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/dashboard/api-keys`, {
        method: "POST",
        headers: { cookie: await sessionCookie(), "content-type": "application/json" },
        body: "{}",
      }),
      testEnv(new FakeDB(), { MANAGED_AGENTS_API_URL: undefined }),
      ctx,
    );
    expect(res.status).toBe(201);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("computer API telemetry: one edge.request per call", () => {
  const TB = "https://tb.test";
  const SID = "cs_0123456789abcdef";
  const tbEnv = (db: FakeDB, extra: Partial<Record<string, unknown>> = {}) =>
    testEnv(db, {
      TINYBIRD_API_URL: TB,
      TINYBIRD_APPEND_TOKEN: "p.test-append",
      CF_VERSION_METADATA: { id: "v-123" },
      ...extra,
    });

  /** Blue answers with its Server-Timing; Tinybird's POSTs are collected. */
  function stubFetch(blue: () => Response = () =>
    Response.json({ ok: true }, { headers: { "server-timing": "blue;dur=12.6" } })) {
    const lines: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith(TB)) {
        expect(String(url)).toBe(`${TB}/v0/events?name=calvin_events&wait=false`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer p.test-append");
        for (const l of String(init?.body).split("\n")) lines.push(JSON.parse(l));
        return new Response("{}", { status: 202 });
      }
      return blue();
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, lines };
  }

  const dataOf = (line: Record<string, unknown>) => JSON.parse(String(line.data)) as Record<string, unknown>;

  it("reports a proxied call: route family, status, upstream, blue_ms, ids only, via waitUntil", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const { lines } = stubFetch();
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(
      api(`/sessions/${SID}/events?after=ev_1&wait=30`, { headers: { "x-api-key": key, "user-agent": "opc/1.2.3" } }),
      tbEnv(db),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalled(); // off the response path
    await settle();
    expect(lines).toHaveLength(1);
    const [e] = lines;
    expect(e).toMatchObject({
      schema_version: 1,
      event_name: "edge.request",
      service_name: "edge",
      service_version: "v-123",
      surface: "cli",
      session_key: SID,
      org_id: ORG,
      outcome: "completed",
      synthetic: false,
    });
    expect(typeof e.duration_ms).toBe("number");
    expect(dataOf(e)).toEqual({
      route: "events",
      method: "GET",
      status: 200,
      upstream: "blue",
      auth: "ok",
      via: "key",
      rate_limited: false,
      blue_ms: 13,
      key_id: db.keys.get(await hashAPIKey(key))!.id,
    });
    // Data policy: no paths, query strings, key secrets, user agents or IPs.
    const text = JSON.stringify(e);
    expect(text).not.toContain(key);
    expect(text).not.toContain("/");
    expect(text).not.toContain("ev_1");
    expect(text).not.toContain("opc/1.2.3");
  });

  it.each([
    ["missing", {}, 401],
    ["invalid", { "x-api-key": "osb_nope" }, 401],
    ["conflicting", { "x-api-key": "osb_a", authorization: "Bearer osb_b" }, 401],
  ] as const)("classes a refused caller: %s", async (auth, headers, status) => {
    const { lines } = stubFetch();
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(api("/me", { headers }), tbEnv(new FakeDB()), ctx);
    expect(res.status).toBe(status);
    await settle();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "failed", error_code: String(status) });
    expect(lines[0]).not.toHaveProperty("org_id");
    expect(dataOf(lines[0])).toMatchObject({ route: "me", status, upstream: "edge", auth, rate_limited: false });
  });

  it("marks a rate-limited key", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const { lines } = stubFetch();
    const { ctx, settle } = testCtx();
    const limit = vi.fn().mockResolvedValue({ success: false });
    const res = await worker.fetch(
      api("/sessions", { headers: { "x-api-key": key } }),
      tbEnv(db, { COMPUTER_API_RATE_LIMIT: { limit } }),
      ctx,
    );
    expect(res.status).toBe(429);
    await settle();
    expect(dataOf(lines[0])).toMatchObject({ route: "sessions", status: 429, upstream: "edge", auth: "ok", rate_limited: true });
  });

  it("names a dashboard call that needs a key, and the wire Worker as upstream", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const { lines } = stubFetch(() => new Response("x", { status: 200 }));
    const cookie = await sessionCookie();
    let t = testCtx();
    await worker.fetch(api(`/sessions/${SID}/workspace/file?path=a`, { headers: { cookie } }), tbEnv(db), t.ctx);
    await t.settle();
    t = testCtx();
    await worker.fetch(api(`/sessions/${SID}/workspace/file?path=a`, { headers: { "x-api-key": key } }), tbEnv(db), t.ctx);
    await t.settle();
    expect(lines.map(dataOf)).toEqual([
      expect.objectContaining({ route: "workspace", status: 403, auth: "key_required", via: "dashboard", upstream: "edge" }),
      expect.objectContaining({ route: "workspace", status: 200, auth: "ok", via: "key", upstream: "wire" }),
    ]);
    expect(dataOf(lines[1])).not.toHaveProperty("blue_ms");
  });

  it("sends nothing when Tinybird is not configured", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    const { fetchMock, lines } = stubFetch();
    const { ctx, settle } = testCtx();
    await worker.fetch(api("/me", { headers: { "x-api-key": key } }), testEnv(db), ctx);
    await worker.fetch(api("/me", { headers: { "x-api-key": key } }), tbEnv(db, { TINYBIRD_APPEND_TOKEN: " " }), ctx);
    await settle();
    expect(lines).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2); // blue only
  });

  it("never fails the call when Tinybird does", async () => {
    const db = new FakeDB();
    const key = await addKey(db);
    let tbCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith(TB)) {
          tbCalls += 1;
          throw new Error("down");
        }
        return Response.json({ ok: true });
      }),
    );
    const { ctx, settle } = testCtx();
    const res = await worker.fetch(api("/me", { headers: { "x-api-key": key } }), tbEnv(db), ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(tbCalls).toBe(2); // one retry, then dropped
  });

  it("maps every documented route to a family", () => {
    expect(
      [
        "/computer/me",
        "/computer/tickets",
        "/computer/sessions",
        `/computer/sessions/${SID}`,
        `/computer/sessions/${SID}/capabilities`,
        `/computer/sessions/${SID}/interrupt`,
        `/computer/sessions/${SID}/turns/tn_1/cancel`,
        `/computer/sessions/${SID}/events`,
        `/computer/sessions/${SID}/asks/toolu_1/answer`,
        `/computer/sessions/${SID}/subagents`,
        "/computer/secrets",
        "/computer/me/secrets/X",
        "/computer/organization/secrets/X",
        `/computer/sessions/${SID}/secrets/X`,
        `/computer/sessions/${SID}/workspace/archive`,
        "/computer/nope",
      ].map(computerApiRouteFamily),
    ).toEqual([
      "me", "tickets", "sessions", "sessions", "sessions", "control", "turns", "events", "asks",
      "subagents", "secrets", "secrets", "secrets", "secrets", "workspace", "other",
    ]);
  });
});
