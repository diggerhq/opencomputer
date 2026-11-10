import { env, SELF, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountDurableObject } from "../src/edge/account-do.js";
import type { LinearConnection } from "../src/protocol.js";
import {
  resolveLinearWebhookRoute,
  type LinearConnections,
  type LinearConnectionWithHealth,
} from "../src/edge/linear-connections.js";

/**
 * Linear agent connections (work 037 S1) through the edge Worker: allocate,
 * credentials, authorize, the public callback, token refresh, revision
 * fencing, and disconnect. Linear is a fetch stub; every secret it hands out
 * is an authored sentinel so the redaction check can grep for it.
 */

const BASE = "https://managedagents.test";
const REDIRECT_URI = "https://api.example/api/managed-agents/linear/callback";
const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const CLIENT_SECRET = "client-secret-must-not-leak";
const SIGNING_SECRET = "lin_wh_signing-secret-must-not-leak";
const ACCESS_TOKEN = "lin_oauth_access-token-must-not-leak";
const REFRESH_TOKEN = "lin_refresh_refresh-token-must-not-leak";
const SECRETS = [CLIENT_SECRET, SIGNING_SECRET, ACCESS_TOKEN, REFRESH_TOKEN];
const APP_USER_ID = "app-user-0001";
const ORGANIZATION_ID = "org-0001";

interface LinearCall {
  url: string;
  form: URLSearchParams;
  json: { query?: string; variables?: unknown } | null;
  authorization: string | null;
}

interface LinearStub {
  calls: LinearCall[];
  /** Access tokens Linear accepts; anything else answers 401. */
  valid: Set<string>;
  refreshCount: number;
  token: (call: LinearCall) => Response | Promise<Response>;
  graphql: (call: LinearCall) => Response | Promise<Response>;
  revoke: (call: LinearCall) => Response;
}

function stubLinear(overrides: Partial<Omit<LinearStub, "calls" | "valid" | "refreshCount">> = {}) {
  const stub: LinearStub = {
    calls: [],
    valid: new Set([ACCESS_TOKEN]),
    refreshCount: 0,
    token: (call) => {
      if (call.form.get("grant_type") === "authorization_code") {
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 86399,
          scope: "read write app:assignable app:mentionable",
        });
      }
      stub.refreshCount += 1;
      const access = `lin_oauth_refreshed-${String(stub.refreshCount)}`;
      stub.valid.add(access);
      return Response.json({
        access_token: access,
        refresh_token: `lin_refresh_rotated-${String(stub.refreshCount)}`,
        token_type: "Bearer",
        expires_in: 86399,
      });
    },
    graphql: (call) => {
      const token = call.authorization?.replace(/^Bearer /, "") ?? "";
      if (!stub.valid.has(token)) {
        return Response.json(
          { errors: [{ message: "Authentication required" }] },
          { status: 401 },
        );
      }
      if (call.json?.query?.includes("viewer")) {
        return Response.json({
          data: { viewer: { id: APP_USER_ID, organization: { id: ORGANIZATION_ID } } },
        });
      }
      return Response.json({ data: { echo: token } });
    },
    revoke: () => new Response(null, { status: 200 }),
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = typeof init?.body === "string" ? init.body : "";
      const headers = new Headers(init?.headers);
      let parsed: LinearCall["json"] = null;
      if (headers.get("content-type")?.includes("json")) {
        parsed = JSON.parse(body) as LinearCall["json"];
      }
      const call: LinearCall = {
        url,
        form: new URLSearchParams(parsed ? "" : body),
        json: parsed,
        authorization: headers.get("authorization"),
      };
      stub.calls.push(call);
      if (url === "https://api.linear.app/oauth/token") return stub.token(call);
      if (url === "https://api.linear.app/graphql") return stub.graphql(call);
      if (url === "https://api.linear.app/oauth/revoke") return stub.revoke(call);
      return new Response("unexpected", { status: 599 });
    }),
  );
  return stub;
}

function callsTo(stub: LinearStub, path: string): LinearCall[] {
  return stub.calls.filter((call) => call.url.endsWith(path));
}

const responses: string[] = [];

async function body<T>(response: Response): Promise<T> {
  const text = await response.text();
  responses.push(text);
  return JSON.parse(text) as T;
}

async function ok<T>(response: Response): Promise<T> {
  const value = await body<T>(response);
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}

async function errorCode(response: Response): Promise<string> {
  return (await body<{ error: { code: string } }>(response)).error.code;
}

async function createProject(slug: string): Promise<{ id: string; agentId: string }> {
  const project = await ok<{ id: string; agents: Array<{ id: string }> }>(
    await SELF.fetch(`${BASE}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: slug, slug }),
    }),
  );
  return { id: project.id, agentId: project.agents[0]!.id };
}

function allocate(
  project: { id: string; agentId: string },
  input: { name?: string; environment?: string; agentId?: string } = {},
): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/projects/${project.id}/linear/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Atlas",
      environment: "development",
      agentId: project.agentId,
      ...input,
    }),
  });
}

interface Allocated {
  connectionId: string;
  webhookUrl: string;
  createAppUrl: string;
}

function putCredentials(connectionId: string, clientId = CLIENT_ID): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/linear/connections/${connectionId}/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret: CLIENT_SECRET,
      signingSecret: SIGNING_SECRET,
    }),
  });
}

async function authorize(connectionId: string): Promise<URL> {
  const { authorizeUrl } = await ok<{ authorizeUrl: string }>(
    await SELF.fetch(`${BASE}/v1/linear/connections/${connectionId}/authorize`, {
      method: "POST",
    }),
  );
  return new URL(authorizeUrl);
}

async function callback(query: Record<string, string>): Promise<Response> {
  const url = new URL(`${BASE}/v1/linear/oauth/callback`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await SELF.fetch(url, { redirect: "manual" });
  responses.push(await response.clone().text());
  return response;
}

function returnedResult(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "");
}

async function connect(
  project: { id: string; agentId: string },
  input: { environment?: string; clientId?: string } = {},
): Promise<Allocated> {
  const allocated = await ok<Allocated>(
    await allocate(project, input.environment ? { environment: input.environment } : {}),
  );
  await ok(await putCredentials(allocated.connectionId, input.clientId));
  const url = await authorize(allocated.connectionId);
  const response = await callback({ code: "auth-code-1", state: url.searchParams.get("state")! });
  expect(returnedResult(response).searchParams.get("linear")).toBe("connected");
  return allocated;
}

async function list(projectId: string, environment = "development") {
  return (
    await ok<{ connections: LinearConnectionWithHealth[] }>(
      await SELF.fetch(
        `${BASE}/v1/projects/${projectId}/linear/connections?environment=${environment}`,
      ),
    )
  ).connections;
}

function account() {
  return env.ACCOUNTS.getByName("local");
}

function inStore<T>(work: (store: LinearConnections) => T | Promise<T>): Promise<T> {
  return runInDurableObject(account(), (instance) =>
    work((instance as unknown as { linearConnections: LinearConnections }).linearConnections),
  );
}

async function row(connectionId: string): Promise<Record<string, unknown>> {
  return runInDurableObject(account(), (_instance, state) =>
    state.storage.sql
      .exec("SELECT * FROM linear_connections WHERE id = ?", connectionId)
      .toArray()[0] as Record<string, unknown>,
  );
}

async function sql(statement: string, ...bindings: SqlStorageValue[]): Promise<void> {
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec(statement, ...bindings);
  });
}

function rotateSecret(connectionId: string, clientSecret: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/linear/connections/${connectionId}/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret, signingSecret: SIGNING_SECRET }),
  });
}

/** Fails instead of hanging when a refresh waits on itself. */
function settled<T>(pending: Promise<T>, ms = 3_000): Promise<T> {
  return Promise.race([
    pending,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`still pending after ${String(ms)} ms`)), ms),
    ),
  ]);
}

function tokenOf(webhookUrl: string): string {
  return new URL(webhookUrl).pathname.split("/").at(-1)!;
}

afterEach(async () => {
  for (const text of responses) {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }
  responses.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("Linear connection setup", () => {
  it("allocates, takes credentials, authorizes and connects", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-setup");

    const created = await allocate(project);
    expect(created.status).toBe(201);
    const allocated = await body<Allocated & { connection: LinearConnection }>(created);
    expect(allocated.connectionId).toMatch(/^lc_[a-f0-9]{32}$/);
    expect(allocated.webhookUrl).toMatch(
      new RegExp(`^${BASE}/v1/webhooks/linear/${allocated.connectionId}/[a-f0-9]{64}$`),
    );
    const createApp = new URL(allocated.createAppUrl);
    expect(createApp.origin + createApp.pathname).toBe(
      "https://linear.app/settings/api/applications/new",
    );
    expect(createApp.searchParams.get("distribution")).toBe("private");
    expect(createApp.searchParams.get("oauth.client_name")).toBe("Atlas");
    expect(createApp.searchParams.get("oauth.redirect_uris")).toBe(REDIRECT_URI);
    expect(createApp.searchParams.get("webhook.enabled")).toBe("true");
    expect(createApp.searchParams.get("webhook.url")).toBe(allocated.webhookUrl);
    expect(createApp.searchParams.getAll("webhook.resourceTypes")).toEqual([
      "AgentSessionEvent",
      "PermissionChange",
      "OAuthAuthorization",
    ]);
    expect(allocated.connection.status).toBe("pending");

    // The route object resolves the URL's token, and only that token.
    const token = tokenOf(allocated.webhookUrl);
    expect(
      await resolveLinearWebhookRoute(env.ACCOUNTS, allocated.connectionId, token),
    ).toEqual({ accountId: "local", connectionId: allocated.connectionId, revision: 1 });
    expect(
      await resolveLinearWebhookRoute(env.ACCOUNTS, allocated.connectionId, "f".repeat(64)),
    ).toBeNull();
    expect(await resolveLinearWebhookRoute(env.ACCOUNTS, "slack-id", token)).toBeNull();

    let [listed] = await list(project.id);
    expect(listed!.health.state).toBe("awaiting_credentials");
    expect(listed!.webhookUrl).toBe(allocated.webhookUrl);

    // Authorizing before credentials is refused.
    const early = await SELF.fetch(
      `${BASE}/v1/linear/connections/${allocated.connectionId}/authorize`,
      { method: "POST" },
    );
    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe("linear_credentials_required");

    const stored = await ok<{ connection: LinearConnection }>(
      await putCredentials(allocated.connectionId),
    );
    expect(stored.connection.clientId).toBe(CLIENT_ID);
    expect(stored.connection.revision).toBe(2);
    [listed] = await list(project.id);
    expect(listed!.health.state).toBe("awaiting_authorization");
    expect(
      await inStore((store) => store.signingSecret(allocated.connectionId)),
    ).toBe(SIGNING_SECRET);

    const url = await authorize(allocated.connectionId);
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    expect(url.searchParams.get("actor")).toBe("app");
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);

    const returned = returnedResult(await callback({ code: "auth-code-1", state }));
    expect(returned.origin + returned.pathname).toBe(
      `https://app.example/projects/${project.id}/connections`,
    );
    expect(returned.searchParams.get("environment")).toBe("development");
    expect(returned.searchParams.get("linear")).toBe("connected");
    expect(returned.searchParams.get("connection")).toBe(allocated.connectionId);

    const [exchange] = callsTo(stub, "/oauth/token");
    expect(exchange!.form.get("grant_type")).toBe("authorization_code");
    expect(exchange!.form.get("code")).toBe("auth-code-1");
    expect(exchange!.form.get("client_id")).toBe(CLIENT_ID);
    expect(exchange!.form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(exchange!.form.get("redirect_uri")).toBe(REDIRECT_URI);
    const [viewer] = callsTo(stub, "/graphql");
    expect(viewer!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(viewer!.json?.query).toContain("viewer { id organization { id } }");

    [listed] = await list(project.id);
    expect(listed).toMatchObject({
      status: "connected",
      appUserId: APP_USER_ID,
      organizationId: ORGANIZATION_ID,
      revision: 3,
      health: { state: "waiting_for_first_delegation", message: "Waiting for the first delegation" },
    });
    const connection = await account().getLinearConnection(allocated.connectionId);
    expect(connection?.status).toBe("connected");
    // The synchronous view never carries the path credential, nor a placeholder URL.
    expect(connection?.webhookUrl).toBeUndefined();
    expect(connection?.createAppUrl).toBeUndefined();
    expect(
      await inStore((store) => store.forAgent(project.id, "development", project.agentId)?.id),
    ).toBe(allocated.connectionId);
    const expiresAt = Date.parse(String((await row(allocated.connectionId)).access_expires_at));
    expect(expiresAt - Date.now()).toBeGreaterThan(86_000_000);

    // Health from verified ingress, without moving the revision.
    await inStore((store) => {
      store.recordEvent(allocated.connectionId, "2026-10-02T10:00:00.000Z");
      store.recordEvent(allocated.connectionId, "2026-10-02T09:00:00.000Z");
      store.updateTeams(allocated.connectionId, { allPublic: false, teamIds: ["t2", "t1"] });
    });
    [listed] = await list(project.id);
    expect(listed).toMatchObject({
      revision: 3,
      verifiedAt: "2026-10-02T10:00:00.000Z",
      lastEventAt: "2026-10-02T10:00:00.000Z",
      teams: { allPublic: false, teamIds: ["t1", "t2"] },
      health: { state: "receiving", lastEventAt: "2026-10-02T10:00:00.000Z" },
    });

    // The nonce is claimed once.
    const replay = returnedResult(await callback({ code: "auth-code-1", state }));
    expect(replay.searchParams.get("linear")).toBe("used");
    expect(callsTo(stub, "/oauth/token")).toHaveLength(1);
  });

  it("refuses names Linear refuses, and bad input", async () => {
    stubLinear();
    const project = await createProject("linear-names");
    const reserved = await allocate(project, { name: "My linear helper" });
    expect(reserved.status).toBe(400);
    expect(await errorCode(reserved)).toBe("linear_app_name_reserved");
    expect(await errorCode(await allocate(project, { name: "  " }))).toBe(
      "invalid_linear_app_name",
    );
    expect(await errorCode(await allocate(project, { environment: "staging" }))).toBe(
      "invalid_environment",
    );
    expect(await errorCode(await allocate(project, { agentId: "someone-else" }))).toBe(
      "invalid_agent",
    );
    const missing = await SELF.fetch(`${BASE}/v1/projects/nope/linear/connections`);
    expect(missing.status).toBe(404);
  });

  it("records a declined authorization and a superseded one", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-declined");
    const allocated = await ok<Allocated>(await allocate(project));
    await ok(await putCredentials(allocated.connectionId));
    const first = await authorize(allocated.connectionId);
    const declined = returnedResult(
      await callback({ error: "access_denied", state: first.searchParams.get("state")! }),
    );
    expect(declined.searchParams.get("linear")).toBe("denied");
    expect((await list(project.id))[0]!.verificationError).toBe("authorization_denied");

    // Credentials pasted again after the URL was issued move the revision;
    // the older authorization can no longer connect.
    const second = await authorize(allocated.connectionId);
    await ok(await putCredentials(allocated.connectionId));
    const superseded = returnedResult(
      await callback({ code: "auth-code-2", state: second.searchParams.get("state")! }),
    );
    expect(superseded.searchParams.get("linear")).toBe("superseded");
    expect(callsTo(stub, "/oauth/token")).toHaveLength(0);
    expect((await list(project.id))[0]!.status).toBe("pending");

    const malformed = await callback({ code: "x", state: "not-a-state" });
    expect(malformed.status).toBe(400);
  });
});

describe("Linear connection uniqueness", () => {
  it("refuses a second connection for a bound agent and environment", async () => {
    stubLinear();
    const project = await createProject("linear-binding");
    const connected = await connect(project);
    const again = await allocate(project);
    expect(again.status).toBe(409);
    const problem = await body<{ error: { code: string; connectionId: string } }>(again);
    expect(problem.error).toMatchObject({
      code: "linear_already_connected",
      connectionId: connected.connectionId,
    });
    // The other environment is a separate binding.
    expect((await allocate(project, { environment: "production", name: "Atlas Prod" })).status).toBe(201);
  });

  it("resets a pending binding to a fresh route instead of adding a second", async () => {
    stubLinear();
    const project = await createProject("linear-pending");
    const first = await ok<Allocated>(await allocate(project));
    const second = await allocate(project, { name: "Atlas Two" });
    expect(second.status).toBe(200);
    const reset = await body<Allocated & { connection: LinearConnection }>(second);
    expect(reset.connectionId).toBe(first.connectionId);
    expect(reset.connection).toMatchObject({ name: "Atlas Two", revision: 2 });
    expect(tokenOf(reset.webhookUrl)).not.toBe(tokenOf(first.webhookUrl));
    expect(
      await resolveLinearWebhookRoute(env.ACCOUNTS, first.connectionId, tokenOf(first.webhookUrl)),
    ).toBeNull();
    expect(
      await resolveLinearWebhookRoute(env.ACCOUNTS, first.connectionId, tokenOf(reset.webhookUrl)),
    ).toMatchObject({ revision: 2 });
    expect(await list(project.id)).toHaveLength(1);
  });

  it("refuses one Linear app on two connections", async () => {
    stubLinear();
    const project = await createProject("linear-client");
    await connect(project);
    const other = await ok<Allocated>(
      await allocate(project, { environment: "production", name: "Atlas Prod" }),
    );
    const duplicate = await putCredentials(other.connectionId);
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("linear_app_already_connected");
    expect((await putCredentials(other.connectionId, "fedcba9876543210fedcba9876543210")).status).toBe(200);
  });
});

describe("Linear tokens", () => {
  it("refreshes a token that expires within five minutes, once", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-refresh");
    const { connectionId } = await connect(project);
    const before = Number((await row(connectionId)).revision);
    await sql(
      "UPDATE linear_connections SET access_expires_at = ? WHERE id = ?",
      new Date(Date.now() + 60_000).toISOString(),
      connectionId,
    );

    const [first, second] = await inStore((store) =>
      Promise.all([
        store.graphql(connectionId, { query: "query { echo }" }),
        store.graphql(connectionId, { query: "query { echo }" }),
      ]),
    );
    expect(first).toEqual({ outcome: "ok", data: { echo: "lin_oauth_refreshed-1" } });
    expect(second).toEqual(first);
    const refreshes = callsTo(stub, "/oauth/token").filter(
      (call) => call.form.get("grant_type") === "refresh_token",
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.form.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(refreshes[0]!.form.get("client_id")).toBe(CLIENT_ID);
    expect(refreshes[0]!.form.get("client_secret")).toBe(CLIENT_SECRET);
    const after = await row(connectionId);
    expect(Number(after.revision)).toBe(before + 1);
    expect(Date.parse(String(after.access_expires_at)) - Date.now()).toBeGreaterThan(86_000_000);

    // Fresh now: no further refresh, and the rotated refresh token is the one kept.
    expect(await inStore((store) => store.accessToken(connectionId))).toMatchObject({
      outcome: "token",
      token: "lin_oauth_refreshed-1",
    });
    stub.valid.delete("lin_oauth_refreshed-1");
    await inStore((store) => store.graphql(connectionId, { query: "query { echo }" }));
    const rotated = callsTo(stub, "/oauth/token").filter(
      (call) => call.form.get("grant_type") === "refresh_token",
    );
    expect(rotated.at(-1)!.form.get("refresh_token")).toBe("lin_refresh_rotated-1");
  });

  it("refreshes once on a 401 and retries the request once", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-401");
    const { connectionId } = await connect(project);
    stub.valid.delete(ACCESS_TOKEN);

    expect(
      await inStore((store) => store.graphql(connectionId, { query: "query { echo }" })),
    ).toEqual({ outcome: "ok", data: { echo: "lin_oauth_refreshed-1" } });
    const graphql = callsTo(stub, "/graphql").slice(1); // after the viewer read
    expect(graphql.map((call) => call.authorization)).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
      "Bearer lin_oauth_refreshed-1",
    ]);

    // A token refused again after its refresh is a permanent failure, not a loop.
    stub.graphql = () =>
      Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
    expect(
      await inStore((store) => store.graphql(connectionId, { query: "query { echo }" })),
    ).toMatchObject({ outcome: "permanent", status: 401 });
    expect(stub.refreshCount).toBe(2);
  });

  it("classifies Linear's failures as transient or permanent", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-failures");
    const { connectionId } = await connect(project);
    const query = { query: "mutation { x }" };

    stub.graphql = () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
    expect(await inStore((store) => store.graphql(connectionId, query))).toMatchObject({
      outcome: "transient",
      status: 429,
      retryAfterSeconds: 7,
    });
    stub.graphql = () =>
      Response.json(
        { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] },
        { status: 400 },
      );
    expect(await inStore((store) => store.graphql(connectionId, query))).toMatchObject({
      outcome: "transient",
      status: 400,
    });
    stub.graphql = () => new Response("bad gateway", { status: 502 });
    expect(await inStore((store) => store.graphql(connectionId, query))).toMatchObject({
      outcome: "transient",
      status: 502,
    });
    stub.graphql = () => {
      throw new TypeError("network down");
    };
    expect(await inStore((store) => store.graphql(connectionId, query))).toMatchObject({
      outcome: "transient",
    });
    stub.graphql = () =>
      Response.json({ errors: [{ message: "Argument Validation Error" }] }, { status: 400 });
    expect(await inStore((store) => store.graphql(connectionId, query))).toEqual({
      outcome: "permanent",
      status: 400,
      message: "Argument Validation Error",
    });
    stub.graphql = () =>
      Response.json({
        data: null,
        errors: [{ message: "conflict on insert of AgentActivity" }],
      });
    expect(await inStore((store) => store.graphql(connectionId, query))).toEqual({
      outcome: "ok",
      data: null,
      errors: [{ message: "conflict on insert of AgentActivity" }],
    });
    expect(stub.refreshCount).toBe(0);
  });

  it("answers unavailable for pending, revoked and unknown connections", async () => {
    stubLinear();
    const project = await createProject("linear-unavailable");
    const pending = await ok<Allocated>(await allocate(project));
    const query = { query: "query { echo }" };
    expect(await inStore((store) => store.graphql(pending.connectionId, query))).toEqual({
      outcome: "unavailable",
      reason: "pending",
    });
    expect(await inStore((store) => store.accessToken("lc_" + "0".repeat(32)))).toEqual({
      outcome: "unavailable",
      reason: "not_found",
    });

    const connected = await connect(project, { environment: "production" });
    const before = Number((await row(connected.connectionId)).revision);
    await inStore((store) => store.markRevoked(connected.connectionId, new Date().toISOString()));
    expect(Number((await row(connected.connectionId)).revision)).toBe(before + 1);
    expect(await inStore((store) => store.graphql(connected.connectionId, query))).toEqual({
      outcome: "unavailable",
      reason: "revoked",
    });
    const [revoked] = await list(project.id, "production");
    expect(revoked!.health.state).toBe("revoked");
    // Still verifiable: a later event from Linear can be checked.
    expect(await inStore((store) => store.signingSecret(connected.connectionId))).toBe(
      SIGNING_SECRET,
    );
  });

  it("marks the connection revoked when Linear refuses the refresh grant", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-refresh-refused");
    const { connectionId } = await connect(project);
    stub.valid.delete(ACCESS_TOKEN);
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(
      await inStore((store) => store.graphql(connectionId, { query: "query { echo }" })),
    ).toEqual({ outcome: "unavailable", reason: "revoked" });
    expect((await row(connectionId)).verification_error).toBe("refresh_rejected");
  });

  it("refreshes again against new credentials when a refresh loses to a credential change", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-refresh-conflict");
    const { connectionId } = await connect(project);
    await sql(
      "UPDATE linear_connections SET access_expires_at = ? WHERE id = ?",
      new Date(Date.now() + 60_000).toISOString(),
      connectionId,
    );
    const before = Number((await row(connectionId)).revision);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshToken = stub.token;
    let refreshes = 0;
    stub.token = async (call) => {
      if (call.form.get("grant_type") === "refresh_token" && ++refreshes === 1) await held;
      return refreshToken(call);
    };

    const pending = inStore((store) => store.accessToken(connectionId));
    await vi.waitFor(() => expect(refreshes).toBe(1));
    // The client secret rotates while Linear answers: same app, still connected,
    // the token still expiring, and the revision the refresh read is gone.
    await ok(await rotateSecret(connectionId, "client-secret-rotated"));
    release();

    expect(await settled(pending)).toMatchObject({
      outcome: "token",
      token: "lin_oauth_refreshed-2",
    });
    const grants = callsTo(stub, "/oauth/token").filter(
      (call) => call.form.get("grant_type") === "refresh_token",
    );
    expect(grants.map((call) => call.form.get("client_secret"))).toEqual([
      CLIENT_SECRET,
      "client-secret-rotated",
    ]);
    expect(callsTo(stub, "/oauth/revoke").map((call) => call.authorization)).toEqual([
      "Bearer lin_oauth_refreshed-1",
    ]);
    const after = await row(connectionId);
    expect(after.status).toBe("connected");
    expect(Number(after.revision)).toBe(before + 2);
    expect(await inStore((store) => store.accessToken(connectionId))).toMatchObject({
      outcome: "token",
      token: "lin_oauth_refreshed-2",
    });
  });

  it("answers transient after one fresh refresh also loses, without looping", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-refresh-conflict-twice");
    const { connectionId } = await connect(project);
    await sql(
      "UPDATE linear_connections SET access_expires_at = ? WHERE id = ?",
      new Date(Date.now() + 60_000).toISOString(),
      connectionId,
    );
    // Gates are made here, outside the Account object, so the test may open them.
    const opens: Array<() => void> = [];
    const gates = [0, 1].map(
      () => new Promise<void>((resolve) => opens.push(resolve)),
    );
    const refreshToken = stub.token;
    let refreshes = 0;
    stub.token = async (call) => {
      if (call.form.get("grant_type") === "refresh_token") {
        refreshes += 1;
        await gates[refreshes - 1];
      }
      return refreshToken(call);
    };

    const pending = inStore((store) =>
      Promise.all([store.accessToken(connectionId), store.accessToken(connectionId)]),
    );
    for (const attempt of [1, 2]) {
      await vi.waitFor(() => expect(refreshes).toBe(attempt));
      await ok(await rotateSecret(connectionId, `client-secret-rotated-${String(attempt)}`));
      opens[attempt - 1]!();
    }

    const [first, second] = await settled(pending);
    expect(first).toMatchObject({ outcome: "transient" });
    expect(second).toEqual(first);
    expect(refreshes).toBe(2);
    expect(callsTo(stub, "/oauth/revoke").map((call) => call.authorization)).toEqual([
      "Bearer lin_oauth_refreshed-1",
      "Bearer lin_oauth_refreshed-2",
    ]);
    expect((await row(connectionId)).status).toBe("connected");

    // The next call starts over against the current credentials.
    stub.token = refreshToken;
    expect(await inStore((store) => store.accessToken(connectionId))).toMatchObject({
      outcome: "token",
      token: "lin_oauth_refreshed-3",
    });
  });
});

describe("Linear token boundary", () => {
  it("R4: no Account RPC returns the app token", () => {
    // The token is attached inside the Account object (GraphQL, activities,
    // the services proxy); nothing outside it may receive it.
    expect("linearAccessToken" in AccountDurableObject.prototype).toBe(false);
    const rpcs = Object.getOwnPropertyNames(AccountDurableObject.prototype);
    expect(rpcs.filter((name) => /token/i.test(name) && /linear/i.test(name))).toEqual([]);
  });
});

describe("Linear disconnect", () => {
  it("revokes, unbinds and advances the revision", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-delete");
    const { connectionId, webhookUrl } = await connect(project);
    const before = Number((await row(connectionId)).revision);

    const deleted = await SELF.fetch(`${BASE}/v1/linear/connections/${connectionId}`, {
      method: "DELETE",
    });
    const result = await ok<{ connection: LinearConnection; revoked: boolean }>(deleted);
    expect(result.revoked).toBe(true);
    expect(result.connection.status).toBe("disconnected");
    expect(result.connection.revision).toBe(before + 1);
    const [revoke] = callsTo(stub, "/oauth/revoke");
    expect(revoke!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    expect(
      await resolveLinearWebhookRoute(env.ACCOUNTS, connectionId, tokenOf(webhookUrl)),
    ).toBeNull();
    expect(await list(project.id)).toEqual([]);
    expect(await inStore((store) => store.signingSecret(connectionId))).toBeNull();
    expect(
      await inStore((store) => store.forAgent(project.id, "development", project.agentId)),
    ).toBeNull();
    const credential = await runInDurableObject(account(), (_instance, state) =>
      state.storage.sql
        .exec("SELECT credential_ciphertext FROM connections WHERE id = ?", connectionId)
        .toArray()[0],
    );
    expect(credential).toEqual({ credential_ciphertext: null });
    expect(
      (await SELF.fetch(`${BASE}/v1/linear/connections/${connectionId}`, { method: "DELETE" }))
        .status,
    ).toBe(404);

    // The binding and the app are free again.
    await connect(project);
  });

  it("discards a refresh that completes after a disconnect and revokes its token", async () => {
    const stub = stubLinear();
    const project = await createProject("linear-race");
    const { connectionId } = await connect(project);
    await sql(
      "UPDATE linear_connections SET access_expires_at = ? WHERE id = ?",
      new Date(Date.now() + 60_000).toISOString(),
      connectionId,
    );
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshToken = stub.token;
    stub.token = async (call) => {
      if (call.form.get("grant_type") === "refresh_token") await held;
      return refreshToken(call);
    };

    const pending = inStore((store) => store.accessToken(connectionId));
    await vi.waitFor(() => {
      expect(
        callsTo(stub, "/oauth/token").some((call) => call.form.get("grant_type") === "refresh_token"),
      ).toBe(true);
    });
    await ok(
      await SELF.fetch(`${BASE}/v1/linear/connections/${connectionId}`, { method: "DELETE" }),
    );
    release();

    expect(await pending).toEqual({ outcome: "unavailable", reason: "disconnected" });
    const revoked = callsTo(stub, "/oauth/revoke").map((call) => call.authorization);
    expect(revoked).toEqual([`Bearer ${ACCESS_TOKEN}`, "Bearer lin_oauth_refreshed-1"]);
    const after = await row(connectionId);
    expect(after.status).toBe("disconnected");
    expect(after.access_expires_at).toBeNull();
    const credential = await runInDurableObject(account(), (_instance, state) =>
      state.storage.sql
        .exec("SELECT credential_ciphertext FROM connections WHERE id = ?", connectionId)
        .toArray()[0],
    );
    expect(credential).toEqual({ credential_ciphertext: null });
  });
});
