// Work 037 Phase 2a harness: a fake Linear API and playback of the provider
// spike's recorded deliveries (test/fixtures/linear/spike-playback.json)
// through the real edge route, for the `linear-fault-matrix` and
// `linear-ask-integrated` vitest projects.
//
// Linear is a fetch stub installed in the test isolate, which the Account
// and Session objects share; it serves the OAuth token exchange, `viewer`,
// `agentActivityCreate` with Linear's id-conflict semantics (spike part 1),
// `agentActivity(id)`, `agentSessionUpdate`, and the `issue` and
// `agentSession` provider-context queries. Every other request goes to the
// original fetch (the harness's outbound service). Recorded bodies are
// re-signed with the test secret; their ISO timestamps are moved by one
// offset per scenario, so the createdAt relations between prompts,
// elicitations and stops are the recorded ones, and `webhookTimestamp` is
// "now" minus the recorded skew. Linear's payload `agentSession.status` is
// carried through as recorded and never read here.

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { expect, vi } from "vitest";

import playback from "./fixtures/linear/spike-playback.json" with { type: "json" };

export const BASE = "https://managedagents.test";
const SIGNING_SECRET = "lin_wh_fixture-signing-secret";
const ACCESS_TOKEN = "lin_oauth_fixture-access-token";
const REFRESH_TOKEN = "lin_refresh_fixture-refresh-token";

interface RecordedDelivery {
  kind: "delivery";
  at: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & {
    action: string;
    webhookTimestamp: number;
    agentSession: { id: string; issueId: string; issue: Record<string, unknown> };
    agentActivity?: { id: string; createdAt: string; signal: string | null; content: { body: string } };
    promptContext?: string | null;
  };
}

interface RecordedActivity {
  kind: "activity_create";
  at: string;
  input: { agentSessionId: string; content: Record<string, unknown>; id?: string };
  response: { status: number; data?: unknown; errors?: unknown[] };
}

type Recorded = RecordedDelivery | RecordedActivity;

const recorded = playback as unknown as Recorded[];

export function recordedDelivery(index: number): RecordedDelivery {
  const entry = recorded[index];
  if (entry?.kind !== "delivery") throw new Error(`Playback entry ${String(index)} is not a delivery`);
  return entry;
}

export function recordedActivity(index: number): RecordedActivity {
  const entry = recorded[index];
  if (entry?.kind !== "activity_create") {
    throw new Error(`Playback entry ${String(index)} is not an activity create`);
  }
  return entry;
}

/** The recorded workspace, app client and app user (ids are as recorded). */
const first = recordedDelivery(0).body;
export const ORGANIZATION_ID = first.organizationId as string;
export const CLIENT_ID = first.oauthClientId as string;
export const APP_USER_ID = first.appUserId as string;

/** The offset that moves recorded entry `index` to now. */
export function shiftToNow(index: number): number {
  return Date.now() - Date.parse(recorded[index]!.at);
}

/** Linear's `createdAt` of a recorded activity create (the elicitation's time, say). */
export function recordedActivityCreatedAt(index: number): string {
  const data = recordedActivity(index).response.data as {
    agentActivityCreate: { agentActivity: { createdAt: string } };
  };
  return data.agentActivityCreate.agentActivity.createdAt;
}

// ── Fake Linear ──────────────────────────────────────────────────────────────

export interface ActivityInput {
  id: string;
  agentSessionId: string;
  content: { type: string; body?: string; action?: string };
  ephemeral?: boolean;
  signal?: string;
  signalMetadata?: { options: Array<{ label: string; value: string }> };
}

export interface ActivityAttempt {
  input: ActivityInput;
  /** created: stored now; conflict: the id was stored before; rejected: an injected failure. */
  outcome: "created" | "conflict" | "rejected";
  at: number;
}

export interface FakeLinear {
  /** What Linear holds: one activity per id, with its `createdAt`. */
  activities: Map<string, { input: ActivityInput; createdAt: string; at: number }>;
  /** Every `agentActivityCreate` call, in arrival order. */
  attempts: ActivityAttempt[];
  sessionUpdates: Array<{ id: string; input: unknown }>;
  queries: Array<{ query: string; variables: Record<string, unknown> }>;
  /**
   * A body to answer one create with instead of storing it (a recorded
   * failure); consulted for every create until it returns undefined.
   */
  reject?: (input: ActivityInput) => unknown;
  /**
   * Called after a create is stored and before Linear answers: a promise
   * delays the answer (the request reached Linear; its response is late).
   */
  delay?: (input: ActivityInput) => Promise<void> | undefined;
  /** Linear's clock against ours, added to every `createdAt` it assigns (negative: Linear is behind). */
  skewMs: number;
  /** The issue facts the provider-context queries return. */
  issueCreator: string;
  issueParent: { id: string; identifier: string } | null;
  /** Posted activities of one Linear session, in Linear's order. */
  posted(agentSessionId: string): Array<ActivityInput & { createdAt: string }>;
}

function graphqlOk(data: unknown): Response {
  return Response.json({ data });
}

/** Linear's answer to a repeated id (spike entry 10, as recorded). */
function conflictBody(): unknown {
  return recordedActivity(10).response;
}

function issueOfSession(agentSessionId: string): Record<string, unknown> {
  for (const entry of recorded) {
    if (entry.kind === "delivery" && entry.body.agentSession.id === agentSessionId) {
      return entry.body.agentSession.issue;
    }
  }
  throw new Error(`No recorded delivery for agent session ${agentSessionId}`);
}

export function installFakeLinear(): FakeLinear {
  const original = globalThis.fetch.bind(globalThis);
  const fake: FakeLinear = {
    activities: new Map(),
    attempts: [],
    sessionUpdates: [],
    queries: [],
    issueCreator: "00000000-0000-4000-8000-000000000031",
    issueParent: null,
    skewMs: 0,
    posted(agentSessionId) {
      return [...fake.activities.values()]
        .filter((entry) => entry.input.agentSessionId === agentSessionId)
        .sort((left, right) => left.at - right.at)
        .map((entry) => ({ ...entry.input, createdAt: entry.createdAt }));
    },
  };
  let clock = 0;
  const graphql = async (body: { query: string; variables?: Record<string, unknown> }): Promise<Response> => {
    const query = body.query;
    const variables = body.variables ?? {};
    fake.queries.push({ query, variables });
    if (/\bviewer\b/.test(query)) {
      return graphqlOk({ viewer: { id: APP_USER_ID, organization: { id: ORGANIZATION_ID } } });
    }
    if (query.includes("agentActivityCreate")) {
      const input = variables.input as ActivityInput;
      const at = Date.now() * 1_000 + (clock += 1);
      const rejected = fake.reject?.(input);
      if (rejected !== undefined) {
        fake.attempts.push({ input, outcome: "rejected", at });
        return Response.json(rejected);
      }
      if (fake.activities.has(input.id)) {
        fake.attempts.push({ input, outcome: "conflict", at });
        return Response.json(conflictBody());
      }
      const createdAt = new Date(Date.now() + fake.skewMs).toISOString();
      fake.activities.set(input.id, { input, createdAt, at });
      fake.attempts.push({ input, outcome: "created", at });
      const delayed = fake.delay?.(input);
      if (delayed) await delayed;
      return graphqlOk({
        agentActivityCreate: {
          success: true,
          agentActivity: {
            id: input.id,
            createdAt,
            signal: input.signal ?? null,
            ephemeral: input.ephemeral ?? false,
            content: { __typename: "AgentActivityContent" },
          },
        },
      });
    }
    if (/agentActivity\s*\(/.test(query)) {
      const stored = fake.activities.get(String(variables.id));
      return graphqlOk({
        agentActivity: stored
          ? { id: variables.id, createdAt: stored.createdAt, content: { __typename: "AgentActivityContent" } }
          : null,
      });
    }
    if (query.includes("agentSessionUpdate")) {
      fake.sessionUpdates.push({ id: String(variables.id), input: variables.input });
      return graphqlOk({ agentSessionUpdate: { success: true } });
    }
    if (/agentSession\s*\(/.test(query)) {
      const id = String(variables.id);
      return graphqlOk({
        agentSession: {
          id,
          issue: { ...issueOfSession(id), parent: fake.issueParent, creator: { id: fake.issueCreator } },
        },
      });
    }
    if (/issue\s*\(/.test(query)) {
      return graphqlOk({
        issue: { id: variables.id, parent: fake.issueParent, creator: { id: fake.issueCreator } },
      });
    }
    return Response.json({ errors: [{ message: `fake Linear: unexpected query ${query.slice(0, 80)}` }] });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname !== "api.linear.app") return original(input, init);
      if (url.pathname === "/oauth/token") {
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 86_399,
          scope: "read write app:assignable app:mentionable",
        });
      }
      if (url.pathname === "/oauth/revoke") return new Response(null, { status: 200 });
      if (url.pathname === "/graphql") {
        if (request.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
          return Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
        }
        return graphql(await request.json());
      }
      return new Response("fake Linear: unexpected path", { status: 599 });
    }),
  );
  return fake;
}

// ── The connection ───────────────────────────────────────────────────────────

export interface LinearFixture {
  projectId: string;
  agentId: string;
  connectionId: string;
  webhookUrl: string;
}

async function ok<T>(response: Response): Promise<T> {
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return JSON.parse(text) as T;
}

function postJson(url: string, method: string, body?: unknown): Promise<Response> {
  return SELF.fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function createProject(slug: string): Promise<{ id: string; agentId: string }> {
  const project = await ok<{ id: string; agents: Array<{ id: string }> }>(
    await postJson(`${BASE}/v1/projects`, "POST", { name: slug, slug }),
  );
  return { id: project.id, agentId: project.agents[0]!.id };
}

/**
 * A connected Linear connection on the project's agent in `development`,
 * through the real routes: allocate, credentials (the recorded client id),
 * authorize, the OAuth callback against the fake token endpoint.
 */
export async function connectLinear(project: { id: string; agentId: string }): Promise<LinearFixture> {
  const allocated = await ok<{ connectionId: string; webhookUrl: string }>(
    await postJson(`${BASE}/v1/projects/${project.id}/linear/connections`, "POST", {
      name: "Atlas",
      environment: "development",
      agentId: project.agentId,
    }),
  );
  await ok(
    await postJson(`${BASE}/v1/linear/connections/${allocated.connectionId}/credentials`, "PUT", {
      clientId: CLIENT_ID,
      clientSecret: "fixture-client-secret",
      signingSecret: SIGNING_SECRET,
    }),
  );
  const { authorizeUrl } = await ok<{ authorizeUrl: string }>(
    await SELF.fetch(`${BASE}/v1/linear/connections/${allocated.connectionId}/authorize`, { method: "POST" }),
  );
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  const callback = new URL(`${BASE}/v1/linear/oauth/callback`);
  callback.searchParams.set("code", "fixture-auth-code");
  callback.searchParams.set("state", state);
  const returned = await SELF.fetch(callback, { redirect: "manual" });
  expect(returned.status).toBe(302);
  expect(new URL(returned.headers.get("location") ?? "").searchParams.get("linear")).toBe("connected");
  return {
    projectId: project.id,
    agentId: project.agentId,
    connectionId: allocated.connectionId,
    webhookUrl: allocated.webhookUrl,
  };
}

// ── Playback ─────────────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function shiftTimes(value: unknown, shiftMs: number): unknown {
  if (typeof value === "string" && ISO.test(value)) {
    return new Date(Date.parse(value) + shiftMs).toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => shiftTimes(item, shiftMs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftTimes(item, shiftMs)]),
    );
  }
  return value;
}

async function sign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface PreparedDelivery {
  deliveryId: string;
  agentSessionId: string;
  body: RecordedDelivery["body"];
  /** The prompt's own (shifted) `createdAt`, when it is a prompt. */
  promptCreatedAt?: string;
  /** Sends these exact bytes and headers again (a redelivery). */
  send(): Promise<Response>;
}

/**
 * One recorded delivery, ready to send: every ISO time in the body moved by
 * `shiftMs`, `webhookTimestamp` set to now minus the recorded skew, the body
 * optionally edited (a test directive for the fake runtime, say), and
 * re-signed. The `Linear-Delivery` id is the recorded one.
 */
export async function prepare(
  fixture: LinearFixture,
  index: number,
  options: { shiftMs: number; edit?: (body: RecordedDelivery["body"]) => void },
): Promise<PreparedDelivery> {
  const entry = recordedDelivery(index);
  const body = shiftTimes(structuredClone(entry.body), options.shiftMs) as RecordedDelivery["body"];
  options.edit?.(body);
  const skew = Date.parse(entry.at) - entry.body.webhookTimestamp;
  body.webhookTimestamp = Date.now() - Math.max(0, skew);
  const raw = JSON.stringify(body);
  const headers = {
    ...entry.headers,
    "linear-signature": await sign(raw),
    "linear-timestamp": String(body.webhookTimestamp),
  };
  return {
    deliveryId: entry.headers["linear-delivery"]!,
    agentSessionId: body.agentSession.id,
    body,
    ...(body.agentActivity ? { promptCreatedAt: body.agentActivity.createdAt } : {}),
    send: () => SELF.fetch(fixture.webhookUrl, { method: "POST", headers, body: raw }),
  };
}

/** Prepare and send; the route must accept it. */
export async function deliver(
  fixture: LinearFixture,
  index: number,
  options: { shiftMs: number; edit?: (body: RecordedDelivery["body"]) => void },
): Promise<PreparedDelivery & { accepted: Record<string, unknown> }> {
  const prepared = await prepare(fixture, index, options);
  const response = await prepared.send();
  const accepted = await ok<Record<string, unknown>>(response);
  return { ...prepared, accepted };
}

// ── The Account object ───────────────────────────────────────────────────────

export function account() {
  return env.ACCOUNTS.getByName("local");
}

export interface LedgerRow {
  id: string;
  event: string;
  kind: string;
  state: string;
  provider_time: string;
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  receipt_json: string | null;
  ack_activity_id: string | null;
  ack_state: string | null;
  session_id: string | null;
}

export async function ledger(deliveryId: string): Promise<LedgerRow | undefined> {
  return runInDurableObject(account(), (_instance, state) =>
    state.storage.sql
      .exec("SELECT * FROM linear_deliveries WHERE id = ?", deliveryId)
      .toArray()[0] as LedgerRow | undefined,
  );
}

export async function ledgerRows(): Promise<LedgerRow[]> {
  return runInDurableObject(account(), (_instance, state) =>
    state.storage.sql
      .exec("SELECT * FROM linear_deliveries ORDER BY received_at, id")
      .toArray() as unknown as LedgerRow[],
  );
}

export async function mapEntries(): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(account(), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM linear_sessions").toArray() as Array<Record<string, unknown>>,
  );
}

/** Run the Account alarm until `done` holds (the ledger is enacted by alarm). */
export async function driveAccount(done: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    await runDurableObjectAlarm(account());
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Wait (and drive both objects' alarms) until `done` holds. */
export async function until(
  done: () => Promise<boolean>,
  what: string,
  sessionIds: string[] = [],
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    await runDurableObjectAlarm(account());
    for (const id of sessionIds) await runDurableObjectAlarm(env.SESSIONS.getByName(id));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Make a ledger row due now: the backoff or lease it waits on has elapsed. */
export async function elapse(deliveryId: string): Promise<void> {
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE linear_deliveries SET next_attempt_at = ? WHERE id = ? AND next_attempt_at IS NOT NULL",
      new Date(Date.now() - 1).toISOString(),
      deliveryId,
    );
  });
}
