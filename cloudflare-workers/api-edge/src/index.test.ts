import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, safeReturnTo } from "./index";

const orgID = "org-1";
const userID = "user-1";

class FakeStatement {
  constructor(private sql: string) {}

  bind(..._args: unknown[]) {
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM api_keys")) {
      return { org_id: orgID, created_by: userID, expires_at: null } as T;
    }
    if (this.sql.includes("SELECT plan FROM orgs")) {
      return { plan: "pro" } as T;
    }
    return null;
  }

  async all<T>() {
    return { results: [] as T[] };
  }

  async run() {
    return {};
  }

  // Mirrors D1's batch() per-statement result shape ({ results: [...] }):
  // single-row queries wrap first() in an array.
  async batchResult<T>(): Promise<{ results: T[] }> {
    const row = await this.first<T>();
    return { results: row ? [row] : [] };
  }
}

const env = {
  OPENCOMPUTER_DB: {
    prepare(sql: string) {
      return new FakeStatement(sql);
    },
    async batch(stmts: FakeStatement[]) {
      return Promise.all(stmts.map((s) => s.batchResult()));
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
} as unknown as Env;

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// The sandbox API, preview URLs and cell routing were removed in 097 step 7.2.
// What used to reach a cell is now an authenticated 404, and nothing is ever
// forwarded.
describe("api-edge after the sandbox strip", () => {
  afterEach(() => vi.unstubAllGlobals());

  const call = (path: string, init: RequestInit = {}) => {
    const fetchSpy = vi.fn(async () => new Response("proxied", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    return { fetchSpy, resp: worker.fetch(new Request(`https://app.opencomputer.dev${path}`, init), env, ctx) };
  };

  it("answers 401 for a sandbox path without an API key, forwarding nothing", async () => {
    const { fetchSpy, resp } = call("/api/sandboxes/sb-123/exec/es-123?api_key=osb_test");
    expect((await resp).status).toBe(401);
    expect(await (await resp).json()).toEqual({ error: "missing or invalid API key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 401 for a sandbox WebSocket without an API key", async () => {
    const { fetchSpy, resp } = call("/api/sandboxes/sb-123/exec/es-123", { headers: { Upgrade: "websocket" } });
    expect((await resp).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 404 for an authenticated sandbox create, forwarding nothing", async () => {
    const { fetchSpy, resp } = call("/api/sandboxes", {
      method: "POST",
      headers: { "X-API-Key": "osb_test", "content-type": "application/json" },
      body: JSON.stringify({ templateID: "base" }),
    });
    expect((await resp).status).toBe(404);
    expect(await (await resp).json()).toEqual({ error: "not found" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 404 for authenticated exec, snapshot and image paths", async () => {
    for (const path of ["/api/sandboxes/sb-123/exec/run-async", "/api/snapshots", "/api/images"]) {
      const { fetchSpy, resp } = call(path, { method: "POST", headers: { "X-API-Key": "osb_test" } });
      expect((await resp).status, path).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("does not route preview hosts or the cell-facing internal routes", async () => {
    for (const url of [
      "https://sb-123-p8080.sb.opencomputer.dev/",
      "https://app.opencomputer.dev/internal/halt-list",
      "https://app.opencomputer.dev/internal/vms/sb-123/connect",
    ]) {
      const fetchSpy = vi.fn(async () => new Response("proxied", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      const resp = await worker.fetch(new Request(url), env, ctx);
      expect(resp.status, url).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });
});

// The scoped-secret boundary that lets the managed agents backend ensure-provision
// Managed without holding the broad CF_ADMIN_SECRET. Asserts the auth gate only
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

describe("safeReturnTo — deferred-action deep-link validation", () => {
  it("accepts same-origin paths (incl. query strings)", () => {
    expect(safeReturnTo("/do?action=abc")).toBe("/do?action=abc");
    expect(safeReturnTo("/sessions/xyz")).toBe("/sessions/xyz");
    expect(safeReturnTo("/")).toBe("/");
  });
  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeReturnTo("https://evil.com")).toBeNull();
    expect(safeReturnTo("//evil.com")).toBeNull();
    expect(safeReturnTo("javascript:alert(1)")).toBeNull();
  });
  it("rejects backslash tricks and non-path input", () => {
    expect(safeReturnTo("/a\\b")).toBeNull();
    expect(safeReturnTo("do?action=abc")).toBeNull();
  });
  it("rejects ASCII control chars (CR/LF header injection)", () => {
    expect(safeReturnTo("/do\r\nSet-Cookie: x=1")).toBeNull();
    expect(safeReturnTo("/do\n")).toBeNull();
    expect(safeReturnTo("/do\u0000")).toBeNull();
    expect(safeReturnTo("/do\u007f")).toBeNull();
  });
  it("accepts a long-but-bounded action, rejects over the cap", () => {
    const ok = "/do?action=" + "a".repeat(4000);
    expect(safeReturnTo(ok)).toBe(ok);
    expect(safeReturnTo("/" + "a".repeat(5000))).toBeNull();
  });
  it("rejects empty and nullish input", () => {
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });
});

// /internal/warm-org pre-populates this colo's auth + create-context caches so a
// key used rarely (a weekly benchmark) is not cold when it matters. It is
// HMAC-auth'd because it reads every API-key hash on an org, so the auth gate is
// the part worth pinning down — a warm cache is an optimisation, but an open
// route that enumerates key material is not.
describe("/internal/warm-org — auth boundary", () => {
  const ADMIN = "admin-secret";
  const authEnv = { ...env, CF_ADMIN_SECRET: ADMIN } as unknown as Env;
  const sign = async (secret: string, ts: string, body: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const post = async (o: { secret?: string; ts?: string; sig?: string; body?: string } = {}) => {
    const body = o.body ?? JSON.stringify({ org_id: "org-x" });
    const ts = o.ts ?? Math.floor(Date.now() / 1000).toString();
    const sig = o.sig ?? (await sign(o.secret ?? ADMIN, ts, body));
    return worker.fetch(
      new Request("https://app.opencomputer.dev/internal/warm-org", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Timestamp": ts, "X-Signature": sig },
        body,
      }),
      authEnv,
      ctx,
    );
  };

  it("rejects a wrong signature", async () => {
    expect((await post({ secret: "not-the-admin-secret" })).status).toBe(401);
  });

  it("rejects a stale timestamp even with a valid signature", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 3600).toString();
    expect((await post({ ts })).status).toBe(401);
  });

  it("requires org_id", async () => {
    expect((await post({ body: JSON.stringify({}) })).status).toBe(400);
  });

  it("authorizes with the admin secret", async () => {
    expect((await post()).status).not.toBe(401);
  });
});

describe("/api/managed-agents/slack/callback — unauthenticated mount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Slack calls this URL with no OpenComputer credentials; it is registered on
  // every app the automated setup creates, so the mount must stay above the
  // API-key check and forward the query untouched.
  it("forwards Slack's redirect to the backend callback without an API key", async () => {
    const fetchSpy = vi.fn(
      async (_target: URL | RequestInfo, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://app.opencomputer.dev/projects/prj_test/connections?environment=development&slack=connected&setup=setup_1",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/slack/callback?state=x&code=y",
      ),
      { ...env, MANAGED_AGENTS_API_URL: "https://managedagents.test" },
      ctx,
    );

    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe(
      "https://app.opencomputer.dev/projects/prj_test/connections?environment=development&slack=connected&setup=setup_1",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].toString()).toBe(
      "https://managedagents.test/v1/channels/slack/oauth/callback?state=x&code=y",
    );
  });
});

describe("/api/managed-agents/linear — public mounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Linear redirects here with no OpenComputer credentials; the backend puts
  // this URL in every authorize link, so the mount stays above the API-key
  // check and forwards the query untouched.
  it("forwards Linear's redirect to the backend callback without an API key", async () => {
    const location =
      "https://app.opencomputer.dev/projects/prj_test/connections?environment=production&linear=connected&connection=lc_1";
    const fetchSpy = vi.fn(
      async (_target: URL | RequestInfo, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/linear/callback?state=x&code=y",
      ),
      { ...env, MANAGED_AGENTS_API_URL: "https://managedagents.test" },
      ctx,
    );

    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe(location);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].toString()).toBe(
      "https://managedagents.test/v1/linear/oauth/callback?state=x&code=y",
    );
  });

  it("requires an API key for the connection routes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_test/linear/connections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Triage", environment: "production", agentId: "triage" }),
        },
      ),
      { ...env, MANAGED_AGENTS_API_URL: "https://managedagents.test" },
      ctx,
    );

    expect(resp.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/api/managed-agents/computer/slack — public mounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The organization-level Slack app calls these URLs without OpenComputer
  // credentials, so they must be routed above the API-key check.
  it("forwards the OAuth redirect without an API key", async () => {
    const location = "https://app.opencomputer.dev/computer?slack=error&reason=state_expired";
    const fetchSpy = vi.fn(
      async (_target: URL | RequestInfo, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/computer/slack/callback?state=x&code=y",
      ),
      { ...env, MANAGED_AGENTS_API_URL: "https://managedagents.test" },
      ctx,
    );

    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe(location);
    expect(fetchSpy.mock.calls[0][0].toString()).toBe(
      "https://managedagents.test/v1/computer/slack/callback?state=x&code=y",
    );
  });

  it.each([
    ["events", "/v1/webhooks/computer/slack/events"],
    ["interactivity", "/v1/webhooks/computer/slack/interactivity"],
  ])("forwards signed Slack %s without an API key", async (kind, upstreamPath) => {
    const fetchSpy = vi.fn(
      async (_target: URL | RequestInfo, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const resp = await worker.fetch(
      new Request(
        `https://app.opencomputer.dev/api/managed-agents/computer/slack/${kind}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=abc",
            "x-slack-request-timestamp": "1700000000",
          },
          body: '{"type":"event_callback"}',
        },
      ),
      { ...env, MANAGED_AGENTS_API_URL: "https://managedagents.test" },
      ctx,
    );

    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].toString()).toBe(
      `https://managedagents.test${upstreamPath}`,
    );
    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get("x-slack-signature")).toBe("v0=abc");
  });
});

describe("/api/managed-agents/computer/agent/connect — public CLI connect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const url = "https://app.opencomputer.dev/api/managed-agents/computer/agent/connect";
  const code = "oc_7KQM2XP94HTRWN3F";
  const target = { ...env, MANAGED_AGENTS_API_URL: "https://managedagents.test" };
  const stub = (upstream: Response) => {
    const fetchSpy = vi.fn(
      async (_target: URL | RequestInfo, _init?: RequestInit) => upstream,
    );
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  };

  it("forwards the body untouched without an API key and passes the answer back", async () => {
    const fetchSpy = stub(
      Response.json({ provider: "codex", connected: true }, { status: 200 }),
    );
    const body = JSON.stringify({
      code,
      provider: "codex",
      authJson: { auth_mode: "chatgpt", tokens: { id_token: "i", access_token: "a", refresh_token: "r" } },
    });
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          cookie: "oc_session=private",
          authorization: "Bearer osb_private",
        },
        body,
      }),
      target,
      ctx,
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    await expect(resp.json()).resolves.toEqual({ provider: "codex", connected: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [forwardedTo, init] = fetchSpy.mock.calls[0];
    expect(forwardedTo.toString()).toBe("https://managedagents.test/v1/computer/agent/connect");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(headers.get("content-type")).toBe("application/json");
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
  });

  it("passes a backend refusal through as is", async () => {
    const refusal = {
      error: {
        code: "computer_agent_token_format",
        message: "That's not a setup token. It starts with sk-ant-oat01-.",
      },
    };
    stub(Response.json(refusal, { status: 422 }));
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, provider: "claude", token: "nope" }),
      }),
      target,
      ctx,
    );
    expect(resp.status).toBe(422);
    await expect(resp.json()).resolves.toEqual(refusal);
  });

  it("trims a pasted code and forwards the trimmed one", async () => {
    const fetchSpy = stub(Response.json({ connected: true }, { status: 200 }));
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: ` ${code}\n`, provider: "claude", token: "t" }),
      }),
      target,
      ctx,
    );
    expect(resp.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
      code,
      provider: "claude",
      token: "t",
    });
  });

  it("accepts a retyped code in lower case", async () => {
    const fetchSpy = stub(Response.json({ connected: true }, { status: 200 }));
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.toLowerCase(), provider: "claude", token: "t" }),
      }),
      target,
      ctx,
    );
    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["GET", undefined, undefined, 405],
    ["PUT", "application/json", JSON.stringify({ code }), 405],
    ["POST", "text/plain", JSON.stringify({ code }), 415],
    ["POST", "application/x-www-form-urlencoded", `code=${code}`, 415],
    ["POST", "application/json", "{not json", 400],
    ["POST", "application/json", JSON.stringify({ provider: "claude" }), 401],
    ["POST", "application/json", JSON.stringify({ code: "occ_b3JnX3Rlc3Q.0123456789abcdefghijkl" }), 401],
    ["POST", "application/json", JSON.stringify({ code: "oc_7KQM2XP94HTRWN3" }), 401],
    ["POST", "application/json", JSON.stringify({ code: "oc_7KQM2XP94HTRWN3F0" }), 401],
    ["POST", "application/json", JSON.stringify({ code: "oc_7KQM2XP94HTRWN3-" }), 401],
    ["POST", "application/json", JSON.stringify({ code: "osb_0123456789abcdefghijkl" }), 401],
  ])("refuses %s %s %s at the edge", async (method, contentType, body, status) => {
    const fetchSpy = stub(new Response(null, { status: 200 }));
    const resp = await worker.fetch(
      new Request(url, {
        method,
        ...(contentType ? { headers: { "content-type": contentType } } : {}),
        ...(body !== undefined ? { body } : {}),
      }),
      target,
      ctx,
    );
    expect(resp.status).toBe(status);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (status === 401) {
      const answer = (await resp.json()) as { error: { code: string } };
      expect(answer.error.code).toBe("computer_connect_code_invalid");
    }
  });

  it("refuses another method as JSON, naming the one allowed", async () => {
    const fetchSpy = stub(new Response(null, { status: 200 }));
    const resp = await worker.fetch(new Request(url, { method: "GET" }), target, ctx);
    expect(resp.status).toBe(405);
    expect(resp.headers.get("allow")).toBe("POST");
    expect(resp.headers.get("cache-control")).toBe("no-store");
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "method_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a body over the bound without reading it all", async () => {
    const fetchSpy = stub(new Response(null, { status: 200 }));
    const big = JSON.stringify({ code, provider: "codex", authJson: "x".repeat(200 * 1024) });
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: big,
      }),
      target,
      ctx,
    );
    expect(resp.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const attempt = (env: Env) =>
    worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, provider: "claude", token: "t" }),
      }),
      env,
      ctx,
    );
  const logged = (log: ReturnType<typeof vi.spyOn>) =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((entry) => entry.event === "computer_agent_connect");

  it("answers 502 when the backend is unreachable, logging the error's name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeout; }));
    const resp = await attempt(target);
    expect(resp.status).toBe(502);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "computer_unavailable" } });
    const entry = logged(log);
    log.mockRestore();
    expect(entry).toMatchObject({ result: "upstream_unavailable", error_name: "TimeoutError" });
    expect(JSON.stringify(entry)).not.toContain("aborted");
  });

  it("answers 502 when the backend redirects instead of answering", async () => {
    stub(new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }));
    const resp = await attempt(target);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("location")).toBeNull();
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "computer_unavailable" } });
  });

  it("logs an unbound rate limit in prod only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stub(Response.json({ connected: true }, { status: 200 }));
    await attempt({ ...target, WORKER_ENV: "prod" } as Env);
    expect(logged(log)).toMatchObject({ result: "connected", rate_limit: "unbound" });
    log.mockClear();
    await attempt(target);
    expect(logged(log)).not.toHaveProperty("rate_limit");
    log.mockRestore();
  });

  it("rate-limits per caller IP before reading the body or calling blue", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const limit = vi.fn(async () => ({ success: false }));
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify({ code, provider: "claude", token: "t" }),
      }),
      { ...target, COMPUTER_CONNECT_RATE_LIMIT: { limit } } as unknown as Env,
      ctx,
    );
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("60");
    expect(await resp.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/internal/computer-keys", () => {
  const MANAGED = "managed-secret";
  const sign = async (secret: string, ts: string, body: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const post = async (secret: string, orgID: string, authEnv: Env, extra: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ org_id: orgID, ...extra });
    const ts = Math.floor(Date.now() / 1000).toString();
    return worker.fetch(
      new Request("https://app.opencomputer.dev/internal/computer-keys", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Timestamp": ts, "X-Signature": await sign(secret, ts, body) },
        body,
      }),
      authEnv,
      ctx,
    );
  };

  it("refuses any other secret", async () => {
    const authEnv = { ...env, CF_ADMIN_SECRET: "admin", OC_MANAGED_CRED_HMAC_SECRET: MANAGED } as unknown as Env;
    expect((await post("admin", "org-x", authEnv)).status).toBe(401);
  });

  it("mints a one-hour key for an existing org", async () => {
    const runs: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => (sql.includes("FROM orgs") && args[0] === "org-x" ? { id: "org-x" } : null),
          run: async () => { runs.push(args); return {}; },
        }),
      }),
    };
    const authEnv = { ...env, OC_MANAGED_CRED_HMAC_SECRET: MANAGED, OPENCOMPUTER_DB: db } as unknown as Env;
    expect((await post(MANAGED, "org-missing", authEnv)).status).toBe(404);
    const res = await post(MANAGED, "org-x", authEnv);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { key: string; expiresAt: string };
    expect(out.key).toMatch(/^osb_/);
    const ttl = Date.parse(out.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(3500_000);
    expect(ttl).toBeLessThanOrEqual(3600_000);
    expect(runs[0][1]).toBe("org-x");
    expect(runs[0][2]).toBe("computer");
    expect(runs[0][8]).toBeNull();
    // Work 095: an explicit list, never a wildcard and never secrets:write.
    expect(runs[0][9]).toBe("sessions:read,sessions:write,asks:answer,terminals");
  });

  it("records the session a key is for, and refuses a malformed one", async () => {
    const runs: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => (sql.includes("FROM orgs") ? { id: "org-x" } : null),
          run: async () => { runs.push(args); return {}; },
        }),
      }),
    };
    const authEnv = { ...env, OC_MANAGED_CRED_HMAC_SECRET: MANAGED, OPENCOMPUTER_DB: db } as unknown as Env;
    expect((await post(MANAGED, "org-x", authEnv, { session_key: "T1:C1:1.2" })).status).toBe(200);
    expect(runs[0][8]).toBe("T1:C1:1.2");
    expect((await post(MANAGED, "org-x", authEnv, { session_key: "T1:C1" })).status).toBe(400);
    expect((await post(MANAGED, "org-x", authEnv, { session_key: 7 })).status).toBe(400);
    expect(runs).toHaveLength(1);
  });
});
