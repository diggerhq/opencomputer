import {
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  InitializeSessionResult,
  ProjectEnvironmentMode,
  ProjectEnvironmentName,
  SessionSnapshot,
} from "../src/protocol.js";
import { consultSessionId as innerSessionId } from "../src/consult.js";
import type { LinearActivityEnqueue, LinearConnectionStore } from "../src/edge/linear-contract.js";

const enqueued = vi.hoisted(() => [] as Array<{ activity: LinearActivityEnqueue }>);
vi.mock("../src/edge/linear-activities.js", () => ({
  LINEAR_STOPPED_TEXT: "Stopped.",
  enqueueLinearActivity: (_storage: unknown, activity: LinearActivityEnqueue) => {
    enqueued.push({ activity });
  },
  linearBinding: (_store?: LinearConnectionStore) => null,
  linearQueueDrained: () => true,
  LinearActivityQueue: class {
    onTurnEvents(): void {}
    async afterSettlement(): Promise<void> {}
    async onAlarm(): Promise<void> {}
    nextDueAtMs(): number | null {
      return null;
    }
  },
}));

beforeEach(async () => {
  enqueued.length = 0;
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

async function eventsOf(sessionId: string): Promise<AgentEvent[]> {
  return (
    await json<{ events: AgentEvent[] }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${encodeURIComponent(sessionId)}/events`),
    )
  ).events;
}

async function waitForEvents(
  sessionId: string,
  predicate: (events: AgentEvent[]) => boolean,
): Promise<AgentEvent[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const events = await eventsOf(sessionId);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for session events");
}

async function waitForTurn(sessionId: string, turnId: string, status: string): Promise<AgentEvent[]> {
  return waitForEvents(sessionId, (current) =>
    current.some((event) => event.turnId === turnId && event.type === `turn.${status}`),
  );
}

async function snapshotOf(sessionId: string): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(await SELF.fetch(`https://managedagents.test/v1/sessions/${encodeURIComponent(sessionId)}`));
}

const SIGNING_SECRET = "s".repeat(32);

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

/** Every Slack Web API call the session makes, in order. */
function captureSlack(): { calls: Array<{ url: string; body: Record<string, unknown> }>; restore: () => void } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return Response.json({ ok: true, ts: "12.3" });
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

async function postTurn(
  sessionId: string,
  input: string,
  idempotencyKey: string,
): Promise<{ turnId: string; status: string; duplicate: boolean }> {
  const response = await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, idempotencyKey }),
  });
  expect([200, 202]).toContain(response.status);
  return response.json();
}

async function registerAgentDeployment(
  agentId: string,
  digest: string,
  environment: ProjectEnvironmentName = "development",
): Promise<void> {
  await env.ACCOUNTS.getByName("local").registerDeployment({
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
  });
}

/** A project with a primary agent and a `categoriser` member, both deployed to its active scope. */
async function projectWithMember(
  slug: string,
  environmentMode: ProjectEnvironmentMode = "legacy",
): Promise<{ projectId: string; primaryAgentId: string; memberAgentId: string }> {
  const account = env.ACCOUNTS.getByName("local");
  const project = await account.createProject({ environmentMode, id: `prj_${slug}`, name: slug, slug });
  const memberAgentId = `${project.agentId}--categoriser`;
  const environment = environmentMode === "single" ? "default" : "development";
  await registerAgentDeployment(project.agentId, "a".repeat(64), environment);
  await registerAgentDeployment(memberAgentId, "b".repeat(64), environment);
  return { projectId: project.id, primaryAgentId: project.agentId, memberAgentId };
}

async function createSession(
  agentId: string,
  environment: ProjectEnvironmentName = "development",
): Promise<string> {
  const created = await json<InitializeSessionResult>(
    await SELF.fetch("https://managedagents.test/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${agentId}@${environment}` }),
    }),
  );
  expect(created.session.executionMode).toBe("workerd");
  return created.session.id;
}

/**
 * Fires the session's alarm until its newest consultation row shows `status`
 * and none remain in flight, or fails. The poll deadline is pulled to now so
 * the next alarm polls at once rather than 5s out.
 */
async function driveConsult(hostSessionId: string, status: "dispatched" | "delivered" | "failed"): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await runDurableObjectAlarm(env.SESSIONS.getByName(hostSessionId));
    const rows = await runInDurableObject(env.SESSIONS.getByName(hostSessionId), (_instance, state) =>
      state.storage.sql
        .exec<{ status: string }>("SELECT status FROM agent_consultations ORDER BY created_at, rowid")
        .toArray(),
    );
    if (
      rows.length > 0 &&
      rows[rows.length - 1]!.status === status &&
      rows.every((row) => row.status !== "pending")
    ) {
      return;
    }
    await runInDurableObject(env.SESSIONS.getByName(hostSessionId), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_consultations SET next_attempt_at_ms = 0 WHERE status = 'dispatched'",
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for consultation ${status}`);
}

describe("consult on Workerd", () => {
  it("dispatches consultation within a single-environment project's default scope", async () => {
    const { primaryAgentId, memberAgentId } = await projectWithMember("consult-default", "single");
    const sessionId = await createSession(primaryAgentId, "default");

    const consult = await postTurn(
      sessionId,
      "Check the board. [consult categoriser What are the open tickets?]",
      "t-consult-default",
    );
    await waitForTurn(sessionId, consult.turnId, "completed");
    await driveConsult(sessionId, "dispatched");

    const memberSnapshot = await snapshotOf(innerSessionId(sessionId, memberAgentId));
    expect(memberSnapshot.agentId).toBe(memberAgentId);
    expect(memberSnapshot.environment).toBe("default");
  });

  it("dispatches the consult's question to the member agent's inner session and admits its answer", async () => {
    const { primaryAgentId, memberAgentId } = await projectWithMember("consult-happy");
    const sessionId = await createSession(primaryAgentId);

    const consult = await postTurn(sessionId, "Check the board. [consult categoriser What are the open tickets?]", "t-consult-1");
    const events = await waitForTurn(sessionId, consult.turnId, "completed");

    // The asking turn settles with outcome question, and the consultation
    // commits with it (question + agent.consult.requested before turn.completed).
    const ofTurn = events.filter((event) => event.turnId === consult.turnId).map((event) => event.type);
    expect(ofTurn.slice(ofTurn.indexOf("message.completed"))).toEqual([
      "message.completed",
      "question.asked",
      "agent.consult.requested",
      "turn.completed",
    ]);
    const snapshot = await snapshotOf(sessionId);
    expect(snapshot.question).not.toBeNull();
    const questionId = snapshot.question!.id;

    // The drive dispatches to the deterministic inner session.
    await driveConsult(sessionId, "dispatched");
    const memberSessionId = innerSessionId(sessionId, memberAgentId);
    const memberSnapshot = await snapshotOf(memberSessionId);
    expect(memberSnapshot.agentId).toBe(memberAgentId);
    expect(memberSnapshot.labels).toMatchObject({ kind: "consult", host: sessionId });

    // The member's sandbox context mounts the host session's workspace.
    const memberRuntimeId = await runInDurableObject(
      env.SESSIONS.getByName(memberSessionId),
      (_instance, state) =>
        state.storage.sql
          .exec<{ runtime_session_id: string }>(
            "SELECT runtime_session_id FROM workerd_session WHERE slot = 1",
          )
          .one().runtime_session_id,
    );
    const memberCalls = await json<{
      creation: { sandboxContext?: { sharedWorkspaceSessionId?: string }; sharedWorkspaceSessionId?: string } | null;
    }>(
      await (env as unknown as { WORKERD_RUNTIME: Fetcher }).WORKERD_RUNTIME.fetch(
        `https://workerd-runtime.invalid/sessions/${encodeURIComponent(memberRuntimeId)}/calls`,
      ),
    );
    // /sessions nests it under sandboxContext; the pooled /sandbox-context
    // claim path posts it flat.
    expect(
      memberCalls.creation?.sandboxContext?.sharedWorkspaceSessionId ??
        memberCalls.creation?.sharedWorkspaceSessionId,
    ).toBe(sessionId);

    // The member's turn completes with the fake runtime's canned answer.
    const memberEvents = await waitForEvents(memberSessionId, (current) =>
      current.some((event) => event.type === "turn.completed"),
    );
    const memberTurn = memberEvents.find((event) => event.type === "turn.completed")!;

    // The next alarm polls, settles the member outcome and admits the answer.
    await driveConsult(sessionId, "delivered");
    const hostEvents = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "agent.consult.answered"),
    );
    const answered = hostEvents.find((event) => event.type === "agent.consult.answered")!;
    expect(answered.data).toMatchObject({
      questionId,
      memberAgentId,
      memberSessionId,
      memberTurnId: memberTurn.turnId,
      outcome: "completed",
    });

    // The question is answered and the answering turn runs to completion.
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "question.answered") &&
      current.filter((event) => event.type === "turn.completed").length >= 2,
    );
    expect((await snapshotOf(sessionId)).question).toBeNull();

    // The answering turn's input is the member's answer.
    const answerTurn = (await snapshotOf(sessionId)).turns.find(
      (turn) => turn.id !== consult.turnId && turn.status === "completed",
    )!;
    expect(answerTurn.input).toContain(memberAgentId);
    expect(answerTurn.input).toContain("answered:");
    expect(answerTurn.input).toContain("running in the Durable Object.");
  });

  it("continues the same inner session on a second consult of the same member", async () => {
    const { primaryAgentId, memberAgentId } = await projectWithMember("consult-again");
    const sessionId = await createSession(primaryAgentId);

    const first = await postTurn(sessionId, "[consult categoriser First]", "t-c1");
    await waitForTurn(sessionId, first.turnId, "completed");
    await driveConsult(sessionId, "delivered");
    await waitForEvents(sessionId, (current) => current.some((event) => event.type === "question.answered"));

    const second = await postTurn(sessionId, "[consult categoriser Second]", "t-c2");
    await waitForTurn(sessionId, second.turnId, "completed");
    await driveConsult(sessionId, "delivered");

    const memberSessionId = innerSessionId(sessionId, memberAgentId);
    const member = await snapshotOf(memberSessionId);
    // One inner session, two consult turns.
    expect(member.turns.filter((turn) => turn.status === "completed").length).toBeGreaterThanOrEqual(2);
    const host = await eventsOf(sessionId);
    expect(host.filter((event) => event.type === "agent.consult.answered").length).toBe(2);
  });

  it("points the thread's status line at the member while the consult is in flight", { timeout: 30_000 }, async () => {
    const { primaryAgentId } = await projectWithMember("consult-announce");
    const sessionId = await createSession(primaryAgentId);
    await slackConnection("conn-consult", primaryAgentId);

    const slack = captureSlack();
    try {
      const stub = env.SESSIONS.getByName(sessionId);
      const asking = await stub.enqueueChannelTurn(
        {
          input: "[consult categoriser What are the open tickets?]",
          agentInput: { source: "channel", text: "[consult categoriser What are the open tickets?]" },
          idempotencyKey: "slack:consult-announce",
        },
        {
          provider: "slack",
          connectionId: "conn-consult",
          externalUserId: "U-CONSULT",
          deliveryRef: { channelId: "C-CONSULT", threadTimestamp: "3.3" },
        },
      );
      await waitForTurn(sessionId, asking.turnId, "completed");
      await driveConsult(sessionId, "dispatched");
      await vi.waitFor(
        () => {
          const statuses = slack.calls.filter((call) => call.url.includes("assistant.threads.setStatus"));
          expect(
            statuses.some((call) => JSON.stringify(call.body).includes("Consulting categoriser")),
          ).toBe(true);
        },
        { timeout: 15_000 },
      );
    } finally {
      slack.restore();
    }
  });

  it("answers the question with the failure when no member deployment exists", async () => {
    const { primaryAgentId } = await projectWithMember("consult-missing");
    const sessionId = await createSession(primaryAgentId);

    const consult = await postTurn(sessionId, "[consult ghost Ping]", "t-ghost");
    await waitForTurn(sessionId, consult.turnId, "completed");
    await driveConsult(sessionId, "failed");

    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "agent.consult.failed"),
    );
    const failed = events.find((event) => event.type === "agent.consult.failed")!;
    expect(String(failed.data.error)).toContain("ghost");

    // The failure is admitted as the answer: the question resolves and the
    // coordinator's next turn runs.
    await waitForEvents(sessionId, (current) => current.some((event) => event.type === "question.answered"));
    expect((await snapshotOf(sessionId)).question).toBeNull();
  });

  it("answers the question with the failure when the session belongs to no project", async () => {
    await registerAgentDeployment("solo-agent", "c".repeat(64));
    const sessionId = await createSession("solo-agent");

    const consult = await postTurn(sessionId, "[consult anyone Hello]", "t-solo");
    await waitForTurn(sessionId, consult.turnId, "completed");
    await driveConsult(sessionId, "failed");

    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "agent.consult.failed"),
    );
    expect(events.find((event) => event.type === "agent.consult.failed")).toBeTruthy();
    expect((await snapshotOf(sessionId)).question).toBeNull();
  });
});
