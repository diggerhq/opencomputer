import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const userID = "11111111-1111-4111-8111-111111111111";
const orgID = "22222222-2222-4222-8222-222222222222";

interface CapturedStatement {
  sql: string;
  args: unknown[];
}

interface FakeMembership {
  id: string;
  name: string;
  plan: string;
  is_personal: number;
  workos_org_id: string | null;
  membership_created_at: number;
  org_created_at: number;
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
    if (this.sql.includes("FROM users WHERE workos_user_id")) {
      if (!this.db.user) return null;
      return this.db.user as T;
    }
    if (this.sql.includes("FROM api_keys WHERE key_hash")) {
      return { org_id: orgID, created_by: userID, expires_at: null } as T;
    }
    if (this.sql.includes("SELECT o.name AS org_name")) {
      return { org_name: "Igor's workspace", email: "igor@example.com" } as T;
    }
    if (this.sql.includes("JOIN org_memberships") && this.sql.includes("LIMIT 1")) {
      return (this.db.memberships[0] ?? null) as T | null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("JOIN org_memberships")) {
      return { results: this.db.memberships as T[] };
    }
    if (this.sql.includes("FROM cells") && this.sql.includes("accepts_new_orgs = 1")) {
      return {
        results: [{
          cell_id: "azure-us-east-2-a",
          region: "us-east-2",
        } as T],
      };
    }
    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    this.db.executed.push({ sql: this.sql, args: this.args });
    if (this.sql.includes("INSERT INTO users")) {
      this.db.user = {
        id: String(this.args[0]),
        email: String(this.args[1]),
        name: String(this.args[3]),
      };
    }
    return {};
  }
}

class FakeDB {
  executed: CapturedStatement[] = [];
  memberships: FakeMembership[];
  user: { id: string; email: string; name: string } | null;

  constructor(
    memberships?: FakeMembership[],
    user: { id: string; email: string; name: string } | null = {
      id: userID,
      email: "igor@example.com",
      name: "Igor",
    },
  ) {
    this.memberships = memberships ?? [{
      id: orgID,
      name: "Igor's workspace",
      plan: "free",
      is_personal: 1,
      workos_org_id: null,
      membership_created_at: 1,
      org_created_at: 1,
    }];
    this.user = user;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

function testEnv(db = new FakeDB()): Env {
  return {
    OPENCOMPUTER_DB: db,
    SESSIONS_KV: {},
    CREDIT_ACCOUNT: {},
    CLI_AUTH_START_RATE_LIMIT: {
      limit: vi.fn(async () => ({ success: true })),
    },
    CLI_AUTH_EXCHANGE_RATE_LIMIT: {
      limit: vi.fn(async () => ({ success: true })),
    },
    SESSION_JWT_SECRET: "test-session-secret",
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    STRIPE_API_KEY: "",
    WORKER_ENV: "test",
    CF_ADMIN_SECRET: "",
    STRIPE_WEBHOOK_SECRET: "",
    EVENT_SECRET: "",
    SECRET_ENCRYPTION_KEY: "",
  } as unknown as Env;
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.opencomputer.dev${path}`, init);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CLI device authorization edge contract", () => {
  it("starts authorization with a form request and returns only validated fields", async () => {
    const providerFetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example.com/device",
      verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expires_in: 300,
      interval: 5,
      refresh_token: "must-not-cross-the-edge",
    }));
    vi.stubGlobal("fetch", providerFetch);

    const resp = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }), testEnv(), ctx);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(await resp.json()).toEqual({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example.com/device",
      verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expires_in: 300,
      interval: 5,
    });
    const [, init] = providerFetch.mock.calls[0];
    expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(init?.body).toBe("client_id=client_test");
    expect(init?.redirect).toBe("manual");
  });

  it("rejects provider redirects without forwarding them to the caller", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.example/device" },
    })));

    const resp = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
    }), testEnv(), ctx);

    expect(resp.status).toBe(503);
    expect(resp.headers.has("location")).toBe(false);
    expect(await resp.json()).toEqual({ error: "auth_provider_unavailable" });
    expect(logSpy.mock.calls.flat().join(" ")).toContain('"provider_status":302');
  });

  it("fails closed without exposing a malformed provider response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream-secret", { status: 200 })));
    const resp = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }), testEnv(), ctx);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(await resp.json()).toEqual({ error: "auth_provider_invalid_response" });
  });

  it("rejects a provider response that places the opaque device code in a URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      device_code: "private-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example.com/device",
      verification_uri_complete: "https://auth.example.com/device?device_code=private-device-code",
      expires_in: 300,
      interval: 5,
    })));
    const resp = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }), testEnv(), ctx);
    expect(resp.status).toBe(502);
    expect(await resp.json()).toEqual({ error: "auth_provider_invalid_response" });
  });

  it("rejects wrong methods, bodies, and missing configuration without calling WorkOS", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const wrongMethod = await worker.fetch(
      request("/auth/cli/device", { method: "GET" }),
      testEnv(),
      ctx,
    );
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toEqual({ error: "method_not_allowed" });

    const wrongBody = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), testEnv(), ctx);
    expect(wrongBody.status).toBe(400);
    expect(await wrongBody.json()).toEqual({ error: "invalid_request" });

    const unavailableEnv = testEnv() as Env;
    unavailableEnv.WORKOS_CLIENT_ID = "";
    const unavailable = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }), unavailableEnv, ctx);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.json()).toEqual({ error: "cli_login_unavailable" });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rate-limits start and exchange independently before contacting WorkOS", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const env = testEnv();
    env.CLI_AUTH_START_RATE_LIMIT = {
      limit: vi.fn(async ({ key }) => ({ success: key !== "203.0.113.10" })),
    };

    const start = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env, ctx);
    expect(start.status).toBe(429);
    expect(start.headers.get("retry-after")).toBe("60");
    expect(await start.json()).toEqual({ error: "rate_limited" });

    env.CLI_AUTH_START_RATE_LIMIT = {
      limit: vi.fn(async () => ({ success: true })),
    };
    env.CLI_AUTH_EXCHANGE_RATE_LIMIT = {
      limit: vi.fn(async ({ key }) => ({ success: key !== "203.0.113.10" })),
    };
    const exchange = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ device_code: "opaque", credential_name: "oc CLI" }),
    }), env, ctx);
    expect(exchange.status).toBe(429);
    expect(exchange.headers.get("retry-after")).toBe("60");
    expect(await exchange.json()).toEqual({ error: "rate_limited" });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the CLI auth limiter is unavailable", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const env = testEnv();
    env.CLI_AUTH_START_RATE_LIMIT = {
      limit: vi.fn(async () => {
        throw new Error("limiter unavailable");
      }),
    };
    const resp = await worker.fetch(request("/auth/cli/device", {
      method: "POST",
    }), env, ctx);
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ error: "cli_login_unavailable" });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("bounds a stalled WorkOS request and maps the timeout to 503", async () => {
    vi.useFakeTimers();
    const providerFetch = vi.fn(async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );
    vi.stubGlobal("fetch", providerFetch);

    const responsePromise = worker.fetch(request("/auth/cli/device", {
      method: "POST",
    }), testEnv(), ctx);
    await vi.advanceTimersByTimeAsync(10_000);
    const resp = await responsePromise;
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ error: "auth_provider_unavailable" });
    expect(providerFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("keeps the WorkOS deadline active while reading the provider body", async () => {
    vi.useFakeTimers();
    const providerFetch = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      }))
    );
    vi.stubGlobal("fetch", providerFetch);

    const responsePromise = worker.fetch(request("/auth/cli/device", {
      method: "POST",
    }), testEnv(), ctx);
    await vi.advanceTimersByTimeAsync(10_000);
    const resp = await responsePromise;
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ error: "auth_provider_unavailable" });
    expect(providerFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("logs actionable provider exceptions without logging request credentials", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("failed for client_test and opaque");
    }));

    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "opaque", credential_name: "oc CLI" }),
    }), testEnv(), ctx);

    expect(resp.status).toBe(503);
    const logs = logSpy.mock.calls.flat().join(" ");
    expect(logs).toContain('"provider_error_name":"TypeError"');
    expect(logs).toContain('"provider_error_message":"failed for [redacted] and [redacted]"');
    expect(logs).not.toContain("client_test");
    expect(logs).not.toContain("opaque");
  });

  it.each([
    ["authorization_pending", 202, { status: "authorization_pending", retry_after: 5 }],
    ["slow_down", 202, { status: "authorization_pending", retry_after: 10 }],
    ["access_denied", 403, { error: "authorization_denied" }],
    ["expired_token", 410, { error: "authorization_expired" }],
  ])("maps provider %s without forwarding raw details", async (error, status, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error,
      error_description: "provider detail must remain private",
    }, { status: 400 })));
    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "opaque", credential_name: "oc CLI on test" }),
    }), testEnv(), ctx);
    expect(resp.status).toBe(status);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(await resp.json()).toEqual(expected);
  });

  it("creates one ordinary key while keeping provider tokens and plaintext out of D1", async () => {
    const db = new FakeDB();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const providerFetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      user: {
        id: "workos-user",
        email: "igor@example.com",
        first_name: "Igor",
      },
      access_token: "workos-access-secret",
      refresh_token: "workos-refresh-secret",
    }));
    vi.stubGlobal("fetch", providerFetch);

    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "opaque", credential_name: "oc CLI on test" }),
    }), testEnv(db), ctx);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    const body = await resp.json<{
      status: string;
      credential: { id: string; key: string; key_prefix: string; name: string };
      user: { id: string; email: string; name: string };
      org: { id: string; name: string };
    }>();
    expect(body.status).toBe("authorized");
    expect(body.credential.key).toMatch(/^osb_[0-9a-f]{64}$/);
    expect(body.user).toEqual({ id: userID, email: "igor@example.com", name: "Igor" });
    expect(body.org).toEqual({ id: orgID, name: "Igor's workspace" });
    expect(JSON.stringify(body)).not.toContain("workos-access-secret");
    expect(JSON.stringify(body)).not.toContain("workos-refresh-secret");

    const insert = db.executed.find((entry) => entry.sql.includes("INSERT INTO api_keys"));
    expect(insert).toBeDefined();
    expect(insert?.args[1]).toBe(orgID);
    expect(insert?.args[2]).toBe(userID);
    expect(insert?.args[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(insert?.args).not.toContain(body.credential.key);
    expect(insert?.sql).toContain("'sandbox:*'");
    const [, providerInit] = providerFetch.mock.calls[0];
    const providerForm = new URLSearchParams(String(providerInit?.body));
    expect(providerForm.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(providerForm.get("device_code")).toBe("opaque");
    expect(providerForm.get("client_id")).toBe("client_test");
    expect(providerForm.has("client_secret")).toBe(false);
    expect(providerInit?.redirect).toBe("manual");
    const logs = logSpy.mock.calls.flat().join(" ");
    expect(logs).not.toContain("workos-access-secret");
    expect(logs).not.toContain("workos-refresh-secret");
    expect(logs).not.toContain(body.credential.key);
    expect(logs).not.toContain(body.credential.key_prefix);
    expect(logs).not.toContain("igor@example.com");
  });

  it("owns the empty CLI credential-name fallback at the edge", async () => {
    const db = new FakeDB();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: { id: "workos-user", email: "igor@example.com", first_name: "Igor" },
    })));
    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "opaque", credential_name: "" }),
    }), testEnv(db), ctx);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ credential: { name: string } }>();
    expect(body.credential.name).toBe("oc CLI");
    const insert = db.executed.find((entry) => entry.sql.includes("INSERT INTO api_keys"));
    expect(insert?.args[5]).toBe("oc CLI");
  });

  it("selects a WorkOS-mapped membership before the personal fallback", async () => {
    const mappedOrgID = "33333333-3333-4333-8333-333333333333";
    const db = new FakeDB([
      {
        id: orgID,
        name: "Personal",
        plan: "free",
        is_personal: 1,
        workos_org_id: null,
        membership_created_at: 1,
        org_created_at: 1,
      },
      {
        id: mappedOrgID,
        name: "Digger",
        plan: "pro",
        is_personal: 0,
        workos_org_id: "workos-org",
        membership_created_at: 2,
        org_created_at: 2,
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: { id: "workos-user", email: "igor@example.com", first_name: "Igor" },
      organization_id: "workos-org",
    })));
    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "opaque", credential_name: "oc CLI" }),
    }), testEnv(db), ctx);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ org: { id: string; name: string } }>();
    expect(body.org).toEqual({ id: mappedOrgID, name: "Digger" });
    const insert = db.executed.find((entry) => entry.sql.includes("INSERT INTO api_keys"));
    expect(insert?.args[1]).toBe(mappedOrgID);
  });

  it("provisions a first-login user, personal org, owner membership, and key", async () => {
    const db = new FakeDB([], null);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: {
        id: "new-workos-user",
        email: "new@example.com",
        first_name: "New",
        last_name: "User",
      },
    })));
    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-ipcountry": "US",
      },
      body: JSON.stringify({ device_code: "opaque", credential_name: "oc CLI" }),
    }), testEnv(db), ctx);
    expect(resp.status).toBe(200);
    const body = await resp.json<{
      user: { id: string; email: string; name: string };
      org: { id: string; name: string };
      credential: { key: string };
    }>();
    expect(body.user.email).toBe("new@example.com");
    expect(body.user.name).toBe("New User");
    expect(body.org.name).toBe("new@example.com's workspace");
    expect(body.credential.key).toMatch(/^osb_[0-9a-f]{64}$/);

    const userInsert = db.executed.find((entry) => entry.sql.includes("INSERT INTO users"));
    const orgInsert = db.executed.find((entry) => entry.sql.includes("INSERT INTO orgs"));
    const membershipInsert = db.executed.find((entry) => entry.sql.includes("INSERT INTO org_memberships"));
    const keyInsert = db.executed.find((entry) => entry.sql.includes("INSERT INTO api_keys"));
    expect(userInsert).toBeDefined();
    expect(userInsert?.sql).toContain("durable_sessions_enabled");
    expect(userInsert?.sql).toContain("infrastructure_enabled");
    expect(userInsert?.sql).toMatch(/VALUES\s*\(\?1, \?2, \?3, \?4, \?5, 0, 1\)/);
    expect(orgInsert?.args[3]).toBe("azure-us-east-2-a");
    expect(membershipInsert?.args[0]).toBe(body.org.id);
    expect(membershipInsert?.args[1]).toBe(body.user.id);
    expect(keyInsert?.args[1]).toBe(body.org.id);
    expect(keyInsert?.args[2]).toBe(body.user.id);
  });

  it("rejects extra exchange fields before contacting WorkOS", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const resp = await worker.fetch(request("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_code: "opaque",
        credential_name: "oc CLI",
        user: { id: "attacker" },
      }),
    }), testEnv(), ctx);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "invalid_request" });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe("CLI identity and credential lifecycle", () => {
  it("returns additive human identity fields from whoami", async () => {
    const resp = await worker.fetch(request("/api/whoami", {
      headers: { "X-API-Key": "osb_test" },
    }), testEnv(), ctx);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      org_id: orgID,
      user_id: userID,
      email: "igor@example.com",
      org_name: "Igor's workspace",
    });
  });

  it("revokes exactly the presented key and does not accept query credentials", async () => {
    const db = new FakeDB();
    const env = testEnv(db);
    const unauthorized = await worker.fetch(
      request("/auth/cli/credential?api_key=osb_query", { method: "DELETE" }),
      env,
      ctx,
    );
    expect(unauthorized.status).toBe(401);

    const resp = await worker.fetch(request("/auth/cli/credential", {
      method: "DELETE",
      headers: { "X-API-Key": "osb_presented" },
    }), env, ctx);
    expect(resp.status).toBe(204);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    const deletion = db.executed.find((entry) => entry.sql.includes("DELETE FROM api_keys"));
    expect(deletion?.args[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(deletion?.args[1]).toBe(orgID);
  });

  it("keeps the browser callback on its historical membership-selection query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: { id: "workos-user", email: "igor@example.com", first_name: "Igor" },
      access_token: "header.payload.signature",
    })));
    const resp = await worker.fetch(request("/auth/callback?code=browser-code"), testEnv(), ctx);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe("https://app.opencomputer.dev/dashboard");
    expect(resp.headers.get("set-cookie")).toContain("oc_session=");
  });

  it("keeps dashboard key creation on the existing one-time wire shape", async () => {
    const db = new FakeDB();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: { id: "workos-user", email: "igor@example.com", first_name: "Igor" },
    })));
    const callback = await worker.fetch(
      request("/auth/callback?code=browser-code"),
      testEnv(db),
      ctx,
    );
    const cookie = callback.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^oc_session=/);

    const resp = await worker.fetch(request("/api/dashboard/api-keys", {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Dashboard key" }),
    }), testEnv(db), ctx);
    expect(resp.status).toBe(201);
    const body = await resp.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual([
      "id",
      "orgId",
      "name",
      "key",
      "keyPrefix",
      "scopes",
      "createdAt",
    ]);
    expect(body.orgId).toBe(orgID);
    expect(body.name).toBe("Dashboard key");
    expect(body.key).toMatch(/^osb_[0-9a-f]{64}$/);
    expect(body.keyPrefix).toBe(String(body.key).slice(0, 8));
    expect(body.scopes).toEqual(["sandbox:*"]);
    const insert = db.executed.find((entry) =>
      entry.sql.includes("INSERT INTO api_keys") && entry.args[5] === "Dashboard key"
    );
    expect(insert?.args).not.toContain(body.key);
  });
});
