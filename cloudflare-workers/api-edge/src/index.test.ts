import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const orgID = "org-1";
const userID = "user-1";
const cellID = "azure-us-east-2-a";

class FakeStatement {
  constructor(private sql: string) {}

  bind(..._args: unknown[]) {
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
    return null;
  }

  async run() {
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
