// Shared helpers for the managed-session-workerd*.test.ts files.

import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { expect } from "vitest";

import type {
  AgentEvent,
  InitializeSessionResult,
  Project,
  SessionSnapshot,
  SessionSummary,
} from "../src/protocol.js";
import { hostToolCallId } from "../src/tool-identity.js";

export async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return response.json<T>();
}

export async function waitForEvents(
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

export const notesDeclaration = {
  id: "notes",
  description: "Notes.",
  provider: { kind: "document" as const, maxBytes: 1_024 },
};

export async function createWorkerdSession(
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
export const runtimeTokens = new Map<string, string>();

/** The fake runtime's record of one managed session's runtime session: calls in order and the live execution. */
export async function fakeRuntimeOf(sessionId: string): Promise<{
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

export async function pendingStopOf(sessionId: string): Promise<
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
export async function elapseStopBudget(sessionId: string): Promise<void> {
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

export function terminalEventsOf(events: AgentEvent[], turnId: string): AgentEvent[] {
  return events.filter(
    (event) =>
      event.turnId === turnId &&
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type),
  );
}

export async function postTurn(
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
export async function projectedRow(sessionId: string, revision: number): Promise<SessionSummary> {
  const account = env.ACCOUNTS.getByName("local");
  for (let attempt = 0; attempt < 500; attempt++) {
    const held = await account.getSession(sessionId);
    if (held && held.revision >= revision) return held;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Session ${sessionId} never reached revision ${String(revision)} in the projection`);
}

export async function snapshotOf(sessionId: string): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(
    await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}`),
  );
}

/**
 * A recorded log with every volatile value replaced, so the same turn
 * recorded twice is the same fixture: ids and timestamps, render ids,
 * millisecond measurements and the runtime's timing text.
 */
export function normalizeRecordedEvent(event: AgentEvent): Record<string, unknown> {
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

export const TOOL_EVENT_KEYS = new Set(["callId", "tool", "title", "input", "output", "message", "result", "settledBy", "identity"]);

/** The host identity the session stamps on a Workerd tool call's events; the fake runtime emits every call under `msg-1`. */
export function workerdToolIdentity(agentId: string, digest: string, sessionId: string, turnId: string, callId: string) {
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
export const NATIVE_TOOL_KEYS = ["id", "name", "content", "assistantMessageID", "sessionID", "error", "metadata", "executed"];
