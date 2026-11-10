import { env, SELF, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectDeploymentReference, SlackSetup } from "../src/protocol.js";
import { AccountDurableObject, handleSlackSetupRoute, SessionDurableObject } from "../src/edge/index.js";
import { hostedSlackManifest } from "../src/channels/slack-manifest.js";

/**
 * The automated Slack setup end to end through the edge Worker: reservation,
 * app creation with a configuration token, OAuth state, the public callback,
 * activation, and then real signed events on the connection it produced.
 *
 * Slack is a fetch stub. Every secret it hands out is a sentinel, so the
 * redaction assertions can grep for them.
 */

const CONFIG_TOKEN = "xoxe.xoxp-1-configuration-token-must-not-leak";
const CLIENT_SECRET = "client-secret-must-not-leak";
const SIGNING_SECRET = "a1b2c3d4".repeat(4);
const BOT_TOKEN = "xoxb-automated-bot-token-must-not-leak";
const CODE = "1234.5678.authorization-code-must-not-leak";
const SECRETS = [CONFIG_TOKEN, CLIENT_SECRET, SIGNING_SECRET, BOT_TOKEN, CODE];
const REDIRECT_URI = "https://api.example/api/managed-agents/slack/callback";
const BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:read",
  "chat:write",
  "groups:read",
  "im:history",
  "im:write",
  "users:read",
];

interface SlackCall {
  method: string;
  form: URLSearchParams;
  authorization: string | null;
}

interface SlackStub {
  calls: SlackCall[];
  create: (call: SlackCall) => Response;
  exchange: (call: SlackCall) => Response;
  authTest: () => Response | Promise<Response>;
  botsInfo: () => Response;
  usersInfo: () => Response;
  conversationsInfo: () => Response;
}

function grant(overrides: Record<string, unknown> = {}) {
  return Response.json({
    ok: true,
    access_token: BOT_TOKEN,
    token_type: "bot",
    scope: BOT_SCOPES.join(","),
    bot_user_id: "U0BOT",
    app_id: "A0AUTO",
    team: { id: "T0TEAM", name: "Acme" },
    enterprise: null,
    authed_user: { id: "U0HUMAN" },
    ...overrides,
  });
}

function created(overrides: Record<string, unknown> = {}) {
  return Response.json({
    ok: true,
    app_id: "A0AUTO",
    credentials: {
      client_id: "111.222",
      client_secret: CLIENT_SECRET,
      verification_token: "legacy",
      signing_secret: SIGNING_SECRET,
    },
    oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222",
    ...overrides,
  });
}

function identity(teamId = "T0TEAM") {
  return Response.json({
    ok: true,
    url: "https://acme.slack.com/",
    team: "Acme",
    user: "coder",
    team_id: teamId,
    user_id: "U0BOT",
    bot_id: "B0BOT",
  });
}

function stubSlack(overrides: Partial<Omit<SlackStub, "calls">> = {}): SlackStub {
  const stub: SlackStub = {
    calls: [],
    create: () => created(),
    exchange: () => grant(),
    authTest: () => identity(),
    // bots.info needs users:read, which installs minted before the name
    // scopes were added do not carry.
    botsInfo: () => Response.json({ ok: false, error: "missing_scope" }),
    usersInfo: () =>
      Response.json({
        ok: true,
        user: {
          id: "U1",
          name: "alovelace",
          real_name: "Ada Lovelace",
          profile: { display_name: "Ada Lovelace", real_name: "Ada Lovelace" },
        },
      }),
    conversationsInfo: () =>
      Response.json({
        ok: true,
        channel: {
          id: "C1",
          name: "dev",
          is_member: true,
          is_private: false,
          is_archived: false,
        },
      }),
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = url.split("/").at(-1) ?? "";
      const call: SlackCall = {
        method,
        form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
        authorization: new Headers(init?.headers).get("authorization"),
      };
      stub.calls.push(call);
      if (method === "apps.manifest.create") return stub.create(call);
      if (method === "oauth.v2.access") return stub.exchange(call);
      if (method === "auth.test") return stub.authTest();
      if (method === "bots.info") return stub.botsInfo();
      // users.info and conversations.info are GETs; the query rides the tail.
      if (method.startsWith("users.info")) return stub.usersInfo();
      if (method.startsWith("conversations.info")) return stub.conversationsInfo();
      return Response.json({ ok: true, ts: "1.1", channel: "C1" });
    }),
  );
  return stub;
}

function calls(stub: SlackStub, method: string): SlackCall[] {
  return stub.calls.filter((call) => call.method === method);
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

async function createProject(slug: string): Promise<{ id: string; agentId: string }> {
  const project = await ok<{ id: string; agents: Array<{ id: string }> }>(
    await SELF.fetch("https://managedagents.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: slug, slug }),
    }),
  );
  return { id: project.id, agentId: project.agents[0]!.id };
}

async function deploy(
  agentId: string,
  alias: "development" | "production",
  projectDeployment?: ProjectDeploymentReference,
): Promise<void> {
  const member = projectDeployment?.agents.find(
    (candidate) => candidate.agentId === agentId,
  );
  await env.ACCOUNTS.getByName("local").registerDeployment({
    agentId,
    alias,
    channels: [],
    connections: [],
    ...(projectDeployment
      ? {
          projectDeployment: {
            ...projectDeployment,
            localAgentId: member?.localId ?? projectDeployment.localAgentId,
          },
        }
      : {}),
    artifact: {
      bucket: "artifacts",
      key: `${agentId}.json`,
      digest: member?.artifactDigest ?? "e".repeat(64),
      size: 10,
    },
    imageArn: "image",
    imageVersion: "1",
  });
}

let keyCounter = 0;
function requestKey(): string {
  keyCounter += 1;
  return `req_${String(keyCounter).padStart(4, "0")}_${"k".repeat(16)}`;
}

function start(input: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://managedagents.test/v1/channels/slack/setups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

function read(id: string): Promise<Response> {
  return SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${id}`);
}

async function authorize(id: string): Promise<{ url: URL; state: string; expiresAt: string }> {
  const result = await ok<{ authorizationUrl: string; expiresAt: string }>(
    await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${id}/authorize`, {
      method: "POST",
    }),
  );
  const url = new URL(result.authorizationUrl);
  return { url, state: url.searchParams.get("state") ?? "", expiresAt: result.expiresAt };
}

async function callback(query: Record<string, string>): Promise<Response> {
  const url = new URL("https://managedagents.test/v1/channels/slack/oauth/callback");
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await SELF.fetch(url, { redirect: "manual" });
  responses.push(await response.clone().text());
  return response;
}

function redirected(response: Response): URL {
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return new URL(response.headers.get("location") ?? "");
}

function expectRedirect(
  response: Response,
  expected: { projectId: string; alias: string; result: string; setupId: string },
): void {
  const location = redirected(response);
  expect(location.origin + location.pathname).toBe(
    `https://app.example/projects/${expected.projectId}/connections`,
  );
  expect(location.searchParams.get("environment")).toBe(expected.alias);
  expect(location.searchParams.get("slack")).toBe(expected.result);
  expect(location.searchParams.get("setup")).toBe(expected.setupId);
}

async function connection(id: string) {
  return env.ACCOUNTS.getByName("local").getSlackConnection(id);
}

async function setupRow(id: string): Promise<Record<string, unknown>> {
  const rows = await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM slack_setups WHERE id = ?", id).toArray(),
  );
  return rows[0] as Record<string, unknown>;
}

async function routeHashOf(connectionId: string): Promise<string | null> {
  const rows = await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) =>
    state.storage.sql
      .exec<{ webhook_token_hash: string | null }>(
        "SELECT webhook_token_hash FROM channel_connections WHERE id = ?",
        connectionId,
      )
      .toArray(),
  );
  return rows[0]?.webhook_token_hash ?? null;
}

async function revisionOf(connectionId: string): Promise<number> {
  const rows = await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) =>
    state.storage.sql
      .exec<{ revision: number }>("SELECT revision FROM channel_connections WHERE id = ?", connectionId)
      .toArray(),
  );
  return rows[0]!.revision;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function manualReserve(agentId: string, reconnect = false) {
  return ok<{ connection: { id: string }; manifest: { settings: { event_subscriptions: { request_url: string } } } }>(
    await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${agentId}@development`, name: "Coder", ...(reconnect ? { reconnect } : {}) }),
    }),
  );
}

function manualCompletion(connectionId: string, appId: string, signingSecret: string, botToken = "xoxb-manual") {
  return SELF.fetch(`https://managedagents.test/v1/channels/slack/connections/${connectionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botToken, appId, signingSecret }),
  });
}

async function manualComplete(connectionId: string, appId: string, signingSecret: string) {
  return ok<{ status: string; appId: string }>(await manualCompletion(connectionId, appId, signingSecret));
}

async function connectionCredential(connectionId: string): Promise<string | null> {
  const rows = await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) =>
    state.storage.sql
      .exec<{ credential_ciphertext: string | null }>(
        "SELECT credential_ciphertext FROM connections WHERE id = ?",
        connectionId,
      )
      .toArray(),
  );
  return rows[0]?.credential_ciphertext ?? null;
}

function setupWebhookUrl(row: Record<string, unknown>): string {
  const manifest = JSON.parse(String(row.manifest_json)) as {
    settings: { event_subscriptions: { request_url: string } };
  };
  return manifest.settings.event_subscriptions.request_url;
}

async function challenge(webhookUrl: string): Promise<number> {
  const response = await SELF.fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "url_verification", challenge: "ping" }),
  });
  return response.status;
}

async function sql(statement: string, ...bindings: unknown[]): Promise<void> {
  await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
    state.storage.sql.exec(statement, ...(bindings as SqlStorageValue[]));
  });
}

/** A project agent, deployed to development with NO declared Slack channel. */
async function dedicatedTarget(slug: string) {
  const project = await createProject(slug);
  await deploy(project.agentId, "development");
  return project;
}

async function connectAutomatically(slug: string, stub = stubSlack()) {
  const project = await dedicatedTarget(slug);
  const { setup } = await ok<{ setup: SlackSetup }>(
    await start({
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: requestKey(),
      configurationToken: CONFIG_TOKEN,
    }),
  );
  expect(setup.phase).toBe("app_created");
  const { state } = await authorize(setup.id);
  const response = await callback({ state, code: CODE });
  expectRedirect(response, {
    projectId: project.id,
    alias: "development",
    result: "connected",
    setupId: setup.id,
  });
  return { project, setup, stub };
}

async function slackSigned(payload: string, secret = SIGNING_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${payload}`)),
  );
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
  };
}

async function deliver(webhookUrl: string, event: Record<string, unknown>, eventId: string) {
  const payload = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    api_app_id: "A0AUTO",
    team_id: "T0TEAM",
    event,
  });
  return SELF.fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await slackSigned(payload)) },
    body: payload,
  });
}

async function boundTurns(connectionId: string, key: string, turns = 1): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = await env.ACCOUNTS.getByName("local").getChannelThreadSession(connectionId, key);
    if (id) {
      const snapshot = await env.SESSIONS.getByName(id).snapshot();
      if (snapshot.turns.length >= turns) return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no session with ${String(turns)} turn(s) for ${key}`);
}

function requestUrlOf(stub: SlackStub): string {
  const manifest = JSON.parse(calls(stub, "apps.manifest.create")[0]!.form.get("manifest") ?? "{}") as {
    settings: { event_subscriptions: { request_url: string } };
  };
  return manifest.settings.event_subscriptions.request_url;
}

beforeEach(async () => {
  responses.length = 0;
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS session_creations (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      countable INTEGER NOT NULL DEFAULT 1,
      exclusion_reason TEXT,
      outcome_at TEXT
    )`,
  ).run();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("Slack automated setup", () => {
  it("provisions a deployment with no declared Slack channel from the platform's standard manifest", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("dedicated");
    const key = requestKey();
    const response = await start({
      agentId: project.agentId,
      alias: "development",
      name: "  Coder  ",
      requestKey: key,
      configurationToken: CONFIG_TOKEN,
    });
    expect(response.status).toBe(201);
    const { setup } = await body<{ setup: SlackSetup }>(response);
    expect(setup).toMatchObject({
      requestKey: key,
      projectId: project.id,
      agentId: project.agentId,
      alias: "development",
      channelId: "slack",
      name: "Coder",
      phase: "app_created",
      app: { id: "A0AUTO", name: "Coder" },
      actions: ["authorize", "manual", "cancel"],
    });
    expect(setup.workspace).toBeUndefined();

    // Exactly the manifest the manual flow hands out, with the callback declared.
    const create = calls(stub, "apps.manifest.create");
    expect(create).toHaveLength(1);
    expect(create[0]!.authorization).toBe(`Bearer ${CONFIG_TOKEN}`);
    const submitted = JSON.parse(create[0]!.form.get("manifest") ?? "") as Record<string, unknown>;
    const webhookUrl = requestUrlOf(stub);
    expect(webhookUrl).toMatch(
      new RegExp(`^https://managedagents\\.test/v1/webhooks/slack/${setup.connectionId}/[a-f0-9]{32}$`),
    );
    expect(submitted).toEqual(
      hostedSlackManifest("Coder", webhookUrl, { redirectUri: REDIRECT_URI }).manifest,
    );
    expect((submitted.oauth_config as { redirect_urls: string[] }).redirect_urls).toEqual([REDIRECT_URI]);

    // The route was live before Slack was asked to create the app, so its
    // URL verification challenge answers.
    const challenge = await ok<{ challenge: string }>(
      await SELF.fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "hello" }),
      }),
    );
    expect(challenge.challenge).toBe("hello");

    // The pending connection is the ordinary one, listed with its consumer.
    expect(await connection(setup.connectionId)).toMatchObject({
      status: "pending",
      channelId: "slack",
      appName: "Coder",
    });
    const listed = await ok<{ connections: Array<{ id: string; agents: string[]; status: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/channels"),
    );
    expect(listed.connections).toEqual([
      expect.objectContaining({ id: setup.connectionId, status: "pending", agents: [project.agentId] }),
    ]);
  });

  it("uses the declared channel's scopes and events and reports every registered agent", async () => {
    const stub = stubSlack();
    const project = await createProject("declared");
    const graph: ProjectDeploymentReference = {
      id: "project:declared:graph",
      digest: "d".repeat(64),
      localAgentId: "coder",
      agents: [
        { localId: "coder", agentId: project.agentId, artifactDigest: "e".repeat(64) },
        { localId: "reviewer", agentId: `${project.agentId}--reviewer`, artifactDigest: "f".repeat(64) },
      ],
      resources: {
        version: 1,
        channels: [
          {
            id: "team-slack",
            type: "slack",
            displayName: "Team Slack",
            scopes: { bot: ["chat:write", "app_mentions:read"] },
            events: ["app_mention"],
            destinations: {},
            routing: { whenAmbiguous: "ask" },
          },
        ],
        channelRegistrations: [
          { agentId: "coder", channelId: "team-slack", triggers: ["mention"] },
          { agentId: "reviewer", channelId: "team-slack", triggers: ["mention"] },
        ],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [],
      },
    };
    // A graph's alias promotes once every member agent is registered.
    await deploy(project.agentId, "development", graph);
    await deploy(`${project.agentId}--reviewer`, "development", graph);
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Team Bot",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    expect(setup.channelId).toBe("team-slack");
    const submitted = JSON.parse(calls(stub, "apps.manifest.create")[0]!.form.get("manifest") ?? "") as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] } };
    };
    expect(submitted.oauth_config.scopes.bot).toEqual([
      "app_mentions:read",
      "channels:read",
      "chat:write",
      "groups:read",
      "users:read",
    ]);
    expect(submitted.settings.event_subscriptions.bot_events).toEqual(["app_mention"]);
    const listed = await ok<{ connections: Array<{ agents: string[] }> }>(
      await SELF.fetch("https://managedagents.test/v1/channels"),
    );
    expect(listed.connections[0]!.agents).toEqual(["coder", "reviewer"]);
  });

  it("dispatches one create for concurrent same-key submissions and refuses a changed intent", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("concurrent");
    const key = requestKey();
    const input = {
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: key,
      configurationToken: CONFIG_TOKEN,
    };
    const [first, second] = await Promise.all([start(input), start(input)]);
    const a = await body<{ setup: SlackSetup }>(first);
    const b = await body<{ setup: SlackSetup }>(second);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(a.setup.id).toBe(b.setup.id);
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);
    const { setup } = await ok<{ setup: SlackSetup }>(await read(a.setup.id));
    expect(setup.phase).toBe("app_created");

    // Same key, different name: not the same request.
    const conflict = await start({ ...input, name: "Other Bot" });
    expect(conflict.status).toBe(409);
    expect(await body<{ error: { code: string } }>(conflict)).toMatchObject({
      error: { code: "slack_setup_conflict" },
    });

    // A second setup for the same target resumes the active one.
    const active = await start({ ...input, requestKey: requestKey() });
    expect(active.status).toBe(409);
    expect(await body<{ error: { code: string; setupId: string } }>(active)).toMatchObject({
      error: { code: "slack_setup_active", setupId: setup.id },
    });
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);
  });

  it("keeps a create whose answer was lost as uncertain and never creates again on its own", async () => {
    const stub = stubSlack({
      create: () => {
        throw new TypeError("connection reset");
      },
    });
    const project = await dedicatedTarget("uncertain");
    const key = requestKey();
    const input = {
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: key,
      configurationToken: CONFIG_TOKEN,
    };
    const { setup } = await ok<{ setup: SlackSetup }>(await start(input));
    expect(setup).toMatchObject({
      phase: "creation_uncertain",
      error: { code: "slack_creation_uncertain", recoverable: false },
      actions: ["manual", "cancel"],
    });
    expect(setup.app).toBeUndefined();
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);

    // Neither a read nor a resubmission with the same key asks Slack again.
    stub.create = () => created();
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe("creation_uncertain");
    const again = await ok<{ setup: SlackSetup }>(await start(input));
    expect(again.setup.phase).toBe("creation_uncertain");
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);

    // An explicit decision: cancel, then a new request key for a fresh setup.
    const cancelled = await ok<{ setup: SlackSetup }>(
      await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, {
        method: "POST",
      }),
    );
    expect(cancelled.setup.phase).toBe("cancelled");
    expect(cancelled.setup.actions).toEqual([]);
    const fresh = await ok<{ setup: SlackSetup }>(await start({ ...input, requestKey: requestKey() }));
    expect(fresh.setup.id).not.toBe(setup.id);
    expect(fresh.setup.phase).toBe("app_created");
    expect(calls(stub, "apps.manifest.create")).toHaveLength(2);
  });

  it("returns an explicit rejection to prepared so a corrected token can be submitted under the same key", async () => {
    const stub = stubSlack({
      create: () => Response.json({ ok: false, error: "token_expired" }),
    });
    const project = await dedicatedTarget("rejected");
    const input = {
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: requestKey(),
      configurationToken: CONFIG_TOKEN,
    };
    const { setup } = await ok<{ setup: SlackSetup }>(await start(input));
    expect(setup).toMatchObject({
      phase: "prepared",
      error: { code: "slack_configuration_token_expired", recoverable: true },
      actions: ["create", "manual", "cancel"],
    });

    stub.create = () =>
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "45" },
      });
    const limited = await ok<{ setup: SlackSetup }>(
      await start({ ...input, configurationToken: "xoxe.xoxp-1-third" }),
    );
    expect(limited.setup.error).toMatchObject({ code: "slack_rate_limited", retryAfterMs: 45_000 });

    stub.create = () => created();
    const succeeded = await ok<{ setup: SlackSetup }>(
      await start({ ...input, configurationToken: "xoxe.xoxp-1-fourth" }),
    );
    expect(succeeded.setup.phase).toBe("app_created");
    expect(succeeded.setup.error).toBeUndefined();
    expect(calls(stub, "apps.manifest.create")).toHaveLength(3);

    // A resubmission without a token just reads.
    const readBack = await ok<{ setup: SlackSetup }>(
      await start({ ...input, configurationToken: undefined }),
    );
    expect(readBack.setup.phase).toBe("app_created");
    expect(calls(stub, "apps.manifest.create")).toHaveLength(3);
  });

  it("keeps a rejected manifest on its setup and regenerates from the current deployment only in a new one", async () => {
    const stub = stubSlack({
      create: () =>
        Response.json({
          ok: false,
          error: "invalid_manifest",
          errors: [{ message: "bad url", pointer: "/settings/event_subscriptions/request_url" }],
        }),
    });
    const project = await createProject("manifest");
    const graph = (digest: string, scopes: string[]): ProjectDeploymentReference => ({
      id: `project:manifest:${digest.slice(0, 4)}`,
      digest,
      localAgentId: "coder",
      agents: [{ localId: "coder", agentId: project.agentId, artifactDigest: digest }],
      resources: {
        version: 1,
        channels: [
          {
            id: "team-slack",
            type: "slack",
            scopes: { bot: scopes },
            events: ["app_mention"],
            destinations: {},
            routing: { whenAmbiguous: "ask" },
          },
        ],
        channelRegistrations: [{ agentId: "coder", channelId: "team-slack", triggers: ["mention"] }],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [],
      },
    });
    await env.ACCOUNTS.getByName("local").registerDeployment({
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      projectDeployment: graph("1".repeat(64), ["chat:write", "app_mentions:read"]),
      artifact: { bucket: "artifacts", key: "one.json", digest: "1".repeat(64), size: 10 },
      imageArn: "image",
      imageVersion: "1",
    });
    const input = {
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: requestKey(),
      configurationToken: CONFIG_TOKEN,
    };
    const { setup } = await ok<{ setup: SlackSetup }>(await start(input));
    expect(setup).toMatchObject({
      phase: "prepared",
      error: {
        code: "slack_manifest_rejected",
        pointer: "/settings/event_subscriptions/request_url",
        recoverable: false,
      },
      actions: ["manual", "cancel"],
    });
    // Slack's free text is not copied into the record; the pointer is enough.
    expect(setup.error?.message).not.toContain("bad url");

    // The snapshot is what Slack rejected; a retry under this key must not resubmit it.
    stub.create = () => created();
    const retried = await ok<{ setup: SlackSetup }>(await start(input));
    expect(retried.setup.phase).toBe("prepared");
    expect(retried.setup.error?.code).toBe("slack_manifest_rejected");
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);

    // Fix the declaration, redeploy, cancel, start again: the new setup's
    // manifest comes from the deployment as it is now.
    await ok(
      await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, { method: "POST" }),
    );
    await env.ACCOUNTS.getByName("local").registerDeployment({
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      projectDeployment: graph("2".repeat(64), ["chat:write", "app_mentions:read", "channels:read"]),
      artifact: { bucket: "artifacts", key: "two.json", digest: "2".repeat(64), size: 10 },
      imageArn: "image",
      imageVersion: "1",
    });
    const fresh = await ok<{ setup: SlackSetup }>(await start({ ...input, requestKey: requestKey() }));
    expect(fresh.setup.phase).toBe("app_created");
    const submitted = JSON.parse(calls(stub, "apps.manifest.create")[1]!.form.get("manifest") ?? "") as {
      oauth_config: { scopes: { bot: string[] } };
    };
    expect(submitted.oauth_config.scopes.bot).toEqual([
      "app_mentions:read",
      "channels:read",
      "chat:write",
      "groups:read",
      "users:read",
    ]);
  });

  it("resumes the stored app after a reload and after a declined consent", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("resume");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );

    // The page reloaded and knows only the target.
    const found = await ok<{ setup: SlackSetup | null }>(
      await SELF.fetch(
        `https://managedagents.test/v1/channels/slack/setups?agentId=${project.agentId}&alias=development`,
      ),
    );
    expect(found.setup).toMatchObject({ id: setup.id, phase: "app_created", app: { id: "A0AUTO" } });
    const none = await ok<{ setup: SlackSetup | null }>(
      await SELF.fetch(
        `https://managedagents.test/v1/channels/slack/setups?agentId=${project.agentId}&alias=production`,
      ),
    );
    expect(none.setup).toBeNull();

    const first = await authorize(setup.id);
    expect(first.url.origin + first.url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(first.url.searchParams.get("client_id")).toBe("111.222");
    expect(first.url.searchParams.get("scope")).toBe(BOT_SCOPES.join(","));
    expect(first.url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(first.url.searchParams.get("team")).toBeNull();
    expect(first.state).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.now() + 9 * 60_000);

    // Declined: the app stays, the setup says so, and nothing was exchanged.
    const declined = await callback({ state: first.state, error: "access_denied" });
    expectRedirect(declined, {
      projectId: project.id,
      alias: "development",
      result: "authorization_denied",
      setupId: setup.id,
    });
    const after = await ok<{ setup: SlackSetup }>(await read(setup.id));
    expect(after.setup).toMatchObject({
      phase: "app_created",
      app: { id: "A0AUTO" },
      error: { code: "slack_authorization_denied", recoverable: true },
      actions: ["authorize", "manual", "cancel"],
    });
    expect(calls(stub, "oauth.v2.access")).toHaveLength(0);
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);

    // Authorizing again uses the same app; no new create, no new token asked.
    const second = await authorize(setup.id);
    expect(second.state).not.toBe(first.state);
    expect(second.url.searchParams.get("client_id")).toBe("111.222");
    expect(calls(stub, "apps.manifest.create")).toHaveLength(1);
  });

  it("connects through the callback, and the connection then turns a mention and a direct message into turns", async () => {
    const { project, setup, stub } = await connectAutomatically("connected");
    const exchange = calls(stub, "oauth.v2.access");
    expect(exchange).toHaveLength(1);
    expect(exchange[0]!.form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(exchange[0]!.form.get("code")).toBe(CODE);
    // The app is proven by OAuth's app_id; the bot and workspace by auth.test.
    // bots.info would need users:read, which the manifest does not request.
    expect(calls(stub, "bots.info")).toHaveLength(0);
    expect(calls(stub, "auth.test")).toHaveLength(1);

    const done = await ok<{ setup: SlackSetup }>(await read(setup.id));
    expect(done.setup).toMatchObject({
      phase: "connected",
      app: { id: "A0AUTO" },
      workspace: { id: "T0TEAM", name: "Acme" },
      botUserId: "U0BOT",
      actions: ["authorize"],
    });
    expect(done.setup.error).toBeUndefined();
    expect(await connection(setup.connectionId)).toMatchObject({
      status: "connected",
      appId: "A0AUTO",
      teamId: "T0TEAM",
      teamName: "Acme",
      botUserId: "U0BOT",
    });
    const listed = await ok<{ connections: Array<{ id: string; status: string; agents: string[] }> }>(
      await SELF.fetch("https://managedagents.test/v1/channels"),
    );
    expect(listed.connections).toEqual([
      expect.objectContaining({ id: setup.connectionId, status: "connected", agents: [project.agentId] }),
    ]);

    // Real signed traffic on the URL the manifest declared.
    const webhookUrl = requestUrlOf(stub);
    const mention = await deliver(
      webhookUrl,
      { type: "app_mention", channel: "C1", channel_type: "channel", user: "U1", ts: "111.1", text: "<@U0BOT> fix the csv export" },
      "Ev1",
    );
    expect(mention.status).toBe(200);
    const mentionSession = await boundTurns(setup.connectionId, "U1:111.1");
    const mentionSnapshot = await env.SESSIONS.getByName(mentionSession).snapshot();
    // The transcript names who spoke and where, with the IDs alongside.
    expect(mentionSnapshot.turns[0]!.input).toContain(
      "[Slack message from Ada Lovelace (U1) in #dev (C1)]",
    );
    expect(mentionSnapshot.turns[0]!.input).toContain("fix the csv export");
    expect(mentionSnapshot.agentId).toBe(project.agentId);

    const direct = await deliver(
      webhookUrl,
      { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "222.2", text: "and the tests" },
      "Ev2",
    );
    expect(direct.status).toBe(200);
    const directSession = await boundTurns(setup.connectionId, "U1:222.2");
    expect(directSession).not.toBe(mentionSession);
    const directSnapshot = await env.SESSIONS.getByName(directSession).snapshot();
    expect(directSnapshot.turns[0]!.input).toContain(
      "[Slack message from Ada Lovelace (U1) in a direct message]",
    );
    expect(directSnapshot.turns[0]!.input).toContain("and the tests");

    // A forged signature is still refused.
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: "Ev3",
      api_app_id: "A0AUTO",
      team_id: "T0TEAM",
      event: { type: "app_mention", channel: "C1", user: "U1", ts: "333.3", text: "<@U0BOT> hi" },
    });
    const forged = await SELF.fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await slackSigned(payload, "0".repeat(32))) },
      body: payload,
    });
    expect(forged.status).toBe(401);
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected" });
  });

  it("passes the thread as channel.conversationId and the team as channel.workspaceId to the agent", async () => {
    const { setup, stub } = await connectAutomatically("thread-id");
    // A mention inside an existing thread: the thread, not the message, is
    // the conversation.
    const reply = await deliver(
      requestUrlOf(stub),
      {
        type: "app_mention",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "555.6",
        thread_ts: "555.5",
        text: "<@U0BOT> status?",
      },
      "Ev-thread",
    );
    expect(reply.status).toBe(200);
    const sessionId = await boundTurns(setup.connectionId, "U1:555.5");
    const agentInput = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      JSON.parse(
        state.storage.sql
          .exec<{ input_json: string }>("SELECT input_json FROM turns ORDER BY created_at, rowid LIMIT 1")
          .one().input_json,
      ) as { source: string; channel?: Record<string, unknown> },
    );
    expect(agentInput.source).toBe("channel");
    expect(agentInput.channel).toEqual({
      provider: "slack",
      connectionId: setup.connectionId,
      workspaceId: "T0TEAM",
      conversationId: "555.5",
      userId: "U1",
    });
  });

  it("admits a Slack message with its own ts as provider time, so a reply after a question card answers it (slack-ux P2)", async () => {
    const { setup, stub } = await connectAutomatically("provider-time");
    const admitted = vi.spyOn(SessionDurableObject.prototype, "enqueueChannelTurn");
    const reply = await deliver(
      requestUrlOf(stub),
      {
        type: "app_mention",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1700000000.123456",
        thread_ts: "1699999999.000001",
        text: "<@U0BOT> go",
      },
      "Ev-provider-time",
    );
    expect(reply.status).toBe(200);
    await boundTurns(setup.connectionId, "U1:1699999999.000001");
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(admitted.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: "slack:Ev-provider-time",
      providerTime: "2023-11-14T22:13:20.123Z",
    });
  });

  it("consumes each state once, expires it, supersedes it, and binds it to its own setup", async () => {
    const { project, setup, stub } = await connectAutomatically("states");

    // Replaying a callback that already exchanged answers from the record.
    const firstState = await authorize(setup.id);
    const connectedAgain = await callback({ state: firstState.state, code: "9999.new-code" });
    expectRedirect(connectedAgain, {
      projectId: project.id,
      alias: "development",
      result: "connected",
      setupId: setup.id,
    });
    expect(calls(stub, "oauth.v2.access")).toHaveLength(2);
    const replay = await callback({ state: firstState.state, code: "9999.replayed" });
    expectRedirect(replay, {
      projectId: project.id,
      alias: "development",
      result: "connected",
      setupId: setup.id,
    });
    expect(calls(stub, "oauth.v2.access")).toHaveLength(2);

    // A fresh authorization supersedes the one before it.
    const older = await authorize(setup.id);
    const newer = await authorize(setup.id);
    const stale = await callback({ state: older.state, code: "9999.stale" });
    expect(redirected(stale).searchParams.get("slack")).toBe("authorization_expired");
    expect(calls(stub, "oauth.v2.access")).toHaveLength(2);

    // Past its ten minutes.
    await sql("UPDATE slack_oauth_states SET expires_at = 1");
    const expired = await callback({ state: newer.state, code: "9999.late" });
    expect(redirected(expired).searchParams.get("slack")).toBe("authorization_expired");
    expect(calls(stub, "oauth.v2.access")).toHaveLength(2);
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe("connected");

    // A state addressed to an account that never issued it answers nothing useful.
    const [, nonce] = newer.state.split(".");
    const foreign = await callback({ state: `${btoa("someone-else")}.${nonce ?? ""}`, code: "9999.x" });
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("content-type")).toContain("text/html");
    expect(foreign.headers.get("cache-control")).toBe("no-store");
    const malformed = await callback({ state: "not-a-state", code: "9999.x" });
    expect(malformed.status).toBe(400);

    // A state belongs to the setup that issued it: it cannot connect another target.
    const other = await createProject("states-other");
    await deploy(other.agentId, "development");
    const otherSetup = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: other.agentId,
        alias: "development",
        name: "Other",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const otherState = await authorize(otherSetup.setup.id);
    const otherResult = await callback({ state: otherState.state, code: "9999.other" });
    expect(redirected(otherResult).searchParams.get("setup")).toBe(otherSetup.setup.id);
    expect(await connection(otherSetup.setup.connectionId)).toMatchObject({ status: "connected" });
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0AUTO" });
  });

  it.each([
    ["another app", { app_id: "A0OTHER" }, undefined, "app_mismatch", "slack_app_mismatch"],
    ["missing scopes", { scope: "chat:write" }, undefined, "scope_missing", "slack_scope_missing"],
    ["an enterprise install", { is_enterprise_install: true, team: null, enterprise: { id: "E1", name: "Org" } }, undefined, "enterprise_install_unsupported", "slack_enterprise_install_unsupported"],
    ["a workspace auth.test disowns", {}, "T0OTHER", "workspace_mismatch", "slack_workspace_mismatch"],
    ["a user token", { token_type: "user", access_token: "xoxp-user" }, undefined, "exchange_failed", "slack_exchange_failed"],
    ["a bot auth.test does not recognise", { bot_user_id: "U0IMPOSTOR" }, undefined, "exchange_failed", "slack_exchange_failed"],
  ])("never activates a connection on %s", async (_label, grantOverrides, authTestTeam, result, code) => {
    stubSlack({
      exchange: () => grant(grantOverrides),
      authTest: () => identity(authTestTeam ?? "T0TEAM"),
    });
    const project = await dedicatedTarget(`reject-${result}`);
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const { state } = await authorize(setup.id);
    const response = await callback({ state, code: CODE });
    expectRedirect(response, { projectId: project.id, alias: "development", result, setupId: setup.id });
    expect(await connection(setup.connectionId)).toMatchObject({ status: "pending" });
    const after = await ok<{ setup: SlackSetup }>(await read(setup.id));
    expect(after.setup).toMatchObject({
      phase: "app_created",
      error: { code, recoverable: true },
      actions: ["authorize", "manual", "cancel"],
    });
    // Nothing of the grant was kept.
    expect(after.setup.workspace).toBeUndefined();
    expect(after.setup.botUserId).toBeUndefined();
  });

  it("refuses a re-authorization into a different workspace and a code Slack rejects", async () => {
    const { setup, stub } = await connectAutomatically("reauthorize");
    const reauthorize = await authorize(setup.id);
    expect(reauthorize.url.searchParams.get("team")).toBe("T0TEAM");

    stub.exchange = () => grant({ team: { id: "T0OTHER", name: "Elsewhere" } });
    stub.authTest = () => identity("T0OTHER");
    const moved = await callback({ state: reauthorize.state, code: "9999.moved" });
    expect(redirected(moved).searchParams.get("slack")).toBe("workspace_mismatch");
    expect(await connection(setup.connectionId)).toMatchObject({
      status: "connected",
      teamId: "T0TEAM",
      appId: "A0AUTO",
    });
    const after = await ok<{ setup: SlackSetup }>(await read(setup.id));
    expect(after.setup).toMatchObject({
      phase: "connected",
      workspace: { id: "T0TEAM" },
      error: { code: "slack_workspace_mismatch" },
    });

    stub.exchange = () => Response.json({ ok: false, error: "invalid_code" });
    const again = await authorize(setup.id);
    const invalid = await callback({ state: again.state, code: "9999.used" });
    expect(redirected(invalid).searchParams.get("slack")).toBe("authorization_expired");
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.error).toMatchObject({
      code: "slack_authorization_expired",
      recoverable: true,
    });

    stub.exchange = () => new Response("bad gateway", { status: 502 });
    const down = await authorize(setup.id);
    const unavailable = await callback({ state: down.state, code: "9999.down" });
    expect(redirected(unavailable).searchParams.get("slack")).toBe("provider_unavailable");
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", teamId: "T0TEAM" });
  });

  it("lets a manual completion or a reconnect during setup win over the stale callback", async () => {
    stubSlack();
    const project = await dedicatedTarget("manual-wins");
    const input = {
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: requestKey(),
      configurationToken: CONFIG_TOKEN,
    };
    const { setup } = await ok<{ setup: SlackSetup }>(await start(input));
    const { state } = await authorize(setup.id);

    // The user finished by hand with a different app while the consent tab
    // sat open. While the setup is active the target is its: a manual
    // reconnect answers 409 naming it; cancelling first, as the message
    // says, then Reconnect regenerates a manual manifest and the completion
    // lands.
    const held = await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${project.agentId}@development`, name: "Coder", reconnect: true }),
    });
    expect(held.status).toBe(409);
    expect(await body<{ error: { code: string; setupId: string } }>(held)).toMatchObject({
      error: { code: "slack_setup_active", setupId: setup.id },
    });
    await ok(await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, { method: "POST" }));
    await manualReserve(project.agentId, true);
    const manual = await manualComplete(setup.connectionId, "A0MANUAL", "b".repeat(32));
    expect(manual).toMatchObject({ status: "connected", appId: "A0MANUAL" });

    const stale = await callback({ state, code: CODE });
    expectRedirect(stale, { projectId: project.id, alias: "development", result: "superseded", setupId: setup.id });
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0MANUAL" });
    const after = await ok<{ setup: SlackSetup }>(await read(setup.id));
    expect(after.setup).toMatchObject({
      phase: "cancelled",
      error: { code: "slack_setup_cancelled", recoverable: false },
    });
    // The target is connected now; a new setup is refused, not layered on top.
    const refused = await start({ ...input, requestKey: requestKey() });
    expect(refused.status).toBe(409);
    expect(await body<{ error: { code: string } }>(refused)).toMatchObject({
      error: { code: "slack_already_connected" },
    });

    // Reconnect after cancelling: the manual flow reissued the webhook
    // identity, so the app this setup created points at a URL that no
    // longer routes, and its late consent cannot connect anything.
    const second = await dedicatedTarget("reconnect-wins");
    const secondSetup = await ok<{ setup: SlackSetup }>(
      await start({ ...input, agentId: second.agentId, requestKey: requestKey() }),
    );
    const secondState = await authorize(secondSetup.setup.id);
    await ok(
      await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${secondSetup.setup.id}/cancel`, {
        method: "POST",
      }),
    );
    await manualReserve(second.agentId, true);
    const superseded = await callback({ state: secondState.state, code: CODE });
    expect(redirected(superseded).searchParams.get("slack")).toBe("superseded");
    expect(await connection(secondSetup.setup.connectionId)).toMatchObject({ status: "pending" });
    expect(await connection(secondSetup.setup.connectionId)).not.toMatchObject({ appId: "A0AUTO" });
  });

  it("fences a manual mint that lands between the exchange and the commit", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("race");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const { state } = await authorize(setup.id);

    // In the window after the callback has everything it needs and before
    // the commit transaction, the user cancels the setup and the manual flow
    // re-mints the webhook identity (a mint is refused while the setup is
    // active, so cancelling comes first).
    const original = AccountDurableObject.prototype.commitSlackExchange;
    const spy = vi
      .spyOn(AccountDurableObject.prototype, "commitSlackExchange")
      .mockImplementationOnce(async function (this: AccountDurableObject, ...args) {
        // Mid-exchange the setup is busy; the lazy bound settles it, then it cancels.
        await sql("UPDATE slack_setups SET attempt_started_at = ? WHERE id = ?", Date.now() - 61_000, setup.id);
        await ok(await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, { method: "POST" }));
        await ok(
          await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId: `${project.agentId}@development`, name: "Coder", reconnect: true }),
          }),
        );
        return original.apply(this, args);
      });
    const response = await callback({ state, code: CODE });
    expect(spy).toHaveBeenCalledTimes(1);
    expectRedirect(response, {
      projectId: project.id,
      alias: "development",
      result: "superseded",
      setupId: setup.id,
    });
    expect(calls(stub, "oauth.v2.access")).toHaveLength(1);
    // The connection now routes by the manual token, so the automated bot
    // token must not have been activated on it.
    expect(await connection(setup.connectionId)).toMatchObject({ status: "pending" });
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe("cancelled");
  });

  it("refuses to cancel mid-attempt and notes a possibly orphaned app when it does cancel", async () => {
    stubSlack();
    const project = await dedicatedTarget("cancel");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
      }),
    );
    const cancel = () =>
      SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, {
        method: "POST",
      });

    // A live claim owns the outcome; cancelling now would discard a
    // successful create's credentials and orphan the app.
    for (const phase of ["creating", "exchanging"]) {
      await sql(
        "UPDATE slack_setups SET phase = ?, attempt_id = 'live', attempt_started_at = ? WHERE id = ?",
        phase,
        Date.now(),
        setup.id,
      );
      const busy = await cancel();
      expect(busy.status, phase).toBe(409);
      expect(await body<{ error: { code: string } }>(busy)).toMatchObject({
        error: { code: "slack_setup_busy" },
      });
      expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe(phase);
    }

    // With an app (or possibly an app), cancelling says so.
    await sql(
      "UPDATE slack_setups SET phase = 'app_created', attempt_id = NULL, attempt_started_at = NULL, app_id = 'A0AUTO', client_id = '111.222' WHERE id = ?",
      setup.id,
    );
    const cancelled = await ok<{ setup: SlackSetup }>(await cancel());
    expect(cancelled.setup).toMatchObject({
      phase: "cancelled",
      actions: [],
      error: { code: "slack_setup_cancelled", recoverable: false },
    });
    expect(cancelled.setup.error?.message).toMatch(/app list/i);

    // Nothing was ever created: a plain cancellation.
    const bare = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
      }),
    );
    const plain = await ok<{ setup: SlackSetup }>(
      await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${bare.setup.id}/cancel`, {
        method: "POST",
      }),
    );
    expect(plain.setup.phase).toBe("cancelled");
    expect(plain.setup.error).toBeUndefined();
  });

  it("never republishes its route over a manual bot when an old setup is retried", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("retry-old");
    const input = {
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: requestKey(),
    };
    const { setup } = await ok<{ setup: SlackSetup }>(await start(input));
    expect(setup.phase).toBe("prepared");

    // Meanwhile the user goes back to the manual flow for the same target.
    // While the setup is active the target is its (409 naming it); after
    // cancelling, Reconnect reuses the pending row and the manual manifest's
    // webhook is the live one.
    const held = await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${project.agentId}@development`, name: "Coder", reconnect: true }),
    });
    expect(held.status).toBe(409);
    expect(await body<{ error: { code: string; setupId: string } }>(held)).toMatchObject({
      error: { code: "slack_setup_active", setupId: setup.id },
    });
    await ok(await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, { method: "POST" }));
    const manual = await manualReserve(project.agentId, true);
    expect(manual.connection.id).toBe(setup.connectionId);
    const manualWebhook = manual.manifest.settings.event_subscriptions.request_url;
    expect(await challenge(manualWebhook)).toBe(200);
    await manualComplete(setup.connectionId, "A0MANUAL", "b".repeat(32));
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0MANUAL" });

    // The old automatic setup is retried with a token: it is cancelled, so
    // it neither publishes nor creates, and the manual bot keeps its route.
    const retried = await ok<{ setup: SlackSetup }>(await start({ ...input, configurationToken: CONFIG_TOKEN }));
    expect(retried.setup.phase).toBe("cancelled");
    expect(calls(stub, "apps.manifest.create")).toHaveLength(0);
    expect(await challenge(manualWebhook)).toBe(200);
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0MANUAL" });
  });

  it("rejects a route publication that a manual reconnect overtook between the claim and the write", async () => {
    stubSlack();
    const project = await dedicatedTarget("route-race");
    // A pending row from a first manual attempt, so the automated reservation reuses it.
    const first = await manualReserve(project.agentId);
    let manualWebhook = "";
    const key = requestKey();
    const original = AccountDurableObject.prototype.setChannelRoute;
    const spy = vi
      .spyOn(AccountDurableObject.prototype, "setChannelRoute")
      .mockImplementationOnce(async function (this: AccountDurableObject, ...args) {
        // While this publication is in flight the user cancels the setup and
        // the manual flow re-mints and publishes (a mint is refused while the
        // setup is active).
        const reserved = await env.ACCOUNTS.getByName("local").findSlackSetupByRequestKey(key);
        await ok(
          await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${reserved!.setup.id}/cancel`, {
            method: "POST",
          }),
        );
        const reconnect = await manualReserve(project.agentId, true);
        manualWebhook = reconnect.manifest.settings.event_subscriptions.request_url;
        return original.apply(this, args);
      });
    const response = await start({
      agentId: project.agentId,
      alias: "development",
      name: "Coder",
      requestKey: key,
    });
    expect(spy).toHaveBeenCalled();
    expect(response.status).toBe(201);
    const { setup } = await body<{ setup: SlackSetup }>(response);
    expect(setup.connectionId).toBe(first.connection.id);
    expect(setup.phase).toBe("cancelled");
    // The route object kept the newer publication: the manual URL answers,
    // the setup's does not.
    expect(await challenge(manualWebhook)).toBe(200);
    expect(await challenge(setupWebhookUrl(await setupRow(setup.id)))).toBe(401);
  });

  it("repairs a connected bot's credentials in place and refuses an older consent afterwards", async () => {
    const { setup, stub } = await connectAutomatically("repair");
    const reauthorize = await authorize(setup.id);
    const before = await revisionOf(setup.connectionId);
    const routeHash = await routeHashOf(setup.connectionId);
    const webhookUrl = requestUrlOf(stub);
    const repaired = "c".repeat(32);
    // Edit credentials: the same app with a regenerated signing secret. The
    // route does not change on a repair, so no Reconnect is needed, whoever
    // minted the route.
    const repair = await manualCompletion(setup.connectionId, "A0AUTO", repaired);
    expect(repair.status).toBe(200);
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0AUTO" });
    expect(await revisionOf(setup.connectionId)).toBe(before + 1);
    expect(await routeHashOf(setup.connectionId)).toBe(routeHash);
    expect(await challenge(webhookUrl)).toBe(200);

    const stale = await callback({ state: reauthorize.state, code: "9999.older-consent" });
    expect(redirected(stale).searchParams.get("slack")).toBe("superseded");
    expect(calls(stub, "oauth.v2.access")).toHaveLength(1);
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup).toMatchObject({
      phase: "cancelled",
      error: { code: "slack_setup_superseded" },
      actions: ["manual"],
    });
    // The repaired secret is the one events verify against, on the unchanged route.
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: "EvRepair",
      api_app_id: "A0AUTO",
      team_id: "T0TEAM",
      event: { type: "app_mention", channel: "C1", user: "U1", ts: "444.4", text: "<@U0BOT> hi" },
    });
    const withOld = await SELF.fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await slackSigned(payload, SIGNING_SECRET)) },
      body: payload,
    });
    expect(withOld.status).toBe(401);
    const withRepaired = await SELF.fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await slackSigned(payload, repaired)) },
      body: payload,
    });
    expect(withRepaired.status).toBe(200);
  });

  it("refuses a manual reconnect while a setup holds the target, and the setup stays whole", async () => {
    stubSlack();
    const project = await dedicatedTarget("reconnect-before-authorize");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const revision = await revisionOf(setup.connectionId);
    const held = await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${project.agentId}@development`, name: "Coder", reconnect: true }),
    });
    expect(held.status).toBe(409);
    expect(await body<{ error: { code: string; setupId: string } }>(held)).toMatchObject({
      error: { code: "slack_setup_active", setupId: setup.id },
    });
    expect(await revisionOf(setup.connectionId)).toBe(revision);
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe("app_created");
    const { state } = await authorize(setup.id);
    expect(redirected(await callback({ state, code: CODE })).searchParams.get("slack")).toBe("connected");
  });

  it("supersedes an exchange when the connection is disconnected before its commit", async () => {
    const { project, setup } = await connectAutomatically("disconnect-mid-exchange");
    const { state } = await authorize(setup.id);
    const original = AccountDurableObject.prototype.commitSlackExchange;
    vi.spyOn(AccountDurableObject.prototype, "commitSlackExchange").mockImplementationOnce(async function (
      this: AccountDurableObject,
      ...args
    ) {
      await ok(
        await SELF.fetch(`https://managedagents.test/v1/channels/slack/connections/${setup.connectionId}`, {
          method: "DELETE",
        }),
      );
      return original.apply(this, args);
    });
    const response = await callback({ state, code: "9999.after-disconnect" });
    expectRedirect(response, { projectId: project.id, alias: "development", result: "superseded", setupId: setup.id });
    expect(await connection(setup.connectionId)).toMatchObject({ status: "disconnected" });
  });

  it("advances the connection revision on commit so a consent recorded earlier is refused", async () => {
    const { project, setup } = await connectAutomatically("revision");
    const before = await revisionOf(setup.connectionId);
    const consent = await authorize(setup.id);
    const done = await callback({ state: consent.state, code: "9999.second" });
    expectRedirect(done, { projectId: project.id, alias: "development", result: "connected", setupId: setup.id });
    expect(await revisionOf(setup.connectionId)).toBe(before + 1);

    // A consent that was issued against the earlier revision and somehow
    // comes back unused cannot exchange against the newer connection.
    const nonceHash = await sha256Hex(consent.state.split(".")[1] ?? "");
    await sql("UPDATE slack_oauth_states SET used_at = NULL, result_code = NULL WHERE nonce_hash = ?", nonceHash);
    const stale = await callback({ state: consent.state, code: "9999.stale" });
    expect(redirected(stale).searchParams.get("slack")).toBe("superseded");
    expect(await revisionOf(setup.connectionId)).toBe(before + 1);
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0AUTO" });
  });

  it("blocks a manual completion on a row whose route an automated setup minted", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("manual-blocked");
    const manual = await manualReserve(project.agentId);
    const manualWebhook = manual.manifest.settings.event_subscriptions.request_url;
    expect(await challenge(manualWebhook)).toBe(200);

    // The user chooses automatic: the reservation takes the pending row and
    // its route; the unfinished manual manifest no longer routes.
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({ agentId: project.agentId, alias: "development", name: "Coder", requestKey: requestKey() }),
    );
    expect(setup.connectionId).toBe(manual.connection.id);
    expect(await challenge(manualWebhook)).toBe(401);
    const revision = await revisionOf(setup.connectionId);

    // Completing by hand now would report connected on a route that is dead.
    const blocked = await manualCompletion(setup.connectionId, "A0MANUAL", "b".repeat(32));
    expect(blocked.status).toBe(409);
    const problemBody = await body<{ error: { code: string; message: string } }>(blocked);
    expect(problemBody.error.code).toBe("slack_manual_completion_blocked");
    expect(problemBody.error.message).toMatch(/cancel/i);
    expect(problemBody.error.message).toMatch(/reconnect/i);
    expect(calls(stub, "auth.test")).toHaveLength(0);
    expect(await connection(setup.connectionId)).toMatchObject({ status: "pending" });
    expect(await revisionOf(setup.connectionId)).toBe(revision);

    // Cancelling the setup is not enough: the route is still the setup's.
    await ok(await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, { method: "POST" }));
    expect((await manualCompletion(setup.connectionId, "A0MANUAL", "b".repeat(32))).status).toBe(409);

    // Reconnect regenerates a manual manifest, and that one completes.
    const again = await manualReserve(project.agentId, true);
    const againWebhook = again.manifest.settings.event_subscriptions.request_url;
    expect(await challenge(againWebhook)).toBe(200);
    await manualComplete(setup.connectionId, "A0MANUAL", "b".repeat(32));
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0MANUAL" });
    expect(await challenge(againWebhook)).toBe(200);
  });

  it("refuses a mistyped manual token while a setup is active, leaving both untouched", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("manual-mistyped");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const revision = await revisionOf(setup.connectionId);
    const refused = await manualCompletion(setup.connectionId, "A0AUTO", "b".repeat(32), "xoxb-mistyped");
    expect(refused.status).toBe(409);
    expect(await body<{ error: { code: string } }>(refused)).toMatchObject({
      error: { code: "slack_manual_completion_blocked" },
    });
    expect(calls(stub, "auth.test")).toHaveLength(0);
    expect(await revisionOf(setup.connectionId)).toBe(revision);
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe("app_created");
    // The setup is still whole: it can go on to authorize and connect.
    const { state } = await authorize(setup.id);
    expect(redirected(await callback({ state, code: CODE })).searchParams.get("slack")).toBe("connected");
  });

  it("publishes a manual route at exactly the revision it wrote, so a reservation in between cannot be overwritten", async () => {
    stubSlack();
    const project = await dedicatedTarget("manual-race");
    let setupId = "";
    // An automated reservation lands between the manual write and the
    // manual publication: it reuses the pending row, advances it, and
    // publishes its own route. (The mint and its revision come from one
    // transaction, so this publication is the only remaining window.)
    const original = AccountDurableObject.prototype.setChannelRoute;
    const spy = vi
      .spyOn(AccountDurableObject.prototype, "setChannelRoute")
      .mockImplementationOnce(async function (this: AccountDurableObject, ...args) {
        const { setup } = await ok<{ setup: SlackSetup }>(
          await start({ agentId: project.agentId, alias: "development", name: "Coder", requestKey: requestKey() }),
        );
        setupId = setup.id;
        return original.apply(this, args);
      });
    const refused = await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${project.agentId}@development`, name: "Coder" }),
    });
    expect(spy).toHaveBeenCalled();
    // The manual publication was refused by the route object, so the caller
    // is not handed a manifest whose URL is already dead: it is told which
    // setup holds the connection.
    expect(refused.status).toBe(409);
    expect(await body<{ error: { code: string; setupId: string } }>(refused)).toMatchObject({
      error: { code: "slack_setup_active", setupId },
    });
    const { setup } = await ok<{ setup: SlackSetup }>(await read(setupId));
    expect(setup.phase).toBe("prepared");
    expect(await challenge(setupWebhookUrl(await setupRow(setup.id)))).toBe(200);
  });

  it("refuses a manual completion that a reservation overtook while the key was working", async () => {
    stubSlack();
    const project = await dedicatedTarget("late-reservation");
    const manual = await manualReserve(project.agentId);
    const manualWebhook = manual.manifest.settings.event_subscriptions.request_url;
    let setupId = "";
    // Between the completion's re-check and its write sits the credential
    // encryption; the reservation lands exactly there.
    const prototype = AccountDurableObject.prototype as unknown as {
      encryptSecret: (value: string) => Promise<{ ciphertext: string; iv: string }>;
    };
    const original = prototype.encryptSecret;
    const spy = vi.spyOn(prototype, "encryptSecret").mockImplementationOnce(async function (
      this: unknown,
      value: string,
    ) {
      const { setup } = await ok<{ setup: SlackSetup }>(
        await start({ agentId: project.agentId, alias: "development", name: "Coder", requestKey: requestKey() }),
      );
      setupId = setup.id;
      return original.call(this, value);
    });
    const completion = await manualCompletion(manual.connection.id, "A0MANUAL", "b".repeat(32));
    expect(spy).toHaveBeenCalled();
    expect(completion.status).toBe(409);
    expect(await body<{ error: { code: string } }>(completion)).toMatchObject({
      error: { code: "slack_manual_completion_blocked" },
    });
    expect(await connection(manual.connection.id)).toMatchObject({ status: "pending" });
    expect(await connectionCredential(manual.connection.id)).toBeNull();
    // The setup's route stands; the manual manifest's URL is the dead one.
    const { setup } = await ok<{ setup: SlackSetup }>(await read(setupId));
    expect(setup.phase).toBe("prepared");
    expect(await challenge(setupWebhookUrl(await setupRow(setup.id)))).toBe(200);
    expect(await challenge(manualWebhook)).toBe(401);
  });

  it("keeps a row the setup lost free of its signing secret when creation commits late", async () => {
    stubSlack();
    const project = await dedicatedTarget("late-commit");
    const input = { agentId: project.agentId, alias: "development", name: "Coder", requestKey: requestKey() };
    const { setup } = await ok<{ setup: SlackSetup }>(await start(input));
    // While the create is in flight neither a manual mint nor a cancel can
    // take the row (409 either way); a disconnect can.
    const original = AccountDurableObject.prototype.commitSlackSetupCreation;
    vi.spyOn(AccountDurableObject.prototype, "commitSlackSetupCreation").mockImplementationOnce(async function (
      this: AccountDurableObject,
      ...args
    ) {
      await ok(
        await SELF.fetch(`https://managedagents.test/v1/channels/slack/connections/${setup.connectionId}`, {
          method: "DELETE",
        }),
      );
      return original.apply(this, args);
    });
    const retried = await ok<{ setup: SlackSetup }>(await start({ ...input, configurationToken: CONFIG_TOKEN }));
    expect(retried.setup).toMatchObject({ phase: "cancelled", error: { code: "slack_setup_superseded" } });
    // The app credentials Slack returned are kept on the setup; the
    // connection the setup lost carries none of them.
    const row = await setupRow(setup.id);
    expect(row.app_id).toBe("A0AUTO");
    expect(row.client_secret_ciphertext).toBeTruthy();
    expect(row.signing_secret_ciphertext).toBeTruthy();
    expect(await connectionCredential(setup.connectionId)).toBeNull();
    expect(await connection(setup.connectionId)).toMatchObject({ status: "disconnected" });
  });

  it("advances the revision on distributed-app upserts and on disconnect", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const installation = {
      appId: "A0SHARED",
      provider: "slack",
      agentId: "shared-agent",
      alias: "development",
      channelId: "slack",
      workspaceId: "T0SHARED",
      botToken: "xoxb-shared",
      signingSecret: "d".repeat(32),
    };
    const first = await account.upsertAppInstallation(installation);
    expect(first.created).toBe(true);
    const created = await revisionOf(first.id);
    const second = await account.upsertAppInstallation({ ...installation, botToken: "xoxb-rotated" });
    expect(second).toEqual({ id: first.id, created: false });
    expect(await revisionOf(first.id)).toBe(created + 1);

    await account.createSlackConnection({
      id: "disconnect-me",
      agentId: "shared-agent",
      alias: "production",
      appName: "Coder",
    });
    const before = await revisionOf("disconnect-me");
    await account.disconnectChannelConnection("disconnect-me", "slack");
    expect(await revisionOf("disconnect-me")).toBe(before + 1);
  });

  it("refuses a manual save whose view of the connection is stale, even after Slack accepted it", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("stale-save");
    const manual = await manualReserve(project.agentId);
    // While the manual request waits on auth.test, the automated setup runs
    // to completion on the same row.
    let setupId = "";
    let interleaved = false;
    stub.authTest = async () => {
      if (!interleaved) {
        interleaved = true;
        const { setup } = await ok<{ setup: SlackSetup }>(
          await start({
            agentId: project.agentId,
            alias: "development",
            name: "Coder",
            requestKey: requestKey(),
            configurationToken: CONFIG_TOKEN,
          }),
        );
        setupId = setup.id;
        const { state } = await authorize(setup.id);
        expect(redirected(await callback({ state, code: CODE })).searchParams.get("slack")).toBe("connected");
      }
      return identity();
    };
    const save = await manualCompletion(manual.connection.id, "A0MANUAL", "b".repeat(32));
    expect(interleaved).toBe(true);
    expect(save.status).toBe(409);
    expect(await body<{ error: { code: string } }>(save)).toMatchObject({
      error: { code: "slack_manual_completion_blocked" },
    });
    // The bot the setup connected is untouched: its app, its secret, its route.
    expect(await connection(manual.connection.id)).toMatchObject({ status: "connected", appId: "A0AUTO" });
    expect((await ok<{ setup: SlackSetup }>(await read(setupId))).setup.phase).toBe("connected");
    const webhookUrl = requestUrlOf(stub);
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: "EvStale",
      api_app_id: "A0AUTO",
      team_id: "T0TEAM",
      event: { type: "app_mention", channel: "C1", user: "U1", ts: "555.5", text: "<@U0BOT> hi" },
    });
    const signedBySetup = await SELF.fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await slackSigned(payload, SIGNING_SECRET)) },
      body: payload,
    });
    expect(signedBySetup.status).toBe(200);
  });

  it("does not mark a connection failed on behalf of a manual save that no longer owns it", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("stale-failure");
    const manual = await manualReserve(project.agentId);
    let setupId = "";
    let interleaved = false;
    // The automated creation finishes while the manual request waits on
    // Slack; then Slack refuses the manual token.
    stub.authTest = async () => {
      if (!interleaved) {
        interleaved = true;
        const { setup } = await ok<{ setup: SlackSetup }>(
          await start({
            agentId: project.agentId,
            alias: "development",
            name: "Coder",
            requestKey: requestKey(),
            configurationToken: CONFIG_TOKEN,
          }),
        );
        setupId = setup.id;
        expect(setup.phase).toBe("app_created");
        return Response.json({ ok: false, error: "invalid_auth" });
      }
      return identity();
    };
    const revisionAfterReservation = async () => revisionOf(manual.connection.id);
    const save = await manualCompletion(manual.connection.id, "A0MANUAL", "b".repeat(32), "xoxb-mistyped");
    expect(interleaved).toBe(true);
    expect(save.status).toBe(502);
    // The Slack error is reported; the row the setup now owns is not marked failed.
    expect(await connection(manual.connection.id)).toMatchObject({ status: "pending" });
    const revision = await revisionAfterReservation();
    const authorizeResponse = await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setupId}/authorize`, {
      method: "POST",
    });
    expect(authorizeResponse.status).toBe(200);
    expect(await revisionOf(manual.connection.id)).toBe(revision);
  });

  it("never yields two connections for one target when a reservation lands inside the manual mint", async () => {
    stubSlack();
    const project = await dedicatedTarget("two-parties");
    let setupId = "";
    // Before the manual mint runs its transaction, the automated setup
    // reserves the same target.
    const prototype = AccountDurableObject.prototype as unknown as {
      mintSlackConnection: (...args: unknown[]) => unknown;
    };
    const original = prototype.mintSlackConnection;
    const spy = vi.spyOn(prototype, "mintSlackConnection").mockImplementationOnce(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const { setup } = await ok<{ setup: SlackSetup }>(
        await start({
          agentId: project.agentId,
          alias: "development",
          name: "Coder",
          requestKey: requestKey(),
          configurationToken: CONFIG_TOKEN,
        }),
      );
      setupId = setup.id;
      return original.apply(this, args);
    });
    const manual = await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${project.agentId}@development`, name: "Coder" }),
    });
    expect(spy).toHaveBeenCalled();
    responses.push(await manual.clone().text());
    // Both parties run to the end: the automated one connects; the manual
    // one was told a setup holds the target.
    const { state } = await authorize(setupId);
    expect(redirected(await callback({ state, code: CODE })).searchParams.get("slack")).toBe("connected");
    expect(manual.status).toBe(409);
    expect(await manual.json()).toMatchObject({
      error: { code: expect.stringMatching(/^slack_setup_active$|^slack_connection_changed$/) },
    });
    const rows = await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; status: string }>(
          "SELECT id, status FROM channel_connections WHERE channel = 'slack' AND agent_id = ? AND alias = 'development'",
          project.agentId,
        )
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "connected" });
  });

  it("settles an abandoned exchange claim itself before deciding whether a manual save may proceed", async () => {
    const { setup } = await connectAutomatically("abandoned-claim");
    // A re-authorization whose exchange never came back, past its bound, and
    // nothing has read the setup since (the dashboard does not read setups
    // for connected bots).
    await sql(
      "UPDATE slack_setups SET phase = 'exchanging', resume_phase = 'connected', attempt_id = 'lost', attempt_started_at = ? WHERE id = ?",
      Date.now() - 61_000,
      setup.id,
    );
    const repair = await manualCompletion(setup.connectionId, "A0AUTO", "c".repeat(32));
    expect(repair.status).toBe(200);
    expect(await connection(setup.connectionId)).toMatchObject({ status: "connected", appId: "A0AUTO" });
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).not.toBe("exchanging");
  });

  it("hides a setup from another project's identity", async () => {
    stubSlack();
    const project = await dedicatedTarget("owner");
    const other = await createProject("owner-other");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const foreign = { kind: "user" as const, userId: "local", accountId: "local", projectId: other.id };
    const base = "https://managedagents.test/v1/channels/slack/setups";
    const attempts = [
      new Request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: project.agentId,
          alias: "development",
          name: "Coder",
          requestKey: requestKey(),
        }),
      }),
      new Request(`${base}/${setup.id}`),
      new Request(`${base}?agentId=${project.agentId}&alias=development`),
      new Request(`${base}/${setup.id}/authorize`, { method: "POST" }),
      new Request(`${base}/${setup.id}/cancel`, { method: "POST" }),
    ];
    for (const request of attempts) {
      const response = await handleSlackSetupRoute(request, env, foreign);
      expect(response, request.url).not.toBeNull();
      expect(response!.status, request.url).toBe(404);
      expect(await body<{ error: { code: string } }>(response!)).toMatchObject({
        error: { code: "project_not_found" },
      });
    }
    // The owner still can.
    const owner = { ...foreign, projectId: project.id };
    const mine = await handleSlackSetupRoute(new Request(`${base}/${setup.id}`), env, owner);
    expect(mine!.status).toBe(200);
    expect((await ok<{ setup: SlackSetup }>(await read(setup.id))).setup.phase).toBe("app_created");
  });

  it("answers 503 when no callback is configured, and the manual flow is unchanged", async () => {
    stubSlack();
    const project = await dedicatedTarget("unconfigured");
    const bare = { ...env, BLUE_SLACK_OAUTH_REDIRECT_URI: undefined } as unknown as typeof env;
    const response = await handleSlackSetupRoute(
      new Request("https://managedagents.test/v1/channels/slack/setups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: project.agentId, alias: "development", name: "Coder", requestKey: requestKey() }),
      }),
      bare,
      { kind: "user", userId: "local", accountId: "local" },
    );
    expect(response!.status).toBe(503);
    expect(await body<{ error: { code: string } }>(response!)).toMatchObject({
      error: { code: "slack_setup_unavailable" },
    });
  });

  it("reports an abandoned creation or exchange claim instead of spinning forever", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("abandoned");
    const { setup } = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
      }),
    );
    expect(setup.phase).toBe("prepared");

    // The isolate died between claiming the create and hearing back.
    await sql(
      "UPDATE slack_setups SET phase = 'creating', attempt_id = 'lost', attempt_started_at = ? WHERE id = ?",
      Date.now() - 121_000,
      setup.id,
    );
    const stalled = await ok<{ setup: SlackSetup }>(await read(setup.id));
    expect(stalled.setup).toMatchObject({
      phase: "creation_uncertain",
      error: { code: "slack_creation_uncertain", recoverable: false },
    });

    // A recent claim is still in flight: a second submission joins it.
    await ok(
      await SELF.fetch(`https://managedagents.test/v1/channels/slack/setups/${setup.id}/cancel`, {
        method: "POST",
      }),
    );
    const second = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
      }),
    );
    await sql(
      "UPDATE slack_setups SET phase = 'creating', attempt_id = 'live', attempt_started_at = ? WHERE id = ?",
      Date.now(),
      second.setup.id,
    );
    const joined = await ok<{ setup: SlackSetup }>(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: second.setup.requestKey,
        configurationToken: CONFIG_TOKEN,
      }),
    );
    expect(joined.setup.phase).toBe("creating");
    expect(joined.setup.actions).toEqual([]);
    expect(calls(stub, "apps.manifest.create")).toHaveLength(0);

    // An exchange claim that never committed falls back to the app for a fresh authorization.
    await sql(
      "UPDATE slack_setups SET phase = 'exchanging', resume_phase = 'app_created', attempt_id = 'lost', attempt_started_at = ?, app_id = 'A0AUTO', client_id = '111.222' WHERE id = ?",
      Date.now() - 61_000,
      second.setup.id,
    );
    const fallen = await ok<{ setup: SlackSetup }>(await read(second.setup.id));
    expect(fallen.setup).toMatchObject({
      phase: "app_created",
      error: { code: "slack_exchange_uncertain", recoverable: true },
      actions: ["authorize", "manual", "cancel"],
    });
  });

  it("keeps every secret out of responses, records and logs", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const stub = stubSlack();
    const { setup } = await connectAutomatically("redaction", stub);
    await ok(await SELF.fetch("https://managedagents.test/v1/channels"));
    await ok(await read(setup.id));
    stubSlack({
      create: () =>
        Response.json({
          ok: false,
          error: "invalid_manifest",
          errors: [{ message: `token ${CONFIG_TOKEN} leaked`, pointer: "/x" }],
        }),
    });
    const other = await dedicatedTarget("redaction-other");
    await ok(
      await start({
        agentId: other.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );

    const row = await setupRow(setup.id);
    const plain = JSON.stringify(
      Object.fromEntries(
        Object.entries(row).filter(([column]) => !/ciphertext|_iv$/.test(column)),
      ),
    );
    for (const secret of SECRETS) {
      for (const response of responses) expect(response, secret).not.toContain(secret);
      for (const line of logged) expect(line, secret).not.toContain(secret);
      expect(plain, secret).not.toContain(secret);
    }
    expect(row.client_secret_ciphertext).toBeTruthy();
    expect(row.signing_secret_ciphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET);
    // Phase transitions were logged, structurally, without provider bodies.
    const transitions = logged.filter((line) => line.includes('"slack.setup.phase"'));
    expect(transitions.length).toBeGreaterThanOrEqual(3);
    for (const line of transitions) expect(line).not.toContain("credentials");
  });

  it("generates the automated app from the same manifest the manual flow hands out", async () => {
    const stub = stubSlack();
    const project = await dedicatedTarget("equal");
    await ok(
      await start({
        agentId: project.agentId,
        alias: "development",
        name: "Coder",
        requestKey: requestKey(),
        configurationToken: CONFIG_TOKEN,
      }),
    );
    const automated = JSON.parse(calls(stub, "apps.manifest.create")[0]!.form.get("manifest") ?? "") as Record<string, unknown>;

    const other = await dedicatedTarget("equal-manual");
    const manual = await ok<{ manifest: Record<string, unknown> }>(
      await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${other.agentId}@development`, name: "Coder" }),
      }),
    );
    const strip = (manifest: Record<string, unknown>) =>
      JSON.parse(
        JSON.stringify(manifest).replace(/https:\/\/managedagents\.test\/v1\/webhooks\/slack\/[^/"]+\/[a-f0-9]{32}/g, "URL"),
      ) as unknown;
    expect(strip(automated)).toEqual(strip(manual.manifest));
  });
});
