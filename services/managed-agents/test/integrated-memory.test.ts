import { abortAllDurableObjects, env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryObjectName, type Document } from "../src/edge/memory-contract.js";
import { OPENROUTER_MODEL_CATALOG_CACHE_KEY } from "../src/edge/model-catalog.js";
import type { MemoryDurableObject } from "../src/edge/memory-do.js";
import { ATTEMPT_DEADLINE_MS } from "../src/edge/memory-session.js";
import type { SessionDurableObject } from "../src/edge/session-do.js";
import type { AgentDeployment, AgentEvent, AgentInputValue, InitializeSessionResult, Project, SessionSnapshot } from "../src/protocol.js";
import { artifactBundle, artifactDigest } from "./fixtures/memory-integrated-fixture.mjs";

/**
 * The gate the integration review asked for: one path through the actual
 * consumers. A managed session with bindings is created at the edge, runs
 * its turns on the real Workerd host (the real OpenCode loop against a
 * scripted model), which recalls and saves through the real Memory
 * Durable Object; the host's saved event reaches the public session log as
 * `memory.saved`. Along the way: environment isolation, an owner edit
 * between steps, grant closure with the object killed while its closing
 * call is in flight, and a second session reading the first one's save.
 */

const base = "https://managedagents.test";
const rw = { notes: { scope: "document", id: "workshop", access: "read-write" } };

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
});

afterEach(() => {
  vi.useRealTimers();
});

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

async function waitForEvents(sessionId: string, predicate: (events: AgentEvent[]) => boolean): Promise<AgentEvent[]> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await SELF.fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/events`);
    expect(response.status).toBe(200);
    const { events } = await response.json<{ events: AgentEvent[] }>();
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for session events");
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the object to reach the expected state");
}

interface Fixture {
  project: Project;
  /** A fresh stub each time: a stub made before a crash is unusable after it. */
  memory: () => DurableObjectStub<MemoryDurableObject>;
  documentUrl: (environment: "development" | "production") => string;
  createSession(): Promise<SessionSnapshot>;
  /** Runs one turn to completion and returns the session's events so far. */
  turn(
    sessionId: string,
    input: string,
    key: string,
    payload?: AgentInputValue,
  ): Promise<{ turnId: string; events: AgentEvent[] }>;
}

/** One project per test: the file never resets storage between tests, and a project name is an agent id. */
async function fixture(projectName: string): Promise<Fixture> {
  await caches.default.put(
    OPENROUTER_MODEL_CATALOG_CACHE_KEY,
    Response.json(
      {
        fetchedAt: Date.now(),
        ids: [
          "anthropic/claude-sonnet-4.6",
          "anthropic/claude-sonnet-5",
        ],
      },
      { headers: { "cache-control": "public, max-age=3600" } },
    ),
  );
  const created = await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { environmentMode: "legacy", name: projectName }));
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  const project = body.project ?? body;
  const digest = await artifactDigest();
  let warmDeployment: AgentDeployment | undefined;
  // One artifact promoted to both environments: the memory scopes differ.
  for (const alias of ["development", "production"]) {
    const deployed = await SELF.fetch(
      `${base}/v1/deployments`,
      jsonRequest("POST", {
        agentId: project.agentId,
        alias,
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: { bucket: "test-artifacts", key: digest, digest, size: artifactBundle.byteLength },
        memory: [{ id: "notes", description: "Workshop notes.", provider: { kind: "document", maxBytes: 8_192 } }],
        models: [
          { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
        ],
      }),
    );
    expect(deployed.status).toBe(201);
    warmDeployment = await deployed.json<AgentDeployment>();
  }
  expect(warmDeployment).toBeDefined();
  const prewarmed = await (
    env as unknown as { WORKERD_RUNTIME: Fetcher }
  ).WORKERD_RUNTIME.fetch("https://workerd-runtime.invalid/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deployment: {
        ...warmDeployment,
        models: [
          { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
          { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
        ],
        defaultModel: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-5",
        },
      },
      modelGateway: {
        baseURL: `${base}/v1/model-gateway-capabilities/prewarm-test/api/v1`,
        token: "prewarm-test-token",
      },
    }),
  });
  expect(prewarmed.status).toBe(201);
  const prewarmedSession = await prewarmed.json<{
    id: string;
    model: { providerID: string; id: string };
  }>();
  expect(prewarmedSession).toMatchObject({
    id: expect.not.stringMatching(/^pending$/),
    model: {
      providerID: "custom",
      id: "anthropic/claude-sonnet-5",
    },
  });
  expect(
    Number(prewarmed.headers.get("x-opencomputer-runtime-init-ms")),
  ).toBeGreaterThan(0);
  const documentUrl = (environment: "development" | "production") =>
    `${base}/v1/projects/${project.id}/memory/notes/documents/workshop?environment=${environment}`;
  return {
    project,
    memory: () => env.MEMORY.getByName(memoryObjectName("local", project.id, "development")),
    documentUrl,
    createSession: async () => {
      const response = await SELF.fetch(
        `${base}/v1/sessions`,
        jsonRequest("POST", { agentId: `${project.agentId}@development`, memory: rw }),
      );
      expect(response.status).toBe(201);
      const { session } = await response.json<InitializeSessionResult>();
      expect(session).toMatchObject({
        executionMode: "workerd",
        environment: "development",
        memoryObject: memoryObjectName("local", project.id, "development"),
        memoryAdmission: { state: "issued" },
      });
      return session;
    },
    turn: async (sessionId, input, key, payload) => {
      const response = await SELF.fetch(
        `${base}/v1/sessions/${sessionId}/turns`,
        jsonRequest("POST", {
          input,
          idempotencyKey: key,
          ...(payload !== undefined ? { payload } : {}),
        }),
      );
      expect(response.status).toBe(202);
      const { turnId } = await response.json<{ turnId: string }>();
      const events = await waitForEvents(sessionId, (current) =>
        current.some((event) => event.turnId === turnId && (event.type === "turn.completed" || event.type === "turn.failed")),
      );
      const failed = events.find((event) => event.turnId === turnId && event.type === "turn.failed");
      if (failed) throw new Error(`Turn failed: ${JSON.stringify(failed.data)}`);
      return { turnId, events: events.filter((event) => event.turnId === turnId) };
    },
  };
}

function rendered(events: AgentEvent[]): string[] {
  return events
    .filter((event) => event.type === "agent.rendered")
    .map((event) => String(event.data.instructions));
}

/** Leaves the Session DO with a closeSession that never replies; the real Memory DO is not called. */
async function hangCloseReply(sessionId: string): Promise<void> {
  await runInDurableObject(env.SESSIONS.getByName(sessionId), (instance: SessionDurableObject) => {
    const host = instance as unknown as { env: Record<string, unknown> };
    host.env = {
      ...host.env,
      MEMORY: {
        getByName: () => ({
          closeSession: () => new Promise<never>(() => undefined),
        }),
      },
    };
  });
}

describe("memory through the edge, the real host and the real Memory DO", () => {
  it("loads a packaged skill and its supporting file through the real Workerd host", async () => {
    const f = await fixture("Integrated skills");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest(
        "PUT",
        { title: "Workshop", text: "test notes" },
        { "if-none-match": "*" },
      ),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    const turn = await f.turn(
      session.id,
      "load the billing skill",
      "skill-loading",
    );
    expect(
      turn.events
        .filter((event) => event.type === "tool.completed")
        .map((event) => event.data.tool),
    ).toEqual(["load_agent_skill", "load_agent_skill"]);
    expect(
      turn.events.find((event) => event.type === "message.completed")?.data.text,
    ).toContain("Verify the customer and current plan");
  });

  it("keeps progress from a retried call out of the answer that follows its tool", async () => {
    const f = await fixture("Model retry before output");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "notes" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    // The first call fails before any output, so the retry writes the
    // same message: progress and a tool call. The answer after the tool
    // is a response of its own, not a continuation of that progress.
    const turn = await f.turn(session.id, "flaky-internal: progress then tool", "model-retry-before-output");
    expect(turn.events.filter((event) => event.type === "runtime.log" && event.data.phase === "model_retry")).toHaveLength(1);
    const completed = turn.events.find((event) => event.type === "message.completed")?.data;
    expect(completed?.text).toBe("Progress before the tool. Final answer.");
    expect(completed?.finalText).toBe("Final answer.");
  });

  it("retries a model call that the provider failed and completes the turn on the real host", async () => {
    const f = await fixture("Model retry");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "notes" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    const turn = await f.turn(session.id, "flaky-internal: plan the change", "model-retry-internal");
    const retries = turn.events.filter((event) => event.type === "runtime.log" && event.data.phase === "model_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]!.data).toEqual(
      expect.objectContaining({ phase: "model_retry", attempt: 2, errorType: "provider.internal" }),
    );
    expect(JSON.stringify(retries[0]!.data)).not.toContain("scripted upstream failure");
    expect(turn.events.find((event) => event.type === "message.completed")?.data.text).toBe(
      "Answered on attempt 2: plan the change",
    );
    expect(retries[0]!.data.hostGranted).toBe(false);
    const usage = turn.events.filter((event) => event.type === "usage.recorded");
    expect(usage.length).toBeGreaterThanOrEqual(1);
    // The qualified model the accounting keys route charges by; the Workerd
    // host registers models without prices, so OpenCode's cost is zero.
    expect(usage[0]!.data).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        model: "openrouter/anthropic/claude-sonnet-5",
        costUsd: 0,
        payer: "user",
      }),
    );
  });

  it("continues a model call whose response stream broke after the first token", async () => {
    const f = await fixture("Model retry stream");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "notes" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    const turn = await f.turn(session.id, "flaky-stream: plan the change", "model-retry-stream");
    const retries = turn.events.filter((event) => event.type === "runtime.log" && event.data.phase === "model_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]!.data.errorType).toBe("provider.invalid-output");
    const completed = turn.events.find((event) => event.type === "message.completed")?.data;
    // The answer is the whole response: the fragment before the break and
    // its continuation, once each.
    expect(completed?.finalText).toBe("Partial Answered on attempt 2: plan the change");
    expect(completed?.text).toBe("Partial Answered on attempt 2: plan the change");
  });

  it("settles a tool call cut off by the broken stream as failed, runs the reissued call once and completes the turn", async () => {
    const f = await fixture("Model retry tool");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "notes" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    const turn = await f.turn(session.id, "flaky-tool:Exercises must run on Node.js 22.", "model-retry-tool");
    const retries = turn.events.filter((event) => event.type === "runtime.log" && event.data.phase === "model_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]!.data).toEqual(
      expect.objectContaining({ errorType: "provider.invalid-output", hostGranted: false }),
    );
    // OpenCode's OpenAI chat protocol emits a tool call at the finish
    // reason, so a call cut off by the break never runs: it is settled as
    // failed with the stream's failure, the continuation carries that
    // result, and the model calls again. That call runs exactly once.
    const tools = turn.events.filter((event) => event.type.startsWith("tool."));
    expect(tools.map((event) => [event.type, event.data.tool])).toEqual([
      ["tool.failed", "memory_save"],
      ["tool.started", "memory_save"],
      ["tool.completed", "memory_save"],
    ]);
    expect(tools[0]!.data.message).toBe("OpenAI Chat stream ended without finish_reason");
    expect(turn.events.filter((event) => event.type === "memory.saved")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ resource: "notes", revision: "2" }) }),
    ]);
    expect(await f.memory().getDocument("notes", "workshop")).toMatchObject({
      kind: "document",
      document: { text: "Exercises must run on Node.js 22.", revision: "2" },
    });
    const completed = turn.events.find((event) => event.type === "message.completed")?.data;
    // The answer after the tool ran is its own response; the fragment cut
    // off by the break stays in the turn's text.
    expect(String(completed?.finalText)).toMatch(/^Saved on attempt 3: .*"status":"saved"/s);
    expect(String(completed?.text)).toMatch(/^Saving Saved on attempt 3: /s);
  });

  it("fails the turn with the provider's typed class, attributed to the call's model, when the provider rejects it", async () => {
    const f = await fixture("Model rejected");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "notes" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    const response = await SELF.fetch(
      `${base}/v1/sessions/${session.id}/turns`,
      jsonRequest("POST", { input: "rejected: plan the change", idempotencyKey: "model-rejected" }),
    );
    expect(response.status).toBe(202);
    const { turnId } = await response.json<{ turnId: string }>();
    const events = await waitForEvents(session.id, (current) =>
      current.some((event) => event.turnId === turnId && (event.type === "turn.completed" || event.type === "turn.failed")),
    );
    const failed = events.find((event) => event.turnId === turnId && event.type === "turn.failed");
    expect(failed).toBeDefined();
    // A rejection is not retried, by OpenCode or the host: one attempt.
    expect(failed!.data.failure).toEqual({
      class: "provider",
      subtype: "auth",
      status: 401,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
      retry: { attempts: 1, hostGranted: false },
    });
    expect(events.filter((event) => event.turnId === turnId && event.data.phase === "model_retry")).toHaveLength(0);
  });

  it("grants the host's one retry for a malformed response and fails the call when the second is malformed too", async () => {
    const f = await fixture("Model host grant");
    const document = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "notes" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const session = await f.createSession();
    // A frame that is not JSON is invalid output OpenCode declines to
    // retry; the host grants one retry, and the second call answers.
    const first = await f.turn(session.id, "malformed: once", "model-malformed-once");
    const retries = first.events.filter((event) => event.type === "runtime.log" && event.data.phase === "model_retry");
    expect(retries.map((event) => event.data.hostGranted)).toEqual([true]);
    expect(retries[0]!.data.errorType).toBe("provider.invalid-output");
    expect(first.events.find((event) => event.type === "message.completed")?.data.finalText).toBe("Recovered after 2 calls");
    // Malformed again after the grant: no second grant, the turn fails
    // with both attempts on record.
    const response = await SELF.fetch(
      `${base}/v1/sessions/${session.id}/turns`,
      jsonRequest("POST", { input: "malformed: always", idempotencyKey: "model-malformed-always" }),
    );
    expect(response.status).toBe(202);
    const { turnId } = await response.json<{ turnId: string }>();
    const events = await waitForEvents(session.id, (current) =>
      current.some((event) => event.turnId === turnId && (event.type === "turn.failed" || event.type === "turn.completed")),
    );
    const current = events.filter((event) => event.turnId === turnId);
    expect(
      current.filter((event) => event.type === "runtime.log" && event.data.phase === "model_retry").map((event) => event.data.hostGranted),
    ).toEqual([true]);
    expect(current.find((event) => event.type === "turn.failed")?.data.failure).toMatchObject({
      class: "provider",
      subtype: "invalid-output",
      retry: { attempts: 2, hostGranted: true },
    });
  });

  it("hands a turn payload to useInput() on the real host", async () => {
    const f = await fixture("Turn payload");
    const response = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { title: "Workshop", text: "dev text" }, { "if-none-match": "*" }),
    );
    expect(response.status).toBe(201);
    const session = await f.createSession();
    const payload = { repo: "acme/widgets", ref: "main", actor: { id: 583231, login: "octocat" } };
    const turn = await f.turn(session.id, "nomemory: plan the change", "turn-payload", payload);
    // The agent projected exactly what useInput().payload returned.
    expect(rendered(turn.events)).toEqual([
      'No memory for this request. Payload: {"repo":"acme/widgets","ref":"main","actor":{"id":583231,"login":"octocat"}}',
    ]);
    expect(turn.events.filter((event) => event.type === "message.received")).toEqual([
      expect.objectContaining({
        turnId: turn.turnId,
        data: { input: "nomemory: plan the change", mode: "queue", payload },
      }),
    ]);
  });

  it("recalls, saves, reports memory.saved, survives a crash mid-closure and hands the notes to the next session", async () => {
    const f = await fixture("Integrated memory");
    for (const [environment, text] of [["development", "dev text"], ["production", "prod text"]] as const) {
      const response = await SELF.fetch(f.documentUrl(environment), jsonRequest("PUT", { title: "Workshop", text }, { "if-none-match": "*" }));
      expect(response.status).toBe(201);
    }

    // Step one: the render reads the development document, never the
    // production one; the model saves; the host's event reaches the log.
    const first = await f.createSession();
    const one = await f.turn(first.id, "save:Exercises must run on Node.js 22.", "turn-1");
    const firstRender = rendered(one.events);
    expect(firstRender.length).toBeGreaterThanOrEqual(1);
    expect(firstRender[0]).toContain('Saved notes (JSON string): "dev text"');
    expect(firstRender[0]).toContain("Use memory_save");
    expect(firstRender.join("\n")).not.toContain("prod text");
    expect(one.events.filter((event) => event.type === "memory.saved")).toEqual([
      expect.objectContaining({
        turnId: one.turnId,
        data: { resource: "notes", documentId: "workshop", revision: "2", bytes: 33 },
      }),
    ]);
    expect(one.events.find((event) => event.type === "message.completed")?.data.text).toContain('"status":"saved"');
    expect(await f.memory().getDocument("notes", "workshop")).toMatchObject({
      kind: "document",
      document: {
        text: "Exercises must run on Node.js 22.",
        summary: "Workshop requirements.",
        revision: "2",
        writer: { kind: "agent", sessionId: first.id },
      },
    });
    const production = await SELF.fetch(f.documentUrl("production"));
    expect((await production.json<Document>()).text).toBe("prod text");

    // Step two: the owner edits between steps; the next render shows the
    // owner's text and the save lands on the fresh revision.
    const edited = await SELF.fetch(
      f.documentUrl("development"),
      jsonRequest("PUT", { text: "Budget approved by the owner." }, { "if-match": '"2"' }),
    );
    expect(edited.status).toBe(200);
    const two = await f.turn(first.id, "save:Speakers confirmed for both days.", "turn-2");
    expect(rendered(two.events)[0]).toContain('"Budget approved by the owner."');
    expect(two.events.filter((event) => event.type === "memory.saved")).toEqual([
      expect.objectContaining({ turnId: two.turnId, data: expect.objectContaining({ revision: "4" }) }),
    ]);
    expect(await f.memory().getDocument("notes", "workshop")).toMatchObject({
      kind: "document",
      document: { text: "Speakers confirmed for both days.", revision: "4" },
    });

    // Grant closure with the Session DO killed while closeSession is in
    // flight: the alarm armed before the call re-drives it, and the
    // session's writes are revoked before end reports success.
    await hangCloseReply(first.id);
    const end = SELF.fetch(`${base}/v1/sessions/${first.id}/end`, { method: "POST" }).catch(() => null);
    await until(async () => (await env.SESSIONS.getByName(first.id).snapshotOrNull())?.memoryClosure === "pending");
    await abortAllDurableObjects();
    await end;
    expect(await env.SESSIONS.getByName(first.id).snapshot()).toMatchObject({ status: "ended", memoryClosure: "pending" });
    expect(await f.memory().save(first.id, "notes", { text: "still open" }, "4")).toMatchObject({ status: "saved", revision: "5" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + ATTEMPT_DEADLINE_MS + 1_000));
    expect(await runDurableObjectAlarm(env.SESSIONS.getByName(first.id))).toBe(true);
    vi.useRealTimers();
    expect((await env.SESSIONS.getByName(first.id).snapshot()).memoryClosure).toBe("acknowledged");
    expect(await f.memory().save(first.id, "notes", { text: "after close" }, "5")).toEqual({ status: "rejected", reason: "session_closed" });
    const ended = await SELF.fetch(`${base}/v1/sessions/${first.id}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    expect((await ended.json<SessionSnapshot>()).memory).toEqual([expect.objectContaining({ resource: "notes", writable: false })]);

    // A second session bound to the same document reads what the first one
    // left, through its own host activation after the crash.
    const second = await f.createSession();
    const three = await f.turn(second.id, "What do the notes say?", "turn-3");
    expect(rendered(three.events)[0]).toContain('Saved notes (JSON string): "still open"');
    expect(three.events.filter((event) => event.type === "memory.saved")).toEqual([]);
    expect(three.events.find((event) => event.type === "message.completed")?.data.text).toBe("No memory used.");
    expect((await SELF.fetch(`${base}/v1/projects/${f.project.id}/memory?environment=development`)).ok).toBe(true);
    expect(await (await SELF.fetch(`${base}/v1/projects/${f.project.id}/memory?environment=development`)).json()).toEqual({
      resources: [{ id: "notes", provider: { kind: "document", maxBytes: 8_192 }, declared: true, documents: 1 }],
    });
  });
});
