import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const orgID = "org-1";
const userID = "user-1";
const cellID = "azure-us-east-2-a";

const sandboxIndexInserts: unknown[][] = [];

class FakeStatement {
  constructor(private sql: string) {}

  private args: unknown[] = [];

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM api_keys")) {
      return { org_id: orgID, created_by: userID, expires_at: null } as T;
    }
    if (this.sql.includes("FROM sandboxes_index") && this.sql.includes("SELECT cell_id, org_id")) {
      return { cell_id: cellID, org_id: orgID } as T;
    }
    if (this.sql.includes("FROM cells WHERE cell_id")) {
      return {
        cell_id: cellID,
        cloud: "azure",
        region: "us-east-2",
        base_url: "https://cp-us-east-2.opencomputer.dev",
        status: "active",
        available_workers: 1,
        capacity_updated_at: Math.floor(Date.now() / 1000),
      } as T;
    }
    if (this.sql.includes("SELECT plan FROM orgs")) {
      return { plan: "pro" } as T;
    }
    if (this.sql.includes("SELECT home_cell, plan, is_halted")) {
      return {
        home_cell: cellID,
        plan: "pro",
        is_halted: 0,
        max_concurrent_sandboxes: 10,
        max_disk_mb: 262144,
      } as T;
    }
    if (this.sql.includes("COUNT(*) AS n FROM sandboxes_index")) {
      return { n: 0 } as T;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("FROM cells WHERE status = 'active'")) {
      return {
        results: [
          {
            cell_id: cellID,
            cloud: "azure",
            region: "us-east-2",
            base_url: "https://cp-us-east-2.opencomputer.dev",
            status: "active",
            available_workers: 1,
            capacity_updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      } as { results: T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes("INSERT OR REPLACE INTO sandboxes_index")) {
      sandboxIndexInserts.push(this.args);
    }
    return {};
  }
}

const env = {
  OPENCOMPUTER_DB: {
    prepare(sql: string) {
      return new FakeStatement(sql);
    },
  },
  SESSIONS_KV: {},
  CREDIT_ACCOUNT: {},
  SESSION_JWT_SECRET: "test-secret",
  WORKOS_API_KEY: "",
  WORKOS_CLIENT_ID: "",
  STRIPE_API_KEY: "",
  WORKER_ENV: "test",
  CF_ADMIN_SECRET: "",
  STRIPE_WEBHOOK_SECRET: "",
  EVENT_SECRET: "",
  SECRET_ENCRYPTION_KEY: "",
} as unknown as Env;

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe("api-edge WebSocket auth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sandboxIndexInserts.length = 0;
  });

  it("accepts api_key query auth for sandbox WebSocket proxy requests", async () => {
    const fetchSpy = vi.fn(async (_req: Request) => new Response("proxied", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/sandboxes/sb-123/exec/es-123?api_key=osb_test&stream=1",
        {
          headers: {
            Upgrade: "websocket",
          },
        },
      ),
      env,
      ctx,
    );

    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const forwarded = fetchSpy.mock.calls[0][0] as Request;
    const forwardedURL = new URL(forwarded.url);
    expect(forwardedURL.origin).toBe("https://cp-us-east-2.opencomputer.dev");
    expect(forwardedURL.pathname).toBe("/api/sandboxes/sb-123/exec/es-123");
    expect(forwardedURL.searchParams.get("stream")).toBe("1");
    expect(forwardedURL.searchParams.has("api_key")).toBe(false);
    expect(forwarded.headers.get("authorization")).toMatch(/^Bearer /);
    expect(forwarded.headers.get("x-api-key")).toBeNull();
  });

  it("does not accept api_key query auth for non-WebSocket HTTP requests", async () => {
    const fetchSpy = vi.fn(async (_req: Request) => new Response("proxied", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/api/sandboxes/sb-123/exec/es-123?api_key=osb_test"),
      env,
      ctx,
    );

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: "missing or invalid API key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strips api_key query params from proxied HTTP requests authenticated by header", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("proxied", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/sandboxes/sb-123/exec?api_key=osb_query&stream=1",
        {
          headers: {
            "X-API-Key": "osb_header",
          },
        },
      ),
      env,
      ctx,
    );

    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const forwardedURL = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(forwardedURL.origin).toBe("https://cp-us-east-2.opencomputer.dev");
    expect(forwardedURL.pathname).toBe("/api/sandboxes/sb-123/exec");
    expect(forwardedURL.searchParams.get("stream")).toBe("1");
    expect(forwardedURL.searchParams.has("api_key")).toBe(false);

    const forwardedHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(forwardedHeaders.get("authorization")).toMatch(/^Bearer /);
    expect(forwardedHeaders.get("x-api-key")).toBeNull();
  });

  it("rejects WebSocket proxy requests without header or query auth", async () => {
    const fetchSpy = vi.fn(async (_req: Request) => new Response("proxied", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/sandboxes/sb-123/exec/es-123",
        {
          headers: {
            Upgrade: "websocket",
          },
        },
      ),
      env,
      ctx,
    );

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: "missing or invalid API key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("api-edge sandbox create", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sandboxIndexInserts.length = 0;
  });

  it("indexes SSE snapshot creates before the streamed response completes", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      const body = [
        "event: build_log",
        'data: {"message":"creating"}',
        "",
        "event: result",
        'data: {"sandboxID":"sb-sse1234","workerID":"worker-1","status":"running","memoryMB":2048}',
        "",
      ].join("\n");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/api/sandboxes", {
        method: "POST",
        headers: {
          "X-API-Key": "osb_test",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ snapshot: "snapshot-1", memoryMB: 1024 }),
      }),
      env,
      ctx,
    );

    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("event: result");
    expect(sandboxIndexInserts).toHaveLength(1);
    expect(sandboxIndexInserts[0]).toEqual([
      "sb-sse1234",
      orgID,
      userID,
      cellID,
      "worker-1",
      "running",
      0,
      2048,
      expect.any(Number),
    ]);
  });
});

// The scoped-secret boundary added so sessions-api can ensure-provision Managed at
// agent-create without holding the broad CF_ADMIN_SECRET. Asserts the auth gate only
// (provisioning itself isn't exercised: getOrg → null → 500, which is still ≠ 401).
describe("/internal/model-billing/enable — scoped-secret auth boundary", () => {
  const ADMIN = "admin-secret";
  const MANAGED = "managed-secret";
  const authEnv = { ...env, CF_ADMIN_SECRET: ADMIN, OC_MANAGED_CRED_HMAC_SECRET: MANAGED } as unknown as Env;
  // HMAC-SHA256 hex via Web Crypto — mirrors the edge's hmacHex (node:crypto isn't in the
  // Worker tsconfig).
  const sign = async (secret: string, ts: string, body: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const post = async (path: string, secret: string, o: { ts?: string; sig?: string } = {}) => {
    const body = JSON.stringify({ org_id: "org-x" });
    const ts = o.ts ?? Math.floor(Date.now() / 1000).toString();
    const sig = o.sig ?? (await sign(secret, ts, body));
    return worker.fetch(
      new Request(`https://app.opencomputer.dev${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Timestamp": ts, "X-Signature": sig },
        body,
      }),
      authEnv,
      ctx,
    );
  };

  // Belt: if auth ever passes through to provisioning, fail fast instead of hitting the net.
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 }))));

  it("managed secret authorizes enable (passes auth → not 401)", async () => {
    expect((await post("/internal/model-billing/enable", MANAGED)).status).not.toBe(401);
  });
  it("managed secret CANNOT call disable → 401", async () => {
    expect((await post("/internal/model-billing/disable", MANAGED)).status).toBe(401);
  });
  it("admin secret authorizes enable and disable (not 401)", async () => {
    expect((await post("/internal/model-billing/enable", ADMIN)).status).not.toBe(401);
    expect((await post("/internal/model-billing/disable", ADMIN)).status).not.toBe(401);
  });
  it("wrong signature → 401", async () => {
    expect((await post("/internal/model-billing/enable", MANAGED, { sig: "deadbeef" })).status).toBe(401);
  });
  it("stale timestamp → 401", async () => {
    const stale = (Math.floor(Date.now() / 1000) - 600).toString();
    expect((await post("/internal/model-billing/enable", MANAGED, { ts: stale })).status).toBe(401);
  });
});
