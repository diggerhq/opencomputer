import { abortAllDurableObjects, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryObjectName, type MemoryDeclaration } from "../src/edge/memory-contract.js";
import type { MemoryDurableObject } from "../src/edge/memory-do.js";
import { ATTEMPT_DEADLINE_MS } from "../src/edge/memory-session.js";
import type { SessionDurableObject } from "../src/edge/session-do.js";
import type { InitializeSessionResult, Project, SessionSnapshot } from "../src/protocol.js";

/**
 * Session admission and closure against the Memory DO: bindings validated
 * on create, grants issued through a pending row, revocation acknowledged
 * before end reports success. Lost replies are injected by swapping the
 * Session DO's MEMORY namespace; eviction restores the real one and the
 * session alarm re-drives whatever is pending.
 */

const base = "https://managedagents.test";
const notes: MemoryDeclaration = { id: "notes", description: "Notes.", provider: { kind: "document", maxBytes: 1_024 } };

const clock = {
  held: Date.now() + 24 * 60 * 60_000,
  hold(): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(this.held));
  },
  advance(ms: number): void {
    this.held += ms;
    vi.setSystemTime(new Date(this.held));
  },
  async release(): Promise<void> {
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
  },
};

beforeEach(async () => {
  clock.hold();
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

afterEach(() => {
  vi.useRealTimers();
});

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

interface Fixture {
  project: Project;
  agent: string;
  memory: DurableObjectStub<import("../src/edge/memory-do.js").MemoryDurableObject>;
  create(key: string, memory: unknown): Promise<Response>;
}

/** A project with one deployed agent declaring `notes`, holding one document `workshop`. */
async function fixture(): Promise<Fixture> {
  const created = await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { environmentMode: "legacy", name: `Adm ${crypto.randomUUID().slice(0, 8)}` }));
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  const project = body.project ?? body;
  const deployed = await SELF.fetch(
    `${base}/v1/deployments`,
    jsonRequest("POST", {
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      imageArn: "test-image",
      imageVersion: "1",
      artifact: { bucket: "b", key: `accounts/local/agents/${project.agentId}/artifact.json`, digest: "a".repeat(64), size: 1 },
      memory: [notes],
    }),
  );
  expect(deployed.status).toBe(201);
  const document = await SELF.fetch(
    `${base}/v1/projects/${project.id}/memory/notes/documents/workshop?environment=development`,
    jsonRequest("PUT", { title: "Workshop", text: "v1" }, { "if-none-match": "*" }),
  );
  expect(document.status).toBe(201);
  return {
    project,
    agent: `${project.agentId}@development`,
    memory: env.MEMORY.getByName(memoryObjectName("local", project.id, "development")),
    create: (key, memory) =>
      SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: `${project.agentId}@development`, memory }, { "idempotency-key": key })),
  };
}

const rw = { notes: { scope: "document", id: "workshop", access: "read-write" } };

/** The same derivation createSession uses for an Idempotency-Key. */
async function sessionIdFor(key: string): Promise<string> {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["session", "local", key])))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

const sessions = (id: string) => env.SESSIONS.getByName(id);

/** Swaps the Session DO's MEMORY namespace for one that loses the named reply. */
async function loseReply(sessionId: string, method: "issueGrants" | "closeSession"): Promise<void> {
  await runInDurableObject(sessions(sessionId), (instance: SessionDurableObject) => {
    const host = instance as unknown as { env: Record<string, unknown> };
    host.env = {
      ...host.env,
      MEMORY: {
        getByName: () => ({
          [method]: async () => {
            throw new Error(`injected lost ${method} reply`);
          },
        }),
      },
    };
  });
}

/**
 * Swaps the Session DO's MEMORY namespace for one whose named method never
 * replies: the object is left with the call in flight, before any catch or
 * finally could run. With `commit`, the real Memory DO is called first, so
 * the remote side has committed and only the local acknowledgement is
 * missing.
 */
async function hangReply(
  sessionId: string,
  method: "issueGrants" | "closeSession",
  options: { commit: boolean },
): Promise<void> {
  await runInDurableObject(sessions(sessionId), (instance: SessionDurableObject) => {
    const host = instance as unknown as { env: Record<string, unknown> };
    const real = host.env.MEMORY as DurableObjectNamespace<MemoryDurableObject>;
    host.env = {
      ...host.env,
      MEMORY: {
        getByName: (name: string) => ({
          [method]: async (...args: unknown[]) => {
            if (options.commit) {
              const stub = real.getByName(name) as unknown as Record<string, (...input: unknown[]) => Promise<unknown>>;
              await stub[method]!(...args);
            }
            await new Promise<never>(() => undefined);
          },
        }),
      },
    };
  });
}

async function evictSession(sessionId: string): Promise<void> {
  await clock.release();
  await evictDurableObject(sessions(sessionId));
  clock.hold();
}

/** Kills every live object at once, in-flight calls included; storage survives. */
async function crashAll(): Promise<void> {
  await clock.release();
  await abortAllDurableObjects();
  clock.hold();
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the object to reach the expected state");
}

async function error(response: Response): Promise<{ status: number; code: string }> {
  const body = await response.json<{ error: { code: string } }>();
  return { status: response.status, code: body.error.code };
}

async function inspect(sessionId: string): Promise<SessionSnapshot> {
  const response = await SELF.fetch(`${base}/v1/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return response.json<SessionSnapshot>();
}

describe("memory bindings on session create", () => {
  it("admits declared bindings, issues grants and reports them with writable", async () => {
    const f = await fixture();
    const response = await f.create("adm-1", rw);
    expect(response.status).toBe(201);
    const { session } = await response.json<InitializeSessionResult>();
    expect(session.memory).toEqual([{ resource: "notes", scope: "document", id: "workshop", access: "read-write", writable: true }]);
    expect(session.memoryAdmission).toEqual({ state: "issued" });
    expect(await f.memory.recall(session.id, "notes")).toMatchObject({ kind: "projection", projection: { text: "v1", writable: true } });

    // Inspection asks the Memory DO: a frozen document is not writable.
    expect((await inspect(session.id)).memory?.[0]?.writable).toBe(true);
    const frozen = await SELF.fetch(
      `${base}/v1/projects/${f.project.id}/memory/notes/documents/workshop?environment=development`,
      jsonRequest("PATCH", { agentWrites: "disabled" }, { "if-match": '"1"' }),
    );
    expect(frozen.status).toBe(200);
    expect((await inspect(session.id)).memory?.[0]?.writable).toBe(false);
    expect(await f.memory.save(session.id, "notes", { text: "v2" }, "1")).toEqual({ status: "rejected", reason: "agent_writes_disabled" });
  });

  it("rejects undeclared resources, missing documents and malformed bindings before any session exists", async () => {
    const f = await fixture();
    expect(await error(await f.create("adm-2a", { other: { scope: "collection" } }))).toEqual({ status: 400, code: "invalid_memory_binding" });
    expect(await error(await f.create("adm-2b", { notes: { scope: "document", id: "absent", access: "read" } }))).toEqual({ status: 400, code: "invalid_memory_binding" });
    expect(await error(await f.create("adm-2c", { notes: { scope: "collection", access: "read-write" } }))).toEqual({ status: 400, code: "invalid_memory_binding" });
    expect(await error(await f.create("adm-2d", { notes: { scope: "namespace", id: "x" } }))).toEqual({ status: 400, code: "invalid_memory_binding" });
    expect(await error(await f.create("adm-2e", [rw]))).toEqual({ status: 400, code: "invalid_memory_binding" });
    for (const key of ["adm-2a", "adm-2b", "adm-2c", "adm-2d", "adm-2e"]) {
      expect(await sessions(await sessionIdFor(key)).snapshotOrNull()).toBeNull();
    }
    // The Memory DO is the authority: a grant set it refuses ends the session.
    const wide = await f.create("adm-2f", { notes: { scope: "collection" }, elsewhere: { scope: "collection" } });
    expect(await error(wide)).toEqual({ status: 400, code: "invalid_memory_binding" });
  });

  it("replays the same key with the same bindings and refuses different bindings", async () => {
    const f = await fixture();
    const first = await f.create("adm-3", rw);
    expect(first.status).toBe(201);
    const { session } = await first.json<InitializeSessionResult>();
    const again = await f.create("adm-3", { notes: { scope: "document", id: "workshop", access: "read-write" } });
    expect(again.status).toBe(200);
    expect((await again.json<{ session: SessionSnapshot }>()).session.id).toBe(session.id);
    expect(await error(await f.create("adm-3", { notes: { scope: "document", id: "workshop", access: "read" } }))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
    expect(await error(await f.create("adm-3", {}))).toEqual({ status: 409, code: "idempotency_conflict" });
    expect(await error(await f.create("adm-3", { notes: { scope: "collection" } }))).toEqual({ status: 409, code: "idempotency_conflict" });
  });

  it("replays an identical create after its document was deleted; a new admission still prevalidates", async () => {
    const f = await fixture();
    const first = await f.create("adm-3b", rw);
    expect(first.status).toBe(201);
    const { session } = await first.json<InitializeSessionResult>();
    const deleted = await SELF.fetch(
      `${base}/v1/projects/${f.project.id}/memory/notes/documents/workshop?environment=development`,
      { method: "DELETE", headers: { "if-match": '"1"' } },
    );
    expect(deleted.status).toBe(204);
    // The immutable inputs match: the existing session comes back, not 400.
    const replay = await f.create("adm-3b", rw);
    expect(replay.status).toBe(200);
    expect((await replay.json<{ session: SessionSnapshot }>()).session.id).toBe(session.id);
    // A different key is a new admission and the live check still applies.
    expect(await error(await f.create("adm-3c", rw))).toEqual({ status: 400, code: "invalid_memory_binding" });
    expect(await sessions(await sessionIdFor("adm-3c")).snapshotOrNull()).toBeNull();
  });

  it("a lost issueGrants reply is unconfirmed, admits no turn, and a replay resumes the RPC", async () => {
    const f = await fixture();
    const sessionId = await sessionIdFor("adm-4");
    await loseReply(sessionId, "issueGrants");
    expect(await error(await f.create("adm-4", rw))).toEqual({ status: 503, code: "memory_admission_unconfirmed" });
    const pending = await sessions(sessionId).snapshot();
    expect(pending.memoryAdmission).toMatchObject({ state: "pending", error: "injected lost issueGrants reply" });
    expect(pending.memory).toEqual([expect.objectContaining({ resource: "notes", writable: false })]);
    expect(await f.memory.recall(sessionId, "notes")).toEqual({ kind: "rejected", reason: "not_bound" });
    expect(await error(await SELF.fetch(`${base}/v1/sessions/${sessionId}/turns`, jsonRequest("POST", { input: "hello" })))).toEqual({
      status: 409,
      code: "memory_admission_pending",
    });

    // The session exists locally with its pending row; a fresh activation
    // sees the real Memory DO and the replay drives the grant to issued.
    await evictSession(sessionId);
    const replay = await f.create("adm-4", rw);
    expect(replay.status).toBe(200);
    expect((await replay.json<{ session: SessionSnapshot }>()).session).toMatchObject({
      id: sessionId,
      memoryAdmission: { state: "issued" },
      memory: [expect.objectContaining({ writable: true })],
    });
    expect(await f.memory.recall(sessionId, "notes")).toMatchObject({ kind: "projection" });
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/turns`, jsonRequest("POST", { input: "hello" }))).status).toBe(202);
  });

  it("a deferred rejected admission refuses turns and ends the session like an initial refusal", async () => {
    const f = await fixture();
    const sessionId = await sessionIdFor("adm-7");
    await loseReply(sessionId, "issueGrants");
    expect((await f.create("adm-7", rw)).status).toBe(503);
    const deleted = await SELF.fetch(
      `${base}/v1/projects/${f.project.id}/memory/notes/documents/workshop?environment=development`,
      { method: "DELETE", headers: { "if-match": '"1"' } },
    );
    expect(deleted.status).toBe(204);
    await evictSession(sessionId);
    clock.advance(5_000);
    expect(await runDurableObjectAlarm(sessions(sessionId))).toBe(true);
    const snapshot = await sessions(sessionId).snapshot();
    expect(snapshot.memoryAdmission).toEqual({ state: "rejected", reason: "not_found", resource: "notes", id: "workshop" });
    expect(snapshot.status).toBe("ended");
    expect(snapshot.memoryClosure).toBe("acknowledged");
    expect(await error(await SELF.fetch(`${base}/v1/sessions/${sessionId}/turns`, jsonRequest("POST", { input: "hello" })))).toEqual({
      status: 409,
      code: "memory_admission_rejected",
    });
    expect(await error(await f.create("adm-7", rw))).toEqual({ status: 400, code: "invalid_memory_binding" });
  });

  it("the session alarm re-drives a pending admission after eviction", async () => {
    const f = await fixture();
    const sessionId = await sessionIdFor("adm-5");
    await loseReply(sessionId, "issueGrants");
    expect((await f.create("adm-5", rw)).status).toBe(503);
    await evictSession(sessionId);
    clock.advance(5_000);
    expect(await runDurableObjectAlarm(sessions(sessionId))).toBe(true);
    expect((await sessions(sessionId).snapshot()).memoryAdmission).toEqual({ state: "issued" });
    expect(await f.memory.recall(sessionId, "notes")).toMatchObject({ kind: "projection", projection: { writable: true } });
  });
});

describe("recovery armed before the first RPC", () => {
  for (const commit of [false, true]) {
    it(`admission: an object killed with issueGrants in flight${commit ? " after the remote commit" : ""} is woken by its alarm`, async () => {
      const f = await fixture();
      const sessionId = await sessionIdFor(`arm-1-${String(commit)}`);
      await hangReply(sessionId, "issueGrants", { commit });
      const create = f.create(`arm-1-${String(commit)}`, rw).catch(() => null);
      await until(async () => (await sessions(sessionId).snapshotOrNull())?.memoryAdmission?.state === "pending");
      await crashAll();
      await create;
      expect((await sessions(sessionId).snapshot()).memoryAdmission?.state).toBe("pending");
      // The wake-up was persisted before the call left, and it completes the admission.
      clock.advance(ATTEMPT_DEADLINE_MS + 1_000);
      expect(await runDurableObjectAlarm(sessions(sessionId))).toBe(true);
      expect((await sessions(sessionId).snapshot()).memoryAdmission).toEqual({ state: "issued" });
      expect(await f.memory.recall(sessionId, "notes")).toMatchObject({ kind: "projection", projection: { writable: true } });
      // The client retries its failed create: the replay returns the admitted
      // session and finishes indexing it, so it is addressable.
      const replay = await f.create(`arm-1-${String(commit)}`, rw);
      expect(replay.status).toBe(200);
      expect((await replay.json<{ session: SessionSnapshot }>()).session.memoryAdmission).toEqual({ state: "issued" });
      expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/turns`, jsonRequest("POST", { input: "hello" }))).status).toBe(202);
    });

    it(`closure: an object killed with closeSession in flight${commit ? " after the remote commit" : ""} is woken by its alarm`, async () => {
      const f = await fixture();
      const { session } = await (await f.create(`arm-2-${String(commit)}`, rw)).json<InitializeSessionResult>();
      await hangReply(session.id, "closeSession", { commit });
      const end = SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" }).catch(() => null);
      await until(async () => (await sessions(session.id).snapshotOrNull())?.memoryClosure === "pending");
      await crashAll();
      await end;
      expect(await sessions(session.id).snapshot()).toMatchObject({ status: "ended", memoryClosure: "pending" });
      clock.advance(ATTEMPT_DEADLINE_MS + 1_000);
      expect(await runDurableObjectAlarm(sessions(session.id))).toBe(true);
      expect((await sessions(session.id).snapshot()).memoryClosure).toBe("acknowledged");
      expect(await f.memory.save(session.id, "notes", { text: "late" }, "1")).toEqual({ status: "rejected", reason: "session_closed" });
      expect((await SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" })).status).toBe(200);
    });
  }
});

describe("memory closure on session end", () => {
  it("end revokes write access before it reports success; writes before it stand", async () => {
    const f = await fixture();
    const { session } = await (await f.create("end-1", rw)).json<InitializeSessionResult>();
    expect(await f.memory.save(session.id, "notes", { text: "before end" }, "1")).toMatchObject({ status: "saved", revision: "2" });
    const ended = await SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({
      status: "ended",
      memory: [expect.objectContaining({ resource: "notes", writable: false })],
    });
    expect(await f.memory.save(session.id, "notes", { text: "after end" }, "2")).toEqual({ status: "rejected", reason: "session_closed" });
    expect(await f.memory.getDocument("notes", "workshop")).toMatchObject({ kind: "document", document: { text: "before end" } });
    expect((await inspect(session.id)).memory?.[0]?.writable).toBe(false);
    // A second end is idempotent and still confirmed.
    expect((await SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" })).status).toBe(200);
  });

  it("a lost closeSession reply is unconfirmed; a retried end re-drives it; the alarm does too after eviction", async () => {
    const f = await fixture();
    const { session } = await (await f.create("end-2", rw)).json<InitializeSessionResult>();
    await loseReply(session.id, "closeSession");
    expect(await error(await SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" }))).toEqual({
      status: 503,
      code: "session_end_unconfirmed",
    });
    // Ended locally, not yet revoked: the documented uncertainty.
    expect((await sessions(session.id).snapshot()).status).toBe("ended");
    expect(await f.memory.save(session.id, "notes", { text: "still open" }, "1")).toMatchObject({ status: "saved" });

    await evictSession(session.id);
    expect((await SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" })).status).toBe(200);
    expect(await f.memory.save(session.id, "notes", { text: "closed" }, "2")).toEqual({ status: "rejected", reason: "session_closed" });

    // And the same recovery through the alarm alone.
    const second = await (await f.create("end-3", rw)).json<InitializeSessionResult>();
    await loseReply(second.session.id, "closeSession");
    expect((await SELF.fetch(`${base}/v1/sessions/${second.session.id}/end`, { method: "POST" })).status).toBe(503);
    await evictSession(second.session.id);
    clock.advance(5_000);
    expect(await runDurableObjectAlarm(sessions(second.session.id))).toBe(true);
    expect(await f.memory.issueGrants(second.session.id, [{ resource: "notes", scope: "collection", access: "read" }])).toEqual({ kind: "closed" });
    expect((await SELF.fetch(`${base}/v1/sessions/${second.session.id}/end`, { method: "POST" })).status).toBe(200);
  });

  it("sessions without bindings end without touching the Memory DO", async () => {
    const f = await fixture();
    const created = await f.create("end-4", undefined);
    expect(created.status).toBe(201);
    const { session } = await created.json<InitializeSessionResult>();
    expect(session.memory).toBeUndefined();
    await loseReply(session.id, "closeSession");
    expect((await SELF.fetch(`${base}/v1/sessions/${session.id}/end`, { method: "POST" })).status).toBe(200);
  });
});
