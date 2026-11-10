import {
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  EventSubscription,
  InitializeSessionResult,
  Project,
  SessionSnapshot,
  SessionSummary,
  TurnOutcomeDelivery,
} from "../src/protocol.js";
import { AccountDurableObject } from "../src/edge/account-do.js";
import { SessionDurableObject } from "../src/edge/session-do.js";
import { workerdModelConfiguration } from "../src/edge/deployment-pool-do.js";
import { hostToolCallId } from "../src/tool-identity.js";
import { questionIdFor } from "../src/ask.js";
import publicEventsFixture from "./fixtures/public-events/workerd-turn-with-result.json" with { type: "json" };

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

afterEach(async () => {
  await reset();
});

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return response.json<T>();
}

async function waitForEvents(
  sessionId: string,
  predicate: (events: AgentEvent[]) => boolean,
): Promise<AgentEvent[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { events } = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      ),
    );
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for managed Workerd session events");
}

const notesDeclaration = {
  id: "notes",
  description: "Notes.",
  provider: { kind: "document" as const, maxBytes: 1_024 },
};

async function createWorkerdSession(
  agentId: string,
  digest: string,
  options: {
    environment?: "development" | "production";
    /** Deploy with the `notes` declaration and bind the session read-write to `workshop`. */
    memory?: boolean;
    labels?: Record<string, string>;
  } = {},
): Promise<string> {
  const environment = options.environment ?? "development";
  const deployment = await env.ACCOUNTS.getByName("local").registerDeployment({
    agentId,
    accountId: "local",
    alias: environment,
    runtimeMode: "workerd-lazy-sandbox",
    channels: [],
    connections: [],
    artifact: {
      bucket: "managed-agent-artifacts",
      key: `accounts/local/agents/${agentId}/artifact.json`,
      digest,
      size: 512,
    },
    imageArn: "test-image",
    imageVersion: "1",
    ...(options.memory ? { memory: [notesDeclaration] } : {}),
  });
  expect(deployment.id).toBeDefined();
  if (options.memory) {
    // The document the session binds, in the owning project's environment.
    const project = (await env.ACCOUNTS.getByName("local").listProjects()).find(
      (candidate: Project) => agentId === candidate.agentId || agentId.startsWith(`${candidate.agentId}--`),
    );
    expect(project).toBeDefined();
    const document = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project!.id}/memory/notes/documents/workshop?environment=${environment}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: JSON.stringify({ title: "Workshop", text: "v1" }),
      },
    );
    expect(document.status).toBe(201);
  }
  const created = await json<InitializeSessionResult>(
    await SELF.fetch("https://managedagents.test/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: `${agentId}@${environment}`,
        ...(options.memory
          ? { memory: { notes: { scope: "document", id: "workshop", access: "read-write" } } }
          : {}),
        ...(options.labels ? { labels: options.labels } : {}),
      }),
    }),
  );
  expect(created.session.executionMode).toBe("workerd");
  if (options.memory) {
    expect(created.session.memoryAdmission).toEqual({ state: "issued" });
  }
  runtimeTokens.set(created.session.id, created.runtimeToken);
  return created.session.id;
}

/** The runtime token each created session was issued: what a host presents when it commits a result. */
const runtimeTokens = new Map<string, string>();

/** The fake runtime's record of one managed session's runtime session: calls in order and the live execution. */
async function fakeRuntimeOf(sessionId: string): Promise<{
  calls: Array<{ route: "turn" | "stop" | "terminate"; turnId?: string | null; text?: string; reason?: string | null; at: number }>;
  creation: {
    deployment?: {
      id: string;
      agentId: string;
      region?: string;
      egress?: { domains: string[]; cidrs: string[] };
      artifact: { digest: string };
    };
    locationHint?: string | null;
    modelRoute?: {
      model: string;
      protocol: "anthropic_messages" | "chat_completions" | "responses";
    };
  } | null;
  live: string | null;
  computerGeneration: number;
  computerTerminated: boolean;
}> {
  const runtimeSessionId = await runInDurableObject(
    env.SESSIONS.getByName(sessionId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ runtime_session_id: string }>(
          "SELECT runtime_session_id FROM workerd_session WHERE slot = 1",
        )
        .one().runtime_session_id,
  );
  const runtime = (env as unknown as { WORKERD_RUNTIME: Fetcher }).WORKERD_RUNTIME;
  return json(
    await runtime.fetch(`https://workerd-runtime.invalid/sessions/${encodeURIComponent(runtimeSessionId)}/calls`),
  );
}

async function pendingStopOf(sessionId: string): Promise<
  | { turn_id: string | null; reason: string; attempts: number; terminate_requested: number; replacement_turn_id: string | null; runtime_generation: string | null }
  | undefined
> {
  return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
    state.storage.sql
      .exec<{ turn_id: string | null; reason: string; attempts: number; terminate_requested: number; replacement_turn_id: string | null; runtime_generation: string | null }>(
        "SELECT turn_id, reason, attempts, terminate_requested, replacement_turn_id, runtime_generation FROM workerd_pending_stop WHERE slot = 1",
      )
      .toArray()[0],
  );
}

/** Make the pending stop's settlement budget elapsed and its next attempt due, then fire the alarm. */
async function elapseStopBudget(sessionId: string): Promise<void> {
  const stub = env.SESSIONS.getByName(sessionId);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE workerd_pending_stop SET requested_at_ms = ?, next_attempt_at_ms = ? WHERE slot = 1",
      Date.now() - 61_000,
      Date.now() - 1,
    );
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

function terminalEventsOf(events: AgentEvent[], turnId: string): AgentEvent[] {
  return events.filter(
    (event) =>
      event.turnId === turnId &&
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type),
  );
}

async function postTurn(
  sessionId: string,
  input: string,
  idempotencyKey: string,
  mode?: "queue" | "steer" | "interrupt",
): Promise<{ turnId: string; status: string; duplicate: boolean }> {
  const response = await SELF.fetch(
    `https://managedagents.test/v1/sessions/${sessionId}/turns`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, idempotencyKey, ...(mode ? { mode } : {}) }),
    },
  );
  expect([200, 202]).toContain(response.status);
  return response.json();
}

/** The Account's list row for the session once it holds at least `revision`. */
async function projectedRow(sessionId: string, revision: number): Promise<SessionSummary> {
  const account = env.ACCOUNTS.getByName("local");
  for (let attempt = 0; attempt < 500; attempt++) {
    const held = await account.getSession(sessionId);
    if (held && held.revision >= revision) return held;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Session ${sessionId} never reached revision ${String(revision)} in the projection`);
}

async function snapshotOf(sessionId: string): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(
    await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}`),
  );
}

/**
 * A recorded log with every volatile value replaced, so the same turn
 * recorded twice is the same fixture: ids and timestamps, render ids,
 * millisecond measurements and the runtime's timing text.
 */
function normalizeRecordedEvent(event: AgentEvent): Record<string, unknown> {
  const replace = (value: unknown, key?: string): unknown => {
    if (typeof value === "number" && key && /Ms$/.test(key)) return 0;
    if (typeof value === "string") {
      if (key === "toolCallId" && value.startsWith("call:")) return "<host-call>";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "<uuid>";
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return "<timestamp>";
      if (value.startsWith("render-")) return "<render-id>";
      if (/^runtime-managed-\d+$/.test(value)) return "<runtime-id>";
      return value.replace(/\d+(\.\d+)? ms/g, "<n> ms");
    }
    if (Array.isArray(value)) return value.map((entry) => replace(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, replace(entry, entryKey)]),
      );
    }
    return value;
  };
  return {
    seq: event.seq,
    type: event.type,
    ...(event.turnId ? { turnId: "<turn>" } : {}),
    data: replace(event.data),
  };
}

const TOOL_EVENT_KEYS = new Set(["callId", "tool", "title", "input", "output", "message", "result", "settledBy", "identity"]);

/** The host identity the session stamps on a Workerd tool call's events; the fake runtime emits every call under `msg-1`. */
function workerdToolIdentity(agentId: string, digest: string, sessionId: string, turnId: string, callId: string) {
  return {
    projectId: `project:${agentId}`,
    environment: "development",
    agentId,
    deploymentId: `${agentId}:${digest}`,
    sessionId,
    turnId,
    messageId: "msg-1",
    providerCallId: callId,
    toolCallId: hostToolCallId({
      sessionId,
      turnId,
      messageId: "msg-1",
      providerCallId: callId,
    }),
  };
}
const NATIVE_TOOL_KEYS = ["id", "name", "content", "assistantMessageID", "sessionID", "error", "metadata", "executed"];

describe("public tool events", () => {
  it("emits every tool event of a Workerd turn in the public shape, with the result call's decoded value, and the recorded log matches the fixture", async () => {
    // Review finding 7, emission half. The fake runtime speaks OpenCode's
    // own event shapes (name on input.started, input on called, content
    // parts on success, { type, message } on failed); what reaches the
    // log must be the documented shape on every event.
    const base = "https://managedagents.test";
    const sessionId = await createWorkerdSession("workerd-public-events", "c".repeat(64));
    const turn = await postTurn(
      sessionId,
      "Report the branch [stall 600ms][tool-fails call-0][result-call call-1]",
      "public-events-1",
    );
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "tool.started" && event.data.callId === "call-1"),
    );
    // The result tool commits during the stall, before the model sees
    // success; the stream's completion for the call is then a duplicate.
    const committed = await SELF.fetch(`${base}/v1/sessions/${sessionId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeTokens.get(sessionId)!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        turnId: turn.turnId,
        callId: "call-1",
        tool: "report",
        runtime: { kind: "workerd", bootId: "boot-managed-test", activation: 1 },
        data: { branch: "task/1" },
      }),
    });
    expect(committed.status).toBe(200);
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
    );
    const toolEvents = events.filter((event) => event.type.startsWith("tool."));
    for (const event of toolEvents) {
      expect(event.turnId).toBe(turn.turnId);
      expect(typeof event.data.callId).toBe("string");
      expect(typeof event.data.tool).toBe("string");
      for (const native of NATIVE_TOOL_KEYS) expect(event.data).not.toHaveProperty(native);
      if (event.type !== "tool.progress") {
        for (const key of Object.keys(event.data)) expect(TOOL_EVENT_KEYS.has(key)).toBe(true);
        expect(typeof event.data.title).toBe("string");
      }
    }
    expect(toolEvents.map((event) => [event.type, event.data.callId])).toEqual([
      ["tool.started", "call-0"],
      ["tool.failed", "call-0"],
      ["tool.started", "call-1"],
      ["tool.progress", "call-1"],
      ["tool.completed", "call-1"],
    ]);
    const identity = (callId: string) =>
      workerdToolIdentity("workerd-public-events", "c".repeat(64), sessionId, turn.turnId, callId);
    expect(toolEvents[0]!.data).toEqual({ callId: "call-0", tool: "lookup", title: "lookup", input: { q: "x" }, identity: identity("call-0") });
    expect(toolEvents[1]!.data).toEqual({ callId: "call-0", tool: "lookup", title: "lookup", message: "lookup exploded", identity: identity("call-0") });
    expect(toolEvents[2]!.data).toEqual({ callId: "call-1", tool: "report", title: "report", input: { branch: "task/1" }, identity: identity("call-1") });
    expect(toolEvents[3]!.data).toEqual({ callId: "call-1", tool: "report", stage: "verifying", identity: identity("call-1") });
    // The result call: started and completed under one callId, the
    // completion carrying the decoded value, never its serialized text.
    expect(toolEvents[4]!.data).toEqual({
      callId: "call-1",
      tool: "report",
      title: "report",
      output: { branch: "task/1" },
      result: true,
      identity: identity("call-1"),
    });
    expect((await snapshotOf(sessionId)).result?.data).toEqual(toolEvents[4]!.data.output);

    // The recorded log is the fixture the React hook's tests consume
    // (test/fixtures/public-events/); a change in what the backend emits
    // fails here first.
    expect(events.map(normalizeRecordedEvent)).toEqual(publicEventsFixture.events);
  }, 30_000);

  it("settles a tool call the turn never completed when the turn is cancelled, ahead of the terminal event", async () => {
    const base = "https://managedagents.test";
    const sessionId = await createWorkerdSession("workerd-public-events-settle", "d".repeat(64));
    const turn = await postTurn(sessionId, "Work [tool-before-stall call-2][stall 20000ms]", "public-events-2");
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "tool.started" && event.data.callId === "call-2"),
    );
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
    await waitForTurn(sessionId, turn.turnId, "cancelled");
    const events = (await waitForEvents(sessionId, () => true)).filter((event) => event.turnId === turn.turnId);
    const cancelled = events.find((event) => event.type === "turn.cancelled")!;
    const settled = events.filter((event) => event.type === "tool.failed" && event.data.callId === "call-2");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.data).toEqual({
      callId: "call-2",
      tool: "sandbox_exec",
      title: "sandbox_exec",
      message: "The turn ended (turn.cancelled) before this tool call completed",
      settledBy: "turn.cancelled",
      identity: workerdToolIdentity("workerd-public-events-settle", "d".repeat(64), sessionId, turn.turnId, "call-2"),
    });
    expect(settled[0]!.seq).toBeLessThan(cancelled.seq);
  }, 30_000);
});

describe("managed Workerd session", () => {
  it("records the host's memory.saved under the active turn and drops malformed frames", async () => {
    const base = "https://managedagents.test";
    const created = await SELF.fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: "Memory events" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ project?: Project } & Project>();
    const project = body.project ?? body;
    const deployed = await SELF.fetch(`${base}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: project.agentId,
        alias: "development",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: {
          bucket: "managed-agent-artifacts",
          key: `accounts/local/agents/${project.agentId}/artifact.json`,
          digest: "d".repeat(64),
          size: 512,
        },
        memory: [{ id: "notes", description: "Notes.", provider: { kind: "document", maxBytes: 1_024 } }],
      }),
    });
    expect(deployed.status).toBe(201);
    const document = await SELF.fetch(
      `${base}/v1/projects/${project.id}/memory/notes/documents/workshop?environment=development`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: JSON.stringify({ title: "Workshop", text: "v1" }),
      },
    );
    expect(document.status).toBe(201);
    const session = await json<InitializeSessionResult>(
      await SELF.fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: `${project.agentId}@development`,
          memory: { notes: { scope: "document", id: "workshop", access: "read-write" } },
        }),
      }),
    );
    expect(session.session).toMatchObject({ executionMode: "workerd", memoryAdmission: { state: "issued" } });
    const turn = await SELF.fetch(`${base}/v1/sessions/${session.session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Remember this.", idempotencyKey: "memory-events-turn" }),
    });
    expect(turn.status).toBe(202);
    const events = await waitForEvents(session.session.id, (current) =>
      current.some((event) => event.type === "turn.completed"),
    );
    const saved = events.filter((event) => event.type === "memory.saved");
    expect(saved).toEqual([
      expect.objectContaining({
        turnId: (await turn.json<{ turnId: string }>()).turnId,
        data: { resource: "notes", documentId: "workshop", revision: "2", bytes: 12 },
      }),
    ]);
    // The save landed between the deltas, and the message still completed.
    const types = events.map((event) => event.type);
    expect(types.indexOf("memory.saved")).toBeGreaterThan(types.indexOf("message.delta"));
    expect(types.indexOf("memory.saved")).toBeLessThan(types.indexOf("message.completed"));
  });

  it("bills a settled Workerd turn as one runtime segment, keyed on the turn", async () => {
    const base = "https://managedagents.test";
    const created = await SELF.fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: "Workerd billing" }),
    });
    const body = await created.json<{ project?: Project } & Project>();
    const project = body.project ?? body;
    const deployed = await SELF.fetch(`${base}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: project.agentId,
        alias: "development",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: {
          bucket: "managed-agent-artifacts",
          key: `accounts/local/agents/${project.agentId}/artifact.json`,
          digest: "d".repeat(64),
          size: 512,
        },
      }),
    });
    expect(deployed.status).toBe(201);
    const session = await json<InitializeSessionResult>(
      await SELF.fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${project.agentId}@development` }),
      }),
    );
    expect(session.session.executionMode).toBe("workerd");
    const turn = await SELF.fetch(`${base}/v1/sessions/${session.session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello.", idempotencyKey: "workerd-billing-turn" }),
    });
    const { turnId } = await turn.json<{ turnId: string }>();
    await waitForEvents(session.session.id, (current) =>
      current.some((event) => event.type === "turn.completed"),
    );

    const segments = await env.SESSIONS.getByName(session.session.id).listRuntimeBillingSegments();
    expect(segments).toEqual([
      expect.objectContaining({
        id: `${turnId}:turn`,
        microvmId: "workerd",
        resourceTier: "2gb_1vcpu",
        closeReason: "turn_settled",
      }),
    ]);
    expect(segments[0]!.quantitySeconds).toBeGreaterThanOrEqual(1);
  });

  it("commits a result during a Workerd turn, fenced by the host's activation, and drops the stream's duplicate", async () => {
    const base = "https://managedagents.test";
    const sessionId = await createWorkerdSession("workerd-result-agent", "f".repeat(64));
    expect((await snapshotOf(sessionId)).result).toBeNull();
    const turn = await postTurn(
      sessionId,
      "Report the branch [stall 1500ms][result-call call-1]",
      "result-turn-1",
    );
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.started" && event.turnId === turn.turnId),
    );
    const commit = (body: Record<string, unknown>) =>
      SELF.fetch(`${base}/v1/sessions/${sessionId}/result`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeTokens.get(sessionId)!}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const rejection = async (response: Response) =>
      (await response.json<{ error: { code: string } }>()).error.code;
    // The host reported boot `boot-managed-test`, activation 1, when the
    // turn started; a later activation of that object, or a MicroVM, is
    // not the runtime this session drives.
    const generation = { kind: "workerd", bootId: "boot-managed-test", activation: 1 };
    expect(
      await rejection(
        await commit({ turnId: turn.turnId, callId: "call-1", tool: "report", runtime: { ...generation, activation: 2 }, data: { branch: "task/1" } }),
      ),
    ).toBe("stale_runtime");
    expect(
      await rejection(
        await commit({ turnId: turn.turnId, callId: "call-1", tool: "report", runtime: { kind: "microvm", epoch: 0 }, data: { branch: "task/1" } }),
      ),
    ).toBe("stale_runtime");
    const committed = await commit({ turnId: turn.turnId, callId: "call-1", tool: "report", runtime: generation, data: { branch: "task/1" } });
    expect(committed.status).toBe(200);
    const afterCommit = await snapshotOf(sessionId);
    expect(afterCommit.result).toMatchObject({
      turnId: turn.turnId,
      callId: "call-1",
      data: { branch: "task/1" },
    });
    // The commit published: the list row carries the result at the
    // snapshot's revision.
    expect((await projectedRow(sessionId, afterCommit.revision)).result).toMatchObject({
      turnId: turn.turnId,
      callId: "call-1",
      data: { branch: "task/1" },
    });

    // The stream's own success frame for the committed call arrives after
    // the stall: one `tool.completed` for the call, the committed one.
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
    );
    const completions = events.filter(
      (event) =>
        event.type === "tool.completed" && (event.data.callId === "call-1" || event.data.id === "call-1"),
    );
    expect(completions).toHaveLength(1);
    // The public shape: the committed value itself as `output`, never its text.
    expect(completions[0]!.data).toEqual({
      tool: "report",
      callId: "call-1",
      title: "report",
      output: { branch: "task/1" },
      result: true,
      identity: workerdToolIdentity("workerd-result-agent", "f".repeat(64), sessionId, turn.turnId, "call-1"),
    });
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
    expect((await snapshotOf(sessionId)).result).toMatchObject({ callId: "call-1" });

    // Cancelled between execution and commit: the interrupt settles the
    // turn first, the commit that follows is refused, the result stands.
    const second = await postTurn(sessionId, "Try again [stall 5000ms]", "result-turn-2");
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.started" && event.turnId === second.turnId),
    );
    const stopped = await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(
      await rejection(
        await commit({ turnId: second.turnId, callId: "call-2", tool: "report", runtime: generation, data: { branch: "task/2" } }),
      ),
    ).toBe("stale_turn");
    const after = await snapshotOf(sessionId);
    expect(after.turns.find((candidate) => candidate.id === second.turnId)?.status).toBe("cancelled");
    expect(after.result).toMatchObject({ turnId: turn.turnId, callId: "call-1" });
  });

  it("falls back to a fresh Workerd session when a prewarm lease is stale", async () => {
    const deployment = await env.ACCOUNTS.getByName("local").registerDeployment({
      agentId: "workerd-fallback-agent",
      alias: "development",
      runtimeMode: "workerd-lazy-sandbox",
      channels: [],
      connections: [],
      artifact: {
        bucket: "managed-agent-artifacts",
        key: "accounts/local/agents/workerd-fallback-agent/artifact.json",
        digest: "c".repeat(64),
        size: 512,
      },
      imageArn: "test-image",
      imageVersion: "1",
    });
    const pool = env.POOLS.getByName(
      ["local", deployment.id, deployment.imageVersion].join(":"),
    );
    const [slot] = await pool.beginWorkerdFill(
      1,
      workerdModelConfiguration(deployment),
    );
    expect(slot).toBeDefined();
    const capability = await pool.createWorkerdModelGatewayCapability(slot!);
    expect(
      await pool.completeWorkerdFill(slot!, {
        runtimeSessionId: "runtime-prewarmed-broken",
        opencodeSessionId: "opencode-prewarmed-broken",
        modelGatewayCapabilityId: capability.id,
        runtimeBootId: "boot-prewarmed-broken",
        runtimeActivation: 1,
        runtimeInitMs: 12,
        createdAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    ).toBe(true);

    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "workerd-fallback-agent@development" }),
      }),
    );

    expect(created.session).toMatchObject({
      executionMode: "workerd",
      status: "idle",
    });
    const events = await waitForEvents(created.session.id, (current) =>
      current.some(
        (event) =>
          event.type === "runtime.log" &&
          event.data.phase === "workerd_prewarm_fallback",
      ),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.log",
          data: expect.objectContaining({
            phase: "workerd_prewarm_fallback",
            prewarmHit: false,
          }),
        }),
        expect.objectContaining({
          type: "runtime.connected",
          data: expect.objectContaining({
            runtimeId: expect.stringMatching(/^runtime-managed-/),
            runtime: "workerd",
          }),
        }),
      ]),
    );
  });

  it.each([
    {
      name: "overrides useModel",
      models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-4.6" }],
    },
    { name: "works without useModel", models: undefined },
  ])("creates a Codex route with the Responses adapter when it $name", async ({ models }) => {
    const account = env.ACCOUNTS.getByName("local");
    const project = await account.createProject({
      environmentMode: "legacy",
      id: `prj_codex_route_${models ? "selected" : "default"}`,
      name: "Codex route",
      slug: `codex-route-${models ? "selected" : "default"}`,
    });
    const deployment = await account.registerDeployment({
      agentId: project.agentId,
      alias: "development",
      runtimeMode: "workerd-lazy-sandbox",
      channels: [],
      connections: [],
      ...(models ? { models } : {}),
      artifact: {
        bucket: "managed-agent-artifacts",
        key: `accounts/local/agents/${project.agentId}/artifact.json`,
        digest: (models ? "d" : "e").repeat(64),
        size: 512,
      },
      imageArn: "test-image",
      imageVersion: "1",
    });
    const started = await account.startModelAccessConnect({
      organizationId: "local",
      connectedByUserId: "admin",
      provider: "openai",
      oauthCodeVerifier: "verifier",
      oauthRedirectUri: "https://app.opencomputer.dev/model-access/callback",
    });
    const connection = await account.completeModelAccessConnect({
      id: started.id,
      accessToken: "codex-access-token",
      refreshToken: "codex-refresh-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
    });
    await account.putModelRoute({
      organizationId: "local",
      projectId: project.id,
      environment: "development",
      connectionId: connection.id,
      model: "gpt-5.6-sol",
      fallback: "fail",
      updatedByUserId: "admin",
    });

    const pool = env.POOLS.getByName(
      ["local", deployment.id, deployment.imageVersion].join(":"),
    );
    const [slot] = await pool.beginWorkerdFill(
      1,
      workerdModelConfiguration(deployment),
    );
    const capability = await pool.createWorkerdModelGatewayCapability(slot!);
    await pool.completeWorkerdFill(slot!, {
      runtimeSessionId: "runtime-prewarmed-chat",
      opencodeSessionId: "opencode-prewarmed-chat",
      modelGatewayCapabilityId: capability.id,
      runtimeBootId: "boot-prewarmed-chat",
      runtimeActivation: 1,
      runtimeInitMs: 10,
      createdAt: new Date().toISOString(),
    });

    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${project.agentId}@development` }),
      }),
    );
    const runtime = await fakeRuntimeOf(created.session.id);
    expect(created.session.runtimeId).not.toBe("runtime-prewarmed-chat");
    expect(runtime.creation?.modelRoute).toEqual({
      model: "gpt-5.6-sol",
      protocol: "responses",
    });
  });

  it(
    "routes a managed session through its deployment-pinned Workerd runtime",
    async () => {
      const deployment = await env.ACCOUNTS.getByName("local").registerDeployment({
        agentId: "workerd-ui-agent",
        alias: "development",
        runtimeMode: "workerd-lazy-sandbox",
        channels: [],
        connections: [],
        artifact: {
          bucket: "managed-agent-artifacts",
          key: "accounts/local/agents/workerd-ui-agent/artifact.json",
          digest: "b".repeat(64),
          size: 512,
        },
        imageArn: "test-image",
        imageVersion: "1",
      });
      const pool = env.POOLS.getByName(
        ["local", deployment.id, deployment.imageVersion].join(":"),
      );
      const [slot] = await pool.beginWorkerdFill(
        1,
        workerdModelConfiguration(deployment),
      );
      expect(slot).toBeDefined();
      const capability = await pool.createWorkerdModelGatewayCapability(slot!);
      expect(
        await pool.completeWorkerdFill(slot!, {
          runtimeSessionId: "runtime-prewarmed-test",
          opencodeSessionId: "opencode-managed-test",
          modelGatewayCapabilityId: capability.id,
          runtimeBootId: "boot-managed-test",
          runtimeActivation: 1,
          runtimeInitMs: 18.5,
          createdAt: new Date(Date.now() - 5_000).toISOString(),
        }),
      ).toBe(true);
      const created = await json<InitializeSessionResult>(
        await SELF.fetch("https://managedagents.test/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "workerd-ui-agent@development",
          }),
        }),
      );

      expect(created.session).toMatchObject({
        executionMode: "workerd",
        status: "idle",
      });
      expect(created.session.runtimeId).toBeUndefined();
      expect(created.session.microvmId).toBeUndefined();
      expect((await fakeRuntimeOf(created.session.id)).creation?.deployment).toMatchObject({
        id: deployment.id,
        agentId: deployment.agentId,
        artifact: { digest: deployment.artifact.digest },
      });

      const createdEvents = await waitForEvents(created.session.id, (current) =>
        current.some(
          (event) =>
            event.type === "runtime.log" &&
            event.data.phase === "workerd_session_ready",
        ),
      );
      expect(createdEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "runtime.log",
            data: expect.objectContaining({
              phase: "workerd_prewarm_hit",
              prewarmHit: true,
              standbyAgeMs: expect.any(Number),
              checkoutMs: expect.any(Number),
            }),
          }),
          expect.objectContaining({
            type: "runtime.log",
            data: expect.objectContaining({
              runtime: "workerd",
              activation: 1,
              initializationMs: 18.5,
            }),
          }),
          expect.objectContaining({
            type: "runtime.connected",
            data: expect.objectContaining({
              runtimeId: "runtime-prewarmed-test",
              epoch: 0,
              runtime: "workerd",
            }),
          }),
        ]),
      );

      const turnResponse = await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/turns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: "Tell me where this agent is running.",
            idempotencyKey: "managed-workerd-turn",
          }),
        },
      );
      expect(turnResponse.status).toBe(202);

      const events = await waitForEvents(created.session.id, (current) =>
        current.some((event) => event.type === "turn.completed"),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "message.delta" }),
          expect.objectContaining({
            type: "runtime.log",
            data: expect.objectContaining({
              phase: "workerd_reused",
              runtime: "workerd",
              activation: 1,
            }),
          }),
          expect.objectContaining({
            type: "agent.rendered",
            data: expect.objectContaining({
              instructions: "These are the deployed agent instructions.",
              providerTurn: 1,
            }),
          }),
          expect.objectContaining({
            type: "message.completed",
            data: expect.objectContaining({
              text: "Managed OpenCode is running in the Durable Object.",
              source: "opencode-workerd",
            }),
          }),
          expect.objectContaining({ type: "turn.completed" }),
        ]),
      );
      expect(events.some((event) => event.type === "runtime.connected")).toBe(
        true,
      );

      const snapshot = await json<SessionSnapshot>(
        await SELF.fetch(
          `https://managedagents.test/v1/sessions/${created.session.id}`,
        ),
      );
      expect(snapshot).toMatchObject({
        executionMode: "workerd",
        status: "idle",
        turns: [expect.objectContaining({ status: "completed" })],
      });
    },
    20_000,
  );

  it(
    "fails a turn whose driver was lost with the object and runs the next one",
    async () => {
      const sessionId = await createWorkerdSession("workerd-lease-agent", "e".repeat(64));
      const first = await postTurn(sessionId, "Keep going [stall 3000ms]", "lease-turn-1");
      const second = await postTurn(sessionId, "And then this one.", "lease-turn-2");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta"),
      );
      const stub = env.SESSIONS.getByName(sessionId);
      const leased = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ id: string; status: string; lease_deadline_at_ms: number | null }>(
            "SELECT id, status, lease_deadline_at_ms FROM turns ORDER BY created_at, rowid",
          )
          .toArray(),
      );
      expect(leased).toEqual([
        expect.objectContaining({
          id: first.turnId,
          status: "running",
          lease_deadline_at_ms: expect.any(Number),
        }),
        expect.objectContaining({ id: second.turnId, status: "queued", lease_deadline_at_ms: null }),
      ]);
      expect(leased[0]!.lease_deadline_at_ms!).toBeGreaterThan(Date.now());
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
        leased[0]!.lease_deadline_at_ms,
      );

      // The object goes away mid-turn, ungracefully (a graceful eviction
      // would drain the in-flight turn first): the driver and its renewal
      // timer die with it, the persisted turn stays running.
      await abortAllDurableObjects();
      expect((await snapshotOf(sessionId)).turns[0]).toMatchObject({ status: "running" });
      const revived = env.SESSIONS.getByName(sessionId);

      // Nothing renewed the lease; once the deadline passes the alarm fails
      // the turn and the session moves on.
      await runInDurableObject(revived, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE turns SET lease_deadline_at_ms = ? WHERE id = ?",
          Date.now() - 1,
          first.turnId,
        );
      });
      expect(await runDurableObjectAlarm(revived)).toBe(true);

      const events = await waitForEvents(sessionId, (current) =>
        current.some(
          (event) => event.type === "turn.completed" && event.turnId === second.turnId,
        ),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "turn.failed",
            turnId: first.turnId,
            data: expect.objectContaining({ reason: "runtime_lost" }),
          }),
          expect.objectContaining({ type: "turn.started", turnId: second.turnId }),
          expect.objectContaining({ type: "turn.completed", turnId: second.turnId }),
        ]),
      );
      expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
      const snapshot = await snapshotOf(sessionId);
      expect(snapshot).toMatchObject({
        status: "idle",
        turns: [
          expect.objectContaining({ id: first.turnId, status: "failed" }),
          expect.objectContaining({ id: second.turnId, status: "completed" }),
        ],
      });
    },
    30_000,
  );

  it(
    "stops the runtime on interrupt and settles the turn cancelled exactly once",
    async () => {
      const sessionId = await createWorkerdSession("workerd-interrupt-agent", "f".repeat(64));
      const stalled = await postTurn(sessionId, "Keep going [stall 5000ms]", "interrupt-turn-1");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta"),
      );

      const interrupted = await json<SessionSnapshot>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/interrupt`, {
          method: "POST",
        }),
      );
      // The stop intent is durable and the session shows it; the turn stays
      // the running one until the host has settled it.
      expect(interrupted).toMatchObject({
        status: "stopping",
        turns: [expect.objectContaining({ id: stalled.turnId, status: "running" })],
      });

      // The runtime settles (loop stopped, nothing dispatched), the turn is
      // cancelled after that, and its own interrupted stream is not a
      // second settlement.
      const events = await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "turn.cancelled" && event.turnId === stalled.turnId),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "runtime.log",
            data: expect.objectContaining({
              phase: "workerd_interrupt",
              interrupted: true,
              acknowledged: true,
              operations: { total: 0, settled: 0 },
              computerTerminated: false,
            }),
          }),
          expect.objectContaining({
            type: "turn.cancelled",
            turnId: stalled.turnId,
            data: expect.objectContaining({
              reason: "interrupted",
              operationsSettled: 0,
              computerTerminated: false,
              settledAfterMs: expect.any(Number),
            }),
          }),
        ]),
      );
      expect(
        events
          .filter((event) => event.type === "session.status_changed")
          .map((event) => [event.data.from, event.data.to]),
      ).toEqual([
        ["new", "idle"],
        ["idle", "running"],
        ["running", "stopping"],
        ["stopping", "idle"],
      ]);
      expect(await pendingStopOf(sessionId)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = await waitForEvents(sessionId, () => true);
      const terminal = settled.filter(
        (event) =>
          event.turnId === stalled.turnId &&
          ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type),
      );
      expect(terminal).toEqual([expect.objectContaining({ type: "turn.cancelled" })]);

      // The session is usable straight away.
      const next = await postTurn(sessionId, "Carry on.", "interrupt-turn-2");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "turn.completed" && event.turnId === next.turnId),
      );
      expect(await snapshotOf(sessionId)).toMatchObject({
        status: "idle",
        turns: [
          expect.objectContaining({ status: "cancelled" }),
          expect.objectContaining({ id: next.turnId, status: "completed" }),
        ],
      });
    },
    30_000,
  );

  it(
    "replaces a running turn on interrupt-mode admission once the runtime has stopped",
    async () => {
      const sessionId = await createWorkerdSession("workerd-replace-agent", "b".repeat(64));
      const stalled = await postTurn(sessionId, "Keep going [stall 5000ms]", "replace-turn-1");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta"),
      );
      const replacement = await postTurn(sessionId, "Do this instead.", "replace-turn-2", "interrupt");
      expect(replacement.status).toBe("queued");
      await waitForTurn(sessionId, replacement.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);
      const order = events
        .filter(
          (event) =>
            (event.type === "turn.cancelled" && event.turnId === stalled.turnId) ||
            (event.type === "runtime.log" && event.data.phase === "workerd_interrupt") ||
            (event.type === "turn.started" && event.turnId === replacement.turnId),
        )
        .map((event) => event.type);
      // Runtime settled first, the cancellation after it, only then the
      // replacement started.
      expect(order).toEqual(["runtime.log", "turn.cancelled", "turn.started"]);
      expect(
        events.find((event) => event.type === "turn.cancelled" && event.turnId === stalled.turnId)?.data,
      ).toMatchObject({ reason: "interrupted", replacementTurnId: replacement.turnId });
      expect(
        events.filter(
          (event) =>
            event.turnId === stalled.turnId &&
            ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type),
        ),
      ).toHaveLength(1);
      expect(await snapshotOf(sessionId)).toMatchObject({
        status: "idle",
        turns: [
          expect.objectContaining({ id: stalled.turnId, status: "cancelled" }),
          expect.objectContaining({ id: replacement.turnId, status: "completed" }),
        ],
      });
    },
    30_000,
  );

  it(
    "interrupts the runtime when a session ends mid-turn and drops the late completion",
    async () => {
      const sessionId = await createWorkerdSession("workerd-end-agent", "a".repeat(64));
      const stalled = await postTurn(sessionId, "Keep going [stall 5000ms]", "end-turn-1");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta"),
      );
      const ended = await json<SessionSnapshot>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/end`, {
          method: "POST",
        }),
      );
      expect(ended).toMatchObject({
        status: "ended",
        turns: [expect.objectContaining({ id: stalled.turnId, status: "cancelled" })],
      });
      const events = await waitForEvents(sessionId, (current) =>
        current.some(
          (event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt",
        ),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "runtime.log",
            data: expect.objectContaining({ phase: "workerd_interrupt", interrupted: true }),
          }),
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = await waitForEvents(sessionId, () => true);
      const types = settled.map((event) => event.type);
      expect(types).not.toContain("turn.completed");
      expect(types).not.toContain("turn.failed");
      expect(
        settled
          .filter((event) => event.type === "session.status_changed")
          .map((event) => [event.data.from, event.data.to]),
      ).toEqual([
        ["new", "idle"],
        ["idle", "running"],
        ["running", "ended"],
      ]);
      expect((await snapshotOf(sessionId)).status).toBe("ended");
    },
    30_000,
  );
});

/** A project with a coordinator agent and one worker agent, each with a Workerd session. */
describe("managed Workerd session turn payload", () => {
  it("hands the turn payload to the render as user input and records it with the admission", async () => {
    const sessionId = await createWorkerdSession("workerd-payload-agent", "a".repeat(64));
    const payload = {
      taskId: "01J9Z6QX4M5N7P8R9S0T1V2W3X",
      repo: "acme/widgets",
      ref: "main",
      actor: { id: 583231, login: "octocat" },
    };
    const response = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "Fix the flaky test.",
          idempotencyKey: `${payload.taskId}/start`,
          payload,
        }),
      },
    );
    expect(response.status).toBe(202);
    const { turnId } = await response.json<{ turnId: string }>();

    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.turnId === turnId && event.type === "turn.completed"),
    );
    // The admission recorded the payload next to the text.
    expect(events.filter((event) => event.type === "message.received")).toEqual([
      expect.objectContaining({
        turnId,
        data: { input: "Fix the flaky test.", mode: "queue", payload },
      }),
    ]);
    // The host handed the same typed input to the render: this is what
    // useInput() returned inside the agent, source user with the payload.
    expect(events.filter((event) => event.type === "agent.rendered")).toEqual([
      expect.objectContaining({
        turnId,
        data: expect.objectContaining({
          input: { source: "user", text: "Fix the flaky test.", payload },
        }),
      }),
    ]);

    // A retry of the same submission after the turn ran is still the same
    // turn; a different submission under the key is refused.
    const retried = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `${payload.taskId}/start`,
          payload: { ref: "main", repo: "acme/widgets", actor: { login: "octocat", id: 583231 }, taskId: payload.taskId },
          input: "Fix the flaky test.",
        }),
      },
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ turnId, duplicate: true });
    const conflict = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "Fix the flaky test.",
          idempotencyKey: `${payload.taskId}/start`,
          payload: { ...payload, ref: "release" },
        }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect((await snapshotOf(sessionId)).turns.map((turn) => turn.id)).toEqual([turnId]);
  });
});

async function coordinatorAndWorker(slug: string): Promise<{
  projectId: string;
  coordinatorAgentId: string;
  workerAgentId: string;
  coordinator: string;
  worker: string;
}> {
  const project = await json<{ id: string; agents: Array<{ id: string }> }>(
    await SELF.fetch("https://managedagents.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: `Outcomes ${slug}`, slug }),
    }),
  );
  const coordinatorAgentId = project.agents[0]!.id;
  const workerAgentId = `${coordinatorAgentId}--worker`;
  const coordinator = await createWorkerdSession(coordinatorAgentId, "1".repeat(64));
  const worker = await createWorkerdSession(workerAgentId, "2".repeat(64));
  return { projectId: project.id, coordinatorAgentId, workerAgentId, coordinator, worker };
}

async function subscribe(
  projectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(`https://managedagents.test/v1/projects/${projectId}/event-subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Run the source session's alarm until the turn's deliveries all settle. */
async function settleDeliveries(
  sessionId: string,
  turnId: string,
): Promise<TurnOutcomeDelivery[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
    const turn = (await snapshotOf(sessionId)).turns.find((candidate) => candidate.id === turnId);
    const deliveries = turn?.deliveries ?? [];
    if (deliveries.length > 0 && deliveries.every((delivery) => delivery.status !== "pending")) {
      return deliveries;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for outcome deliveries to settle");
}

async function waitForTurn(sessionId: string, turnId: string, status: string): Promise<void> {
  await waitForEvents(sessionId, (current) =>
    current.some((event) => event.turnId === turnId && event.type === `turn.${status}`),
  );
}

/**
 * Make the target session's next `enqueueTurn` fail. With `commit`, the turn
 * is committed first and only the reply is lost, as a dropped RPC reply
 * would; without it the admission never happens, as an unreachable object
 * would. Other sessions are untouched.
 */
function failTargetAdmissionOnce(targetSessionId: string, options: { commit: boolean }): () => void {
  const enqueue = SessionDurableObject.prototype.enqueueTurn;
  let armed = true;
  SessionDurableObject.prototype.enqueueTurn = function (this: SessionDurableObject, input) {
    const own = (this as unknown as { requireSession(): { id: string } }).requireSession().id;
    if (!armed || own !== targetSessionId) return enqueue.call(this, input);
    armed = false;
    if (!options.commit) throw new Error("injected target unavailable");
    // A reply is lost after the callee finished: the admission commits,
    // then the caller never hears of it.
    return enqueue.call(this, input).then(() => {
      throw new Error("injected lost enqueue reply");
    });
  };
  return () => {
    SessionDurableObject.prototype.enqueueTurn = enqueue;
  };
}

async function makeDeliveryDue(sessionId: string, deliveryId: string): Promise<void> {
  await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE outcome_deliveries SET next_attempt_at_ms = ? WHERE id = ?",
      Date.now() - 1,
      deliveryId,
    );
  });
}

async function pendingDelivery(sessionId: string, turnId: string): Promise<TurnOutcomeDelivery> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const turn = (await snapshotOf(sessionId)).turns.find((candidate) => candidate.id === turnId);
    const delivery = turn?.deliveries?.[0];
    if (delivery && delivery.attempt >= 1 && delivery.error) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a failed delivery attempt");
}

describe("outcome delivery to a session", () => {
  it("queues a worker's completed turn on the coordinator as a typed event turn, once", async () => {
    const { projectId, workerAgentId, coordinator, worker } =
      await coordinatorAndWorker("outcomes-basic");
    const created = await subscribe(projectId, {
      agentId: workerAgentId,
      events: ["turn.completed", "turn.failed", "turn.cancelled"],
      destination: { type: "session", sessionId: coordinator },
    });
    expect(created.status).toBe(201);
    const { subscription } = (await created.json()) as { subscription: EventSubscription };
    expect(subscription).toMatchObject({
      projectId,
      agentId: workerAgentId,
      events: ["turn.completed", "turn.failed", "turn.cancelled"],
      destination: { type: "session", sessionId: coordinator },
    });
    const listed = await json<{ subscriptions: EventSubscription[] }>(
      await SELF.fetch(`https://managedagents.test/v1/projects/${projectId}/event-subscriptions`),
    );
    expect(listed.subscriptions.map((entry) => entry.id)).toEqual([subscription.id]);

    const work = await postTurn(worker, "Research the topic.", "worker-turn-1");
    await waitForTurn(worker, work.turnId, "completed");
    const workerEvents = await waitForEvents(worker, () => true);
    const terminal = workerEvents.find(
      (event) => event.type === "turn.completed" && event.turnId === work.turnId,
    )!;

    const deliveries = await settleDeliveries(worker, work.turnId);
    expect(deliveries).toEqual([
      expect.objectContaining({
        id: `${subscription.id}:${terminal.id}`,
        subscriptionId: subscription.id,
        eventId: terminal.id,
        eventType: "turn.completed",
        destination: { type: "session", sessionId: coordinator },
        status: "delivered",
        attempt: 1,
        receipt: { sessionId: coordinator, turnId: expect.any(String) },
      }),
    ]);
    const receiptTurnId = deliveries[0]!.receipt!.turnId;

    // The coordinator received exactly one queued turn under the delivery
    // key, carrying the typed event that reaches `useInput()`.
    await waitForTurn(coordinator, receiptTurnId, "completed");
    const coordinatorEvents = await waitForEvents(coordinator, () => true);
    expect(coordinatorEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.received",
          turnId: receiptTurnId,
          data: expect.objectContaining({
            mode: "queue",
            input: expect.stringContaining(
              "Outcome event turn.completed from agent " + workerAgentId,
            ),
          }),
        }),
        expect.objectContaining({
          type: "agent.rendered",
          turnId: receiptTurnId,
          data: expect.objectContaining({
            input: {
              source: "event",
              event: {
                id: terminal.id,
                type: "turn.completed",
                sessionId: worker,
                turnId: work.turnId,
                agentId: workerAgentId,
                occurredAt: terminal.timestamp,
                result: {
                  text: "Managed OpenCode is running in the Durable Object.",
                  truncated: false,
                },
              },
            },
          }),
        }),
      ]),
    );
    expect((await snapshotOf(coordinator)).turns.map((turn) => turn.id)).toEqual([receiptTurnId]);

    // Running the alarm again changes nothing: the delivery is settled and
    // the target holds one turn under the key.
    await runDurableObjectAlarm(env.SESSIONS.getByName(worker));
    expect((await snapshotOf(worker)).turns[0]!.deliveries).toEqual(deliveries);
    expect((await snapshotOf(coordinator)).turns).toHaveLength(1);

    // The coordinator's own completed turn matched no subscription: the
    // agent filter excludes it, so nothing comes back to the worker.
    expect((await snapshotOf(coordinator)).turns[0]!.deliveries).toBeUndefined();
    expect((await snapshotOf(worker)).turns).toHaveLength(1);

    const deleted = await SELF.fetch(
      `https://managedagents.test/v1/projects/${projectId}/event-subscriptions/${subscription.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
    expect(
      (
        await json<{ subscriptions: EventSubscription[] }>(
          await SELF.fetch(
            `https://managedagents.test/v1/projects/${projectId}/event-subscriptions`,
          ),
        )
      ).subscriptions,
    ).toEqual([]);
  }, 30_000);

  it("delivers from the alarm after the source object dies once the outcome is committed", async () => {
    const { projectId, workerAgentId, coordinator, worker } =
      await coordinatorAndWorker("outcomes-crash");
    expect(
      (
        await subscribe(projectId, {
          agentId: workerAgentId,
          events: ["turn.completed"],
          destination: { type: "session", sessionId: coordinator },
        })
      ).status,
    ).toBe(201);

    // The first attempt finds the target unreachable and backs off; then
    // the source object is lost. The outbox row, written with the
    // completion, is all that survives.
    const restore = failTargetAdmissionOnce(coordinator, { commit: false });
    let delivery: TurnOutcomeDelivery;
    const work = await postTurn(worker, "Research the topic.", "worker-crash-turn");
    try {
      await waitForTurn(worker, work.turnId, "completed");
      delivery = await pendingDelivery(worker, work.turnId);
      expect(delivery).toMatchObject({
        status: "pending",
        attempt: 1,
        error: "injected target unavailable",
        nextAttemptAt: expect.any(String),
      });
      expect(new Date(delivery.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now() + 4_000);
      await abortAllDurableObjects();
    } finally {
      restore();
    }
    expect((await snapshotOf(coordinator)).turns).toEqual([]);

    // Time passes; the recovered object's alarm delivers.
    await makeDeliveryDue(worker, delivery.id);
    const settled = await settleDeliveries(worker, work.turnId);
    expect(settled).toEqual([
      expect.objectContaining({
        id: delivery.id,
        status: "delivered",
        attempt: 2,
        receipt: { sessionId: coordinator, turnId: expect.any(String) },
      }),
    ]);
    expect(settled[0]!.error).toBeUndefined();
    expect((await snapshotOf(coordinator)).turns).toEqual([
      expect.objectContaining({ id: settled[0]!.receipt!.turnId }),
    ]);
  }, 30_000);

  it("returns the original receipt when the admission reply was lost, with one target turn", async () => {
    const { projectId, workerAgentId, coordinator, worker } =
      await coordinatorAndWorker("outcomes-lost-reply");
    expect(
      (
        await subscribe(projectId, {
          agentId: workerAgentId,
          events: ["turn.completed"],
          destination: { type: "session", sessionId: coordinator },
        })
      ).status,
    ).toBe(201);
    const restore = failTargetAdmissionOnce(coordinator, { commit: true });
    let delivery: TurnOutcomeDelivery;
    const work = await postTurn(worker, "Research the topic.", "worker-lost-turn");
    try {
      await waitForTurn(worker, work.turnId, "completed");
      delivery = await pendingDelivery(worker, work.turnId);
    } finally {
      restore();
    }
    expect(delivery).toMatchObject({
      status: "pending",
      attempt: 1,
      error: "injected lost enqueue reply",
    });
    // The target committed the turn under the delivery key before the reply
    // was lost.
    const committed = (await snapshotOf(coordinator)).turns;
    expect(committed).toHaveLength(1);

    await makeDeliveryDue(worker, delivery.id);
    const settled = await settleDeliveries(worker, work.turnId);
    expect(settled).toEqual([
      expect.objectContaining({
        id: delivery.id,
        status: "delivered",
        attempt: 2,
        receipt: { sessionId: coordinator, turnId: committed[0]!.id },
      }),
    ]);
    expect((await snapshotOf(coordinator)).turns.map((turn) => turn.id)).toEqual([committed[0]!.id]);
  }, 30_000);

  it("fails visibly for an ended target and never restarts it", async () => {
    const { projectId, workerAgentId, coordinator, worker } =
      await coordinatorAndWorker("outcomes-ended");
    const created = await subscribe(projectId, {
      agentId: workerAgentId,
      events: ["turn.completed", "turn.cancelled"],
      destination: { type: "session", sessionId: coordinator },
    });
    expect(created.status).toBe(201);
    const { subscription } = (await created.json()) as { subscription: EventSubscription };

    // A subscription cannot be pointed at a session outside the project,
    // at an ended session, or at nothing in particular.
    expect(
      (
        await subscribe(projectId, {
          events: ["turn.completed"],
          destination: { type: "session", sessionId: "ses_nowhere" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await subscribe(projectId, { events: ["session.ended"], destination: { type: "session", sessionId: coordinator } })).status,
    ).toBe(400);
    expect(
      (await subscribe(projectId, { events: ["turn.completed"], destination: { type: "https", url: "https://example.invalid" } })).status,
    ).toBe(400);

    await SELF.fetch(`https://managedagents.test/v1/sessions/${coordinator}/end`, { method: "POST" });
    expect(
      (
        await subscribe(projectId, {
          events: ["turn.completed"],
          destination: { type: "session", sessionId: coordinator },
        })
      ).status,
    ).toBe(409);

    const work = await postTurn(worker, "Research the topic.", "worker-ended-turn");
    await waitForTurn(worker, work.turnId, "completed");
    const deliveries = await settleDeliveries(worker, work.turnId);
    expect(deliveries).toEqual([
      expect.objectContaining({
        id: `${subscription.id}:${deliveries[0]!.eventId}`,
        status: "failed",
        attempt: 1,
        error: "target_ended",
      }),
    ]);
    expect(deliveries[0]!.receipt).toBeUndefined();
    const ended = await snapshotOf(coordinator);
    expect(ended.status).toBe("ended");
    expect(ended.turns).toEqual([]);

    // Ending the worker mid-turn records the cancellation as its own
    // outcome, with the same visible failure against the ended target.
    const stalled = await postTurn(worker, "Keep going [stall 5000ms]", "worker-ended-turn-2");
    await waitForEvents(worker, (current) =>
      current.some((event) => event.type === "message.delta" && event.turnId === stalled.turnId),
    );
    await SELF.fetch(`https://managedagents.test/v1/sessions/${worker}/end`, { method: "POST" });
    const cancelled = await settleDeliveries(worker, stalled.turnId);
    expect(cancelled).toEqual([
      expect.objectContaining({ eventType: "turn.cancelled", status: "failed", error: "target_ended" }),
    ]);
    expect(
      (await waitForEvents(worker, () => true)).find(
        (event) => event.type === "turn.cancelled" && event.turnId === stalled.turnId,
      )?.data,
    ).toEqual({ reason: "session_ended" });
  }, 30_000);

  it("without an agent filter delivers every other agent's outcome and never the destination's own", async () => {
    const { projectId, coordinator, worker } = await coordinatorAndWorker("outcomes-unfiltered");
    const created = await subscribe(projectId, {
      events: ["turn.completed", "turn.failed"],
      destination: { type: "session", sessionId: coordinator },
    });
    expect(created.status).toBe(201);
    const { subscription } = (await created.json()) as { subscription: EventSubscription };
    expect(subscription.agentId).toBeUndefined();

    // The coordinator's own turn matches the subscription's filter but is
    // its own destination: no delivery, no loop.
    const own = await postTurn(coordinator, "Plan the work.", "coordinator-own-turn");
    await waitForTurn(coordinator, own.turnId, "completed");
    expect((await snapshotOf(coordinator)).turns[0]!.deliveries).toBeUndefined();

    const work = await postTurn(worker, "Research the topic.", "worker-unfiltered-turn");
    await waitForTurn(worker, work.turnId, "completed");
    const deliveries = await settleDeliveries(worker, work.turnId);
    expect(deliveries).toEqual([
      expect.objectContaining({ status: "delivered", receipt: { sessionId: coordinator, turnId: expect.any(String) } }),
    ]);
    const delivered = deliveries[0]!.receipt!.turnId;
    await waitForTurn(coordinator, delivered, "completed");
    // The delivered turn's own completion is not delivered back either.
    expect((await snapshotOf(coordinator)).turns.map((turn) => [turn.id, turn.deliveries])).toEqual([
      [own.turnId, undefined],
      [delivered, undefined],
    ]);

    // A subscription deleted while a delivery is pending fails it visibly.
    const restore = failTargetAdmissionOnce(coordinator, { commit: false });
    let pending: TurnOutcomeDelivery;
    const later = await postTurn(worker, "Research more.", "worker-unfiltered-turn-2");
    try {
      await waitForTurn(worker, later.turnId, "completed");
      pending = await pendingDelivery(worker, later.turnId);
    } finally {
      restore();
    }
    expect(
      (
        await SELF.fetch(
          `https://managedagents.test/v1/projects/${projectId}/event-subscriptions/${subscription.id}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    await makeDeliveryDue(worker, pending.id);
    const failed = await settleDeliveries(worker, later.turnId);
    expect(failed).toEqual([
      expect.objectContaining({ id: pending.id, status: "failed", attempt: 2, error: "subscription_unavailable" }),
    ]);
    expect((await snapshotOf(coordinator)).turns).toHaveLength(2);
  }, 30_000);
  it("selects source sessions by sourceLabels: only a session carrying every pair reaches the narrowed subscription", async () => {
    const { projectId, coordinatorAgentId, workerAgentId, coordinator, worker } =
      await coordinatorAndWorker("outcomes-source-labels");
    // A second coordinating session on the same agent; the workers it
    // starts carry its label.
    const lead = await createWorkerdSession(coordinatorAgentId, "1".repeat(64));
    const broad = await subscribe(projectId, {
      agentId: workerAgentId,
      events: ["turn.completed"],
      destination: { type: "session", sessionId: coordinator },
    });
    const narrowed = await subscribe(projectId, {
      agentId: workerAgentId,
      sourceLabels: { lead, team: "core" },
      events: ["turn.completed"],
      destination: { type: "session", sessionId: lead },
    });
    expect([broad.status, narrowed.status]).toEqual([201, 201]);
    const broadSubscription = ((await broad.json()) as { subscription: EventSubscription }).subscription;
    const narrowedSubscription = ((await narrowed.json()) as { subscription: EventSubscription })
      .subscription;
    expect(broadSubscription.sourceLabels).toBeUndefined();
    expect(narrowedSubscription.sourceLabels).toEqual({ lead, team: "core" });
    expect(
      (
        await json<{ subscription: EventSubscription }>(
          await SELF.fetch(
            `https://managedagents.test/v1/projects/${projectId}/event-subscriptions/${narrowedSubscription.id}`,
          ),
        )
      ).subscription.sourceLabels,
    ).toEqual({ lead, team: "core" });
    expect(
      (
        await json<{ subscriptions: EventSubscription[] }>(
          await SELF.fetch(`https://managedagents.test/v1/projects/${projectId}/event-subscriptions`),
        )
      ).subscriptions.map((entry) => [entry.id, entry.sourceLabels]),
    ).toEqual([
      [broadSubscription.id, undefined],
      [narrowedSubscription.id, { lead, team: "core" }],
    ]);

    // An unlabelled worker: the broad subscription only.
    const plain = await postTurn(worker, "Research the topic.", "source-labels-plain");
    await waitForTurn(worker, plain.turnId, "completed");
    expect(
      (await settleDeliveries(worker, plain.turnId)).map((delivery) => [delivery.subscriptionId, delivery.status]),
    ).toEqual([[broadSubscription.id, "delivered"]]);

    // A worker carrying one of the two pairs, and one carrying the other
    // value: still the broad subscription only.
    const partial = await createWorkerdSession(workerAgentId, "2".repeat(64), { labels: { lead } });
    const partialTurn = await postTurn(partial, "Research the topic.", "source-labels-partial");
    await waitForTurn(partial, partialTurn.turnId, "completed");
    expect(
      (await settleDeliveries(partial, partialTurn.turnId)).map((delivery) => delivery.subscriptionId),
    ).toEqual([broadSubscription.id]);

    // A worker carrying both pairs (and more): both subscriptions, and the
    // event the lead receives carries the source's labels.
    const labelled = await createWorkerdSession(workerAgentId, "2".repeat(64), {
      labels: { lead, team: "core", stream: "edge" },
    });
    const work = await postTurn(labelled, "Research the topic.", "source-labels-labelled");
    await waitForTurn(labelled, work.turnId, "completed");
    const deliveries = await settleDeliveries(labelled, work.turnId);
    expect(deliveries.map((delivery) => [delivery.subscriptionId, delivery.status]).sort()).toEqual(
      [
        [broadSubscription.id, "delivered"],
        [narrowedSubscription.id, "delivered"],
      ].sort(),
    );
    const receipt = deliveries.find((delivery) => delivery.subscriptionId === narrowedSubscription.id)!
      .receipt!.turnId!;
    await waitForTurn(lead, receipt, "completed");
    expect((await snapshotOf(lead)).turns.map((turn) => turn.id)).toEqual([receipt]);
    expect(
      (await waitForEvents(lead, () => true)).find(
        (event) => event.type === "agent.rendered" && event.turnId === receipt,
      )?.data,
    ).toMatchObject({
      input: {
        source: "event",
        event: { sessionId: labelled, labels: { lead, stream: "edge", team: "core" } },
      },
    });
  }, 30_000);

  it("matches sourceLabels against the labels at admission: a later label change does not move the turn's capture", async () => {
    const { projectId, coordinatorAgentId, workerAgentId, coordinator } =
      await coordinatorAndWorker("outcomes-source-labels-admission");
    const lead = await createWorkerdSession(coordinatorAgentId, "1".repeat(64));
    const broad = (
      (await (
        await subscribe(projectId, {
          agentId: workerAgentId,
          events: ["turn.completed"],
          destination: { type: "session", sessionId: coordinator },
        })
      ).json()) as { subscription: EventSubscription }
    ).subscription;
    const narrowed = (
      (await (
        await subscribe(projectId, {
          agentId: workerAgentId,
          sourceLabels: { lead },
          events: ["turn.completed"],
          destination: { type: "session", sessionId: lead },
        })
      ).json()) as { subscription: EventSubscription }
    ).subscription;
    const patchLabels = async (sessionId: string, patch: Record<string, unknown>) => {
      const response = await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/labels`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(200);
    };

    // Labelled at admission, unlabelled before the outcome: still captured.
    const labelled = await createWorkerdSession(workerAgentId, "2".repeat(64), { labels: { lead } });
    const kept = await postTurn(labelled, "Work [stall 1000ms]", "source-labels-kept");
    await patchLabels(labelled, { unset: ["lead"] });
    await waitForTurn(labelled, kept.turnId, "completed");
    expect(
      (await settleDeliveries(labelled, kept.turnId)).map((delivery) => delivery.subscriptionId).sort(),
    ).toEqual([broad.id, narrowed.id].sort());

    // Unlabelled at admission, labelled before the outcome: not captured.
    const unlabelled = await createWorkerdSession(workerAgentId, "2".repeat(64));
    const missed = await postTurn(unlabelled, "Work [stall 1000ms]", "source-labels-missed");
    await patchLabels(unlabelled, { set: { lead } });
    await waitForTurn(unlabelled, missed.turnId, "completed");
    expect(
      (await settleDeliveries(unlabelled, missed.turnId)).map((delivery) => delivery.subscriptionId),
    ).toEqual([broad.id]);

    // The next turn is admitted with the new labels and is captured.
    const next = await postTurn(unlabelled, "Research the topic.", "source-labels-next");
    await waitForTurn(unlabelled, next.turnId, "completed");
    expect(
      (await settleDeliveries(unlabelled, next.turnId)).map((delivery) => delivery.subscriptionId).sort(),
    ).toEqual([broad.id, narrowed.id].sort());
  }, 30_000);

  it("refuses sourceLabels that break the label rules or name more than eight pairs", async () => {
    const { projectId, workerAgentId, coordinator } =
      await coordinatorAndWorker("outcomes-source-labels-invalid");
    const attempt = (sourceLabels: unknown) =>
      subscribe(projectId, {
        agentId: workerAgentId,
        sourceLabels,
        events: ["turn.completed"],
        destination: { type: "session", sessionId: coordinator },
      });
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, "v"]));
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, "v"]));
    for (const [sourceLabels, message] of [
      [nine, "at most 8 labels"],
      [{ "Bad Key": "v" }, "Label key"],
      [{ lead: 7 }, "must be a string"],
      [{ lead: "x".repeat(257) }, "exceeds 256 characters"],
      [{}, "at least one label"],
      [["lead"], "object of strings"],
      ["lead", "object of strings"],
    ] as const) {
      const refused = await attempt(sourceLabels);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: {
          code: "invalid_event_subscription",
          message: expect.stringContaining(message),
        },
      });
    }
    expect(
      (
        await json<{ subscriptions: EventSubscription[] }>(
          await SELF.fetch(`https://managedagents.test/v1/projects/${projectId}/event-subscriptions`),
        )
      ).subscriptions,
    ).toEqual([]);
    const accepted = await attempt(eight);
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { subscription: EventSubscription }).subscription.sourceLabels).toEqual(
      eight,
    );
  }, 30_000);
});

/**
 * The execution fence (work 025 review, D1 and D2). A stop the host has not
 * acknowledged is persisted on the session and nothing dispatches until it
 * has; the host refuses a prompt while an older execution is live there and
 * the controller treats that as "interrupt first", never as an admission.
 */
describe("execution fence", () => {
  it(
    "holds the replacement while the stop reply is pending: a held interrupt never stops the next turn (D1)",
    async () => {
      const sessionId = await createWorkerdSession("workerd-fence-hold", "3".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 5000ms][hold-interrupt 500ms]", "hold-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      // A is replaced; the host holds its stop reply. A plain enqueue meanwhile
      // must not start B (or C) into A's still-running execution.
      const b = await postTurn(sessionId, "Do this instead [stall 800ms]", "hold-b", "interrupt");
      const c = await postTurn(sessionId, "And then this.", "hold-c");
      const during = await snapshotOf(sessionId);
      expect(during.status).toBe("stopping");
      expect(during.turns.map((turn) => [turn.id, turn.status])).toEqual([
        [a.turnId, "running"],
        [b.turnId, "queued"],
        [c.turnId, "queued"],
      ]);
      expect(await pendingStopOf(sessionId)).toMatchObject({ turn_id: a.turnId, reason: "interrupted" });

      await waitForTurn(sessionId, c.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);
      // Nothing was failed by a late session-wide interrupt.
      expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
      expect(terminalEventsOf(events, a.turnId)).toEqual([expect.objectContaining({ type: "turn.cancelled" })]);
      expect(terminalEventsOf(events, b.turnId)).toEqual([expect.objectContaining({ type: "turn.completed" })]);
      expect(terminalEventsOf(events, c.turnId)).toEqual([expect.objectContaining({ type: "turn.completed" })]);
      // B started only after the host acknowledged the stop.
      const order = events
        .filter(
          (event) =>
            (event.type === "runtime.log" && event.data.phase === "workerd_interrupt") ||
            (event.type === "turn.started" && (event.turnId === b.turnId || event.turnId === c.turnId)),
        )
        .map((event) => (event.type === "runtime.log" ? "acknowledged" : `started:${event.turnId === b.turnId ? "b" : "c"}`));
      expect(order).toEqual(["acknowledged", "started:b", "started:c"]);
      expect(events.find((event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt")?.data).toMatchObject({
        acknowledged: true,
        interrupted: true,
        reason: "interrupted",
      });
      // The host saw the stop before B's prompt, and B's prompt carried B.
      const runtime = await fakeRuntimeOf(sessionId);
      expect(runtime.calls.map((call) => [call.route, call.turnId])).toEqual([
        ["turn", a.turnId],
        ["stop", a.turnId],
        ["turn", b.turnId],
        ["turn", c.turnId],
      ]);
      expect(runtime.live).toBeNull();
      expect(await pendingStopOf(sessionId)).toBeUndefined();
    },
    30_000,
  );

  it(
    "keeps an already queued turn waiting through a standalone interrupt until the host acknowledges (D1)",
    async () => {
      const sessionId = await createWorkerdSession("workerd-fence-queued", "4".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 5000ms][hold-interrupt 500ms]", "queued-a");
      const b = await postTurn(sessionId, "Next [stall 500ms]", "queued-b");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      const interrupted = await json<SessionSnapshot>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/interrupt`, { method: "POST" }),
      );
      expect(interrupted.status).toBe("stopping");
      expect(interrupted.turns.map((turn) => [turn.id, turn.status])).toEqual([
        [a.turnId, "running"],
        [b.turnId, "queued"],
      ]);
      await waitForTurn(sessionId, b.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);
      expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
      expect(terminalEventsOf(events, b.turnId)).toEqual([expect.objectContaining({ type: "turn.completed" })]);
      const runtime = await fakeRuntimeOf(sessionId);
      expect(runtime.calls.map((call) => [call.route, call.turnId])).toEqual([
        ["turn", a.turnId],
        ["stop", a.turnId],
        ["turn", b.turnId],
      ]);
      expect(terminalEventsOf(events, a.turnId)).toEqual([expect.objectContaining({ type: "turn.cancelled" })]);
    },
    30_000,
  );

  it(
    "re-drives a failed stop from the alarm after eviction and only then dispatches (D1)",
    async () => {
      const sessionId = await createWorkerdSession("workerd-fence-retry", "5".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 5000ms][fail-interrupt 1]", "retry-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      const b = await postTurn(sessionId, "Next.", "retry-b", "interrupt");
      // The first stop attempt fails; the replacement waits.
      const failed = await waitForEvents(sessionId, (current) =>
        current.some(
          (event) =>
            event.type === "runtime.log" &&
            event.data.phase === "workerd_interrupt" &&
            event.data.acknowledged === false,
        ),
      );
      expect(failed.find((event) => event.type === "turn.started" && event.turnId === b.turnId)).toBeUndefined();
      expect(await pendingStopOf(sessionId)).toMatchObject({ turn_id: a.turnId, attempts: 1 });
      expect((await snapshotOf(sessionId)).turns[1]).toMatchObject({ id: b.turnId, status: "queued" });

      // The controller dies; the recorded stop and its retry survive it.
      await abortAllDurableObjects();
      const revived = env.SESSIONS.getByName(sessionId);
      expect((await snapshotOf(sessionId)).turns[1]).toMatchObject({ id: b.turnId, status: "queued" });
      await runInDurableObject(revived, (_instance, state) => {
        state.storage.sql.exec("UPDATE workerd_pending_stop SET next_attempt_at_ms = ? WHERE slot = 1", Date.now() - 1);
      });
      expect(await runDurableObjectAlarm(revived)).toBe(true);
      await waitForTurn(sessionId, b.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);
      expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
      expect(
        events
          .filter((event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt")
          .map((event) => [event.data.attempt, event.data.acknowledged]),
      ).toEqual([
        [1, false],
        [2, true],
      ]);
      expect(await pendingStopOf(sessionId)).toBeUndefined();
      expect((await fakeRuntimeOf(sessionId)).calls.map((call) => [call.route, call.turnId])).toEqual([
        ["turn", a.turnId],
        ["stop", a.turnId],
        ["stop", a.turnId],
        ["turn", b.turnId],
      ]);
    },
    30_000,
  );

  it(
    "loses only the controller: the host keeps executing, lease recovery stops it before the next turn owns the session (D2)",
    async () => {
      const project = await json<{ agents: Array<{ id: string }> }>(
        await SELF.fetch("https://managedagents.test/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environmentMode: "legacy", name: "Fence lost", slug: "fence-lost" }),
        }),
      );
      const sessionId = await createWorkerdSession(`${project.agents[0]!.id}--worker`, "6".repeat(64), { memory: true });
      const a = await postTurn(sessionId, "Keep going [stall 20000ms]", "lost-a");
      const b = await postTurn(sessionId, "And then this one.", "lost-b");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      // Only the controller dies. The fake runtime is a Node service: A's
      // execution is still live there.
      await abortAllDurableObjects();
      expect((await fakeRuntimeOf(sessionId)).live).toBe(a.turnId);
      const revived = env.SESSIONS.getByName(sessionId);
      await runInDurableObject(revived, (_instance, state) => {
        state.storage.sql.exec("UPDATE turns SET lease_deadline_at_ms = ? WHERE id = ?", Date.now() - 1, a.turnId);
      });
      expect(await runDurableObjectAlarm(revived)).toBe(true);
      await waitForTurn(sessionId, b.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);

      // Turn ownership: A failed once (runtime_lost), B completed once, and
      // B started only after the host acknowledged A's stop.
      expect(terminalEventsOf(events, a.turnId)).toEqual([
        expect.objectContaining({ type: "turn.failed", data: expect.objectContaining({ reason: "runtime_lost" }) }),
      ]);
      expect(terminalEventsOf(events, b.turnId)).toEqual([expect.objectContaining({ type: "turn.completed" })]);
      const order = events
        .filter(
          (event) =>
            (event.type === "turn.failed" && event.turnId === a.turnId) ||
            (event.type === "runtime.log" && event.data.phase === "workerd_interrupt") ||
            (event.type === "turn.started" && event.turnId === b.turnId),
        )
        .map((event) => event.type);
      expect(order).toEqual(["turn.failed", "runtime.log", "turn.started"]);
      expect(events.find((event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt")?.data).toMatchObject({
        acknowledged: true,
        interrupted: true,
        reason: "runtime_lost",
        hostTurnId: a.turnId,
      });
      const runtime = await fakeRuntimeOf(sessionId);
      expect(runtime.calls.map((call) => [call.route, call.turnId])).toEqual([
        ["turn", a.turnId],
        ["stop", a.turnId],
        ["turn", b.turnId],
      ]);
      expect(runtime.live).toBeNull();
      // The same fence as a Stop: the session was stopping until the host
      // settled, and only then idle and dispatching.
      expect(
        events
          .filter((event) => event.type === "session.status_changed")
          .map((event) => `${event.data.from}>${event.data.to}`),
      ).toEqual(["new>idle", "idle>running", "running>stopping", "stopping>idle", "idle>running", "running>idle"]);

      // Input ownership: B's render carries B's input, not A's.
      const rendered = events.filter((event) => event.type === "agent.rendered");
      expect(rendered.map((event) => [event.turnId, (event.data.input as { text: string }).text])).toEqual([
        [a.turnId, "Keep going [stall 20000ms]"],
        [b.turnId, "And then this one."],
      ]);
      // Memory ownership: the interrupted execution reported no save; B's did.
      expect(events.filter((event) => event.type === "memory.saved").map((event) => event.turnId)).toEqual([b.turnId]);
      expect((await snapshotOf(sessionId)).memoryAdmission).toEqual({ state: "issued" });
    },
    30_000,
  );

  it(
    "treats the host's turn_in_progress as retry-after-interrupt, never as an admission (D2)",
    async () => {
      const sessionId = await createWorkerdSession("workerd-fence-409", "7".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 20000ms][replay-after-interrupt]", "replay-a");
      const b = await postTurn(sessionId, "After the replay.", "replay-b");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      await abortAllDurableObjects();
      const revived = env.SESSIONS.getByName(sessionId);
      await runInDurableObject(revived, (_instance, state) => {
        state.storage.sql.exec("UPDATE turns SET lease_deadline_at_ms = ? WHERE id = ?", Date.now() - 1, a.turnId);
      });
      expect(await runDurableObjectAlarm(revived)).toBe(true);
      await waitForTurn(sessionId, b.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);
      // The first stop acknowledged but the execution was still there (a
      // replayed loop); B's prompt was refused, B went back to queued with
      // a recorded stop, and only the second acknowledgement let it run.
      expect(
        events
          .filter((event) => event.type === "runtime.log" && event.data.phase === "workerd_turn_deferred")
          .map((event) => [event.turnId, event.data.hostTurnId]),
      ).toEqual([[b.turnId, a.turnId]]);
      expect(terminalEventsOf(events, b.turnId)).toEqual([expect.objectContaining({ type: "turn.completed" })]);
      expect(terminalEventsOf(events, a.turnId)).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.started" && event.turnId === b.turnId)).toHaveLength(2);
      expect(
        events
          .filter((event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt")
          .map((event) => [event.data.reason, event.data.acknowledged]),
      ).toEqual([
        ["runtime_lost", true],
        ["turn_in_progress", true],
      ]);
      expect((await fakeRuntimeOf(sessionId)).calls.map((call) => [call.route, call.turnId])).toEqual([
        ["turn", a.turnId],
        ["stop", a.turnId],
        ["turn", b.turnId],
        ["stop", a.turnId],
        ["turn", b.turnId],
      ]);
      expect(await pendingStopOf(sessionId)).toBeUndefined();
    },
    30_000,
  );
});

/** Delivery boundaries (work 025 review, D3, D4, D5) and the combined proofs. */
describe("outcome delivery boundaries", () => {
  it("scopes a subscription to the destination's environment: Development never delivers into Production (D3)", async () => {
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Outcomes env", slug: "outcomes-env" }),
      }),
    );
    const coordinatorAgentId = project.agents[0]!.id;
    const workerAgentId = `${coordinatorAgentId}--worker`;
    const development = await createWorkerdSession(coordinatorAgentId, "1".repeat(64));
    const production = await createWorkerdSession(coordinatorAgentId, "1".repeat(64), { environment: "production" });
    const worker = await createWorkerdSession(workerAgentId, "2".repeat(64));
    expect((await snapshotOf(development)).environment).toBe("development");
    expect((await snapshotOf(production)).environment).toBe("production");
    expect((await snapshotOf(worker)).environment).toBe("development");

    // A subscription takes the destination's environment; naming another
    // one is refused rather than ignored.
    expect(
      (
        await subscribe(project.id, {
          agentId: workerAgentId,
          events: ["turn.completed"],
          environment: "development",
          destination: { type: "session", sessionId: production },
        })
      ).status,
    ).toBe(409);
    const toProduction = await subscribe(project.id, {
      agentId: workerAgentId,
      events: ["turn.completed"],
      destination: { type: "session", sessionId: production },
    });
    expect(toProduction.status).toBe(201);
    expect(((await toProduction.json()) as { subscription: EventSubscription }).subscription.environment).toBe("production");

    // The Development worker's outcome matches no subscription at all.
    const first = await postTurn(worker, "Research the topic.", "env-worker-1");
    await waitForTurn(worker, first.turnId, "completed");
    await runDurableObjectAlarm(env.SESSIONS.getByName(worker));
    expect((await snapshotOf(worker)).turns[0]!.deliveries).toBeUndefined();
    expect((await snapshotOf(production)).turns).toEqual([]);

    // The same worker outcome reaches the Development coordinator.
    const toDevelopment = await subscribe(project.id, {
      agentId: workerAgentId,
      events: ["turn.completed"],
      environment: "development",
      destination: { type: "session", sessionId: development },
    });
    expect(toDevelopment.status).toBe(201);
    const second = await postTurn(worker, "Research more.", "env-worker-2");
    await waitForTurn(worker, second.turnId, "completed");
    const deliveries = await settleDeliveries(worker, second.turnId);
    expect(deliveries).toEqual([
      expect.objectContaining({ status: "delivered", receipt: { sessionId: development, turnId: expect.any(String) } }),
    ]);
    await waitForTurn(development, deliveries[0]!.receipt!.turnId, "completed");
    expect((await snapshotOf(production)).turns).toEqual([]);
    expect((await snapshotOf(development)).turns.map((turn) => turn.id)).toEqual([deliveries[0]!.receipt!.turnId]);
  }, 30_000);

  it("reconciles a committed receipt before treating a deleted subscription as a failure (D4)", async () => {
    const { projectId, workerAgentId, coordinator, worker } = await coordinatorAndWorker("outcomes-deleted-receipt");
    const created = await subscribe(projectId, {
      agentId: workerAgentId,
      events: ["turn.completed"],
      destination: { type: "session", sessionId: coordinator },
    });
    expect(created.status).toBe(201);
    const { subscription } = (await created.json()) as { subscription: EventSubscription };
    // The target commits the turn, the reply is lost, then the subscription
    // is deleted before the retry.
    const restore = failTargetAdmissionOnce(coordinator, { commit: true });
    let delivery: TurnOutcomeDelivery;
    const work = await postTurn(worker, "Research the topic.", "deleted-receipt-turn");
    try {
      await waitForTurn(worker, work.turnId, "completed");
      delivery = await pendingDelivery(worker, work.turnId);
    } finally {
      restore();
    }
    const committed = (await snapshotOf(coordinator)).turns;
    expect(committed).toHaveLength(1);
    expect(
      (
        await SELF.fetch(`https://managedagents.test/v1/projects/${projectId}/event-subscriptions/${subscription.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    await makeDeliveryDue(worker, delivery.id);
    const settled = await settleDeliveries(worker, work.turnId);
    expect(settled).toEqual([
      expect.objectContaining({
        id: delivery.id,
        status: "delivered",
        attempt: 2,
        receipt: { sessionId: coordinator, turnId: committed[0]!.id },
      }),
    ]);
    expect(settled[0]!.error).toBeUndefined();
    expect((await snapshotOf(coordinator)).turns.map((turn) => turn.id)).toEqual([committed[0]!.id]);
  }, 30_000);

  it("delivers the final assistant message, not the progress before it (D5)", async () => {
    const { projectId, workerAgentId, coordinator, worker } = await coordinatorAndWorker("outcomes-final-answer");
    expect(
      (
        await subscribe(projectId, {
          agentId: workerAgentId,
          events: ["turn.completed"],
          destination: { type: "session", sessionId: coordinator },
        })
      ).status,
    ).toBe(201);
    const work = await postTurn(worker, "Work it out [long-progress]", "final-answer-turn");
    await waitForTurn(worker, work.turnId, "completed");
    const completed = (await waitForEvents(worker, () => true)).find(
      (event) => event.type === "message.completed" && event.turnId === work.turnId,
    )!;
    expect((completed.data.text as string).length).toBeGreaterThan(22 * 1024);
    expect(completed.data.finalText).toBe("Final answer: 42.");
    const deliveries = await settleDeliveries(worker, work.turnId);
    expect(deliveries[0]).toMatchObject({ status: "delivered" });
    const receiptTurnId = deliveries[0]!.receipt!.turnId;
    await waitForTurn(coordinator, receiptTurnId, "completed");
    const rendered = (await waitForEvents(coordinator, () => true)).find(
      (event) => event.type === "agent.rendered" && event.turnId === receiptTurnId,
    )!;
    expect((rendered.data.input as { event: { result: unknown } }).event.result).toEqual({
      text: "Final answer: 42.",
      truncated: false,
    });
  }, 30_000);

  it("acknowledges memory closure on end while a delivery is still pending, and the delivery still lands", async () => {
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Outcomes closure", slug: "outcomes-closure" }),
      }),
    );
    const coordinatorAgentId = project.agents[0]!.id;
    const workerAgentId = `${coordinatorAgentId}--worker`;
    const coordinator = await createWorkerdSession(coordinatorAgentId, "1".repeat(64));
    const worker = await createWorkerdSession(workerAgentId, "2".repeat(64), { memory: true });
    expect(
      (
        await subscribe(project.id, {
          agentId: workerAgentId,
          events: ["turn.completed"],
          destination: { type: "session", sessionId: coordinator },
        })
      ).status,
    ).toBe(201);
    const restore = failTargetAdmissionOnce(coordinator, { commit: false });
    let delivery: TurnOutcomeDelivery;
    const work = await postTurn(worker, "Research the topic.", "closure-turn");
    try {
      await waitForTurn(worker, work.turnId, "completed");
      delivery = await pendingDelivery(worker, work.turnId);
    } finally {
      restore();
    }
    expect(delivery.status).toBe("pending");

    // End answers only once the Memory DO acknowledged the closure.
    const ended = await SELF.fetch(`https://managedagents.test/v1/sessions/${worker}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    const snapshot = await ended.json<SessionSnapshot>();
    expect(snapshot).toMatchObject({ status: "ended", memoryClosure: "acknowledged" });
    expect((await snapshotOf(worker)).turns[0]!.deliveries).toEqual([expect.objectContaining({ status: "pending" })]);

    // The ended session's alarm still delivers the committed outcome.
    await makeDeliveryDue(worker, delivery.id);
    const settled = await settleDeliveries(worker, work.turnId);
    expect(settled).toEqual([
      expect.objectContaining({ status: "delivered", attempt: 2, receipt: { sessionId: coordinator, turnId: expect.any(String) } }),
    ]);
    await waitForTurn(coordinator, settled[0]!.receipt!.turnId, "completed");
    expect((await snapshotOf(worker)).memoryClosure).toBe("acknowledged");
  }, 30_000);
});

/** Design C4: durable stop intent that settles every dispatched operation, or retires the computer. */
describe("durable stop", () => {
  it(
    "refuses a result commit for a turn that is being stopped; a receipt still answers its replay and the earlier result stands",
    async () => {
      const base = "https://managedagents.test";
      const sessionId = await createWorkerdSession("workerd-stop-result", "a".repeat(64));
      const turn = await postTurn(sessionId, "Report [stall 20000ms][ops 1][hold-settlement 1500ms]", "stop-result-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === turn.turnId),
      );
      const generation = { kind: "workerd", bootId: "boot-managed-test", activation: 1 };
      const commit = (callId: string, data: Record<string, unknown>) =>
        SELF.fetch(`${base}/v1/sessions/${sessionId}/result`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtimeTokens.get(sessionId)!}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ turnId: turn.turnId, callId, tool: "report", runtime: generation, data }),
        });
      expect((await commit("call-1", { branch: "task/1" })).status).toBe(200);

      const interrupted = await json<SessionSnapshot>(
        await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" }),
      );
      expect(interrupted.status).toBe("stopping");
      expect(interrupted.turns.find((candidate) => candidate.id === turn.turnId)?.status).toBe("running");
      // Running, but fenced: the stop is recorded and the commit is stale.
      const refused = await commit("call-2", { branch: "task/2" });
      expect(refused.status).toBe(409);
      expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("stale_turn");
      // The receipt of the commit that preceded the stop still answers.
      expect((await commit("call-1", { branch: "task/1" })).status).toBe(200);
      expect((await snapshotOf(sessionId)).result).toMatchObject({ turnId: turn.turnId, callId: "call-1", data: { branch: "task/1" } });

      await waitForTurn(sessionId, turn.turnId, "cancelled");
      const after = await snapshotOf(sessionId);
      expect(after.status).toBe("idle");
      expect(after.result).toMatchObject({ turnId: turn.turnId, callId: "call-1" });
      expect(
        (await waitForEvents(sessionId, () => true)).filter(
          (event) => event.type === "tool.completed" && event.data.result === true,
        ),
      ).toHaveLength(1);
    },
    30_000,
  );

  it(
    "refuses a first result for a turn interrupted while the host delays settlement",
    async () => {
      // Review finding 5's exact reproduction: no result yet, the turn
      // interrupted, the host holding settlement; the session shows
      // `stopping` and the turn is still `running`, and the first commit
      // must not go through on that basis.
      const base = "https://managedagents.test";
      const sessionId = await createWorkerdSession("workerd-stop-first-result", "b".repeat(64));
      const turn = await postTurn(sessionId, "Report [stall 20000ms][ops 1][hold-settlement 1500ms]", "stop-first-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === turn.turnId),
      );
      const interrupted = await json<SessionSnapshot>(
        await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" }),
      );
      expect(interrupted.status).toBe("stopping");
      expect(interrupted.turns.find((candidate) => candidate.id === turn.turnId)?.status).toBe("running");
      const refused = await SELF.fetch(`${base}/v1/sessions/${sessionId}/result`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeTokens.get(sessionId)!}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          turnId: turn.turnId,
          callId: "call-1",
          tool: "report",
          runtime: { kind: "workerd", bootId: "boot-managed-test", activation: 1 },
          data: { branch: "task/1" },
        }),
      });
      expect(refused.status).toBe(409);
      expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("stale_turn");
      expect((await snapshotOf(sessionId)).result).toBeNull();
      await waitForTurn(sessionId, turn.turnId, "cancelled");
      expect((await snapshotOf(sessionId)).result).toBeNull();
    },
    30_000,
  );

  it(
    "a stop with commands in flight cancels the turn only after the last one has settled",
    async () => {
      const sessionId = await createWorkerdSession("workerd-stop-ops", "8".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 20000ms][ops 2][hold-settlement 1500ms]", "ops-a");
      const b = await postTurn(sessionId, "Afterwards.", "ops-b");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      const interrupted = await json<SessionSnapshot>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/interrupt`, { method: "POST" }),
      );
      expect(interrupted.status).toBe("stopping");
      expect(await pendingStopOf(sessionId)).toMatchObject({
        turn_id: a.turnId,
        reason: "interrupted",
        runtime_generation: "boot-managed-test:1",
      });
      // The stop is listed: the row shows the session stopping with the
      // turn still active, at the revision the interrupt answered with.
      const stoppingRow = await projectedRow(sessionId, interrupted.revision);
      expect(stoppingRow).toMatchObject({
        status: "stopping",
        activity: { activeTurnId: a.turnId, queued: 1 },
      });

      // The first attempt finds both operations still pending: the turn stays
      // running, nothing dispatches, the attempt is recorded with the ids.
      const unsettled = await waitForEvents(sessionId, (current) =>
        current.some(
          (event) =>
            event.type === "runtime.log" &&
            event.data.phase === "workerd_interrupt" &&
            event.data.acknowledged === false,
        ),
      );
      expect(
        unsettled.find((event) => event.type === "runtime.log" && event.data.acknowledged === false)?.data,
      ).toMatchObject({ pendingOperations: [`${a.turnId}-op-1`, `${a.turnId}-op-2`], escalated: false });
      expect((await snapshotOf(sessionId)).turns.map((turn) => [turn.id, turn.status])).toEqual([
        [a.turnId, "running"],
        [b.turnId, "queued"],
      ]);

      // Re-driven from the alarm until the host reports both settled.
      await waitForTurn(sessionId, b.turnId, "completed");
      const events = await waitForEvents(sessionId, () => true);
      expect(terminalEventsOf(events, a.turnId)).toEqual([
        expect.objectContaining({
          type: "turn.cancelled",
          data: expect.objectContaining({ reason: "interrupted", operationsSettled: 2, computerTerminated: false }),
        }),
      ]);
      const order = events
        .filter(
          (event) =>
            (event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === true) ||
            (event.type === "turn.cancelled" && event.turnId === a.turnId) ||
            (event.type === "turn.started" && event.turnId === b.turnId),
        )
        .map((event) => event.type);
      expect(order).toEqual(["runtime.log", "turn.cancelled", "turn.started"]);
      expect(events.find((event) => event.type === "runtime.log" && event.data.acknowledged === true)?.data).toMatchObject({
        operations: { total: 2, settled: 2 },
        computerTerminated: false,
        settledAfterMs: expect.any(Number),
      });
      const runtime = await fakeRuntimeOf(sessionId);
      expect(runtime.calls.filter((call) => call.route === "stop").length).toBeGreaterThanOrEqual(2);
      expect(runtime.calls.some((call) => call.route === "terminate")).toBe(false);
      expect(await pendingStopOf(sessionId)).toBeUndefined();
      const idle = await snapshotOf(sessionId);
      expect(idle.status).toBe("idle");
      // Settlement published too: the row left `stopping` at a newer revision.
      const idleRow = await projectedRow(sessionId, idle.revision);
      expect(idleRow.revision).toBeGreaterThan(stoppingRow.revision);
      expect(idleRow).toMatchObject({ status: "idle", activity: { activeTurnId: null, queued: 0 } });
    },
    30_000,
  );

  it(
    "terminates the computer, confirmed, when the supervisor never settles; the next turn runs on a new one",
    async () => {
      const sessionId = await createWorkerdSession("workerd-stop-terminate", "9".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 20000ms][ops 1][never-settle][fail-terminate 1]", "term-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/interrupt`, { method: "POST" });
      await waitForEvents(sessionId, (current) =>
        current.some(
          (event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false,
        ),
      );
      expect((await snapshotOf(sessionId)).status).toBe("stopping");

      // The budget passes: the drive escalates to terminating the computer.
      // The first termination fails and is retried; the escalation sticks.
      await elapseStopBudget(sessionId);
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "runtime.log" && event.data.escalated === true),
      );
      expect(await pendingStopOf(sessionId)).toMatchObject({ terminate_requested: 1 });
      expect((await snapshotOf(sessionId)).turns[0]).toMatchObject({ id: a.turnId, status: "running" });
      await elapseStopBudget(sessionId);
      await waitForTurn(sessionId, a.turnId, "cancelled");
      const events = await waitForEvents(sessionId, () => true);
      expect(terminalEventsOf(events, a.turnId)).toEqual([
        expect.objectContaining({
          type: "turn.cancelled",
          data: expect.objectContaining({ reason: "interrupted", computerTerminated: true, operationsSettled: 1 }),
        }),
      ]);
      expect(events.find((event) => event.type === "runtime.log" && event.data.acknowledged === true)?.data).toMatchObject({
        computerTerminated: true,
        generation: 1,
      });
      const runtime = await fakeRuntimeOf(sessionId);
      expect(runtime.calls.filter((call) => call.route === "terminate")).toHaveLength(2);
      expect(runtime.computerTerminated).toBe(true);
      expect((await snapshotOf(sessionId)).status).toBe("idle");

      // The follow-up is a real remedy: it runs on the next computer.
      const b = await postTurn(sessionId, "And now this.", "term-b");
      await waitForTurn(sessionId, b.turnId, "completed");
      expect((await fakeRuntimeOf(sessionId)).computerGeneration).toBe(2);
    },
    30_000,
  );

  it(
    "end mid-turn settles the dispatched operations behind the same fence",
    async () => {
      const sessionId = await createWorkerdSession("workerd-stop-end", "c".repeat(64));
      const a = await postTurn(sessionId, "Keep going [stall 20000ms][ops 1]", "end-ops-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === a.turnId),
      );
      const ended = await json<SessionSnapshot>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/end`, { method: "POST" }),
      );
      expect(ended).toMatchObject({ status: "ended", turns: [expect.objectContaining({ status: "cancelled" })] });
      const events = await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "runtime.log" && event.data.acknowledged === true),
      );
      expect(events.find((event) => event.type === "runtime.log" && event.data.acknowledged === true)?.data).toMatchObject({
        reason: "session_ended",
        operations: { total: 1, settled: 1 },
      });
      expect(terminalEventsOf(events, a.turnId)).toEqual([
        expect.objectContaining({ type: "turn.cancelled", data: { reason: "session_ended" } }),
      ]);
      expect((await fakeRuntimeOf(sessionId)).calls.map((call) => call.route)).toEqual(["turn", "stop"]);
      expect(await pendingStopOf(sessionId)).toBeUndefined();
      expect((await snapshotOf(sessionId)).status).toBe("ended");
    },
    30_000,
  );

  it(
    "archiving the project stops the Workerd runtime and preserves its session",
    async () => {
      const project = await json<Project>(
        await SELF.fetch("https://managedagents.test/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environmentMode: "legacy", slug: "workerd-project-archive", name: "Archive" }),
        }),
      );
      const sessionId = await createWorkerdSession(project.agentId, "d".repeat(64));
      const turn = await postTurn(sessionId, "Keep going [stall 20000ms]", "delete-a");
      await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "message.delta" && event.turnId === turn.turnId),
      );

      const archived = await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/archive`,
        { method: "POST" },
      );
      expect(archived.status).toBe(200);
      // A Workerd session binds a runtime but never a microvm_id, so the
      // MicroVM terminate is a no-op for it and ending the record is the only
      // thing that stops the runtime. Counting it as stopped has to mean the
      // stop actually reached the runtime.
      expect(await json(archived)).toMatchObject({ archivedAt: expect.any(String) });
      await vi.waitFor(async () => {
        expect((await fakeRuntimeOf(sessionId)).calls.map((call) => call.route)).toEqual([
          "turn",
          "stop",
        ]);
      });
      expect(await env.SESSIONS.getByName(sessionId).snapshot()).toMatchObject({
        status: "ended",
        turns: [expect.objectContaining({ status: "cancelled" })],
      });
      const preserved = await SELF.fetch(
        `https://managedagents.test/v1/sessions/${sessionId}`,
      );
      expect(preserved.status).toBe(200);
      expect(await json(preserved)).toMatchObject({ status: "ended" });
    },
    30_000,
  );

});

describe("a channel conversation on Workerd", () => {
  const SIGNING_SECRET = "s".repeat(32);

  /** A connected Slack channel for the agent, the way the connect flow leaves one. */
  async function slackConnection(id: string, agentId: string): Promise<void> {
    const account = env.ACCOUNTS.getByName("local");
    await account.createSlackConnection({ id, agentId, alias: "development", appName: "Workerd" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, team_id: "T1", team: "Acme", user_id: "B1", bot_id: "BOT1" })) as unknown as typeof globalThis.fetch;
    try {
      await account.completeSlackConnection(id, "xoxb-workerd", "A1", SIGNING_SECRET);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /** Every Slack Web API call the session makes, in order; `answer` overrides Slack's reply per call. */
  type SlackAnswer = Record<string, unknown> | Response | undefined;
  function captureSlack(
    answer?: (url: string, ordinal: number) => SlackAnswer | Promise<SlackAnswer>,
  ): { calls: Array<{ url: string; body: Record<string, unknown> }>; restore: () => void } {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      const answered = await answer?.(String(url), calls.length);
      if (answered instanceof Response) return answered;
      return Response.json(answered ?? { ok: true, ts: "12.3" });
    }) as unknown as typeof globalThis.fetch;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
  }

  /**
   * Settled channel turns whose reply never went out: what an activation that
   * died between settlement and the send leaves behind.
   */
  async function seedSettledReplies(
    sessionId: string,
    connectionId: string,
    count: number,
    row: { attempts?: number; nextAttemptAtMs?: number | null; leaseUntilMs?: number | null } = {},
  ): Promise<string[]> {
    return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const turnId = `seeded-${index}-${crypto.randomUUID()}`;
        const at = new Date(Date.now() - (count - index) * 1_000).toISOString();
        state.storage.sql.exec(
          `INSERT INTO turns (id, input, status, idempotency_key, created_at, updated_at)
           VALUES (?, ?, 'completed', ?, ?, ?)`,
          turnId,
          `seed ${index}`,
          `seed:${turnId}`,
          at,
          at,
        );
        state.storage.sql.exec(
          `INSERT INTO events (id, timestamp, turn_id, type, data)
           VALUES (?, ?, ?, 'message.completed', ?)`,
          crypto.randomUUID(),
          at,
          turnId,
          JSON.stringify({ text: `answer ${index}`, finalText: `answer ${index}` }),
        );
        state.storage.sql.exec(
          `INSERT INTO slack_deliveries (
             turn_id, connected_account_id, channel_id, external_user_id, thread_timestamp,
             progress_message_timestamp, provider, delivery_ref, status, attempts,
             next_attempt_at_ms, lease_until_ms, updated_at
           ) VALUES (?, ?, 'C1', 'U-ONE', '1.1', NULL, 'slack', ?, 'pending', ?, ?, ?, ?)`,
          turnId,
          connectionId,
          JSON.stringify({ channelId: "C1", threadTimestamp: "1.1" }),
          row.attempts ?? 0,
          row.nextAttemptAtMs ?? null,
          row.leaseUntilMs ?? null,
          at,
        );
        ids.push(turnId);
      }
      return ids;
    });
  }

  const deliveryRow = (sessionId: string, turnId: string) =>
    runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<{ status: string; attempts: number; next_attempt_at_ms: number | null; lease_until_ms: number | null }>(
          "SELECT status, attempts, next_attempt_at_ms, lease_until_ms FROM slack_deliveries WHERE turn_id = ?",
          turnId,
        )
        .one(),
    );

  const alarmOf = (sessionId: string) =>
    runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => state.storage.getAlarm());

  /** What a settlement's own `scheduleAlarm()` would do after the object came back. */
  const rearm = (sessionId: string) =>
    runInDurableObject(env.SESSIONS.getByName(sessionId), (instance) =>
      (instance as unknown as { scheduleAlarm(): Promise<void> }).scheduleAlarm(),
    );

  const posts = (calls: Array<{ url: string; body: Record<string, unknown> }>) =>
    calls.filter((call) => call.url.includes("chat.postMessage"));

  /** The arrow link every Slack reply ends with — under the project when the session has one. */
  const sessionLink = (sessionId: string, projectId?: string) =>
    projectId
      ? `<https://app.example/projects/${projectId}/sessions/${sessionId}|↗>`
      : `<https://app.example/sessions/${sessionId}|↗>`;

  it("answers on the channel when the turn settles, without waiting for an alarm", async () => {
    const project = await env.ACCOUNTS.getByName("local").createProject({
      environmentMode: "legacy",
      id: "prj_channel_answers",
      name: "Channel answers",
      slug: "channel-answers",
    });
    const sessionId = await createWorkerdSession(project.agentId, "c".repeat(64));
    await slackConnection("conn-workerd", project.agentId);
    const slack = captureSlack();
    let turnId: string;
    try {
      const turn = await env.SESSIONS.getByName(sessionId).enqueueChannelTurn(
        { input: "ping", agentInput: { source: "channel", text: "ping" }, idempotencyKey: "slack:ping" },
        {
          provider: "slack",
          connectionId: "conn-workerd",
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
        },
      );
      turnId = turn.turnId;
      await waitForEvents(sessionId, (events) => terminalEventsOf(events, turn.turnId).length > 0);
      // The reply follows the settlement itself. Before this was wired, the
      // pending row waited for whichever alarm fired next: the turn lease armed
      // at dispatch, a minute after an answer that took seconds.
      await vi.waitFor(() => {
        expect(
          slack.calls.some(
            (call) =>
              call.url.includes("chat.postMessage") &&
              call.body.text ===
                `Managed OpenCode is running in the Durable Object. ${sessionLink(sessionId, project.id)}`,
          ),
        ).toBe(true);
      });
    } finally {
      slack.restore();
    }
    const delivery = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM slack_deliveries WHERE turn_id = ?",
          turnId,
        )
        .one(),
    );
    expect(delivery).toEqual({ status: "delivered", attempts: 1 });
    // The status line under the message is cleared once the answer is posted,
    // and the alarm that fires later finds nothing left to deliver.
    const statusCalls = slack.calls.filter((call) => call.url.includes("assistant.threads.setStatus"));
    expect(statusCalls.at(-1)?.body.status).toBe("");
    const before = slack.calls.length;
    await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
    expect(slack.calls.length).toBe(before);
  });

  it("names the tool on the progress line and in the public events", async () => {
    const sessionId = await createWorkerdSession("agent-channel-tools", "f".repeat(64));
    await slackConnection("conn-workerd-tools", "agent-channel-tools");
    const slack = captureSlack();
    let events: AgentEvent[] = [];
    let turnId = "";
    try {
      const turn = await env.SESSIONS.getByName(sessionId).enqueueChannelTurn(
        {
          // Pause after the tool frames so the status request can land before
          // the final answer supersedes it. A tool and answer emitted in one
          // synchronous stream burst are deliberately coalesced.
          input: "[long-progress] [pause-after-tool 500ms] check it",
          agentInput: {
            source: "channel",
            text: "[long-progress] [pause-after-tool 500ms] check it",
          },
          idempotencyKey: "slack:tools",
        },
        {
          provider: "slack",
          connectionId: "conn-workerd-tools",
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
        },
      );
      turnId = turn.turnId;
      events = await waitForEvents(sessionId, (all) => terminalEventsOf(all, turn.turnId).length > 0);
      // The admission ack is itself a chat.postMessage and lands much
      // earlier; the answer's ↗ link marks the settle-path writes done.
      await vi.waitFor(() => {
        expect(
          slack.calls.some(
            (call) =>
              call.url.includes("chat.postMessage") &&
              String(call.body.text ?? "").includes("|↗>"),
          ),
        ).toBe(true);
      });
    } finally {
      slack.restore();
    }
    // The public shape the runtime-stream harness produces and the docs
    // describe: `tool` and `callId` on every frame, OpenCode's ids dropped.
    const started = events.find((event) => event.turnId === turnId && event.type === "tool.started");
    expect(started?.data).toEqual({
      callId: "call-1",
      tool: "sandbox_exec",
      title: "sandbox_exec",
      input: { command: "npm test" },
      identity: workerdToolIdentity("agent-channel-tools", "f".repeat(64), sessionId, turnId, "call-1"),
    });
    const completed = events.find((event) => event.turnId === turnId && event.type === "tool.completed");
    expect(completed?.data).toMatchObject({
      callId: "call-1",
      tool: "sandbox_exec",
      output: "ok",
    });
    expect(completed?.data).not.toHaveProperty("sessionID");
    // Slack gets the final assistant message, not the 22 KB of progress text
    // the turn wrote before it.
    const posted = slack.calls.filter(
      (call) =>
        call.url.includes("chat.postMessage") &&
        String(call.body.text ?? "").includes("|↗>"),
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.text).toBe(`Final answer: 42. ${sessionLink(sessionId)}`);
    // The status line under the message said what was running, by name.
    const statuses = slack.calls
      .filter((call) => call.url.includes("assistant.threads.setStatus"))
      .map((call) => call.body.status);
    expect(statuses).toContain("sandbox_exec npm test");
    expect(statuses.at(-1)).toBe("");
    // The thinking-steps stream opened on the thread, carried the tool's task
    // card, and finalized once the turn settled.
    const started_ = slack.calls.find((call) => call.url.includes("chat.startStream"));
    expect(started_?.body).toMatchObject({
      channel: "C1",
      thread_ts: "1.1",
      recipient_user_id: "U-ONE",
    });
    const cards = slack.calls
      .filter((call) => call.url.includes("chat.appendStream"))
      .flatMap((call) => call.body.chunks as Array<Record<string, unknown>>);
    expect(cards).toContainEqual(
      expect.objectContaining({
        type: "task_update",
        title: "sandbox_exec npm test",
        status: "in_progress",
      }),
    );
    expect(cards.at(-1)).toMatchObject({ type: "task_update", status: "complete" });
    expect(
      slack.calls.some((call) => call.url.includes("chat.stopStream")),
    ).toBe(true);
  });

  it("resumes the thinking-steps stream when the progress object is lost mid-turn", async () => {
    const sessionId = await createWorkerdSession("agent-channel-recycle", "c".repeat(64));
    await slackConnection("conn-workerd-recycle", "agent-channel-recycle");
    const slack = captureSlack();
    let turnId = "";
    try {
      const turn = await env.SESSIONS.getByName(sessionId).enqueueChannelTurn(
        {
          input: "[long-progress] [pause-after-tool 500ms] check it",
          agentInput: {
            source: "channel",
            text: "[long-progress] [pause-after-tool 500ms] check it",
          },
          idempotencyKey: "slack:recycle",
        },
        {
          provider: "slack",
          connectionId: "conn-workerd-recycle",
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
        },
      );
      turnId = turn.turnId;
      // The stream opens at enqueue. Wait for its ts to be persisted — then
      // drop the in-memory progress objects, which is what a Durable Object
      // recycle mid-turn does: the delivery row is all that survives it.
      await vi.waitFor(async () => {
        const row = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_i, state) =>
          state.storage.sql
            .exec<{ ts: string | null }>(
              "SELECT progress_message_timestamp AS ts FROM slack_deliveries WHERE turn_id = ?",
              turnId,
            )
            .one(),
        );
        expect(row.ts).toBe("12.3");
      });
      await runInDurableObject(env.SESSIONS.getByName(sessionId), (instance) => {
        (instance as unknown as { slackProgress: Map<string, unknown> }).slackProgress.clear();
      });
      await waitForEvents(sessionId, (all) => terminalEventsOf(all, turn.turnId).length > 0);
      // The ack's chat.postMessage lands at admission; the stream's close is
      // the settle-path write that proves the turn finished.
      await vi.waitFor(() => {
        expect(slack.calls.some((call) => call.url.includes("chat.stopStream"))).toBe(true);
      });
    } finally {
      slack.restore();
    }
    // One stream for the whole turn: a rebuilt progress resumes the ts that
    // was persisted at the first open instead of starting a second stream.
    expect(slack.calls.filter((call) => call.url.includes("chat.startStream"))).toHaveLength(1);
    const appends = slack.calls.filter((call) => call.url.includes("chat.appendStream"));
    expect(appends.length).toBeGreaterThan(0);
    for (const call of appends) expect(call.body.ts).toBe("12.3");
    const stops = slack.calls.filter((call) => call.url.includes("chat.stopStream"));
    expect(stops).toHaveLength(1);
    expect(stops[0]!.body.ts).toBe("12.3");
  });

  it("does not send the answer again when the bookkeeping after it fails", async () => {
    const sessionId = await createWorkerdSession("agent-channel-books", "a1".repeat(32));
    await slackConnection("conn-workerd-books", "agent-channel-books");
    const record = AccountDurableObject.prototype.recordChannelDelivery;
    AccountDurableObject.prototype.recordChannelDelivery = function () {
      throw new Error("injected bookkeeping failure");
    };
    const slack = captureSlack();
    let turnId = "";
    try {
      const turn = await env.SESSIONS.getByName(sessionId).enqueueChannelTurn(
        { input: "ping", agentInput: { source: "channel", text: "ping" }, idempotencyKey: "slack:books" },
        {
          provider: "slack",
          connectionId: "conn-workerd-books",
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
        },
      );
      turnId = turn.turnId;
      await waitForEvents(sessionId, (events) => terminalEventsOf(events, turn.turnId).length > 0);
      // The admission ack is a chat.postMessage too; the answer is the post
      // carrying the session's ↗ link.
      await vi.waitFor(() => {
        expect(
          slack.calls.some(
            (call) =>
              call.url.includes("chat.postMessage") &&
              String(call.body.text ?? "").includes("|↗>"),
          ),
        ).toBe(true);
      });
      // The row is delivered whatever the bookkeeping did, so the alarm has
      // nothing to retry and the person gets one answer.
      await vi.waitFor(async () => {
        const row = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
          state.storage.sql
            .exec<{ status: string }>("SELECT status FROM slack_deliveries WHERE turn_id = ?", turnId)
            .one(),
        );
        expect(row.status).toBe("delivered");
      });
      await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
      expect(
        slack.calls.filter(
          (call) =>
            call.url.includes("chat.postMessage") &&
            String(call.body.text ?? "").includes("|↗>"),
        ),
      ).toHaveLength(1);
    } finally {
      slack.restore();
      AccountDurableObject.prototype.recordChannelDelivery = record;
    }
  });

  // An alarm the scheduler sets for "now" fires at once in this harness, so
  // these tests capture Slack first and watch for the effect rather than
  // reading an alarm that has already been consumed.

  it("makes a settled reply the settlement never sent due for the alarm", async () => {
    const sessionId = await createWorkerdSession("agent-channel-lost", "b1".repeat(32));
    await slackConnection("conn-workerd-lost", "agent-channel-lost");
    const [turnId] = await seedSettledReplies(sessionId, "conn-workerd-lost", 1);
    const slack = captureSlack();
    try {
      // Nothing but the alarm can send a seeded reply: the settlement that
      // would have is in an activation that no longer exists.
      await rearm(sessionId);
      await vi.waitFor(() => {
        expect(posts(slack.calls).map((call) => call.body.text)).toEqual([
          `answer 0 ${sessionLink(sessionId)}`,
        ]);
      });
    } finally {
      slack.restore();
    }
    expect(await deliveryRow(sessionId, turnId!)).toEqual({
      status: "delivered",
      attempts: 1,
      next_attempt_at_ms: null,
      lease_until_ms: null,
    });
  });

  it("follows a batch that leaves replies behind with another", async () => {
    const sessionId = await createWorkerdSession("agent-channel-batch", "c1".repeat(32));
    await slackConnection("conn-workerd-batch", "agent-channel-batch");
    await seedSettledReplies(sessionId, "conn-workerd-batch", 11);
    const slack = captureSlack();
    try {
      await rearm(sessionId);
      // One alarm drains ten; the eleventh is still due, so the handler
      // re-arms and the next firing takes it.
      await vi.waitFor(
        () => {
          expect(posts(slack.calls)).toHaveLength(11);
        },
        { timeout: 5_000 },
      );
    } finally {
      slack.restore();
    }
    // In settlement order, oldest first.
    expect(posts(slack.calls).map((call) => call.body.text)).toEqual(
      Array.from({ length: 11 }, (_, index) => `answer ${index} ${sessionLink(sessionId)}`),
    );
  });

  it("retries a transient provider failure on its schedule", async () => {
    const sessionId = await createWorkerdSession("agent-channel-retry", "d1".repeat(32));
    await slackConnection("conn-workerd-retry", "agent-channel-retry");
    const [turnId] = await seedSettledReplies(sessionId, "conn-workerd-retry", 1);
    let failures = 0;
    const slack = captureSlack((url) => {
      if (url.includes("chat.postMessage") && failures === 0) {
        failures += 1;
        return { ok: false, error: "ratelimited" };
      }
      return undefined;
    });
    try {
      const before = Date.now();
      await rearm(sessionId);
      await vi.waitFor(async () => {
        expect(await deliveryRow(sessionId, turnId!)).toMatchObject({ status: "pending", attempts: 1, lease_until_ms: null });
      });
      const failed = await deliveryRow(sessionId, turnId!);
      expect(failed.next_attempt_at_ms!).toBeGreaterThanOrEqual(before + 2_000);
      // The alarm is for the retry, not for now, so it is still there to read.
      expect((await alarmOf(sessionId))!).toBeGreaterThanOrEqual(before + 2_000);
      // Time passes; the alarm fires.
      await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE slack_deliveries SET next_attempt_at_ms = ? WHERE turn_id = ?",
          Date.now() - 1,
          turnId,
        );
      });
      expect(await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId))).toBe(true);
    } finally {
      slack.restore();
    }
    expect(posts(slack.calls)).toHaveLength(2);
    expect(await deliveryRow(sessionId, turnId!)).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("gives up after the schedule, and at once on a permanent error", async () => {
    const sessionId = await createWorkerdSession("agent-channel-exhaust", "e1".repeat(32));
    await slackConnection("conn-workerd-exhaust", "agent-channel-exhaust");
    const [worn, doomed] = await seedSettledReplies(sessionId, "conn-workerd-exhaust", 2, { attempts: 4 });
    await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
      state.storage.sql.exec("UPDATE slack_deliveries SET attempts = 0 WHERE turn_id = ?", doomed);
    });
    const slack = captureSlack((url) =>
      url.includes("chat.postMessage")
        ? { ok: false, error: posts(slack.calls).length === 1 ? "ratelimited" : "channel_not_found" }
        : undefined,
    );
    try {
      await rearm(sessionId);
      await vi.waitFor(async () => {
        // The fifth attempt was the last; the permanent error needed only one.
        expect(await deliveryRow(sessionId, worn!)).toMatchObject({ status: "failed", next_attempt_at_ms: null, attempts: 5 });
        expect(await deliveryRow(sessionId, doomed!)).toMatchObject({ status: "failed", next_attempt_at_ms: null, attempts: 1 });
      });
    } finally {
      slack.restore();
    }
    expect(posts(slack.calls)).toHaveLength(2);
    // Nothing left for the scheduler to arm on their account.
    await rearm(sessionId);
    const next = await alarmOf(sessionId);
    if (next !== null) expect(next).toBeGreaterThan(Date.now() + 1_000);
  });

  it("lets a late word from a superseded attempt change nothing", async () => {
    const sessionId = await createWorkerdSession("agent-channel-late", "b2".repeat(32));
    await slackConnection("conn-workerd-late", "agent-channel-late");
    const [turnId] = await seedSettledReplies(sessionId, "conn-workerd-late", 1);
    // The first post hangs for a while and then fails; the second answers
    // at once. (The delay lives in the fetch stub, in the account object's
    // own context; a promise settled from the test would cross objects.)
    let postsSeen = 0;
    const slack = captureSlack(async (url) => {
      if (!url.includes("chat.postMessage")) return undefined;
      postsSeen += 1;
      if (postsSeen === 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: false, error: "ratelimited" };
      }
      return undefined;
    });
    try {
      await rearm(sessionId);
      await vi.waitFor(async () => {
        expect(await deliveryRow(sessionId, turnId!)).toMatchObject({ status: "pending", attempts: 1 });
        expect(posts(slack.calls)).toHaveLength(1);
      });
      // Its lease runs out while it is still waiting on Slack; the alarm
      // finds the row free and a second attempt answers.
      await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE slack_deliveries SET lease_until_ms = ? WHERE turn_id = ?",
          Date.now() - 1,
          turnId,
        );
      });
      await runInDurableObject(env.SESSIONS.getByName(sessionId), (instance) =>
        (instance as SessionDurableObject).alarm(),
      );
      await vi.waitFor(async () => {
        expect(await deliveryRow(sessionId, turnId!)).toMatchObject({ status: "delivered", attempts: 2 });
      });
      expect(posts(slack.calls)).toHaveLength(2);
      // The first attempt now hears that its post failed. It no longer owns
      // the row, so the delivered answer is not put back in line.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await deliveryRow(sessionId, turnId!)).toMatchObject({ status: "delivered", attempts: 2, next_attempt_at_ms: null });
      await runInDurableObject(env.SESSIONS.getByName(sessionId), (instance) =>
        (instance as SessionDurableObject).alarm(),
      );
      expect(posts(slack.calls)).toHaveLength(2);
    } finally {
      slack.restore();
    }
  });

  it("waits as long as the provider asked before trying again", async () => {
    const sessionId = await createWorkerdSession("agent-channel-limited", "c2".repeat(32));
    await slackConnection("conn-workerd-limited", "agent-channel-limited");
    const [turnId] = await seedSettledReplies(sessionId, "conn-workerd-limited", 1);
    let limited = false;
    const slack = captureSlack((url) => {
      if (!url.includes("chat.postMessage") || limited) return undefined;
      limited = true;
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    });
    try {
      const before = Date.now();
      await rearm(sessionId);
      // Settled, not merely leased: the attempt has recorded its failure.
      await vi.waitFor(async () => {
        const row = await deliveryRow(sessionId, turnId!);
        expect(row).toMatchObject({ status: "pending", attempts: 1, lease_until_ms: null });
        expect(row.next_attempt_at_ms).not.toBeNull();
      });
      // Sixty seconds, not the two the schedule alone would give.
      const row = await deliveryRow(sessionId, turnId!);
      expect(row.next_attempt_at_ms!).toBeGreaterThanOrEqual(before + 60_000);
      expect((await alarmOf(sessionId))!).toBeGreaterThanOrEqual(before + 60_000);
    } finally {
      slack.restore();
    }
  });

  it("keeps retrying replies the code before this column meant to retry", async () => {
    const sessionId = await createWorkerdSession("agent-channel-old", "d2".repeat(32));
    await slackConnection("conn-workerd-old", "agent-channel-old");
    // The table as the previous code left it: no retry columns, and a reply
    // that failed once with attempts to spare, which then meant "retry".
    await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE slack_deliveries DROP COLUMN next_attempt_at_ms");
      state.storage.sql.exec("ALTER TABLE slack_deliveries DROP COLUMN lease_until_ms");
      const at = new Date(Date.now() - 5_000).toISOString();
      state.storage.sql.exec(
        `INSERT INTO turns (id, input, status, idempotency_key, created_at, updated_at)
         VALUES ('old-turn', 'old', 'completed', 'seed:old-turn', ?, ?)`,
        at,
        at,
      );
      state.storage.sql.exec(
        `INSERT INTO events (id, timestamp, turn_id, type, data)
         VALUES (?, ?, 'old-turn', 'message.completed', ?)`,
        crypto.randomUUID(),
        at,
        JSON.stringify({ text: "old answer", finalText: "old answer" }),
      );
      state.storage.sql.exec(
        `INSERT INTO slack_deliveries (
           turn_id, connected_account_id, channel_id, external_user_id, thread_timestamp,
           progress_message_timestamp, provider, delivery_ref, status, attempts, updated_at
         ) VALUES ('old-turn', 'conn-workerd-old', 'C1', 'U-ONE', '1.1', NULL, 'slack', ?, 'failed', 1, ?)`,
        JSON.stringify({ channelId: "C1", threadTimestamp: "1.1" }),
        at,
      );
      state.storage.sql.exec(
        `INSERT INTO slack_deliveries (
           turn_id, connected_account_id, channel_id, external_user_id, thread_timestamp,
           progress_message_timestamp, provider, delivery_ref, status, attempts, updated_at
         ) VALUES ('given-up', 'conn-workerd-old', 'C1', 'U-ONE', '1.1', NULL, 'slack', ?, 'failed', 5, ?)`,
        JSON.stringify({ channelId: "C1", threadTimestamp: "1.1" }),
        at,
      );
    });
    // A new activation runs the constructor's migration over that table.
    await abortAllDurableObjects();
    const slack = captureSlack();
    try {
      await rearm(sessionId);
      await vi.waitFor(async () => {
        expect(posts(slack.calls).map((call) => call.body.text)).toEqual([
          `old answer ${sessionLink(sessionId)}`,
        ]);
      });
    } finally {
      slack.restore();
    }
    expect(await deliveryRow(sessionId, "old-turn")).toMatchObject({ status: "delivered", attempts: 2 });
    // The one the old code had given up on stays given up.
    expect(await deliveryRow(sessionId, "given-up")).toMatchObject({ status: "failed", attempts: 5 });
  });

  it("leaves an attempt in flight alone until its lease ends", async () => {
    const sessionId = await createWorkerdSession("agent-channel-lease", "f1".repeat(32));
    await slackConnection("conn-workerd-lease", "agent-channel-lease");
    const leaseUntilMs = Date.now() + 30_000;
    const [turnId] = await seedSettledReplies(sessionId, "conn-workerd-lease", 1, { leaseUntilMs });
    await rearm(sessionId);
    const slack = captureSlack();
    try {
      await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
    } finally {
      slack.restore();
    }
    expect(posts(slack.calls)).toHaveLength(0);
    expect(await deliveryRow(sessionId, turnId!)).toMatchObject({ status: "pending", attempts: 0, lease_until_ms: leaseUntilMs });
    // Armed for the lease's end, when a dead attempt is retried.
    expect((await alarmOf(sessionId))!).toBeGreaterThanOrEqual(leaseUntilMs);
  });

  it("does not clear the status line a queued successor is already writing", async () => {
    const sessionId = await createWorkerdSession("agent-channel-thread", "a2".repeat(32));
    await slackConnection("conn-workerd-thread", "agent-channel-thread");
    const slack = captureSlack();
    try {
      const stub = env.SESSIONS.getByName(sessionId);
      const delivery = {
        provider: "slack",
        connectionId: "conn-workerd-thread",
        externalUserId: "U-ONE",
        deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
      };
      const first = await stub.enqueueChannelTurn(
        {
          input: "[stall 300ms] first",
          agentInput: { source: "channel", text: "[stall 300ms] first" },
          idempotencyKey: "slack:thread-1",
        },
        delivery,
      );
      const second = await stub.enqueueChannelTurn(
        { input: "second", agentInput: { source: "channel", text: "second" }, idempotencyKey: "slack:thread-2" },
        delivery,
      );
      await waitForEvents(
        sessionId,
        (events) =>
          terminalEventsOf(events, first.turnId).length > 0 && terminalEventsOf(events, second.turnId).length > 0,
      );
      // Each admission also posts its ack; the two answers carry the ↗ link.
      await vi.waitFor(() => {
        expect(
          posts(slack.calls).filter((call) =>
            String(call.body.text ?? "").includes("|↗>"),
          ),
        ).toHaveLength(2);
      });
    } finally {
      slack.restore();
    }
    const clears = slack.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.url.includes("assistant.threads.setStatus") && call.body.status === "");
    const [firstPost, secondPost] = slack.calls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          call.url.includes("chat.postMessage") &&
          String(call.body.text ?? "").includes("|↗>"),
      );
    // One clear, by the last turn on the thread, not by the first one while
    // the second was still queued behind it.
    expect(clears).toHaveLength(1);
    expect(clears[0]!.index).toBeGreaterThan(firstPost!.index);
    expect(clears[0]!.index).toBeLessThan(secondPost!.index);
  });

  /** The object's stored idle deadline and its pending alarm time. */
  async function idleTimers(sessionId: string): Promise<{ idleAt: number | undefined; alarm: number | null }> {
    return runInDurableObject(env.SESSIONS.getByName(sessionId), async (_instance, state) => ({
      idleAt: await state.storage.get<number>("channelIdleAtMs"),
      alarm: await state.storage.getAlarm(),
    }));
  }

  it("never arms the MicroVM idle timer, whatever the channel asks for", async () => {
    const sessionId = await createWorkerdSession("agent-channel-idle", "d".repeat(64));
    await slackConnection("conn-workerd-idle", "agent-channel-idle");
    const slack = captureSlack();
    try {
      const turn = await env.SESSIONS.getByName(sessionId).enqueueChannelTurn(
        { input: "ping", agentInput: { source: "channel", text: "ping" }, idempotencyKey: "slack:idle" },
        {
          provider: "slack",
          connectionId: "conn-workerd-idle",
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
          idleSuspendSeconds: 1,
        },
      );
      await waitForEvents(sessionId, (events) => terminalEventsOf(events, turn.turnId).length > 0);
      // Wait for the settled answer, not the admission ack, so any armed
      // alarm belongs to post-settlement bookkeeping.
      await vi.waitFor(() => {
        expect(
          slack.calls.some(
            (call) =>
              call.url.includes("chat.postMessage") &&
              String(call.body.text ?? "").includes("|↗>"),
          ),
        ).toBe(true);
      });
    } finally {
      slack.restore();
    }
    // There is no bound VM to suspend, so settlement leaves no deadline behind
    // and the alarm, if any, is for something else and not already overdue.
    const timers = await idleTimers(sessionId);
    expect(timers.idleAt).toBeUndefined();
    if (timers.alarm !== null) expect(timers.alarm).toBeGreaterThan(Date.now() - 1);
  });

  it("drops a stale idle deadline instead of waking in a loop over it", async () => {
    const sessionId = await createWorkerdSession("agent-channel-stale", "e".repeat(64));
    await runInDurableObject(env.SESSIONS.getByName(sessionId), async (_instance, state) => {
      await state.storage.put("channelIdleSeconds", 1);
      await state.storage.put("channelIdleAtMs", Date.now() - 1_000);
    });
    // The handler as the alarm would run it, whatever else is due.
    await runInDurableObject(env.SESSIONS.getByName(sessionId), (instance) =>
      (instance as SessionDurableObject).alarm(),
    );
    const timers = await idleTimers(sessionId);
    expect(timers.idleAt).toBeUndefined();
    if (timers.alarm !== null) expect(timers.alarm).toBeGreaterThan(Date.now() - 1);
  });

  it("posts the working-in ack only when the grace ends on a turn still running", async () => {
    const sessionId = await createWorkerdSession("agent-channel-ack", "f".repeat(64));
    await slackConnection("conn-workerd-ack", "agent-channel-ack");
    const slack = captureSlack();
    const stub = env.SESSIONS.getByName(sessionId);
    const acks = () =>
      slack.calls.filter(
        (call) =>
          call.url.includes("chat.postMessage") &&
          String(call.body.text ?? "").includes("On it"),
      );
    try {
      const turn = await stub.enqueueChannelTurn(
        { input: "ping", agentInput: { source: "channel", text: "ping" }, idempotencyKey: "slack:ack" },
        {
          provider: "slack",
          connectionId: "conn-workerd-ack",
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
        },
      );
      await waitForEvents(sessionId, (events) => terminalEventsOf(events, turn.turnId).length > 0);

      // Settled inside the window: the answer is the acknowledgement, so a
      // due slot on the settled turn still posts nothing. The handler is
      // invoked directly — nothing else is armed, so no alarm is scheduled.
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("UPDATE slack_deliveries SET ack_due_at_ms = 0"),
      );
      await runInDurableObject(stub, (instance) =>
        (instance as SessionDurableObject).alarm(),
      );
      expect(acks().length).toBe(0);

      // The same slot coming due on a turn still running posts the ack —
      // once, no matter how often the alarm fires.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE turns SET status = 'running' WHERE id = ?", turn.turnId);
        state.storage.sql.exec("UPDATE slack_deliveries SET ack_due_at_ms = 0");
      });
      await runInDurableObject(stub, (instance) =>
        (instance as SessionDurableObject).alarm(),
      );
      expect(acks().length).toBe(1);
      expect(String(acks()[0]!.body.text)).toContain("working in");
      expect(String(acks()[0]!.body.text)).toContain(sessionId);
      await runInDurableObject(stub, (instance) =>
        (instance as SessionDurableObject).alarm(),
      );
      expect(acks().length).toBe(1);
    } finally {
      slack.restore();
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("UPDATE turns SET status = 'completed' WHERE status = 'running'"),
      );
    }
  });

  // ── A question in a Slack thread does not hold it (K26) ─────────────────────

  type SlackCall = { url: string; body: Record<string, unknown> };
  type Block = { type: string; text?: unknown; elements?: Array<Record<string, unknown>> };

  /**
   * A Slack thread on a Workerd session whose first message asked: the card
   * is out when this returns. Every Slack post answers with its own `ts`,
   * so each card can be told apart.
   */
  async function askedInThread(agentId: string, digest: string, connectionId: string) {
    const sessionId = await createWorkerdSession(agentId, digest);
    await slackConnection(connectionId, agentId);
    const slack = captureSlack((url, ordinal) =>
      url.includes("chat.postMessage") ? { ok: true, ts: `20.${String(ordinal).padStart(6, "0")}` } : undefined,
    );
    const stub = env.SESSIONS.getByName(sessionId);
    // As the Slack ingress admits a message: the model's text starts with
    // the transcript header, the typed input carries the bare text.
    const say = async (key: string, text: string) => {
      const receipt = await stub.enqueueChannelTurn(
        {
          input: `${SLACK_HEADER}\n\n${text}`,
          agentInput: { source: "channel", text, channel: { provider: "slack", connectionId, userId: "U-ONE" } },
          idempotencyKey: `slack:${key}`,
          providerTime: new Date().toISOString(),
        },
        {
          provider: "slack",
          connectionId,
          externalUserId: "U-ONE",
          deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
        },
      );
      return receipt as { turnId: string; status: string; duplicate: boolean };
    };
    const settled = (turnId: string) =>
      waitForEvents(sessionId, (events) => terminalEventsOf(events, turnId).length > 0);
    const cards = () =>
      slack.calls.filter(
        (call) => call.url.includes("chat.postMessage") && JSON.stringify(call.body.blocks ?? []).includes('"actions"'),
      );
    const updates = () => slack.calls.filter((call) => call.url.includes("chat.update"));
    const blocksOf = (call: SlackCall) => call.body.blocks as Block[];
    const renderedInput = async (turnId: string) => {
      const events = await waitForEvents(sessionId, (current) =>
        current.some((event) => event.turnId === turnId && event.type === "agent.rendered"),
      );
      const rendered = events.find((event) => event.turnId === turnId && event.type === "agent.rendered")!;
      return (rendered.data as { input: Record<string, unknown> }).input;
    };
    const questionOf = async () =>
      (await json<SessionSnapshot>(await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}`))).question;
    /** The text the model was given for a turn, as the runtime received it. */
    const modelText = async (turnId: string) =>
      (await fakeRuntimeOf(sessionId)).calls.find((call) => call.route === "turn" && call.turnId === turnId)!.text;
    const closedReason = (questionId: string) =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ closed_reason: string | null }>("SELECT closed_reason FROM questions WHERE id = ?", questionId)
          .one().closed_reason,
      );

    const asking = await say("ask", "Plan the change. [ask call-ask]");
    await settled(asking.turnId);
    const questionId = await questionIdFor(asking.turnId, "call-ask");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const card = cards()[0]!;
    return {
      sessionId,
      stub,
      slack,
      say,
      settled,
      cards,
      updates,
      blocksOf,
      renderedInput,
      questionOf,
      modelText,
      askingTurnId: asking.turnId,
      closedReason,
      questionId,
      cardTs: "20." + String(slack.calls.indexOf(card) + 1).padStart(6, "0"),
      cardMarkdown: String(blocksOf(card)[0]!.text),
    };
  }

  const SLACK_HEADER = "[Slack message from Una (U-ONE) in #general (C1)]";
  const OPEN_QUESTION_LINE =
    'Open question: "Which approach?" (options: Go · Wait). A button answers it; this message is not the answer unless it says so.';

  const openQuestionOf = (questionId: string) => ({
    id: questionId,
    text: "Which approach?",
    options: [
      { label: "Go", value: "go" },
      { label: "Wait", value: "wait" },
    ],
  });

  it("ask, then a typed question, then a reply with no ask: the reply runs at once and the card is superseded", async () => {
    const thread = await askedInThread("agent-flow-reply", "a1".repeat(32), "conn-flow-reply");
    try {
      const typed = await thread.say("why", "What would Go change?");
      // Not held: an ordinary turn, admitted beside the open question.
      expect(typed).toMatchObject({ status: "queued", duplicate: false });
      const events = await thread.settled(typed.turnId);
      expect(terminalEventsOf(events, typed.turnId).map((event) => event.type)).toEqual(["turn.completed"]);
      expect(await thread.renderedInput(typed.turnId)).toMatchObject({
        source: "channel",
        text: "What would Go change?",
        openQuestion: openQuestionOf(thread.questionId),
      });
      // The model reads the pending question in the transcript header; a
      // turn with no open question has no such line.
      expect(await thread.modelText(typed.turnId)).toBe(
        `${SLACK_HEADER}\n${OPEN_QUESTION_LINE}\n\nWhat would Go change?`,
      );
      expect(await thread.modelText(thread.askingTurnId)).toBe(`${SLACK_HEADER}\n\nPlan the change. [ask call-ask]`);
      expect(events.filter((event) => event.type === "message.held")).toEqual([]);
      expect(events.filter((event) => event.type === "question.answered")).toEqual([]);
      expect(
        events.filter((event) => event.type === "question.closed").map((event) => [event.turnId, event.data]),
      ).toEqual([[typed.turnId, { questionId: thread.questionId, reason: "superseded" }]]);
      expect(await thread.questionOf()).toBeNull();
      expect(await thread.closedReason(thread.questionId)).toBe("superseded");
      // The reply posts in the thread, and the card keeps its text, loses
      // its buttons and gains one quiet line.
      await vi.waitFor(() => {
        expect(
          thread.slack.calls.some(
            (call) =>
              call.url.includes("chat.postMessage") &&
              String(call.body.text ?? "").startsWith("Managed OpenCode is running in the Durable Object."),
          ),
        ).toBe(true);
        expect(thread.updates()).toHaveLength(1);
      });
      const update = thread.updates()[0]!;
      expect(update.body).toMatchObject({ channel: "C1", ts: thread.cardTs });
      expect(thread.blocksOf(update)).toEqual([
        { type: "markdown", text: thread.cardMarkdown },
        { type: "context", elements: [{ type: "mrkdwn", text: "answered in the thread" }] },
      ]);
      expect(thread.cards()).toHaveLength(1);
    } finally {
      thread.slack.restore();
    }
  });

  it("ask, then a typed message, then a reply that asks again: the old card is superseded and the new one posts under the reply", async () => {
    const thread = await askedInThread("agent-flow-reask", "a2".repeat(32), "conn-flow-reask");
    try {
      const typed = await thread.say("revise", "Make it smaller. [ask call-again]");
      expect(typed).toMatchObject({ status: "queued", duplicate: false });
      const events = await thread.settled(typed.turnId);
      const next = await questionIdFor(typed.turnId, "call-again");
      expect(next).not.toBe(thread.questionId);
      // In the settlement: the old question closes before the new one opens,
      // so the session never has two open questions.
      const settlement = events
        .filter((event) => event.turnId === typed.turnId && event.type.startsWith("question."))
        .map((event) => [event.type, event.data.questionId, event.data.reason]);
      expect(settlement).toEqual([
        ["question.closed", thread.questionId, "superseded"],
        ["question.asked", next, undefined],
      ]);
      expect((await thread.questionOf())?.id).toBe(next);
      expect(await thread.closedReason(thread.questionId)).toBe("superseded");
      await vi.waitFor(() => {
        expect(thread.cards()).toHaveLength(2);
        expect(thread.updates()).toHaveLength(1);
      });
      expect(thread.updates()[0]!.body).toMatchObject({ channel: "C1", ts: thread.cardTs });
      expect(JSON.stringify(thread.blocksOf(thread.updates()[0]!))).toContain("answered in the thread");
      expect(JSON.stringify(thread.blocksOf(thread.updates()[0]!))).not.toContain('"actions"');
      const newCard = thread.cards()[1]!;
      expect(newCard.body).toMatchObject({ channel: "C1", thread_ts: "1.1" });
      expect(JSON.stringify(thread.blocksOf(newCard))).toContain(`${next}:0`);
      expect(events.filter((event) => event.type === "message.held")).toEqual([]);
    } finally {
      thread.slack.restore();
    }
  });

  it("ask, then a builder's outcome event: the event runs and the question stays open, still answerable by its buttons", async () => {
    const thread = await askedInThread("agent-flow-event", "a3".repeat(32), "conn-flow-event");
    try {
      const outcome = await thread.stub.enqueueTurn({
        input: "The api stream landed.",
        idempotencyKey: "outcome-1",
        mode: "queue",
        agentInput: {
          source: "event",
          event: {
            id: "evt-outcome-1",
            type: "turn.completed",
            sessionId: "builder-session",
            turnId: "builder-turn-1",
            agentId: "builder-agent",
            occurredAt: "2026-10-07T00:00:00.000Z",
            result: { text: "The api stream landed.", truncated: false },
          },
        },
      });
      expect(outcome).toMatchObject({ status: "queued", duplicate: false });
      const turnId = (outcome as { turnId: string }).turnId;
      const events = await thread.settled(turnId);
      expect(terminalEventsOf(events, turnId).map((event) => event.type)).toEqual(["turn.completed"]);
      expect(events.filter((event) => event.type === "message.held")).toEqual([]);
      expect(events.filter((event) => event.type === "question.closed")).toEqual([]);
      expect((await thread.renderedInput(turnId)).openQuestion).toBeUndefined();
      expect(await thread.modelText(turnId)).toBe("The api stream landed.");
      expect((await thread.questionOf())?.id).toBe(thread.questionId);
      // The outcome's reply posts in the thread; the card is left alone.
      await vi.waitFor(() =>
        expect(
          thread.slack.calls.filter(
            (call) => call.url.includes("chat.postMessage") && !JSON.stringify(call.body.blocks ?? []).includes('"actions"'),
          ),
        ).toHaveLength(1),
      );
      expect(thread.updates()).toEqual([]);
      // The buttons still answer.
      const clicked = await thread.stub.answerQuestionFromChannel({
        questionId: thread.questionId,
        optionIndex: 0,
        externalUserId: "U-ONE",
        actionTimestamp: "1700000000.000001",
        connectionId: "conn-flow-event",
      });
      expect(clicked).toMatchObject({ outcome: "admitted", duplicate: false });
      await vi.waitFor(async () => expect(await thread.questionOf()).toBeNull());
    } finally {
      thread.slack.restore();
    }
  });

  it("ask, then a typed message, then a silent reply: the question stays open, the card is unchanged and its buttons still answer", async () => {
    const thread = await askedInThread("agent-flow-silent", "a5".repeat(32), "conn-flow-silent");
    try {
      const typed = await thread.say("aside", "Noted, carry on. [silent]");
      expect(typed).toMatchObject({ status: "queued", duplicate: false });
      const events = await thread.settled(typed.turnId);
      expect(terminalEventsOf(events, typed.turnId).map((event) => event.type)).toEqual(["turn.completed"]);
      // It ran beside the question and knew of it, then said nothing.
      expect(await thread.modelText(typed.turnId)).toContain(OPEN_QUESTION_LINE);
      expect(events.filter((event) => event.type === "question.closed")).toEqual([]);
      expect(await thread.closedReason(thread.questionId)).toBeNull();
      expect((await thread.questionOf())?.id).toBe(thread.questionId);
      // Nothing posted for the silent reply, nothing rewritten.
      await runDurableObjectAlarm(thread.stub);
      expect(thread.slack.calls.filter((call) => call.url.includes("chat.postMessage"))).toHaveLength(1);
      expect(thread.updates()).toEqual([]);
      // The buttons still answer.
      const clicked = await thread.stub.answerQuestionFromChannel({
        questionId: thread.questionId,
        optionIndex: 0,
        externalUserId: "U-ONE",
        actionTimestamp: "1700000000.000003",
        connectionId: "conn-flow-silent",
      });
      expect(clicked).toMatchObject({ outcome: "admitted", duplicate: false });
      await vi.waitFor(() => expect(thread.updates().length).toBeGreaterThan(0));
      expect(JSON.stringify(thread.blocksOf(thread.updates().at(-1)!))).toContain("chosen: Go · by <@U-ONE>");
    } finally {
      thread.slack.restore();
    }
  });

  it("ask, then a click: the click answers the question and the card shows the choice", async () => {
    const thread = await askedInThread("agent-flow-click", "a4".repeat(32), "conn-flow-click");
    try {
      const clicked = await thread.stub.answerQuestionFromChannel({
        questionId: thread.questionId,
        optionIndex: 1,
        externalUserId: "U-ONE",
        actionTimestamp: "1700000000.000002",
        connectionId: "conn-flow-click",
      });
      expect(clicked).toMatchObject({ outcome: "admitted", duplicate: false });
      const turnId = (clicked as { turnId: string }).turnId;
      const events = await thread.settled(turnId);
      const input = await thread.renderedInput(turnId);
      expect(input.answer).toEqual({ questionId: thread.questionId, text: "Wait", value: "wait" });
      expect(input.openQuestion).toBeUndefined();
      expect(await thread.modelText(turnId)).toBe("Wait");
      expect(events.filter((event) => event.type === "question.answered").map((event) => event.data.questionId)).toEqual([
        thread.questionId,
      ]);
      expect(events.filter((event) => event.type === "question.closed")).toEqual([]);
      expect(await thread.closedReason(thread.questionId)).toBeNull();
      expect(await thread.questionOf()).toBeNull();
      await vi.waitFor(() => expect(thread.updates().length).toBeGreaterThan(0));
      const update = thread.updates().at(-1)!;
      expect(update.body).toMatchObject({ channel: "C1", ts: thread.cardTs });
      expect(JSON.stringify(thread.blocksOf(update))).toContain("chosen: Wait · by <@U-ONE>");
      expect(JSON.stringify(thread.blocksOf(update))).not.toContain('"actions"');
    } finally {
      thread.slack.restore();
    }
  });
});

describe("model call failures", () => {
  const route = (sessionId: string, model: string, chargeUsd: number) =>
    env.SESSIONS.getByName(sessionId).recordModelRouteResolved({
      providerCallId: `call-${model}`,
      requested: { provider: "openrouter", model },
      effective: { provider: "openrouter", model },
      runtime: "claude",
      access: { type: "managed" },
      openComputerModelChargeUsd: chargeUsd,
    });

  it("logs a host-granted retry as one milestone and answers with the whole continued response", async () => {
    const sessionId = await createWorkerdSession("workerd-model-retry", "d".repeat(64));
    const turn = await postTurn(sessionId, "Keep going [model-retry 2 host]", "model-retry-1");
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
    );
    const retries = events.filter(
      (event) => event.type === "runtime.log" && event.data.phase === "model_retry",
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]!.turnId).toBe(turn.turnId);
    expect(retries[0]!.data).toEqual(
      expect.objectContaining({
        phase: "model_retry",
        runtime: "workerd",
        attempt: 2,
        errorType: "provider.transport",
        hostGranted: true,
      }),
    );
    expect(typeof retries[0]!.data.delayMs).toBe("number");
    expect(JSON.stringify(retries[0]!.data)).not.toContain("socket hang up");
    // The continuation is a new assistant message: the answer is the
    // fragment before the break and the continuation, once each.
    const completed = events.find((event) => event.type === "message.completed" && event.turnId === turn.turnId)?.data;
    expect(completed?.text).toBe("Managed OpenCode is running in the Durable Object.");
    expect(completed?.finalText).toBe("Managed OpenCode is running in the Durable Object.");
    expect(terminalEventsOf(events, turn.turnId).map((event) => event.type)).toEqual(["turn.completed"]);
  });

  it("records a model call that failed with its typed fields and one attempt", async () => {
    const sessionId = await createWorkerdSession("workerd-model-fails", "e".repeat(64));
    const turn = await postTurn(sessionId, "Keep going [model-fails provider.internal]", "model-fails-1");
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.failed" && event.turnId === turn.turnId),
    );
    const failed = events.find((event) => event.type === "turn.failed" && event.turnId === turn.turnId)!;
    expect(failed.data).toEqual({
      message: "upstream socket hang up",
      failure: {
        class: "provider",
        subtype: "internal",
        status: 502,
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        retry: { attempts: 1, hostGranted: false },
      },
    });
    expect((await snapshotOf(sessionId)).status).toBe("idle");
  });

  it("excludes a first-call quota failure and restores the session after later work", async () => {
    const sessionId = await createWorkerdSession("workerd-model-quota", "e".repeat(64));
    const failedTurn = await postTurn(
      sessionId,
      "Keep going [model-fails provider.quota]",
      "model-quota-1",
    );
    await waitForEvents(sessionId, (current) =>
      current.some(
        (event) => event.type === "turn.failed" && event.turnId === failedTurn.turnId,
      ),
    );

    const row = async () =>
      env.SERVERLESS_AGENTS_DB.prepare(
        `SELECT countable, exclusion_reason FROM session_creations WHERE session_id = ?`,
      )
        .bind(sessionId)
        .first<{ countable: number; exclusion_reason: string | null }>();
    let projected = await row();
    for (let attempt = 0; projected?.countable !== 0 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      projected = await row();
    }
    expect(projected).toEqual({
      countable: 0,
      exclusion_reason: "model_credit_exhausted",
    });

    const completedTurn = await postTurn(sessionId, "Keep going", "model-quota-2");
    await waitForEvents(sessionId, (current) =>
      current.some(
        (event) => event.type === "turn.completed" && event.turnId === completedTurn.turnId,
      ),
    );
    projected = await row();
    for (let attempt = 0; projected?.countable !== 1 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      projected = await row();
    }
    expect(projected).toEqual({ countable: 1, exclusion_reason: null });
  });

  it("counts the host-granted retry a failed model call had", async () => {
    const sessionId = await createWorkerdSession("workerd-model-fails-retried", "e".repeat(64));
    const turn = await postTurn(sessionId, "Keep going [model-retry 2 host] [model-fails provider.transport]", "model-fails-2");
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.failed" && event.turnId === turn.turnId),
    );
    const failed = events.find((event) => event.type === "turn.failed" && event.turnId === turn.turnId)!;
    expect(failed.data.failure).toEqual({
      class: "provider",
      subtype: "transport",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      retry: { attempts: 2, hostGranted: true },
    });
  });

  it("attributes a failure to the failing call's model, not to an earlier call's route", async () => {
    const sessionId = await createWorkerdSession("workerd-model-attribution", "e".repeat(64));
    // An earlier call resolved to Anthropic; the current step names Google
    // and fails before the gateway records its route.
    await route(sessionId, "anthropic/claude-sonnet-4.6", 0.01);
    const turn = await postTurn(
      sessionId,
      "Keep going [step-model google/gemini-2.5-pro] [model-fails provider.internal]",
      "model-fails-3",
    );
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.failed" && event.turnId === turn.turnId),
    );
    const failed = events.find((event) => event.type === "turn.failed" && event.turnId === turn.turnId)!;
    expect(failed.data.failure).toEqual(
      expect.objectContaining({ provider: "openrouter", model: "google/gemini-2.5-pro" }),
    );
  });

  it("records routed usage under the effective model instead of the requested alias", async () => {
    const sessionId = await createWorkerdSession("workerd-step-usage", "f".repeat(64));
    const turn = await postTurn(
      sessionId,
      "Keep going [delay-stream 100ms] [step-usage]",
      "step-usage-1",
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fakeRuntimeOf(sessionId)).calls.some((call) => call.route === "turn")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The real Workerd handler can reach the gateway before its response
    // stream delivers session.step.started back to the session object.
    await env.SESSIONS.getByName(sessionId).recordModelRouteResolved({
      providerCallId: "call-jev-router",
      requested: { provider: "openrouter", model: "typesafe/jev-router" },
      effective: {
        provider: "openrouter",
        model: "google/gemini-2.5-pro",
      },
      runtime: "claude",
      access: { type: "managed" },
      openComputerModelChargeUsd: 0.5,
    });
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
    );
    const usage = events.filter((event) => event.type === "usage.recorded" && event.turnId === turn.turnId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.data).toEqual({
      provider: "openrouter",
      model: "openrouter/google/gemini-2.5-pro",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cachedTokens: 5,
      cacheWriteTokens: 2,
      costUsd: 0.0123,
      payer: "user",
    });
    const types = events.filter((event) => event.turnId === turn.turnId).map((event) => event.type);
    expect(types.indexOf("usage.recorded")).toBeLessThan(types.indexOf("turn.completed"));
    // The accounting finds the route's charge under that key, ahead of the
    // cost the runtime reported.
    await expect(env.SESSIONS.getByName(sessionId).usageSummary()).resolves.toEqual(
      expect.objectContaining({ modelCalls: 1, modelProviderCostUsd: 0.5 }),
    );
  });
});

describe("deployment region (work 057)", () => {
  const base = "https://managedagents.test";

  async function deploy(agentId: string, digest: string, region?: unknown): Promise<Response> {
    return SELF.fetch(`${base}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        alias: "development",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: {
          bucket: "managed-agent-artifacts",
          key: `accounts/local/agents/${agentId}/artifact.json`,
          digest,
          size: 512,
        },
        ...(region === undefined ? {} : { region }),
      }),
    });
  }

  async function project(name: string): Promise<Project> {
    const created = await SELF.fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ project?: Project } & Project>();
    return body.project ?? body;
  }

  it("rejects a region the platform does not offer", async () => {
    const { agentId } = await project("Region rejected");
    const response = await deploy(agentId, "a".repeat(64), "mars");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_region" } });
  });

  it("stores the region and creates the runtime session with its location hint", async () => {
    const { agentId } = await project("Region au");
    const deployed = await deploy(agentId, "b".repeat(64), "au");
    expect(deployed.status).toBe(201);
    expect(await deployed.json()).toMatchObject({ region: "au" });

    const created = await json<InitializeSessionResult>(
      await SELF.fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${agentId}@development` }),
      }),
    );
    const runtime = await fakeRuntimeOf(created.session.id);
    expect(runtime.creation).toMatchObject({
      deployment: { region: "au" },
      locationHint: "oc",
    });
  });

  it("updates the region when only the region changes, and clears it when removed", async () => {
    const { agentId } = await project("Region change");
    const digest = "c".repeat(64);
    expect(await (await deploy(agentId, digest)).json()).not.toHaveProperty("region");
    expect(await (await deploy(agentId, digest, "au")).json()).toMatchObject({ region: "au" });
    expect(await (await deploy(agentId, digest)).json()).not.toHaveProperty("region");
  });

  it("creates the runtime session without a hint for a deployment without a region", async () => {
    const { agentId } = await project("Region none");
    expect((await deploy(agentId, "e".repeat(64))).status).toBe(201);
    const created = await json<InitializeSessionResult>(
      await SELF.fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${agentId}@development` }),
      }),
    );
    expect((await fakeRuntimeOf(created.session.id)).creation).toMatchObject({
      locationHint: null,
    });
  });
});

describe("deployment egress (work 057)", () => {
  const base = "https://managedagents.test";

  async function deploy(agentId: string, digest: string, egress?: unknown): Promise<Response> {
    return SELF.fetch(`${base}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        alias: "development",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: {
          bucket: "managed-agent-artifacts",
          key: `accounts/local/agents/${agentId}/artifact.json`,
          digest,
          size: 512,
        },
        ...(egress === undefined ? {} : { egress }),
      }),
    });
  }

  async function project(name: string): Promise<Project> {
    const created = await SELF.fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ project?: Project } & Project>();
    return body.project ?? body;
  }

  it("rejects an invalid allowlist", async () => {
    const { agentId } = await project("Egress rejected");
    const response = await deploy(agentId, "1".repeat(64), { domains: ["https://a.com"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_egress" } });
  });

  it("stores the normalized allowlist and hands it to the runtime session", async () => {
    const { agentId } = await project("Egress stored");
    const deployed = await deploy(agentId, "2".repeat(64), {
      domains: ["API.github.com", "*.acme.example"],
      cidrs: ["203.0.113.10"],
    });
    expect(deployed.status).toBe(201);
    const egress = { domains: ["*.acme.example", "api.github.com"], cidrs: ["203.0.113.10/32"] };
    expect(await deployed.json()).toMatchObject({ egress });

    const created = await json<InitializeSessionResult>(
      await SELF.fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${agentId}@development` }),
      }),
    );
    const runtime = await fakeRuntimeOf(created.session.id);
    expect(runtime.creation).toMatchObject({ deployment: { egress } });
  });

  it("updates the allowlist when only it changes, and clears it when removed", async () => {
    const { agentId } = await project("Egress change");
    const digest = "3".repeat(64);
    expect(await (await deploy(agentId, digest)).json()).not.toHaveProperty("egress");
    expect(await (await deploy(agentId, digest, { cidrs: ["10.0.0.0/8"] })).json()).toMatchObject({
      egress: { domains: [], cidrs: ["10.0.0.0/8"] },
    });
    expect(await (await deploy(agentId, digest)).json()).not.toHaveProperty("egress");
  });
});
