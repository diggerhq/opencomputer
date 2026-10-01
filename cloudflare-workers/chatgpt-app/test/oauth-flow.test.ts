// The whole connect flow through the real OAuth provider, with KV in memory and the OpenComputer
// API mocked: client registration → consent page → OpenComputer sign-in → token → MCP tool call.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const ORIGIN = "https://chatgpt.example.test";
const API = "https://api.example.test";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

function memoryKV(): KVNamespace {
  const store = new Map<string, { value: string; expires?: number }>();
  const live = (key: string) => {
    const hit = store.get(key);
    if (hit?.expires && hit.expires < Date.now()) store.delete(key);
    return store.get(key);
  };
  return {
    async get(key: string, type?: string | { type?: string }) {
      const hit = live(key);
      if (!hit) return null;
      const kind = typeof type === "string" ? type : type?.type;
      return kind === "json" ? JSON.parse(hit.value) : hit.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }) {
      const expires = options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : options?.expiration
          ? options.expiration * 1000
          : undefined;
      store.set(key, { value, expires });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = [...store.keys()].filter((k) => !options?.prefix || k.startsWith(options.prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    async getWithMetadata(key: string) {
      return { value: live(key)?.value ?? null, metadata: null, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

class Browser {
  cookies = new Map<string, string>();
  constructor(private env: Env) {}
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { ...init, headers, redirect: "manual" }), this.env, ctx());
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, value] = pair!.split("=");
      if (/Max-Age=0/.test(cookie)) this.cookies.delete(name!);
      else this.cookies.set(name!, value!);
    }
    return response;
  }
}

async function pkce() {
  const verifier = "v".repeat(64);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

function mockOpenComputer(opts: { pendingPolls?: number } = {}) {
  let polls = 0;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    expect(url.origin).toBe(API);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.pathname === "/auth/cli/device") {
      return json({
        device_code: "dev_code", user_code: "ABCD-EFGH", verification_uri: "https://auth.example.test/device",
        verification_uri_complete: "https://auth.example.test/device?code=ABCD-EFGH", expires_in: 600, interval: 5,
      });
    }
    if (url.pathname === "/auth/cli/device/exchange") {
      expect(await request.json()).toEqual({ device_code: "dev_code", credential_name: "ChatGPT" });
      if (polls++ < (opts.pendingPolls ?? 0)) return json({ status: "authorization_pending", retry_after: 5 }, 202);
      return json({ status: "authorized", credential: { id: "key_1", key: "osb_secret", key_prefix: "osb_sec", name: "ChatGPT" } });
    }
    if (url.pathname === "/api/whoami") {
      if (request.headers.get("x-api-key") === "osb_orgkey") return json({ org_id: "org_1", user_id: null, email: null, org_name: "Acme" });
      if (request.headers.get("x-api-key") !== "osb_secret") return json({ error: "unauthorized" }, 401);
      return json({ org_id: "org_1", user_id: "usr_1", email: "a@example.test", org_name: "Acme" });
    }
    if (url.pathname === "/api/managed-agents/agents") {
      expect(request.headers.get("x-api-key")).toBe("osb_secret");
      return json({ agents: [{ id: "agt_1", name: "Helper", activeDeploymentId: "dep_1" }] });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

async function startAuthorization(browser: Browser) {
  const registered = await browser.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT <script>", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code", client_id, redirect_uri: REDIRECT, scope: "agents offline_access", state: "st",
    code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp`,
  });
  const consent = await browser.fetch(`/authorize?${query}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("ChatGPT &#60;script&#62;");
  expect(html).not.toContain("<script>\"");
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  return { client_id, verifier, handle, html };
}

async function exchangeCode(browser: Browser, location: string, clientId: string, verifier: string) {
  const redirect = new URL(location);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("st");
  expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
  const token = await browser.fetch("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: redirect.searchParams.get("code")!, redirect_uri: REDIRECT,
      client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string; refresh_token?: string; scope: string };
  expect(body.access_token).not.toContain("osb_");
  return body;
}

async function callListAgents(browser: Browser, accessToken: string) {
  const response = await browser.fetch("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents", arguments: {} } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { result: { structuredContent: unknown } };
}

const env = (extra: Partial<Env> = { ALLOW_API_KEY_CONNECT: "true" }): Env =>
  ({ OAUTH_KV: memoryKV(), PUBLIC_URL: ORIGIN, OPENCOMPUTER_API_URL: API, ...extra }) as Env;
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
});

describe("connect flow", () => {
  it("publishes discovery metadata and challenges unauthenticated MCP calls", async () => {
    const browser = new Browser(env());
    const resource = (await (await browser.fetch("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const server = (await (await browser.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: ORIGIN, authorization_response_iss_parameter_supported: true, code_challenge_methods_supported: ["S256"],
    });
    // CIMD needs the Workers-only `global_fetch_strictly_public` flag, so it is off under Node.
    const unauthenticated = await browser.fetch("/mcp", { method: "POST", body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("signs in with OpenComputer and calls a tool with the stored key", async () => {
    const calls = mockOpenComputer({ pendingPolls: 1 });
    const browser = new Browser(env());
    const { client_id, verifier, handle } = await startAuthorization(browser);

    const waiting = await browser.fetch("/authorize", form({ handle, action: "sign_in" }));
    const html = await waiting.text();
    expect(html).toContain("ABCD-EFGH");
    expect(html).not.toContain("dev_code");
    const pending = /data-pending="([^"]+)"/.exec(html)![1]!;

    const poll = () =>
      browser.fetch("/authorize/poll", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ pending }) });
    expect(await (await poll()).json()).toEqual({ status: "pending", retryAfter: 5 });
    const done = (await (await poll()).json()) as { status: string; redirectTo: string };
    expect(done.status).toBe("authorized");

    const tokens = await exchangeCode(browser, done.redirectTo, client_id, verifier);
    expect(tokens.scope.split(" ").sort()).toEqual(["agents", "offline_access"]);
    expect(tokens.refresh_token).toBeTruthy();
    const result = await callListAgents(browser, tokens.access_token);
    expect(result.result.structuredContent).toEqual({ agents: [{ id: "agt_1", name: "Helper", deployed: true, updatedAt: null }] });
    expect(calls).toContain("POST /auth/cli/device/exchange");
    expect((await poll()).status).toBe(410);
  });

  it("connects with a pasted API key and rejects a bad one", async () => {
    mockOpenComputer();
    const browser = new Browser(env());
    const { client_id, verifier, handle } = await startAuthorization(browser);
    expect((await browser.fetch("/authorize", form({ handle, action: "api_key", api_key: "osb_wrong" }))).status).toBe(400);
    const ok = await browser.fetch("/authorize", form({ handle, action: "api_key", api_key: "osb_secret" }));
    expect(ok.status).toBe(302);
    const tokens = await exchangeCode(browser, ok.headers.get("location")!, client_id, verifier);
    expect((await callListAgents(browser, tokens.access_token)).result.structuredContent).toBeTruthy();
  });

  it("offers sign-in only when API-key connect is off", async () => {
    mockOpenComputer();
    const browser = new Browser(env({}));
    const { handle, html } = await startAuthorization(browser);
    expect(html).not.toContain('name="api_key"');
    const posted = await browser.fetch("/authorize", form({ handle, action: "api_key", api_key: "osb_secret" }));
    expect(posted.status).toBe(400);
  });

  it("serves the OpenAI domain-verification token when configured", async () => {
    expect((await new Browser(env({})).fetch("/.well-known/openai-apps-challenge")).status).toBe(404);
    const res = await new Browser(env({ OPENAI_APPS_CHALLENGE: "tok_123" })).fetch("/.well-known/openai-apps-challenge");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tok_123");
  });

  it("accepts an organization key that has no user", async () => {
    mockOpenComputer();
    const browser = new Browser(env());
    const { client_id, verifier, handle } = await startAuthorization(browser);
    const ok = await browser.fetch("/authorize", form({ handle, action: "api_key", api_key: "osb_orgkey" }));
    expect(ok.status).toBe(302);
    await exchangeCode(browser, ok.headers.get("location")!, client_id, verifier);
  });

  it("refuses cross-origin form posts and consent from another browser", async () => {
    mockOpenComputer();
    const e = env();
    const { handle } = await startAuthorization(new Browser(e));
    const crossSite = await new Browser(e).fetch("/authorize", { ...form({ handle, action: "api_key", api_key: "osb_secret" }), headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" } });
    expect(crossSite.status).toBe(403);
    const otherBrowser = await new Browser(e).fetch("/authorize", form({ handle, action: "api_key", api_key: "osb_secret" }));
    expect(otherBrowser.status).toBe(400);
  });

  it("denies back to the client with access_denied", async () => {
    const browser = new Browser(env());
    const { handle } = await startAuthorization(browser);
    const denied = await browser.fetch("/authorize", form({ handle, action: "deny" }));
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });
});
