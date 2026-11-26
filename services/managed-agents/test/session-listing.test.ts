import {
  env,
  SELF,
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_STATUSES,
  type AgentEvent,
  type InitializeSessionResult,
  type SessionSnapshot,
  type SessionSummary,
  type SessionToRuntimeFrame,
} from "../src/protocol.js";
import {
  LAST_SETTLED_TURN_SQL,
  NEXT_SETTLED_SEQ_SQL,
  OPEN_TOOL_CALLS_SQL,
  SessionDurableObject,
} from "../src/edge/session-do.js";
import { AccountDurableObject } from "../src/edge/account-do.js";
import {
  applyLabelPatch,
  parseLabelPatch,
  parseLabels,
} from "../src/edge/session-labels.js";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  parseSessionListQuery,
} from "../src/edge/session-listing.js";
import { hostToolCallId } from "../src/tool-identity.js";

const BASE = "https://managedagents.test";

afterEach(async () => {
  await reset();
});

beforeEach(async () => {
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
  await env.SERVERLESS_AGENTS_DB.prepare("DELETE FROM session_creations").run();
});

interface ListPage {
  sessions: SessionSummary[];
  nextCursor: string | null;
}

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function problem(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

async function createSession(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: InitializeSessionResult }> {
  const response = await SELF.fetch(`${BASE}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ agentId: "local/examples/hello-agent", ...body }),
  });
  const parsed = (await response.json()) as InitializeSessionResult;
  return { status: response.status, body: parsed };
}

async function list(query = ""): Promise<ListPage> {
  return json<ListPage>(await SELF.fetch(`${BASE}/v1/sessions${query}`));
}

async function patchLabels(
  sessionId: string,
  body: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/sessions/${sessionId}/labels`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A row as the projection would receive it, for tests that exercise the projection alone. */
function row(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    projectId: "prj_rows",
    agentId: "rows-agent",
    deploymentId: "rows-agent:digest",
    environment: "development",
    source: "api",
    status: "idle",
    labels: {},
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    revision: 1,
    activity: { activeTurnId: null, queued: 0, lastSettledTurn: null },
    result: null,
    ...overrides,
  };
}

async function publish(
  account: DurableObjectStub<AccountDurableObject>,
  summary: SessionSummary,
): Promise<{ accepted: boolean; revision: number }> {
  return account.acceptSessionPublication({
    sessionId: summary.id,
    revision: summary.revision,
    row: summary,
  });
}

const inboxes = new WeakMap<WebSocket, unknown[]>();

async function connect(path: string): Promise<WebSocket> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  const inbox: unknown[] = [];
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (message) => {
    inbox.push(JSON.parse(String(message.data)) as unknown);
  });
  socket.accept();
  return socket;
}

function nextFrame<T>(
  socket: WebSocket,
  predicate: (frame: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const inbox = inboxes.get(socket)!;
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const index = inbox.findIndex((frame) => predicate(frame as T));
      if (index >= 0) {
        resolve(inbox.splice(index, 1)[0] as T);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for WebSocket frame"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

/** Waits until the Session object owes nothing: the alarm or the eager delivery has been acknowledged. */
async function acknowledged(sessionId: string): Promise<void> {
  const stub = env.SESSIONS.getByName(sessionId);
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await stub.pendingPublication()) === null) return;
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Session ${sessionId} still owes a publication`);
}

/** Waits until the projection holds the session at a revision at least `revision`. */
async function projected(
  sessionId: string,
  revision: number,
): Promise<SessionSummary> {
  const account = env.ACCOUNTS.getByName("local");
  for (let attempt = 0; attempt < 200; attempt++) {
    const held = await account.getSession(sessionId);
    if (held && held.revision >= revision) return held;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Session ${sessionId} never reached revision ${revision}`);
}

describe("session labels", () => {
  it("bounds a label map and a patch", () => {
    expect(parseLabels(undefined)).toEqual({ labels: {} });
    expect(parseLabels({ b: "2", a: "1" })).toEqual({ labels: { a: "1", b: "2" } });
    expect(parseLabels("nope")).toHaveProperty("error");
    expect(parseLabels({ Upper: "x" })).toHaveProperty("error");
    expect(parseLabels({ "1abc": "x" })).toHaveProperty("error");
    expect(parseLabels({ ["k".repeat(65)]: "x" })).toHaveProperty("error");
    expect(parseLabels({ ok: 1 })).toHaveProperty("error");
    expect(parseLabels({ ok: "v".repeat(257) })).toHaveProperty("error");
    expect(parseLabels({ ok: "v".repeat(256) })).toHaveProperty("labels");
    expect(
      parseLabels(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))),
    ).toHaveProperty("error");
    expect(
      parseLabels(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v".repeat(256)]))),
    ).toHaveProperty("error");
    expect(parseLabelPatch({})).toHaveProperty("error");
    expect(parseLabelPatch({ set: { a: "1" }, other: 1 })).toHaveProperty("error");
    expect(parseLabelPatch({ unset: ["Bad"] })).toHaveProperty("error");
    expect(parseLabelPatch({ set: { a: "1" }, unset: ["b"] })).toEqual({
      set: { a: "1" },
      unset: ["b"],
    });
    expect(
      applyLabelPatch({ a: "1", b: "2" }, { set: { a: "3", c: "4" }, unset: ["b", "a"] }),
    ).toEqual({ labels: { a: "3", c: "4" } });
    expect(
      applyLabelPatch(
        Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"])),
        { set: { extra: "v" }, unset: [] },
      ),
    ).toHaveProperty("error");
  });

  it("creates with labels, lists the row right after 201, and keeps the pending row as the fallback", async () => {
    const created = await createSession({ labels: { repo: "acme/api", task: "t-1" } });
    expect(created.status).toBe(201);
    expect(created.body.session.labels).toEqual({ repo: "acme/api", task: "t-1" });
    expect(created.body.session.result).toBeNull();
    expect(created.body.session.revision).toBeGreaterThanOrEqual(1);

    const page = await list();
    const listed = page.sessions.find((session) => session.id === created.body.session.id);
    expect(listed).toMatchObject({
      id: created.body.session.id,
      projectId: `project:${created.body.session.agentId}`,
      agentId: created.body.session.agentId,
      deploymentId: "development",
      environment: null,
      source: "api",
      status: "new",
      labels: { repo: "acme/api", task: "t-1" },
      revision: created.body.session.revision,
      activity: { activeTurnId: null, queued: 0, lastSettledTurn: null },
      result: null,
    });
    expect(listed).not.toHaveProperty("turns");
    expect(listed).not.toHaveProperty("memory");
    expect(page.nextCursor).toBeNull();

    // The synchronous publication leaves the pending row; the alarm (armed
    // at creation, and free to fire on its own) delivers again, is
    // acknowledged as already held, and clears it.
    await acknowledged(created.body.session.id);
    const held = await env.ACCOUNTS.getByName("local").getSession(created.body.session.id);
    expect(held?.revision).toBe(created.body.session.revision);

    const detail = await json<SessionSnapshot>(
      await SELF.fetch(`${BASE}/v1/sessions/${created.body.session.id}`),
    );
    expect(detail.labels).toEqual({ repo: "acme/api", task: "t-1" });
    expect(detail.result).toBeNull();
    expect(detail.source).toBe("api");

    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        "SELECT account_id, source FROM session_creations WHERE session_id = ?",
      )
        .bind(created.body.session.id)
        .first(),
    ).resolves.toEqual({ account_id: "local", source: "api" });
  });

  it("leaves the pending row after a synchronous publication and clears it on the acknowledged delivery", async () => {
    const created = await createSession();
    const sessionId = created.body.session.id;
    await acknowledged(sessionId);
    const stub = env.SESSIONS.getByName(sessionId);
    const revision = await runInDurableObject(stub, (_instance, state) =>
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE session SET revision = revision + 1");
        const next = state.storage.sql
          .exec<{ revision: number }>("SELECT revision FROM session")
          .one().revision;
        state.storage.sql.exec(
          `INSERT OR REPLACE INTO pending_publication (slot, revision, since, attempts, next_attempt_at_ms)
           VALUES (1, ?, ?, 0, ?)`,
          next,
          new Date().toISOString(),
          Date.now() + 3_600_000,
        );
        return next;
      }),
    );
    await expect(stub.publishSummary()).resolves.toEqual({ revision, acknowledged: true, held: revision });
    await expect(stub.pendingPublication()).resolves.toMatchObject({ revision });
    await expect(env.ACCOUNTS.getByName("local").getSession(sessionId)).resolves.toMatchObject({ revision });
    // The same revision again: nothing new written, still acknowledged (held), so delivery clears the row.
    await expect(stub.publishSummary()).resolves.toEqual({ revision, acknowledged: true, held: revision });
    await expect(stub.reconcilePublication(0)).resolves.toEqual({ pending: true, delivered: true });
    await expect(stub.pendingPublication()).resolves.toBeNull();
  });

  it("refuses invalid labels on create and ignores labels on an idempotent replay", async () => {
    for (const labels of [
      "x",
      { Bad: "x" },
      { ok: 5 },
      { ok: "v".repeat(257) },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])),
    ]) {
      const response = await SELF.fetch(`${BASE}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "local/examples/hello-agent", labels }),
      });
      await expect(problem(response)).resolves.toEqual({ status: 400, code: "invalid_labels" });
    }

    const key = crypto.randomUUID();
    const first = await createSession({ labels: { a: "1" } }, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const replay = await createSession({ labels: { a: "changed", b: "2" } }, { "idempotency-key": key });
    expect(replay.status).toBe(200);
    expect(replay.body.session.id).toBe(first.body.session.id);
    expect(replay.body.session.labels).toEqual({ a: "1" });
  });

  /**
   * Failure injection on the projection: the Account object's accept is
   * replaced on the prototype for the calls the test names, the way the
   * review reproduced it, so the Session object, the edge and the alarm
   * run their real code against a projection that fails or stalls.
   */
  function injectPublication(
    behaviour: (
      call: number,
      original: () => Promise<{ accepted: boolean; revision: number }>,
      publication: { sessionId: string; revision: number },
    ) => Promise<{ accepted: boolean; revision: number }>,
  ): () => void {
    const original = AccountDurableObject.prototype.acceptSessionPublication;
    let calls = 0;
    AccountDurableObject.prototype.acceptSessionPublication = function (this: AccountDurableObject, publication) {
      calls += 1;
      return behaviour(calls, () => original.call(this, publication), publication);
    };
    return () => {
      AccountDurableObject.prototype.acceptSessionPublication = original;
    };
  }

  it("answers a create whose first publication failed with a retryable 503 that names the session, never a 201 with a missing row", async () => {
    // Review finding 6: the Durable Object failure injection produced
    // create=201, initialized=true, projected=false, then GET=404 because
    // routing needs the Account index.
    // Every delivery fails while armed: the synchronous one the create
    // request makes and the eager one the session.created bump starts.
    const restore = injectPublication(async () => {
      throw new Error("injected projection failure");
    });
    let created: { status: number; body: InitializeSessionResult };
    try {
      created = await createSession({ labels: { task: "t-503" } }, { "idempotency-key": "create-unconfirmed" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      restore();
    }
    expect(created.status).toBe(503);
    const failure = created.body as unknown as { error: { code: string; sessionId: string } };
    expect(failure.error.code).toBe("session_publication_unconfirmed");
    const sessionId = failure.error.sessionId;
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    // Initialized, not projected: the identity is stable and nothing claimed it was listed.
    await expect(env.SESSIONS.getByName(sessionId).snapshotOrNull()).resolves.toMatchObject({ id: sessionId });
    await expect(env.ACCOUNTS.getByName("local").getSession(sessionId)).resolves.toBeNull();
    expect((await SELF.fetch(`${BASE}/v1/sessions/${sessionId}`)).status).toBe(404);
    expect((await list()).sessions.map((session) => session.id)).not.toContain(sessionId);
    await expect(env.SESSIONS.getByName(sessionId).pendingPublication()).resolves.not.toBeNull();

    // The retry under the same key publishes again and answers once held.
    const retried = await createSession({ labels: { task: "ignored on replay" } }, { "idempotency-key": "create-unconfirmed" });
    expect(retried.status).toBe(200);
    expect(retried.body.session.id).toBe(sessionId);
    expect((await SELF.fetch(`${BASE}/v1/sessions/${sessionId}`)).status).toBe(200);
    expect((await list()).sessions.find((session) => session.id === sessionId)).toMatchObject({
      id: sessionId,
      labels: { task: "t-503" },
      revision: retried.body.session.revision,
    });
  });

  it("answers a label patch with 200 only once the projection holds its revision; unconfirmed is a retryable 503 and the alarm still delivers", async () => {
    const created = await createSession({ labels: { outcome: "open" } });
    expect(created.status).toBe(201);
    const sessionId = created.body.session.id;
    await acknowledged(sessionId);
    const restore = injectPublication(async (call, original) => {
      if (call === 1) throw new Error("injected projection failure");
      return original();
    });
    let response: Response;
    try {
      response = await patchLabels(sessionId, { set: { outcome: "archived" } });
    } finally {
      restore();
    }
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "session_publication_unconfirmed", sessionId },
    });
    // Recorded on the session, not yet on the row: the two disagree, and
    // the caller was told so instead of 200.
    const detail = await json<SessionSnapshot>(await SELF.fetch(`${BASE}/v1/sessions/${sessionId}`));
    expect(detail.labels).toEqual({ outcome: "archived" });
    expect((await env.ACCOUNTS.getByName("local").getSession(sessionId))?.labels).toEqual({ outcome: "open" });

    // Background retry stays: the alarm delivers the recorded revision.
    await acknowledged(sessionId);
    expect((await env.ACCOUNTS.getByName("local").getSession(sessionId))?.labels).toEqual({ outcome: "archived" });
    // And a retry of the same patch answers 200 with the row holding it.
    const retried = await json<SessionSnapshot>(await patchLabels(sessionId, { set: { outcome: "archived" } }));
    expect(retried.labels).toEqual({ outcome: "archived" });
    expect((await projected(sessionId, retried.revision)).labels).toEqual({ outcome: "archived" });
  });

  it("does not count joining an older in-flight publication as acknowledgement of a newer revision", async () => {
    const created = await createSession({ labels: { a: "0", b: "0" } });
    expect(created.status).toBe(201);
    const sessionId = created.body.session.id;
    await acknowledged(sessionId);
    // A delivery of patch A's revision is held; every delivery carrying
    // patch B's revision fails (the drive's re-run, or an alarm that fires
    // on its own meanwhile). Keyed on the revision, not the call count, so
    // an alarm-driven delivery cannot consume the injected failure. Flags,
    // not promises: a promise made in the test's context must not be
    // awaited inside the Account object's request.
    const revisionA = created.body.session.revision + 1;
    let firstStarted = false;
    let firstReleased = false;
    const restore = injectPublication(async (_call, original, publication) => {
      if (publication.revision === revisionA) {
        firstStarted = true;
        while (!firstReleased) await new Promise((resolve) => setTimeout(resolve, 5));
        return original();
      }
      if (publication.revision > revisionA) throw new Error("injected projection failure");
      return original();
    });
    try {
      const patchA = patchLabels(sessionId, { set: { a: "1" } });
      while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 5));
      // B's bump lands while A's delivery is in flight; B joins the drive.
      const patchB = patchLabels(sessionId, { set: { b: "1" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      firstReleased = true;
      const [responseA, responseB] = await Promise.all([patchA, patchB]);
      expect(responseA.status).toBe(200);
      // B's revision was never acknowledged: A's delivery held the old row.
      expect(responseB.status).toBe(503);
      expect(await responseB.json()).toMatchObject({ error: { code: "session_publication_unconfirmed", sessionId } });
      const held = await env.ACCOUNTS.getByName("local").getSession(sessionId);
      expect(held?.labels).toEqual({ a: "1", b: "0" });
    } finally {
      restore();
    }
    await acknowledged(sessionId);
    expect((await env.ACCOUNTS.getByName("local").getSession(sessionId))?.labels).toEqual({ a: "1", b: "1" });
  });

  it("patches labels per key, reflects them in the row, and allows it on an ended session", async () => {
    const created = await createSession({ labels: { a: "1", b: "2" } });
    const patched = await json<SessionSnapshot>(
      await patchLabels(created.body.session.id, { set: { a: "3", c: "4" }, unset: ["b"] }),
    );
    expect(patched.labels).toEqual({ a: "3", c: "4" });
    expect(patched.labelsUpdatedAt).toBeTruthy();
    expect(patched.revision).toBeGreaterThan(created.body.session.revision);
    expect(patched.source).toBe("api");

    const held = await env.ACCOUNTS.getByName("local").getSession(created.body.session.id);
    expect(held).toMatchObject({ labels: { a: "3", c: "4" }, revision: patched.revision });

    await expect(
      problem(await patchLabels(created.body.session.id, { set: { Bad: "x" } })),
    ).resolves.toEqual({ status: 400, code: "invalid_labels" });
    await expect(
      problem(await patchLabels(created.body.session.id, {})),
    ).resolves.toEqual({ status: 400, code: "invalid_labels" });
    await expect(
      problem(
        await patchLabels(created.body.session.id, {
          set: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "v"])),
        }),
      ),
    ).resolves.toEqual({ status: 400, code: "invalid_labels" });
    await expect(
      problem(await patchLabels("missing-session", { set: { a: "1" } })),
    ).resolves.toEqual({ status: 404, code: "session_not_found" });

    await SELF.fetch(`${BASE}/v1/sessions/${created.body.session.id}/end`, { method: "POST" });
    const ended = await json<SessionSnapshot>(
      await patchLabels(created.body.session.id, { set: { outcome: "archived" } }),
    );
    expect(ended.status).toBe("ended");
    expect(ended.labels).toEqual({ a: "3", c: "4", outcome: "archived" });
    const endedRow = await projected(created.body.session.id, ended.revision);
    expect(endedRow).toMatchObject({ status: "ended", labels: ended.labels });
  });

});

describe("session listing", () => {
  it("parses the query strictly", () => {
    expect(parseSessionListQuery(new URLSearchParams(""))).toEqual({ labels: [], limit: 50 });
    expect(
      parseSessionListQuery(
        new URLSearchParams(
          "project=p&environment=production&agent=a&status=idle&label.repo=x&label.task=y&limit=100",
        ),
      ),
    ).toEqual({
      project: "p",
      environment: "production",
      agent: "a",
      status: "idle",
      labels: [
        { key: "repo", value: "x" },
        { key: "task", value: "y" },
      ],
      limit: 100,
    });
    for (const bad of [
      "unknown=1",
      "limit=0",
      "limit=101",
      "limit=abc",
      "environment=staging",
      "status=nope",
      "label.Bad=x",
      "label.a=1&label.b=2&label.c=3&label.d=4",
      "cursor=%%%",
      "cursor=bm9wZQ",
      "project=",
      "agent=a&agent=b",
    ]) {
      expect(parseSessionListQuery(new URLSearchParams(bad))).toHaveProperty("error");
    }
    const cursor = encodeSessionListCursor({ createdAt: "2026-09-15T00:00:00.000Z", id: "s" });
    expect(decodeSessionListCursor(cursor)).toEqual({
      createdAt: "2026-09-15T00:00:00.000Z",
      id: "s",
    });
    expect(parseSessionListQuery(new URLSearchParams(`cursor=${cursor}`))).toMatchObject({
      cursor: { id: "s" },
    });
  });

  it("answers invalid queries with 400 invalid_query", async () => {
    for (const query of ["?unknown=1", "?limit=101", "?label.a=1&label.b=2&label.c=3&label.d=4", "?cursor=nope"]) {
      await expect(problem(await SELF.fetch(`${BASE}/v1/sessions${query}`))).resolves.toEqual({
        status: 400,
        code: "invalid_query",
      });
    }
  });

  it("accepts every public status as a filter, stopping included", async () => {
    // The validator derives from the shared status list: a status a
    // session can show (`stopping`, while a Stop settles) is never a 400.
    for (const status of SESSION_STATUSES) {
      expect(parseSessionListQuery(new URLSearchParams(`status=${status}`))).toEqual({
        status,
        labels: [],
        limit: 50,
      });
    }
    const account = env.ACCOUNTS.getByName("local");
    await publish(account, row({ id: "s-stopping", status: "stopping" }));
    const response = await SELF.fetch(`${BASE}/v1/sessions?status=stopping`);
    expect(response.status).toBe(200);
    expect((await response.json<ListPage>()).sessions.map((session) => session.id)).toEqual(["s-stopping"]);
  });

  it("filters by project, environment, agent, status and labels", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await publish(account, row({ id: "s-a", projectId: "prj_a", agentId: "agent-a", environment: "development", status: "idle", labels: { repo: "acme/api", task: "1" } }));
    await publish(account, row({ id: "s-b", projectId: "prj_a", agentId: "agent-a", environment: "production", status: "running", labels: { repo: "acme/api", task: "2" } }));
    await publish(account, row({ id: "s-c", projectId: "prj_b", agentId: "agent-b", environment: "development", status: "ended", labels: { repo: "acme/web" } }));

    const ids = async (query: string) => (await list(query)).sessions.map((session) => session.id);
    expect(await ids("?project=prj_a")).toEqual(["s-a", "s-b"]);
    expect(await ids("?environment=production")).toEqual(["s-b"]);
    expect(await ids("?agent=agent-b")).toEqual(["s-c"]);
    expect(await ids("?status=ended")).toEqual(["s-c"]);
    expect(await ids("?label.repo=acme%2Fapi")).toEqual(["s-a", "s-b"]);
    expect(await ids("?label.repo=acme%2Fapi&label.task=2")).toEqual(["s-b"]);
    expect(await ids("?project=prj_a&environment=development&label.task=1")).toEqual(["s-a"]);
    expect(await ids("?label.missing=x")).toEqual([]);
    expect(await ids("?project=unknown")).toEqual([]);
  });

  it("pages 101 rows in two reads with a cursor that holds while rows are updated", async () => {
    const account = env.ACCOUNTS.getByName("local");
    for (let index = 0; index < 101; index++) {
      const minute = String(index % 60).padStart(2, "0");
      const hour = String(Math.floor(index / 60)).padStart(2, "0");
      await publish(
        account,
        row({
          id: `s-${String(index).padStart(3, "0")}`,
          createdAt: `2026-09-14T${hour}:${minute}:00.000Z`,
          updatedAt: `2026-09-14T${hour}:${minute}:00.000Z`,
        }),
      );
    }
    // Two rows share a createdAt: the tie breaks on id, ascending.
    await publish(account, row({ id: "s-tie-b", createdAt: "2026-09-14T00:30:00.000Z" }));
    await publish(account, row({ id: "s-tie-a", createdAt: "2026-09-14T00:30:00.000Z" }));

    const first = await list("?limit=100");
    expect(first.sessions).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(first.sessions[0]!.id).toBe("s-100");
    const tieIndex = first.sessions.findIndex((session) => session.id === "s-030");
    expect(first.sessions.slice(tieIndex, tieIndex + 3).map((session) => session.id)).toEqual([
      "s-030",
      "s-tie-a",
      "s-tie-b",
    ]);

    // Rows on the first page change while the reader holds the cursor: the
    // order is by createdAt, so nothing moves past the cursor.
    await publish(account, row({ id: "s-100", createdAt: "2026-09-14T01:40:00.000Z", revision: 2, status: "running", updatedAt: "2026-09-15T12:00:00.000Z" }));
    await publish(account, row({ id: "s-002", createdAt: "2026-09-14T00:02:00.000Z", revision: 2, status: "ended", updatedAt: "2026-09-15T12:00:00.000Z" }));

    const second = await list(`?limit=100&cursor=${first.nextCursor}`);
    expect(second.sessions.map((session) => session.id)).toEqual(["s-002", "s-001", "s-000"]);
    expect(second.sessions[0]).toMatchObject({ status: "ended", revision: 2 });
    expect(second.nextCursor).toBeNull();
    const seen = new Set([...first.sessions, ...second.sessions].map((session) => session.id));
    expect(seen.size).toBe(103);

    const small = await list("?limit=2");
    expect(small.sessions.map((session) => session.id)).toEqual(["s-100", "s-099"]);
    const next = await list(`?limit=2&cursor=${small.nextCursor}`);
    expect(next.sessions.map((session) => session.id)).toEqual(["s-098", "s-097"]);
  });

  it("serves the project overview from the projection", async () => {
    // The overview also reports the project's template source from D1.
    await env.SERVERLESS_AGENTS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS template_versions (
         id TEXT PRIMARY KEY, repository_url TEXT NOT NULL, commit_sha TEXT NOT NULL
       )`,
    ).run();
    await env.SERVERLESS_AGENTS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS template_installations (
         account_id TEXT NOT NULL, project_id TEXT NOT NULL, version_id TEXT NOT NULL,
         state TEXT NOT NULL, project_repo_id TEXT, updated_at TEXT NOT NULL
       )`,
    ).run();
    const account = env.ACCOUNTS.getByName("local");
    const project = await account.createProject({ environmentMode: "legacy", id: "prj_overview", name: "Overview", slug: "overview" });
    await publish(account, row({ id: "s-in", projectId: project.id, agentId: project.agentId }));
    await publish(account, row({ id: "s-out", projectId: "prj_other", agentId: "other" }));
    const overview = await json<{ sessions: SessionSummary[]; files?: unknown }>(
      await SELF.fetch(`${BASE}/v1/projects/${project.id}`),
    );
    expect(overview.sessions.map((session) => session.id)).toEqual(["s-in"]);
    expect(overview.sessions[0]).not.toHaveProperty("turns");
    expect(overview).not.toHaveProperty("files");
  });
});

describe("session projection", () => {
  it("projects countability without letting delayed revisions regress it", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const first = row({ id: "s-countability", revision: 1 });
    await account.acceptSessionPublication({
      sessionId: first.id,
      revision: first.revision,
      row: first,
      countability: { countable: true, exclusionReason: null, outcomeAt: null },
    });
    const failed = row({
      id: first.id,
      revision: 2,
      updatedAt: "2026-09-15T00:05:00.000Z",
    });
    await account.acceptSessionPublication({
      sessionId: failed.id,
      revision: failed.revision,
      row: failed,
      countability: {
        countable: false,
        exclusionReason: "model_credit_exhausted",
        outcomeAt: "2026-09-15T00:05:00.000Z",
      },
    });

    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        `SELECT countable, exclusion_reason, outcome_at
         FROM session_creations WHERE session_id = ?`,
      )
        .bind(first.id)
        .first(),
    ).resolves.toEqual({
      countable: 0,
      exclusion_reason: "model_credit_exhausted",
      outcome_at: "2026-09-15T00:05:00.000Z",
    });

    await account.acceptSessionPublication({
      sessionId: first.id,
      revision: first.revision,
      row: first,
      countability: { countable: true, exclusionReason: null, outcomeAt: null },
    });
    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        "SELECT countable FROM session_creations WHERE session_id = ?",
      )
        .bind(first.id)
        .first("countable"),
    ).resolves.toBe(0);

    const recovered = row({
      id: first.id,
      revision: 3,
      updatedAt: "2026-09-15T00:10:00.000Z",
    });
    await account.acceptSessionPublication({
      sessionId: recovered.id,
      revision: recovered.revision,
      row: recovered,
      countability: {
        countable: true,
        exclusionReason: null,
        outcomeAt: "2026-09-15T00:10:00.000Z",
      },
    });
    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        `SELECT countable, exclusion_reason
         FROM session_creations WHERE session_id = ?`,
      )
        .bind(first.id)
        .first(),
    ).resolves.toEqual({ countable: 1, exclusion_reason: null });
  });

  it("accepts only newer revisions, so a delayed or duplicated delivery cannot regress a row", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await expect(publish(account, row({ id: "s-rev", revision: 3, status: "running" }))).resolves.toEqual({
      accepted: true,
      revision: 3,
    });
    await expect(publish(account, row({ id: "s-rev", revision: 2, status: "idle" }))).resolves.toEqual({
      accepted: false,
      revision: 3,
    });
    await expect(publish(account, row({ id: "s-rev", revision: 3, status: "idle" }))).resolves.toEqual({
      accepted: false,
      revision: 3,
    });
    await expect(account.getSession("s-rev")).resolves.toMatchObject({ status: "running", revision: 3 });
    await expect(publish(account, row({ id: "s-rev", revision: 4, status: "ended" }))).resolves.toEqual({
      accepted: true,
      revision: 4,
    });
    await expect(account.getSession("s-rev")).resolves.toMatchObject({ status: "ended", revision: 4 });
    // Asserted on the instance: a throw over the RPC stub is also reported
    // by the pool as an unhandled rejection.
    await runInDurableObject(account, async (instance: AccountDurableObject) => {
      await expect(
        instance.acceptSessionPublication({ sessionId: "s-rev", revision: 0, row: row({ id: "s-rev", revision: 0 }) }),
      ).rejects.toThrow(/malformed/);
      await expect(
        instance.acceptSessionPublication({ sessionId: "other", revision: 5, row: row({ id: "s-rev", revision: 5 }) }),
      ).rejects.toThrow(/malformed/);
    });
    await expect(
      env.SERVERLESS_AGENTS_DB.prepare("SELECT COUNT(*) AS count FROM session_creations WHERE session_id = ?")
        .bind("s-rev")
        .first("count"),
    ).resolves.toBe(1);
  });

  it("keeps a row indexed before the projection and takes its first publication", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await runInDurableObject(account, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sessions (id, agent_id, deployment_id, source, status, created_at, updated_at)
         VALUES ('s-legacy', 'legacy-agent', 'legacy-agent:digest', 'schedule', 'idle',
                 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      );
    });
    await expect(account.getSession("s-legacy")).resolves.toMatchObject({
      id: "s-legacy",
      projectId: "project:legacy-agent",
      source: "schedule",
      labels: {},
      revision: 0,
      activity: { activeTurnId: null, queued: 0, lastSettledTurn: null },
      result: null,
    });
    await expect(
      publish(account, row({ id: "s-legacy", agentId: "legacy-agent", source: "schedule", revision: 1, status: "ended" })),
    ).resolves.toEqual({ accepted: true, revision: 1 });
    await expect(account.getSession("s-legacy")).resolves.toMatchObject({ status: "ended", revision: 1 });
  });

  it("publishes turn admission, start and settlement as activity", async () => {
    const created = await createSession();
    const sessionId = created.body.session.id;
    const runtime = await connect(
      `/v1/sessions/${sessionId}/connect?role=runtime&token=${created.body.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
    if (welcome.type !== "runtime.welcome") throw new Error("no welcome");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));

    const first = await json<{ turnId: string }>(
      await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "first", idempotencyKey: "k1" }),
      }),
    );
    const start = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "turn.start");
    expect(start).toMatchObject({ type: "turn.start", turnId: first.turnId });
    const second = await json<{ turnId: string }>(
      await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "second", idempotencyKey: "k2" }),
      }),
    );
    const running = await env.SESSIONS.getByName(sessionId).snapshot();
    const runningRow = await projected(sessionId, running.revision);
    expect(runningRow).toMatchObject({
      status: "running",
      activity: { activeTurnId: first.turnId, queued: 1, lastSettledTurn: null },
    });

    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-1",
        turnId: first.turnId,
        events: [
          { type: "message.completed", data: { text: "done" } },
          { type: "turn.completed", data: {} },
        ],
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "turn.start" && frame.turnId === second.turnId);
    const afterFirst = await env.SESSIONS.getByName(sessionId).snapshot();
    const settledRow = await projected(sessionId, afterFirst.revision);
    expect(settledRow.activity).toMatchObject({
      activeTurnId: second.turnId,
      queued: 0,
      lastSettledTurn: { id: first.turnId, status: "completed" },
    });
    expect(settledRow.updatedAt).toBe(afterFirst.updatedAt);

    const events = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/events`),
    );
    expect(events.events.map((event) => event.type)).not.toContain("session.labels_changed");
    runtime.close(1000, "done");
    await acknowledged(sessionId);
  });

  it("marks a no-usage credit failure uncountable and restores a later success", async () => {
    const created = await createSession({ source: "schedule" });
    const sessionId = created.body.session.id;
    const runtime = await connect(
      `/v1/sessions/${sessionId}/connect?role=runtime&token=${created.body.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    if (welcome.type !== "runtime.welcome") throw new Error("no welcome");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));

    const first = await json<{ turnId: string }>(
      await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "scheduled", idempotencyKey: "countability-1" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === first.turnId,
    );
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "countability-failed",
        turnId: first.turnId,
        events: [
          {
            type: "turn.failed",
            data: {
              message: "provider credit preflight refused the call",
              code: "model_credit_exhausted",
            },
          },
        ],
      }),
    );
    await vi.waitFor(async () => {
      await expect(
        env.SERVERLESS_AGENTS_DB.prepare(
          "SELECT countable FROM session_creations WHERE session_id = ?",
        )
          .bind(sessionId)
          .first("countable"),
      ).resolves.toBe(0);
    });
    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        "SELECT exclusion_reason FROM session_creations WHERE session_id = ?",
      )
        .bind(sessionId)
        .first("exclusion_reason"),
    ).resolves.toBe("model_credit_exhausted");

    const second = await json<{ turnId: string }>(
      await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "after top-up", idempotencyKey: "countability-2" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === second.turnId,
    );
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "countability-completed",
        turnId: second.turnId,
        events: [{ type: "turn.completed", data: {} }],
      }),
    );
    await vi.waitFor(async () => {
      await expect(
        env.SERVERLESS_AGENTS_DB.prepare(
          "SELECT countable FROM session_creations WHERE session_id = ?",
        )
          .bind(sessionId)
          .first("countable"),
      ).resolves.toBe(1);
    });
    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        "SELECT exclusion_reason FROM session_creations WHERE session_id = ?",
      )
        .bind(sessionId)
        .first("exclusion_reason"),
    ).resolves.toBeNull();
    runtime.close(1000, "done");
  });

  it("publishes a committed result on the row and keeps it on the settled row", async () => {
    const created = await createSession();
    const sessionId = created.body.session.id;
    const runtime = await connect(
      `/v1/sessions/${sessionId}/connect?role=runtime&token=${created.body.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
    if (welcome.type !== "runtime.welcome") throw new Error("no welcome");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));
    const turn = await json<{ turnId: string }>(
      await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "report", idempotencyKey: "k1" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "turn.start");
    const stub = env.SESSIONS.getByName(sessionId);
    const running = await stub.snapshot();
    expect((await projected(sessionId, running.revision)).result).toBeNull();

    // The commit is a listed mutation: the row moves to a newer revision
    // and carries the result with its provenance.
    await expect(
      stub.commitResult({
        turnId: turn.turnId,
        callId: "call-1",
        tool: "report",
        runtime: { kind: "microvm", epoch: welcome.epoch },
        data: { branch: "task/1", pr: { number: 7 } },
      }),
    ).resolves.toMatchObject({ status: "committed", replayed: false });
    const committed = await stub.snapshot();
    expect(committed.revision).toBeGreaterThan(running.revision);
    const committedRow = await projected(sessionId, committed.revision);
    expect(committedRow.result).toEqual({
      turnId: turn.turnId,
      callId: "call-1",
      reportedAt: expect.any(String),
      data: { branch: "task/1", pr: { number: 7 } },
      identity: expect.objectContaining({
        sessionId,
        turnId: turn.turnId,
        providerCallId: "call-1",
        toolCallId: hostToolCallId({
          sessionId,
          turnId: turn.turnId,
          messageId: "",
          providerCallId: "call-1",
        }),
        environment: "development",
      }),
    });
    expect(committedRow.updatedAt).toBe(committed.updatedAt);
    // A replay writes nothing and moves nothing.
    await expect(
      stub.commitResult({
        turnId: turn.turnId,
        callId: "call-1",
        tool: "report",
        runtime: { kind: "microvm", epoch: welcome.epoch },
        data: { pr: { number: 7 }, branch: "task/1" },
      }),
    ).resolves.toMatchObject({ status: "committed", replayed: true });
    expect((await stub.snapshot()).revision).toBe(committed.revision);

    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-1",
        turnId: turn.turnId,
        events: [
          { type: "message.completed", data: { text: "done" } },
          { type: "turn.completed", data: {} },
        ],
      }),
    );
    const settled = await stub.snapshot();
    const settledRow = await projected(sessionId, settled.revision);
    expect(settledRow.activity.lastSettledTurn).toMatchObject({ id: turn.turnId, status: "completed" });
    expect(settledRow.result).toMatchObject({ turnId: turn.turnId, callId: "call-1" });
    expect((await list()).sessions.find((row) => row.id === sessionId)?.result).toMatchObject({
      callId: "call-1",
    });
    runtime.close(1000, "done");
    await acknowledged(sessionId);
  });

  it("delivers a publication pending across an eviction with the right revision", async () => {
    const created = await createSession();
    const sessionId = created.body.session.id;
    const stub = env.SESSIONS.getByName(sessionId);
    await acknowledged(sessionId);

    // A mutation whose delivery never ran: the transaction committed the
    // bump and the pending row, then the object died.
    const bumped = await runInDurableObject(stub, (instance: SessionDurableObject, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE session SET status = 'running', labels_json = '{\"lost\":\"yes\"}'");
        state.storage.sql.exec("UPDATE session SET revision = revision + 1");
        const revision = state.storage.sql
          .exec<{ revision: number }>("SELECT revision FROM session")
          .one().revision;
        state.storage.sql.exec(
          `INSERT OR REPLACE INTO pending_publication (slot, revision, since, attempts, next_attempt_at_ms)
           VALUES (1, ?, ?, 0, ?)`,
          revision,
          new Date().toISOString(),
          Date.now(),
        );
      });
      // The mutation path arms the alarm after its transaction; the object
      // dies before the eager delivery runs. Armed a minute out so workerd
      // does not fire it on its own before the test forces it.
      void state.storage.setAlarm(Date.now() + 60_000);
      return instance.summary().revision;
    });
    // No intermediate assertion on the projection: a trailing alarm of the
    // create may legitimately re-arm to the planted row and deliver it
    // early. The contract is the outcome after the eviction and the alarm.
    await evictDurableObject(stub);
    await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
    const after = await env.ACCOUNTS.getByName("local").getSession(sessionId);
    expect(after).toMatchObject({ revision: bumped, status: "running", labels: { lost: "yes" } });
    await expect(env.SESSIONS.getByName(sessionId).pendingPublication()).resolves.toBeNull();
  });

  it("reconciles owed publications and skips a damaged session without hiding the others", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const healthy = await createSession();
    const damaged = await createSession();
    for (const id of [healthy.body.session.id, damaged.body.session.id]) {
      await acknowledged(id);
    }
    const plant = (stub: DurableObjectStub<SessionDurableObject>) =>
      runInDurableObject(stub, (_instance, state) => {
        state.storage.transactionSync(() => {
          state.storage.sql.exec("UPDATE session SET status = 'idle', revision = revision + 1");
          const revision = state.storage.sql
            .exec<{ revision: number }>("SELECT revision FROM session")
            .one().revision;
          state.storage.sql.exec(
            `INSERT OR REPLACE INTO pending_publication (slot, revision, since, attempts, next_attempt_at_ms)
             VALUES (1, ?, '2026-09-01T00:00:00.000Z', 0, ?)`,
            revision,
            Date.now() + 3_600_000,
          );
        });
      });
    await plant(env.SESSIONS.getByName(healthy.body.session.id));
    await plant(env.SESSIONS.getByName(damaged.body.session.id));
    await runInDurableObject(env.SESSIONS.getByName(damaged.body.session.id), (_instance, state) => {
      // Every read of this object now throws; the constructor does not heal a renamed column.
      state.storage.sql.exec("ALTER TABLE session RENAME COLUMN status TO status_lost");
    });
    for (const id of [healthy.body.session.id, damaged.body.session.id]) {
      await evictDurableObject(env.SESSIONS.getByName(id));
    }
    // The projection still holds the create-time rows; make them look quiet.
    await runInDurableObject(account, (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET updated_at = '2026-09-01T00:00:00.000Z'");
    });

    const outcome = await account.reconcileSessionPublications({ olderThanMs: 0 });
    expect(outcome).toMatchObject({ scanned: 2, pending: 1, delivered: 1, failed: 1 });
    const repaired = await account.getSession(healthy.body.session.id);
    expect(repaired).toMatchObject({ status: "idle", revision: healthy.body.session.revision + 1 });
    await expect(account.getSession(damaged.body.session.id)).resolves.toMatchObject({
      revision: damaged.body.session.revision,
    });
    // A probed session is not probed again within the day.
    await expect(account.reconcileSessionPublications({ olderThanMs: 0 })).resolves.toMatchObject({
      scanned: 0,
    });
  });

  it("runs reconciliation from the internal route with the operator credential", async () => {
    const unauthorized = await SELF.fetch(
      `${BASE}/internal/session-projection/reconcile?account_id=local`,
      { method: "POST" },
    );
    expect(unauthorized.status).toBe(401);
    const response = await SELF.fetch(
      `${BASE}/internal/session-projection/reconcile?account_id=local&older_than_ms=0`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-session-index-admin-secret" },
      },
    );
    await expect(json<Record<string, unknown>>(response)).resolves.toMatchObject({
      account_id: "local",
      scanned: 0,
    });
  });

  it("ends a session and publishes the ended row without an index write from the edge", async () => {
    const created = await createSession();
    const ended = await json<SessionSnapshot>(
      await SELF.fetch(`${BASE}/v1/sessions/${created.body.session.id}/end`, { method: "POST" }),
    );
    const held = await projected(created.body.session.id, ended.revision);
    expect(held).toMatchObject({ status: "ended", revision: ended.revision });
  });
});

describe("bounded reads over a session's history", () => {
  it("settles open tool calls and reads the last settled turn through indexes, never a table scan or a temporary sort", async () => {
    // Re-review, architecture: terminal tool settlement scanned the whole
    // events table twice per settled turn, and the last-settled read in
    // summary() sorted the turns table into a temporary b-tree. Both grow
    // with the history; both are per-turn reads. The settlement order a
    // settling turn takes is read the same way: the first index entry.
    const created = await createSession({});
    expect(created.status).toBe(201);
    const plans = await runInDurableObject(env.SESSIONS.getByName(created.body.session.id), (_instance, state) => {
      const plan = (sql: string, ...args: string[]): string[] =>
        state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...args)
          .toArray()
          .map((row) => row.detail);
      return {
        open: plan(OPEN_TOOL_CALLS_SQL, "turn-1", "turn-1"),
        settled: plan(LAST_SETTLED_TURN_SQL),
        next: plan(NEXT_SETTLED_SEQ_SQL),
      };
    });
    console.log(JSON.stringify({ event: "query_plans", ...plans }));
    for (const step of [...plans.open, ...plans.settled, ...plans.next]) {
      expect(step).not.toMatch(/TEMP B-TREE/);
      expect(step).not.toMatch(/^SCAN (events|turns)$/);
    }
    expect(plans.open.join("\n")).toMatch(/events USING INDEX events_turn_type/);
    expect(plans.settled.join("\n")).toMatch(/turns USING (COVERING )?INDEX turns_settled/);
    expect(plans.next.join("\n")).toMatch(/turns USING (COVERING )?INDEX turns_settled/);
  });

  it("names the turn settled last when two settle in the same millisecond, whichever was admitted first", async () => {
    // Re-review, correctness: the last-settled read ordered by updated_at
    // and let the index break ties. Timestamps tie whenever two turns
    // settle within one millisecond, and what the index breaks ties by is
    // rowid, which orders admission, not settlement: the row named the
    // older admission while the result belonged to the turn settled after
    // it. Settlement now has its own order. Both admission orders are
    // exercised, so the test holds whichever way rowid would break a tie:
    // a steered turn is admitted as running beside the active one, and
    // either of the two can settle last.
    const created = await createSession();
    const sessionId = created.body.session.id;
    const runtime = await connect(
      `/v1/sessions/${sessionId}/connect?role=runtime&token=${created.body.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
    if (welcome.type !== "runtime.welcome") throw new Error("no welcome");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));
    const stub = env.SESSIONS.getByName(sessionId);
    const admit = async (input: string, mode: "queue" | "steer"): Promise<{ turnId: string }> =>
      json<{ turnId: string }>(
        await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, mode, idempotencyKey: `${mode}:${input}` }),
        }),
      );
    const settle = async (turnId: string): Promise<void> => {
      runtime.send(
        JSON.stringify({
          type: "event.batch",
          epoch: welcome.epoch,
          frameId: `completed:${turnId}`,
          turnId,
          events: [{ type: "turn.completed", data: {} }],
        }),
      );
      for (let attempt = 0; attempt < 200; attempt++) {
        const snapshot: SessionSnapshot = await stub.snapshot();
        if (snapshot.turns.find((turn) => turn.id === turnId)?.status === "completed") return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Turn ${turnId} never settled`);
    };
    /**
     * Admits an active turn and a steered one, settles them in `order`
     * within one frozen millisecond with the result committed by the turn
     * settled last, and expects the row to name that turn.
     */
    const pair = async (
      frozenAt: string,
      order: "steered first" | "active first",
    ): Promise<{ earlier: string; later: string }> => {
      const active = await admit(`work at ${frozenAt}`, "queue");
      await nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) => frame.type === "turn.start" && frame.turnId === active.turnId,
      );
      const steered = await admit(`focus at ${frozenAt}`, "steer");
      await nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) => frame.type === "turn.steer" && frame.turnId === steered.turnId,
      );
      const [earlier, later] =
        order === "steered first" ? [steered.turnId, active.turnId] : [active.turnId, steered.turnId];
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(frozenAt));
        await settle(earlier);
        await expect(
          stub.commitResult({
            turnId: later,
            callId: `call:${later}`,
            tool: "report",
            runtime: { kind: "microvm", epoch: welcome.epoch },
            data: { settled: later },
          }),
        ).resolves.toMatchObject({ status: "committed", replayed: false });
        await settle(later);
      } finally {
        vi.useRealTimers();
      }
      const summary = await stub.summary();
      expect(summary.activity.lastSettledTurn).toEqual({ id: later, status: "completed", at: frozenAt });
      expect(summary.result?.turnId).toBe(later);
      return { earlier, later };
    };

    // The older admission settles last: an admission-ordered tiebreak walked
    // from the lowest rowid names it too, by coincidence.
    const first = await pair("2026-09-16T12:00:00.000Z", "steered first");
    // The newer admission settles last: only settlement order names it.
    const second = await pair("2026-09-16T12:00:01.000Z", "active first");

    const order = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; settled_seq: number }>("SELECT id, settled_seq FROM turns ORDER BY settled_seq")
        .toArray(),
    );
    expect(order).toEqual([
      { id: first.earlier, settled_seq: 1 },
      { id: first.later, settled_seq: 2 },
      { id: second.earlier, settled_seq: 3 },
      { id: second.later, settled_seq: 4 },
    ]);
    runtime.close(1000, "done");
    await acknowledged(sessionId);
  });

  it("gives turns settled before the settlement order existed their previous order, updated_at then rowid, and continues above it", async () => {
    const created = await createSession();
    const sessionId = created.body.session.id;
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      // The schema as it was: no settled_seq, and turns_settled over updated_at.
      state.storage.sql.exec("DROP INDEX turns_settled");
      state.storage.sql.exec("ALTER TABLE turns DROP COLUMN settled_seq");
      state.storage.sql.exec(
        `CREATE INDEX turns_settled ON turns(updated_at DESC)
         WHERE status IN ('completed', 'failed', 'cancelled')`,
      );
      const legacy: Array<[id: string, status: string, updatedAt: string]> = [
        ["turn-a", "completed", "2026-09-16T12:00:00.000Z"],
        ["turn-b", "failed", "2026-09-16T11:59:59.000Z"],
        ["turn-c", "cancelled", "2026-09-16T12:00:00.000Z"],
        ["turn-d", "queued", "2026-09-16T12:00:01.000Z"],
      ];
      for (const [id, status, updatedAt] of legacy) {
        state.storage.sql.exec(
          `INSERT INTO turns (id, input, status, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          id,
          status,
          `key:${id}`,
          "2026-09-16T11:00:00.000Z",
          updatedAt,
        );
      }
    });
    // The next activation migrates: the column, its backfill and the rebuilt index.
    await evictDurableObject(stub);
    const migrated = await runInDurableObject(stub, (_instance, state) => ({
      turns: state.storage.sql
        .exec<{ id: string; settled_seq: number | null }>("SELECT id, settled_seq FROM turns ORDER BY rowid")
        .toArray(),
      index: state.storage.sql
        .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'turns_settled'")
        .one().sql,
    }));
    expect(migrated.turns).toEqual([
      { id: "turn-a", settled_seq: 2 },
      { id: "turn-b", settled_seq: 1 },
      { id: "turn-c", settled_seq: 3 },
      { id: "turn-d", settled_seq: null },
    ]);
    expect(migrated.index).toContain("settled_seq");
    expect((await stub.summary()).activity.lastSettledTurn).toEqual({
      id: "turn-c",
      status: "cancelled",
      at: "2026-09-16T12:00:00.000Z",
    });
    // A settlement after the migration orders above every backfilled row.
    await json<SessionSnapshot>(await SELF.fetch(`${BASE}/v1/sessions/${sessionId}/end`, { method: "POST" }));
    expect((await stub.summary()).activity.lastSettledTurn).toMatchObject({ id: "turn-d", status: "cancelled" });
    const ended = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ settled_seq: number }>("SELECT settled_seq FROM turns WHERE id = 'turn-d'")
        .one().settled_seq,
    );
    expect(ended).toBe(4);
  });
});
