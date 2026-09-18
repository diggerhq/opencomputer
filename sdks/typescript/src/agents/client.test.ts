import { describe, expect, expectTypeOf, it } from "vitest";
import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";

interface Call { method: string; path: string; headers: Record<string, string>; body?: unknown }

// A fake of the management API that records every call and answers from a
// table keyed by `METHOD /path`. Unlisted routes answer 404 with the API's
// error envelope.
function fakeApi(routes: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const call: Call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as unknown;
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (route) return route(call);
    return Response.json({ error: { code: "not_found", message: `no route ${call.method} ${url.pathname}` } }, { status: 404 });
  };
  return { calls, fetch, last: () => calls[calls.length - 1] };
}

const oc = (api: ReturnType<typeof fakeApi>) => new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

describe("OpenComputer client", () => {
  it("sends the API key, JSON and the Idempotency-Key on create, and reports 200 as not created", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions": (call) =>
        Response.json(
          { session: { id: "ses_1", status: "new", createdAt: "t" }, deployment: { id: "dep_1", agentId: "worker", alias: "development", createdAt: "t" } },
          { status: call.headers["idempotency-key"] === "again" ? 200 : 201 },
        ),
    });
    const created = await oc(api).sessions.create(
      { agentId: "worker@development", labels: { request: "task_1" } },
      { idempotencyKey: "task_1" },
    );
    expect(created).toEqual({
      session: { id: "ses_1", status: "new", createdAt: "t" },
      deployment: { id: "dep_1", agentId: "worker", alias: "development", createdAt: "t" },
      created: true,
    });
    expect(api.last()).toMatchObject({
      method: "POST",
      path: "/api/managed-agents/sessions",
      headers: { "x-api-key": "osb_test", "content-type": "application/json", "idempotency-key": "task_1" },
      body: { agentId: "worker@development", labels: { request: "task_1" } },
    });
    const replay = await oc(api).sessions.create({ agentId: "worker@development" }, { idempotencyKey: "again" });
    expect(replay.created).toBe(false);
    const bare = await oc(api).sessions.create({ agentId: "worker@development" });
    expect(bare.created).toBe(true);
    expect(api.last().headers["idempotency-key"]).toBeUndefined();
  });

  it("gets, ends, interrupts and labels a session on the documented routes", async () => {
    const session = { id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", source: "api", turns: [], createdAt: "t", updatedAt: "t" };
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1": () => Response.json(session),
      "POST /api/managed-agents/sessions/ses_1/end": () => Response.json({ ...session, status: "ended" }),
      "POST /api/managed-agents/sessions/ses_1/interrupt": () => Response.json(session),
      "PATCH /api/managed-agents/sessions/ses_1/labels": (call) => Response.json({ ...session, labels: (call.body as { set: unknown }).set }),
    });
    const client = oc(api);
    expect(await client.sessions.get("ses_1")).toEqual(session);
    expect((await client.sessions.end("ses_1")).status).toBe("ended");
    expect((await client.sessions.interrupt("ses_1")).id).toBe("ses_1");
    const labelled = await client.sessions.setLabels("ses_1", { set: { title: "Fix login" }, unset: ["archived"] });
    expect(labelled.labels).toEqual({ title: "Fix login" });
    expect(api.last()).toMatchObject({ method: "PATCH", body: { set: { title: "Fix login" }, unset: ["archived"] } });
  });

  it("lists sessions with filters, label filters and paging, and normalizes a missing cursor", async () => {
    const row = (id: string) => ({
      id, projectId: "prj_1", agentId: "worker", deploymentId: "dep_1", environment: null, source: "api", status: "idle",
      labels: {}, createdAt: "t", updatedAt: "t", revision: 1,
      activity: { activeTurnId: null, queued: 0, lastSettledTurn: null }, result: null,
    });
    const rows = [row("ses_2"), row("ses_1")];
    let withCursor = true;
    const api = fakeApi({
      "GET /api/managed-agents/sessions": () => Response.json(withCursor ? { sessions: rows, nextCursor: "c2" } : { sessions: rows }),
    });
    const page = await oc(api).sessions.list({
      project: "prj_1", environment: "development", agent: "worker", status: "idle",
      labels: { request: "task_1", archived: "false" }, cursor: "c1", limit: 20,
    });
    expect(page).toEqual({ sessions: rows, nextCursor: "c2" });
    const query = new URL(`https://x${api.last().path}`).searchParams;
    expect(Object.fromEntries(query.entries())).toEqual({
      project: "prj_1", environment: "development", agent: "worker", status: "idle",
      "label.request": "task_1", "label.archived": "false", cursor: "c1", limit: "20",
    });
    withCursor = false;
    expect(await oc(api).sessions.list()).toEqual({ sessions: rows, nextCursor: null });
    expect(api.last().path).toBe("/api/managed-agents/sessions");
  });

  it("sends a turn with its key as the Idempotency-Key header, its mode and payload, and reads the receipt from 202 and 200", async () => {
    let duplicate = false;
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_1/turns": () =>
        Response.json({ turnId: "turn_1", status: duplicate ? "running" : "queued", duplicate }, { status: duplicate ? 200 : 202 }),
    });
    const client = oc(api);
    const receipt = await client.sessions.turns.send("ses_1", {
      input: "Fix the login page.",
      idempotencyKey: "task_1/start",
      payload: { repo: "acme/web", ref: "main" },
    });
    expect(receipt).toEqual({ turnId: "turn_1", status: "queued", duplicate: false });
    // One rule for both routes: the key is the header, never the body.
    expect(api.last().headers["idempotency-key"]).toBe("task_1/start");
    expect(api.last().body).toEqual({
      input: "Fix the login page.",
      payload: { repo: "acme/web", ref: "main" },
    });
    duplicate = true;
    expect(await client.sessions.turns.send("ses_1", { input: "again", mode: "steer" })).toEqual({
      turnId: "turn_1", status: "running", duplicate: true,
    });
    expect(api.last().headers["idempotency-key"]).toBeUndefined();
    expect(api.last().body).toEqual({ input: "again", mode: "steer" });
  });

  it("reads the event log from a cursor", async () => {
    const events = [{ id: "e1", seq: 1, timestamp: "t", sessionId: "ses_1", type: "session.created", data: { agentId: "worker", deploymentId: "dep_1" } }];
    const api = fakeApi({ "GET /api/managed-agents/sessions/ses_1/events": () => Response.json({ events }) });
    expect(await oc(api).sessions.events.list("ses_1", { after: 7 })).toEqual(events);
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/events?after=7");
    await oc(api).sessions.events.list("ses_1");
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/events?after=0");
  });

  it("covers projects, agents and deployments", async () => {
    const project = { id: "prj_1", slug: "p", name: "P", environments: [], agents: [], createdAt: "t", updatedAt: "t" };
    const api = fakeApi({
      "GET /api/managed-agents/projects": () => Response.json({ projects: [project] }),
      "POST /api/managed-agents/projects": () => Response.json(project, { status: 201 }),
      "GET /api/managed-agents/projects/prj_1": () =>
        Response.json({ project, deployments: [], sessions: [], connections: [], channels: [], schedules: [] }),
      "GET /api/managed-agents/agents": () => Response.json({ agents: [{ id: "worker", name: "Worker", activeAlias: "development" }] }),
      "GET /api/managed-agents/deployments": () => Response.json({ deployments: [{ id: "dep_1", agentId: "worker", alias: "development", createdAt: "t" }] }),
      "GET /api/managed-agents/deployments/dep_1": () => Response.json({ id: "dep_1", agentId: "worker", alias: "development", createdAt: "t" }),
    });
    const client = oc(api);
    expect(await client.projects.list()).toEqual([project]);
    expect((await client.projects.create({ name: "P" })).id).toBe("prj_1");
    expect((await client.projects.get("prj_1")).project).toEqual(project);
    expect((await client.agents.list())[0].activeAlias).toBe("development");
    expect((await client.deployments.list({ agentId: "worker" }))[0].id).toBe("dep_1");
    expect(api.last().path).toBe("/api/managed-agents/deployments?agentId=worker");
    expect((await client.deployments.get("dep_1")).alias).toBe("development");
  });

  // The agent a new project creates has no deployment yet, and the API lists
  // it with `activeAlias: null, activeDeploymentId: null`. A validator that
  // took only a string or an absence failed the whole list on that one row.
  it("lists an agent that has no deployment yet: its activation fields are null and the list still comes back", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/agents": () =>
        Response.json({
          agents: [
            { id: "worker", name: "Worker", activeAlias: "development", activeDeploymentId: "dep_1", deploymentCount: 1, createdAt: "t", updatedAt: "t" },
            { id: "fresh", name: "Fresh", activeAlias: null, activeDeploymentId: null, deploymentCount: 0, createdAt: "t", updatedAt: "t" },
          ],
        }),
    });
    const agents = await oc(api).agents.list();
    expect(agents.map((agent) => agent.id)).toEqual(["worker", "fresh"]);
    expect(agents[0]).toMatchObject({ activeAlias: "development", activeDeploymentId: "dep_1" });
    expect(agents[1]).toMatchObject({ activeAlias: null, activeDeploymentId: null, deploymentCount: 0 });
    expectTypeOf(agents[1]!.activeAlias).toEqualTypeOf<string | null | undefined>();
    expectTypeOf(agents[1]!.activeDeploymentId).toEqualTypeOf<string | null | undefined>();
  });

  it("drives memory documents with the conditional headers the API requires", async () => {
    const doc = { id: "workshop", title: "W", text: "", summary: "", agentWrites: "enabled", revision: "r1", bytes: 0, maxBytes: 8192, updatedAt: "t", writer: { kind: "owner" } };
    const api = fakeApi({
      "GET /api/managed-agents/projects/prj_1/memory": () => Response.json({ resources: [] }),
      "GET /api/managed-agents/projects/prj_1/memory/notes/documents": () => Response.json({ documents: [doc], nextCursor: null }),
      "GET /api/managed-agents/projects/prj_1/memory/notes/documents/workshop": () => Response.json(doc),
      "PUT /api/managed-agents/projects/prj_1/memory/notes/documents/workshop": () => Response.json(doc, { status: 201 }),
      "PATCH /api/managed-agents/projects/prj_1/memory/notes/documents/workshop": () => Response.json(doc),
      "DELETE /api/managed-agents/projects/prj_1/memory/notes/documents/workshop": () => new Response(null, { status: 204 }),
    });
    const memory = oc(api).projects.memory;
    const env = { environment: "development" as const };
    expect(await memory.resources("prj_1", env)).toEqual({ resources: [] });
    expect(api.last().path).toBe("/api/managed-agents/projects/prj_1/memory?environment=development");
    expect((await memory.documents.list("prj_1", "notes", { ...env, cursor: "c" })).documents).toEqual([doc]);
    expect(api.last().path).toContain("cursor=c");
    expect(await memory.documents.get("prj_1", "notes", "workshop", env)).toEqual(doc);
    await memory.documents.create("prj_1", "notes", "workshop", { title: "W", text: "" }, env);
    expect(api.last()).toMatchObject({ method: "PUT", headers: { "if-none-match": "*" }, body: { title: "W", text: "" } });
    await memory.documents.replace("prj_1", "notes", "workshop", { text: "new" }, { ...env, revision: "r1" });
    expect(api.last()).toMatchObject({ method: "PUT", headers: { "if-match": '"r1"' }, body: { text: "new" } });
    await memory.documents.patch("prj_1", "notes", "workshop", { agentWrites: "disabled" }, { ...env, revision: '"r1"' });
    expect(api.last()).toMatchObject({ method: "PATCH", headers: { "if-match": '"r1"' } });
    await memory.documents.delete("prj_1", "notes", "workshop", { ...env, revision: "r1" });
    expect(api.last()).toMatchObject({ method: "DELETE", headers: { "if-match": '"r1"' } });
  });

  it("covers webhooks, event subscriptions and the repository listing", async () => {
    const webhook = { id: "wh_1", projectId: "prj_1", environment: "development", agentId: "worker", name: "gh", enabled: true, invocationUrl: "https://x/wh_1/tok", token: "tok", createdAt: "t", updatedAt: "t" };
    const subscription = { id: "evs_1", projectId: "prj_1", events: ["turn.completed"], destination: { type: "session", sessionId: "ses_c" }, createdAt: "t" };
    const api = fakeApi({
      "GET /api/managed-agents/projects/prj_1/webhooks": () => Response.json({ webhooks: [webhook] }),
      "POST /api/managed-agents/projects/prj_1/webhooks": () => Response.json({ webhook }, { status: 201 }),
      "PATCH /api/managed-agents/projects/prj_1/webhooks/wh_1": () => Response.json({ webhook: { ...webhook, enabled: false } }),
      "POST /api/managed-agents/projects/prj_1/webhooks/wh_1/rotate-token": () => Response.json({ webhook }),
      "DELETE /api/managed-agents/projects/prj_1/webhooks/wh_1": () => new Response(null, { status: 204 }),
      "GET /api/managed-agents/projects/prj_1/webhooks/wh_1/requests": () => Response.json({ requests: [{ id: "req_1" }] }),
      "POST /api/managed-agents/projects/prj_1/event-subscriptions": () => Response.json({ subscription }, { status: 201 }),
      "GET /api/managed-agents/projects/prj_1/event-subscriptions": () => Response.json({ subscriptions: [subscription] }),
      "GET /api/managed-agents/projects/prj_1/event-subscriptions/evs_1": () => Response.json({ subscription }),
      "DELETE /api/managed-agents/projects/prj_1/event-subscriptions/evs_1": () => new Response(null, { status: 204 }),
      "GET /api/managed-agents/projects/prj_1/github/repositories": () =>
        Response.json({ repositories: [{ id: 1, fullName: "acme/web", private: true, defaultBranch: "main", archived: false }] }),
    });
    const projects = oc(api).projects;
    expect(await projects.webhooks.list("prj_1", { environment: "development" })).toEqual([webhook]);
    expect(api.last().path).toBe("/api/managed-agents/projects/prj_1/webhooks?environment=development");
    expect(await projects.webhooks.create("prj_1", { name: "gh", agentId: "worker", environment: "development" })).toEqual(webhook);
    expect((await projects.webhooks.update("prj_1", "wh_1", { enabled: false, identity: null })).enabled).toBe(false);
    expect(api.last().body).toEqual({ enabled: false, identity: null });
    expect((await projects.webhooks.rotateToken("prj_1", "wh_1")).token).toBe("tok");
    await projects.webhooks.delete("prj_1", "wh_1");
    expect(await projects.webhooks.requests("prj_1", "wh_1")).toEqual([{ id: "req_1" }]);

    expect(await projects.eventSubscriptions.create("prj_1", { events: ["turn.completed"], destination: { type: "session", sessionId: "ses_c" } })).toEqual(subscription);
    expect(await projects.eventSubscriptions.list("prj_1")).toEqual([subscription]);
    expect(await projects.eventSubscriptions.get("prj_1", "evs_1")).toEqual(subscription);
    await projects.eventSubscriptions.delete("prj_1", "evs_1");
    expect(api.last().method).toBe("DELETE");

    const repositories = await projects.github.repositories("prj_1", { environment: "development", limit: 50 });
    expect(repositories).toEqual({
      repositories: [{ id: 1, fullName: "acme/web", private: true, defaultBranch: "main", archived: false }],
      nextCursor: null,
    });
    expect(api.last().path).toBe("/api/managed-agents/projects/prj_1/github/repositories?environment=development&limit=50");
  });

  it("throws one error shape for every failure: the API's code, a status-derived code, or the bare text", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/sessions/conflict": () =>
        Response.json({ error: { code: "idempotency_conflict", message: "different inputs" } }, { status: 409 }),
      "GET /api/managed-agents/sessions/bare": () => Response.json({ error: "Unauthorized" }, { status: 401 }),
      "GET /api/managed-agents/sessions/text": () => new Response("Bad Gateway", { status: 502 }),
      "GET /api/managed-agents/sessions/limited": () =>
        Response.json({ error: { code: "rate_limited", message: "slow down" } }, { status: 429, headers: { "retry-after": "3" } }),
    });
    const client = oc(api);
    const conflict = await client.sessions.get("conflict").catch((cause: unknown) => cause);
    expect(conflict).toBeInstanceOf(OpenComputerError);
    expect(conflict).toMatchObject({ code: "idempotency_conflict", status: 409, message: "different inputs" });
    expect(await client.sessions.get("bare").catch((cause: unknown) => cause)).toMatchObject({
      code: "unauthorized", status: 401, message: "Unauthorized",
    });
    expect(await client.sessions.get("text").catch((cause: unknown) => cause)).toMatchObject({
      code: "unavailable", status: 502, message: "Bad Gateway",
    });
    expect(await client.sessions.get("missing").catch((cause: unknown) => cause)).toMatchObject({
      code: "not_found", status: 404,
    });
    expect(await client.sessions.get("limited").catch((cause: unknown) => cause)).toMatchObject({
      code: "rate_limited", status: 429, retryAfter: 3,
    });
  });

  it("fails a success whose body is not JSON or not the documented shape with invalid_response, and passes unknown fields through", async () => {
    const session = { id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", source: "api", turns: [], createdAt: "t", updatedAt: "t" };
    const api = fakeApi({
      "GET /api/managed-agents/sessions/text": () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      "GET /api/managed-agents/sessions/shape": () => Response.json({ ...session, turns: "none" }),
      "GET /api/managed-agents/sessions/extra": () => Response.json({ ...session, nextThing: { added: true } }),
    });
    const client = oc(api);
    // A 200 with a text body is not a session; before validation it came back typed as one.
    const text = await client.sessions.get("text").catch((cause: unknown) => cause);
    expect(text).toBeInstanceOf(OpenComputerError);
    expect(text).toMatchObject({ code: "invalid_response", status: 200 });
    expect((text as Error).message).toMatch(/GET \/sessions\/text/);
    const shape = await client.sessions.get("shape").catch((cause: unknown) => cause);
    expect(shape).toMatchObject({ code: "invalid_response", status: 200 });
    expect((shape as Error).message).toMatch(/turns/);
    expect(await client.sessions.get("extra")).toEqual({ ...session, nextThing: { added: true } });
  });

  // `projectId` is on every session the API returns and an authorization
  // check reads it. The session shape did not name it: the type did not
  // offer it, and a value of the wrong type passed through unchecked.
  it("reads projectId on a session, checks it is a string, and accepts a session that has none", async () => {
    const session = { id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", source: "api", turns: [], createdAt: "t", updatedAt: "t" };
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1": () => Response.json({ ...session, projectId: "prj_1" }),
      "GET /api/managed-agents/sessions/wrong": () => Response.json({ ...session, id: "wrong", projectId: 42 }),
      "GET /api/managed-agents/sessions/older": () => Response.json({ ...session, id: "older" }),
    });
    const client = oc(api);
    const got = await client.sessions.get("ses_1");
    expect(got.projectId).toBe("prj_1");
    expectTypeOf(got.projectId).toEqualTypeOf<string | undefined>();
    const wrong = await client.sessions.get("wrong").catch((cause: unknown) => cause);
    expect(wrong).toMatchObject({ code: "invalid_response", status: 200 });
    expect((wrong as Error).message).toMatch(/projectId/);
    expect((await client.sessions.get("older")).projectId).toBeUndefined();
  });

  // Application data is the application's. A body whose JSON has a key named
  // `__proto__` is valid JSON, and parsing keeps it as an own key; a
  // validator that rebuilt the object by assignment set the copy's prototype
  // instead, so the key vanished from the returned value and the copy
  // inherited whatever the key held. Labels are rebuilt the same way.
  it("returns application data and labels with every key as it came, a key named __proto__ included, and never sets a prototype", async () => {
    const body =
      '{"id":"ses_1","agentId":"worker","deploymentId":"dep_1","status":"idle","source":"api",' +
      '"labels":{"__proto__":"kept","title":"Fix login"},' +
      '"turns":[{"id":"turn_1","input":"go","mode":"queue","status":"completed",' +
      '"payload":{"__proto__":{"isAdmin":true},"safe":"ok"},"createdAt":"t","updatedAt":"t"}],' +
      '"result":{"turnId":"turn_1","callId":"call_1","reportedAt":"t",' +
      '"data":{"__proto__":{"isAdmin":true},"nested":[{"__proto__":1}]}},' +
      '"createdAt":"t","updatedAt":"t"}';
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1": () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    });
    const session = await oc(api).sessions.get("ses_1");
    const payload = session.turns[0]!.payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).toBe('{"__proto__":{"isAdmin":true},"safe":"ok"}');
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(payload.isAdmin).toBeUndefined();
    const data = session.result!.data as Record<string, unknown>;
    expect(JSON.stringify(data)).toBe('{"__proto__":{"isAdmin":true},"nested":[{"__proto__":1}]}');
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(data.isAdmin).toBeUndefined();
    expect(JSON.stringify(session.labels)).toBe('{"__proto__":"kept","title":"Fix login"}');
    expect(Object.getPrototypeOf(session.labels)).toBe(Object.prototype);
    // Nothing else moved either: the session serializes back to the body it came from.
    expect(JSON.stringify(session)).toBe(body);
  });

  // The API answers a repeated key with the turn's persisted status. A
  // retry of a turn that has since completed, failed or been cancelled must
  // say so; a receipt that read "queued" for a completed turn was the
  // review's reproduction.
  it("keeps the persisted status on a duplicate admission receipt: completed, failed and cancelled included", async () => {
    let status = "completed";
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_1/turns": () => Response.json({ turnId: "turn_1", status, duplicate: true }),
    });
    const client = oc(api);
    for (status of ["completed", "failed", "cancelled", "running", "queued"]) {
      expect(await client.sessions.turns.send("ses_1", { input: "again", idempotencyKey: "task_1/start" })).toEqual({
        turnId: "turn_1", status, duplicate: true,
      });
    }
    // A status the API adds later reaches the caller as itself.
    status = "stopping";
    expect((await client.sessions.turns.send("ses_1", { input: "again" })).status).toBe("stopping");
  });

  // Create and setLabels answer 503 session_publication_unconfirmed when the
  // session, or its label change, is recorded but its list row is not yet
  // confirmed. The client throws it with the session id and does not retry:
  // the caller repeats the same call under the same key, and the replay is
  // what publishes again.
  it("surfaces session_publication_unconfirmed with the session id and leaves the retry to the caller", async () => {
    let creates = 0;
    const unconfirmed = () =>
      Response.json(
        { error: { code: "session_publication_unconfirmed", message: "not listed yet; retry", sessionId: "ses_1" } },
        { status: 503 },
      );
    const api = fakeApi({
      "POST /api/managed-agents/sessions": () =>
        ++creates === 1 ? unconfirmed() : Response.json({ session: { id: "ses_1", status: "new", createdAt: "t" } }, { status: 200 }),
      "PATCH /api/managed-agents/sessions/ses_1/labels": unconfirmed,
    });
    const client = oc(api);
    const first = await client.sessions.create({ agentId: "worker@development" }, { idempotencyKey: "task_1" }).catch((cause: unknown) => cause);
    expect(first).toBeInstanceOf(OpenComputerError);
    expect(first).toMatchObject({ code: "session_publication_unconfirmed", status: 503, sessionId: "ses_1", message: "not listed yet; retry" });
    expect(api.calls).toHaveLength(1);
    // The caller's retry, same key and body: the replay answers 200, not created.
    const retry = await client.sessions.create({ agentId: "worker@development" }, { idempotencyKey: "task_1" });
    expect(retry).toMatchObject({ session: { id: "ses_1" }, created: false });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1].headers["idempotency-key"]).toBe("task_1");
    expect(api.calls[1].body).toEqual(api.calls[0].body);
    const patch = await client.sessions.setLabels("ses_1", { set: { outcome: "merged" } }).catch((cause: unknown) => cause);
    expect(patch).toBeInstanceOf(OpenComputerError);
    expect(patch).toMatchObject({ code: "session_publication_unconfirmed", status: 503, sessionId: "ses_1" });
    expect(api.calls).toHaveLength(3);
    // Errors the API does not tie to a session carry no sessionId.
    const untied = (await client.sessions.get("missing").catch((cause: unknown) => cause)) as OpenComputerError;
    expect(untied.code).toBe("not_found");
    expect(untied.sessionId).toBeUndefined();
  });

  it("honours a custom base URL and requires a key", () => {
    const api = fakeApi();
    const client = new OpenComputer({ apiKey: "k", baseUrl: "https://edge.example.test/mgmt/", fetch: api.fetch });
    void client.sessions.get("x").catch(() => undefined);
    expect(() => new OpenComputer({ apiKey: "", fetch: api.fetch })).toThrow(/API key/);
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(api.last().path).toBe("/mgmt/sessions/x");
    });
  });
});
