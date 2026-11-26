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
  EventSubscription,
  InitializeSessionResult,
  SessionSnapshot,
  TurnOutcomeDelivery,
} from "../src/protocol.js";
import { STEERING_ITEM_LIMIT, STEERING_SIZE_LIMIT } from "../src/protocol.js";
import { questionIdFor } from "../src/ask.js";
import { commitConsultation } from "../src/edge/consultations.js";
import { slackTimestampIso } from "../src/channels/slack-adapter.js";
import type { LinearActivityEnqueue, LinearConnectionStore } from "../src/edge/linear-contract.js";
import { linearConnectionPrincipal, unavailableLinearConnectionStore } from "../src/edge/linear-contract.js";

// What the Session object hands the Linear activity queue (stream S3's
// file, a no-op on this branch), recorded per call.
const enqueued = vi.hoisted(() => [] as Array<{ activity: LinearActivityEnqueue }>);
// Only the enqueue is observed. The Session object also holds S3's queue;
// here it is an inert stub (no importOriginal: loading the real module from
// inside the mock deadlocks the Workers pool on the import cycle).
vi.mock("../src/edge/linear-activities.js", () => ({
  LINEAR_STOPPED_TEXT: "Stopped.",
  enqueueLinearActivity: (_storage: unknown, activity: LinearActivityEnqueue) => {
    enqueued.push({ activity });
  },
  linearBinding: () => null,
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
  const deadline = Date.now() + 10_000;
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

async function createWorkerdSession(
  agentId: string,
  digest: string,
  connections: string[] = [],
): Promise<string> {
  await env.ACCOUNTS.getByName("local").registerDeployment({
    agentId,
    accountId: "local",
    alias: "development",
    runtimeMode: "workerd-lazy-sandbox",
    channels: [],
    connections,
    artifact: {
      bucket: "managed-agent-artifacts",
      key: `accounts/local/agents/${agentId}/artifact.json`,
      digest,
      size: 512,
    },
    imageArn: "test-image",
    imageVersion: "1",
  });
  const created = await json<InitializeSessionResult>(
    await SELF.fetch("https://managedagents.test/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${agentId}@development` }),
    }),
  );
  expect(created.session.executionMode).toBe("workerd");
  runtimeTokens.set(created.session.id, created.runtimeToken);
  return created.session.id;
}

const runtimeTokens = new Map<string, string>();

async function postTurn(
  sessionId: string,
  input: string,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, idempotencyKey, ...extra }),
  });
}

async function admitted(response: Response): Promise<{ turnId: string; status: string; duplicate: boolean }> {
  expect([200, 202]).toContain(response.status);
  return response.json();
}

async function snapshotOf(sessionId: string): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}`));
}

/** Starts a session, runs one turn that asks, and returns the question id. */
async function askedSession(
  agentId: string,
  digest: string,
  directive = "[ask call-ask]",
): Promise<{ sessionId: string; turnId: string; questionId: string }> {
  const sessionId = await createWorkerdSession(agentId, digest);
  const turn = await admitted(await postTurn(sessionId, `Plan the change. ${directive}`, "ask-1"));
  await waitForTurn(sessionId, turn.turnId, "completed");
  const questionId = (await snapshotOf(sessionId)).question!.id;
  return { sessionId, turnId: turn.turnId, questionId };
}

async function renderedInput(sessionId: string, turnId: string): Promise<Record<string, unknown>> {
  const events = await waitForEvents(sessionId, (current) =>
    current.some((event) => event.turnId === turnId && event.type === "agent.rendered"),
  );
  const rendered = events.find((event) => event.turnId === turnId && event.type === "agent.rendered")!;
  return (rendered.data as { input: Record<string, unknown> }).input;
}

/** The text the model was given for a turn, as the fake runtime received it. */
async function modelTextOf(sessionId: string, turnId: string): Promise<string> {
  const runtimeSessionId = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
    state.storage.sql
      .exec<{ runtime_session_id: string }>("SELECT runtime_session_id FROM workerd_session WHERE slot = 1")
      .one().runtime_session_id,
  );
  const runtime = (env as unknown as { WORKERD_RUNTIME: Fetcher }).WORKERD_RUNTIME;
  const { calls } = await json<{ calls: Array<{ route: string; turnId: string | null; text?: string }> }>(
    await runtime.fetch(`https://workerd-runtime.invalid/sessions/${encodeURIComponent(runtimeSessionId)}/calls`),
  );
  return calls.find((call) => call.route === "turn" && call.turnId === turnId)!.text ?? "";
}

/** Admits a Linear-shaped input with a provider time, as the ingress does. */
function linearEnqueue(sessionId: string) {
  const session = env.SESSIONS.getByName(sessionId);
  return (key: string, text: string, providerTime: string) =>
    session.enqueueTurn({
      input: text,
      idempotencyKey: key,
      providerTime,
      agentInput: { source: "channel", text, channel: { provider: "linear", connectionId: "conn-1" } },
    });
}

type QuestionHost = {
  questionElicitationInTransaction(
    questionId: string,
    outcome: { kind: "posted"; providerTime: string } | { kind: "undeliverable" },
  ): AgentEvent[];
  broadcastEvents(events: AgentEvent[]): void;
  dispatchNextTurn(): void;
};

/**
 * What the Linear activity queue does when an elicitation settles (its queue
 * is stubbed here): the Session object's hook inside a transaction, then the
 * broadcast and a dispatch. Returns the events the hook appended.
 */
async function elicitationSettled(
  sessionId: string,
  questionId: string,
  outcome: { kind: "posted"; providerTime: string } | { kind: "undeliverable" },
): Promise<AgentEvent[]> {
  return runInDurableObject(env.SESSIONS.getByName(sessionId), (instance, state) => {
    const host = instance as unknown as QuestionHost;
    const events = state.storage.transactionSync(() => host.questionElicitationInTransaction(questionId, outcome));
    host.broadcastEvents(events);
    if (events.length) host.dispatchNextTurn();
    return events;
  });
}

const elicitationPosted = (sessionId: string, questionId: string, providerTime: string) =>
  elicitationSettled(sessionId, questionId, { kind: "posted", providerTime });
const elicitationUndeliverable = (sessionId: string, questionId: string) =>
  elicitationSettled(sessionId, questionId, { kind: "undeliverable" });

describe("ask on Workerd", () => {
  it("settles the asking turn completed with outcome question, in one transaction with the question and its events", async () => {
    const sessionId = await createWorkerdSession("ask-settles", "a".repeat(64));
    const turn = await admitted(await postTurn(sessionId, "Plan the change. [ask call-ask]", "ask-1"));
    const events = await waitForTurn(sessionId, turn.turnId, "completed");
    const questionId = await questionIdFor(turn.turnId, "call-ask");

    const ofTurn = events.filter((event) => event.turnId === turn.turnId).map((event) => event.type);
    // The question is committed before the terminal event, with no failure.
    expect(ofTurn.slice(ofTurn.indexOf("message.completed"))).toEqual([
      "message.completed",
      "question.asked",
      "turn.completed",
    ]);
    expect(ofTurn).not.toContain("turn.failed");
    const asked = events.find((event) => event.type === "question.asked")!;
    expect(asked.data).toEqual({
      questionId,
      text: "Which approach?",
      options: [
        { label: "Go", value: "go" },
        { label: "Wait", value: "wait" },
      ],
    });
    const completed = events.find((event) => event.type === "turn.completed")!;
    expect(completed.data).toEqual({ outcome: "question", questionId });
    // The ask call itself completed as an ordinary tool call.
    expect(
      events.some((event) => event.type === "tool.completed" && (event.data as { callId?: string }).callId === "call-ask"),
    ).toBe(true);

    const snapshot = await snapshotOf(sessionId);
    expect(snapshot.question).toEqual({
      id: questionId,
      text: "Which approach?",
      options: [
        { label: "Go", value: "go" },
        { label: "Wait", value: "wait" },
      ],
      askedAt: completed.timestamp,
    });
    expect(snapshot.turns[0]).toMatchObject({ id: turn.turnId, status: "completed", outcome: "question" });
    // A question is not a result.
    expect(snapshot.result).toBeNull();
    expect(snapshot.status).toBe("idle");

    // The elicitation was handed to the activity queue with its options.
    expect(enqueued.map((entry) => entry.activity)).toEqual([
      {
        kind: "terminal",
        content: { type: "elicitation", body: "Which approach?" },
        turnId: turn.turnId,
        questionId,
        signal: "select",
        signalMetadata: {
          options: [
            { label: "Go", value: "go" },
            { label: "Wait", value: "wait" },
          ],
        },
      },
    ]);

    // The list projection reads the asking turn as an ordinary completed turn.
    let row: { activity: { lastSettledTurn: { id: string; status: string } | null } } | null = null;
    for (let attempt = 0; attempt < 500; attempt++) {
      row = await env.ACCOUNTS.getByName("local").getSession(sessionId);
      if (row && row.activity.lastSettledTurn?.id === turn.turnId) break;
      await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(row?.activity.lastSettledTurn).toMatchObject({ id: turn.turnId, status: "completed" });
  });

  it("settles the asking turn only after every operation it dispatched has settled, then commits the question and elicitation", async () => {
    const sessionId = await createWorkerdSession("ask-ops", "ac".repeat(32));
    const turn = await admitted(await postTurn(sessionId, "Plan. [ops 2] [hold-settlement 1500ms] [ask call-ops]", "ask-ops"));
    // The host interrupted the loop after `ask`, with two operations still
    // in flight: the turn waits on the same durable stop a stop uses.
    const waiting = await waitForEvents(sessionId, (current) =>
      current.some(
        (event) =>
          event.type === "runtime.log" &&
          event.data.phase === "workerd_interrupt" &&
          event.data.acknowledged === false,
      ),
    );
    expect(waiting.find((event) => event.type === "runtime.log" && event.data.phase === "workerd_stop_requested")).toMatchObject({
      turnId: turn.turnId,
      data: { reason: "asked" },
    });
    expect(waiting.find((event) => event.data.acknowledged === false)?.data).toMatchObject({
      reason: "asked",
      pendingOperations: [`${turn.turnId}-op-1`, `${turn.turnId}-op-2`],
    });
    const meanwhile = await snapshotOf(sessionId);
    expect(meanwhile.turns[0]).toMatchObject({ id: turn.turnId, status: "running" });
    // Nobody stopped it: the session is not shown stopping.
    expect(meanwhile.status).toBe("running");
    expect(meanwhile.question).toBeNull();
    expect(waiting.some((event) => event.type === "question.asked")).toBe(false);
    expect(enqueued).toEqual([]);

    // A turn admitted meanwhile is queued, and held once the question exists.
    const queued = await admitted(await postTurn(sessionId, "Written meanwhile.", "ask-ops-queued"));
    expect(queued.status).toBe("queued");

    const events = await waitForTurn(sessionId, turn.turnId, "completed");
    const questionId = await questionIdFor(turn.turnId, "call-ops");
    const order = events
      .filter(
        (event) =>
          (event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === true) ||
          event.type === "question.asked" ||
          (event.type === "turn.completed" && event.turnId === turn.turnId),
      )
      .map((event) => event.type);
    expect(order).toEqual(["runtime.log", "question.asked", "turn.completed"]);
    expect(events.find((event) => event.type === "runtime.log" && event.data.acknowledged === true)?.data).toMatchObject({
      reason: "asked",
      operations: { total: 2, settled: 2 },
      computerTerminated: false,
    });
    expect(events.find((event) => event.type === "turn.completed" && event.turnId === turn.turnId)!.data).toEqual({
      outcome: "question",
      questionId,
    });
    expect(events.find((event) => event.turnId === queued.turnId && event.type === "turn.cancelled")!.data).toEqual({
      reason: "held",
      questionId,
    });
    expect(enqueued.map((entry) => entry.activity)).toEqual([
      expect.objectContaining({ kind: "terminal", content: { type: "elicitation", body: "Which approach?" }, questionId }),
    ]);
    const settled = await snapshotOf(sessionId);
    expect(settled.status).toBe("idle");
    expect(settled.question?.id).toBe(questionId);
    const pending = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql.exec("SELECT 1 FROM workerd_pending_stop").toArray(),
    );
    expect(pending).toEqual([]);
  });

  it("cancels an asking turn that is stopped before its operations settle, and asks nothing", async () => {
    const sessionId = await createWorkerdSession("ask-ops-stopped", "ad".repeat(32));
    const turn = await admitted(await postTurn(sessionId, "Plan. [ops 1] [hold-settlement 1500ms] [ask call-stop]", "ask-stop"));
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false),
    );
    const result = await env.SESSIONS.getByName(sessionId).applyControl({
      deliveryId: "delivery-stop-ask",
      kind: "stop",
      providerTime: "2026-10-02T10:00:00.000Z",
    });
    expect(result).toMatchObject({ interruptedTurnId: turn.turnId, duplicate: false });
    const events = await waitForTurn(sessionId, turn.turnId, "cancelled");
    expect(events.find((event) => event.turnId === turn.turnId && event.type === "turn.cancelled")!.data).toMatchObject({
      reason: "stopped",
    });
    expect(events.some((event) => event.type === "question.asked" || event.type === "turn.completed")).toBe(false);
    expect((await snapshotOf(sessionId)).question).toBeNull();
    expect(enqueued.some((entry) => entry.activity.content.type === "elicitation")).toBe(false);
  });

  it("omits signal and options for a question without options; question is null on sessions that never asked (item 8)", async () => {
    const plain = await createWorkerdSession("ask-plain", "b".repeat(64));
    const never = await snapshotOf(plain);
    expect(never).toHaveProperty("question");
    expect(never.question).toBeNull();
    const turn = await admitted(await postTurn(plain, "Plan. [ask-plain call-plain]", "plain-1"));
    await waitForTurn(plain, turn.turnId, "completed");
    expect((await snapshotOf(plain)).question).toMatchObject({ text: "Which approach?", options: [] });
    expect(enqueued[0]!.activity).toEqual({
      kind: "terminal",
      content: { type: "elicitation", body: "Which approach?" },
      turnId: turn.turnId,
      questionId: await questionIdFor(turn.turnId, "call-plain"),
    });
  });

  it("records the context an ask gives on the question, question.asked and the snapshot; Linear's elicitation stays the question alone", async () => {
    const sessionId = await createWorkerdSession("ask-context", "ae".repeat(32));
    const turn = await admitted(
      await postTurn(sessionId, "Plan. [ask-context Two callers read the token: api.ts and cli.ts.] [ask call-ctx]", "ctx-1"),
    );
    const events = await waitForTurn(sessionId, turn.turnId, "completed");
    const questionId = await questionIdFor(turn.turnId, "call-ctx");
    const context = "Two callers read the token: api.ts and cli.ts.";
    expect(events.find((event) => event.type === "question.asked")!.data).toEqual({
      questionId,
      text: "Which approach?",
      options: [
        { label: "Go", value: "go" },
        { label: "Wait", value: "wait" },
      ],
      context,
    });
    expect((await snapshotOf(sessionId)).question).toMatchObject({ id: questionId, text: "Which approach?", context });
    const row = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql.exec<{ context: string | null }>("SELECT context FROM questions WHERE id = ?", questionId).one(),
    );
    expect(row.context).toBe(context);
    // Linear (design 018) shows the question as its elicitation body, as before.
    expect(enqueued.map((entry) => entry.activity.content)).toEqual([
      { type: "elicitation", body: "Which approach?" },
    ]);
  });

  it("derives the question id from turn and call, so a replayed call names the same question and asks once", async () => {
    expect(await questionIdFor("turn-1", "call-1")).toBe(await questionIdFor("turn-1", "call-1"));
    expect(await questionIdFor("turn-1", "call-1")).not.toBe(await questionIdFor("turn-1", "call-2"));
    expect(await questionIdFor("turn-1", "call-1")).not.toBe(await questionIdFor("turn-2", "call-1"));

    const { sessionId, turnId, questionId } = await askedSession("ask-replay", "c".repeat(64));
    const { commitQuestion } = await import("../src/edge/questions.js");
    const replay = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      commitQuestion(
        state.storage.sql,
        { id: questionId, turnId, toolCallId: "call-ask", text: "Which approach?", options: [], askedAt: new Date().toISOString() },
        () => {
          throw new Error("a replayed question appends nothing");
        },
      ),
    );
    expect(replay).toEqual({ events: [], committed: false });
    const rows = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql.exec("SELECT id FROM questions").toArray(),
    );
    expect(rows).toEqual([{ id: questionId }]);
  });
});

describe("answers and held inputs", () => {
  it("refuses an answer to a question that is not open as 409 question_stale", async () => {
    const { sessionId, questionId } = await askedSession("ask-stale", "d".repeat(64));
    const stale = await postTurn(sessionId, "go", "answer-stale", { answers: "question_other" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "question_stale" } });
    // A session with no open question refuses any `answers` the same way.
    const fresh = await createWorkerdSession("ask-stale-fresh", "e".repeat(64));
    const none = await postTurn(fresh, "go", "answer-none", { answers: questionId });
    expect(none.status).toBe(409);
    const malformed = await postTurn(fresh, "go", "answer-bad", { answers: 42 });
    expect(malformed.status).toBe(400);
  });

  it("admits the answer with the option value matched by value or label, and replays to the original receipt", async () => {
    const { sessionId, questionId } = await askedSession("ask-answer", "f".repeat(64));
    const answer = await admitted(await postTurn(sessionId, "  GO ", "answer-1", { answers: questionId }));
    expect(answer.status).toBe("queued");
    await waitForTurn(sessionId, answer.turnId, "completed");
    const input = await renderedInput(sessionId, answer.turnId);
    expect(input.answer).toEqual({ questionId, text: "  GO ", value: "go" });
    expect(input.steering).toBeUndefined();
    const events = await eventsOf(sessionId);
    expect(events.find((event) => event.type === "question.answered")).toMatchObject({
      turnId: answer.turnId,
      data: { questionId, answer: { questionId, text: "  GO ", value: "go" } },
    });
    expect((await snapshotOf(sessionId)).question).toBeNull();

    const replay = await postTurn(sessionId, "  GO ", "answer-1", { answers: questionId });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ turnId: answer.turnId, status: "completed", duplicate: true });

    // By label, on the next question.
    const second = await admitted(await postTurn(sessionId, "Again. [ask call-2]", "ask-2"));
    await waitForTurn(sessionId, second.turnId, "completed");
    const next = (await snapshotOf(sessionId)).question!.id;
    const byLabel = await admitted(await postTurn(sessionId, "wait", "answer-2", { answers: next }));
    await waitForTurn(sessionId, byLabel.turnId, "completed");
    expect((await renderedInput(sessionId, byLabel.turnId)).answer).toEqual({ questionId: next, text: "wait", value: "wait" });
    const free = await admitted(await postTurn(sessionId, "Again. [ask call-3]", "ask-3"));
    await waitForTurn(sessionId, free.turnId, "completed");
    const third = (await snapshotOf(sessionId)).question!.id;
    const freeText = await admitted(await postTurn(sessionId, "something else", "answer-3", { answers: third }));
    await waitForTurn(sessionId, freeText.turnId, "completed");
    expect((await renderedInput(sessionId, freeText.turnId)).answer).toEqual({ questionId: third, text: "something else" });
  });

  it("holds inputs while the question is open and delivers them with the answer, in arrival order", async () => {
    const { sessionId, questionId } = await askedSession("ask-held", "1".repeat(64));
    const first = await postTurn(sessionId, "Use the staging database.", "held-1");
    expect(first.status).toBe(202);
    const firstReceipt = await first.json<{ heldId: string }>();
    expect(firstReceipt).toEqual({ status: "held", questionId, heldId: expect.stringMatching(/^held_/), duplicate: false });
    const second = await postTurn(sessionId, "And keep the API stable.", "held-2");
    expect(await second.json()).toEqual({ status: "held", questionId, heldId: expect.any(String), duplicate: false });
    // No turn ran for them.
    expect((await snapshotOf(sessionId)).turns).toHaveLength(1);
    const repeat = await postTurn(sessionId, "Use the staging database.", "held-1");
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ status: "held", questionId, heldId: firstReceipt.heldId, duplicate: true });
    const conflict = await postTurn(sessionId, "Something else.", "held-1");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

    const answer = await admitted(await postTurn(sessionId, "go", "answer-1", { answers: questionId }));
    await waitForTurn(sessionId, answer.turnId, "completed");
    const input = await renderedInput(sessionId, answer.turnId);
    expect(input.answer).toEqual({ questionId, text: "go", value: "go" });
    expect((input.steering as Array<{ text: string }>).map((held) => held.text)).toEqual([
      "Use the staging database.",
      "And keep the API stable.",
    ]);
    // A held key replayed after the answer names the turn that carried it.
    const afterwards = await postTurn(sessionId, "Use the staging database.", "held-1");
    expect(await afterwards.json()).toEqual({ turnId: answer.turnId, status: "completed", duplicate: true });
  });

  it("turns queued behind the asking turn wait as steering instead of running", async () => {
    const sessionId = await createWorkerdSession("ask-queued", "2".repeat(64));
    const asking = await admitted(await postTurn(sessionId, "Plan. [stall 300ms] [ask call-q]", "ask-q"));
    await waitForEvents(sessionId, (events) =>
      events.some((event) => event.turnId === asking.turnId && event.type === "turn.started"),
    );
    const queued = await admitted(await postTurn(sessionId, "Written while it worked.", "queued-1"));
    expect(queued.status).toBe("queued");
    // A channel message queued the same way: its reply is owed nothing.
    const channel = await env.SESSIONS.getByName(sessionId).enqueueChannelTurn(
      { input: "From the thread.", agentInput: { source: "channel", text: "From the thread." }, idempotencyKey: "slack:queued-2" },
      {
        provider: "slack",
        connectionId: "conn-held",
        externalUserId: "U-HELD",
        deliveryRef: { channelId: "C-HELD", threadTimestamp: "1.1" },
      },
    );
    expect(channel).toMatchObject({ status: "queued" });
    const channelTurnId = (channel as { turnId: string }).turnId;
    await waitForTurn(sessionId, asking.turnId, "completed");
    const events = await waitForTurn(sessionId, queued.turnId, "cancelled");
    const snapshot = await snapshotOf(sessionId);
    const questionId = snapshot.question!.id;
    expect(events.find((event) => event.turnId === queued.turnId && event.type === "turn.cancelled")!.data).toEqual({
      reason: "held",
      questionId,
    });
    // Converted into held inputs: one `message.held` each, naming the turn.
    expect(
      events.filter((event) => event.type === "message.held").map((event) => [event.data.turnId, event.data.input]),
    ).toEqual([
      [queued.turnId, "Written while it worked."],
      [channelTurnId, "From the thread."],
    ]);
    // The public turn record says where its text went.
    expect(snapshot.turns.map((turn) => [turn.id, turn.status, turn.reason, turn.questionId])).toEqual([
      [asking.turnId, "completed", undefined, undefined],
      [queued.turnId, "cancelled", "held", questionId],
      [channelTurnId, "cancelled", "held", questionId],
    ]);
    // No outcome is recorded for a held turn, and no channel reply is sent:
    // the reply row is settled without an attempt, and an alarm leaves it.
    expect(snapshot.turns[1]!.deliveries).toBeUndefined();
    await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
    const reply = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM slack_deliveries WHERE turn_id = ?",
          channelTurnId,
        )
        .one(),
    );
    expect(reply).toEqual({ status: "delivered", attempts: 0 });
    // The list row's last settled turn is the one that asked, not a held one.
    let row: { activity: { lastSettledTurn: { id: string; status: string } | null } } | null = null;
    for (let attempt = 0; attempt < 500; attempt++) {
      row = await env.ACCOUNTS.getByName("local").getSession(sessionId);
      if (row && row.activity.lastSettledTurn?.id === asking.turnId) break;
      await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(row?.activity.lastSettledTurn).toMatchObject({ id: asking.turnId, status: "completed" });
    expect(await (await postTurn(sessionId, "Written while it worked.", "queued-1")).json()).toEqual({
      status: "held",
      questionId,
      heldId: expect.any(String),
      duplicate: true,
    });
    const answer = await admitted(await postTurn(sessionId, "go", "answer-q", { answers: questionId }));
    await waitForTurn(sessionId, answer.turnId, "completed");
    expect(((await renderedInput(sessionId, answer.turnId)).steering as Array<{ text: string }>).map((held) => held.text)).toEqual([
      "Written while it worked.",
      "From the thread.",
    ]);
  });

  it("admits an internally-answered turn with the asking turn's channel delivery", async () => {
    const sessionId = await createWorkerdSession("ask-channel-answer", "fa".repeat(32));
    const stub = env.SESSIONS.getByName(sessionId);
    const asking = await stub.enqueueChannelTurn(
      {
        input: "Plan. [ask call-q]",
        agentInput: { source: "channel", text: "Plan. [ask call-q]" },
        idempotencyKey: "slack:ask-1",
      },
      {
        provider: "slack",
        connectionId: "conn-ask",
        externalUserId: "U-ASK",
        deliveryRef: { channelId: "C-ASK", threadTimestamp: "9.9" },
      },
    );
    const askingTurnId = (asking as { turnId: string }).turnId;
    await waitForTurn(sessionId, askingTurnId, "completed");
    const questionId = (await snapshotOf(sessionId)).question!.id;
    // The answer arrives without a channel of its own — an API call, a
    // consult answer: it still replies in the thread the question came
    // from.
    const answer = await admitted(await postTurn(sessionId, "go", "answer-1", { answers: questionId }));
    await waitForTurn(sessionId, answer.turnId, "completed");
    const delivery = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          channel_id: string;
          thread_timestamp: string;
          provider: string;
          connected_account_id: string;
          delivery_ref: string;
        }>(
          "SELECT channel_id, thread_timestamp, provider, connected_account_id, delivery_ref FROM slack_deliveries WHERE turn_id = ?",
          answer.turnId,
        )
        .one(),
    );
    expect(delivery).toMatchObject({
      channel_id: "C-ASK",
      thread_timestamp: "9.9",
      provider: "slack",
      connected_account_id: "conn-ask",
    });
    expect(JSON.parse(delivery.delivery_ref)).toEqual({ channelId: "C-ASK", threadTimestamp: "9.9" });
  });

  it("decides answer versus steering by provider time, never by arrival", async () => {
    const { sessionId, questionId } = await askedSession("ask-provider-time", "3".repeat(64));
    const askedAt = Date.parse((await snapshotOf(sessionId)).question!.askedAt);
    const at = (ms: number) => new Date(askedAt + ms).toISOString();
    const enqueue = linearEnqueue(sessionId);
    // Written before the question was asked: held.
    expect(await enqueue("linear:d1", "typed early", at(-10_000))).toEqual({
      status: "held",
      questionId,
      heldId: expect.any(String),
      duplicate: false,
    });
    // Linear's time for the elicitation is later than ours here.
    expect(await elicitationPosted(sessionId, questionId, at(5_000))).toEqual([]);
    // Written before the elicitation: steering, whatever its arrival.
    expect(await enqueue("linear:d2", "constraint", at(4_000))).toMatchObject({ status: "held" });
    // Written after it: the answer.
    const answer = await enqueue("linear:d3", "Wait", at(9_000));
    expect(answer).toMatchObject({ status: "queued", duplicate: false });
    const turnId = (answer as { turnId: string }).turnId;
    await waitForTurn(sessionId, turnId, "completed");
    const input = await renderedInput(sessionId, turnId);
    expect(input.answer).toEqual({ questionId, text: "Wait", value: "wait" });
    expect(input.steering).toEqual([
      expect.objectContaining({ text: "typed early", providerTime: at(-10_000) }),
      expect.objectContaining({ text: "constraint", providerTime: at(4_000) }),
    ]);
    expect((input.steering as Array<{ channel?: unknown }>)[0]!.channel).toEqual({
      provider: "linear",
      connectionId: "conn-1",
    });
  });

  it("item 1: a reply written after asked_at answers while the elicitation's time is unknown", async () => {
    const { sessionId, questionId } = await askedSession("item1-asked-at", "7".repeat(64));
    const askedAt = Date.parse((await snapshotOf(sessionId)).question!.askedAt);
    const answer = await linearEnqueue(sessionId)("linear:r1", "go", new Date(askedAt + 1_000).toISOString());
    expect(answer).toMatchObject({ status: "queued", duplicate: false });
    const turnId = (answer as { turnId: string }).turnId;
    await waitForTurn(sessionId, turnId, "completed");
    expect((await renderedInput(sessionId, turnId)).answer).toEqual({ questionId, text: "go", value: "go" });
  });

  it("item 1: when the elicitation's time becomes known, held inputs are reclassified and the earliest written after it answers", async () => {
    const { sessionId, questionId } = await askedSession("item1-reclassify", "8".repeat(64));
    const askedAt = Date.parse((await snapshotOf(sessionId)).question!.askedAt);
    const at = (ms: number) => new Date(askedAt + ms).toISOString();
    const enqueue = linearEnqueue(sessionId);
    // Linear's clock is behind ours: every reply below is held against
    // asked_at, though two were written after the elicitation (at -5 s).
    expect(await enqueue("linear:s1", "Use staging.", at(-8_000))).toMatchObject({ status: "held" });
    expect(await enqueue("linear:r2", "And ship it after.", at(-1_000))).toMatchObject({ status: "held" });
    expect(await enqueue("linear:r1", "go", at(-3_000))).toMatchObject({ status: "held" });
    expect((await snapshotOf(sessionId)).turns).toHaveLength(1);

    const events = await elicitationPosted(sessionId, questionId, at(-5_000));
    const answerTurnId = events.find((event) => event.type === "question.answered")!.turnId!;
    const delivered = events.filter((event) => event.type === "message.delivered").map((event) => event.data);
    expect(delivered.map((data) => [data.as, data.turnId === answerTurnId])).toEqual([
      ["answer", true],
      ["steering", true],
      ["turn", false],
    ]);
    await waitForTurn(sessionId, answerTurnId, "completed");
    const input = await renderedInput(sessionId, answerTurnId);
    expect(input.text).toBe("go");
    expect(input.answer).toEqual({ questionId, text: "go", value: "go" });
    expect((input.steering as Array<{ text: string }>).map((held) => held.text)).toEqual(["Use staging."]);
    // The later reply runs as its own turn, after the answer.
    const laterTurnId = delivered[2]!.turnId as string;
    await waitForTurn(sessionId, laterTurnId, "completed");
    expect((await renderedInput(sessionId, laterTurnId)).text).toBe("And ship it after.");
    expect((await snapshotOf(sessionId)).question).toBeNull();
    // Each key now answers with the turn that carried it.
    expect(await enqueue("linear:r1", "go", at(-3_000))).toMatchObject({ turnId: answerTurnId, duplicate: true });
    expect(await enqueue("linear:s1", "Use staging.", at(-8_000))).toMatchObject({ turnId: answerTurnId, duplicate: true });
    expect(await enqueue("linear:r2", "And ship it after.", at(-1_000))).toMatchObject({ turnId: laterTurnId, duplicate: true });
    // A second post of the same elicitation changes nothing.
    expect(await elicitationPosted(sessionId, questionId, at(-4_000))).toEqual([]);
  });

  it("item 1: an elicitation that can never post closes the question undeliverable and runs held inputs as ordinary turns, in order", async () => {
    const { sessionId, questionId } = await askedSession("item1-undeliverable", "9".repeat(64));
    await postTurn(sessionId, "First held.", "held-1");
    await postTurn(sessionId, "Second held.", "held-2");
    const events = await elicitationUndeliverable(sessionId, questionId);
    expect(events.find((event) => event.type === "question.closed")!.data).toEqual({ questionId, reason: "undeliverable" });
    const turnIds = events.filter((event) => event.type === "message.delivered").map((event) => event.data.turnId as string);
    expect(turnIds).toHaveLength(2);
    for (const turnId of turnIds) await waitForTurn(sessionId, turnId, "completed");
    expect(await Promise.all(turnIds.map(async (turnId) => (await renderedInput(sessionId, turnId)).text))).toEqual([
      "First held.",
      "Second held.",
    ]);
    const snapshot = await snapshotOf(sessionId);
    expect(snapshot.question).toBeNull();
    expect(snapshot.turns.slice(1).map((turn) => turn.id)).toEqual(turnIds);
    // A later elicitation outcome for the closed question does nothing.
    expect(await elicitationUndeliverable(sessionId, questionId)).toEqual([]);
    expect(await elicitationPosted(sessionId, questionId, new Date().toISOString())).toEqual([]);
  });

  it("item 2: steering takes at most 20 held inputs; the rest run as ordinary turns after the answer, in order", async () => {
    expect(STEERING_ITEM_LIMIT).toBe(20);
    const { sessionId, questionId } = await askedSession("item2-count", "a1".padEnd(64, "0"));
    for (let index = 1; index <= 22; index++) {
      expect((await postTurn(sessionId, `Held ${String(index)}.`, `held-${String(index)}`)).status).toBe(202);
    }
    const answer = await admitted(await postTurn(sessionId, "go", "answer-1", { answers: questionId }));
    const events = await waitForTurn(sessionId, answer.turnId, "completed");
    const steering = (await renderedInput(sessionId, answer.turnId)).steering as Array<{ text: string }>;
    expect(steering.map((held) => held.text)).toEqual(Array.from({ length: 20 }, (_, index) => `Held ${String(index + 1)}.`));
    const overflow = events
      .filter((event) => event.type === "message.delivered" && event.data.as === "turn")
      .map((event) => event.data.turnId as string);
    expect(overflow).toHaveLength(2);
    for (const turnId of overflow) await waitForTurn(sessionId, turnId, "completed");
    expect(await Promise.all(overflow.map(async (turnId) => (await renderedInput(sessionId, turnId)).text))).toEqual([
      "Held 21.",
      "Held 22.",
    ]);
    // In order, after the answering turn.
    const turns = (await snapshotOf(sessionId)).turns.map((turn) => turn.id);
    expect(turns.slice(turns.indexOf(answer.turnId))).toEqual([answer.turnId, ...overflow]);
    expect(await (await postTurn(sessionId, "Held 21.", "held-21")).json()).toMatchObject({ turnId: overflow[0], duplicate: true });
  });

  it("item 2: steering takes at most 64 KiB, as a prefix; an answer never fails because of held size", async () => {
    expect(STEERING_SIZE_LIMIT).toBe(64 * 1024);
    const { sessionId, questionId } = await askedSession("item2-size", "a2".padEnd(64, "0"));
    const small = "Keep the API stable.";
    const big = "b".repeat(40 * 1024);
    // Two fit (about 40 KiB and 20 bytes); the third pushes past 64 KiB, so
    // it and everything after it run as turns, in order.
    for (const [key, text] of [
      ["held-a", big],
      ["held-b", small],
      ["held-c", big],
      ["held-d", small],
    ] as const) {
      expect((await postTurn(sessionId, text, key)).status).toBe(202);
    }
    // Held inputs together far beyond any single input's bound.
    for (let index = 0; index < 4; index++) {
      expect((await postTurn(sessionId, "c".repeat(200 * 1024), `held-big-${String(index)}`)).status).toBe(202);
    }
    // A long answer: its text and the steering together exceed 256 KiB.
    const answerText = `go ${"d".repeat(200 * 1024)}`;
    const answer = await postTurn(sessionId, answerText, "answer-1", { answers: questionId });
    expect(answer.status).toBe(202);
    const { turnId } = await answer.json<{ turnId: string }>();
    const events = await waitForTurn(sessionId, turnId, "completed");
    const steering = (await renderedInput(sessionId, turnId)).steering as Array<{ text: string }>;
    expect(steering.map((held) => held.text.length)).toEqual([big.length, small.length]);
    const overflow = events
      .filter((event) => event.type === "message.delivered" && event.data.as === "turn")
      .map((event) => event.data.turnId as string);
    expect(overflow).toHaveLength(6);
    const lengths: number[] = [];
    for (const overflowTurnId of overflow) {
      await waitForTurn(sessionId, overflowTurnId, "completed");
      lengths.push(((await renderedInput(sessionId, overflowTurnId)).text as string).length);
    }
    expect(lengths).toEqual([big.length, small.length, ...Array(4).fill(200 * 1024)]);
  });

  it("item 3: the same key with a different question reference is 409 idempotency_conflict", async () => {
    const { sessionId, questionId } = await askedSession("item3-fingerprint", "a3".padEnd(64, "0"));
    // Held without `answers`, then the same key naming the question.
    expect((await postTurn(sessionId, "go", "key-held")).status).toBe(202);
    const heldThenAnswer = await postTurn(sessionId, "go", "key-held", { answers: questionId });
    expect(heldThenAnswer.status).toBe(409);
    expect(await heldThenAnswer.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

    const answer = await admitted(await postTurn(sessionId, "go", "key-answer", { answers: questionId }));
    expect(answer.duplicate).toBe(false);
    for (const extra of [{ answers: "question_other" }, {}]) {
      const conflict = await postTurn(sessionId, "go", "key-answer", extra);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    }
    // The same request again is the original receipt.
    const replay = await postTurn(sessionId, "go", "key-answer", { answers: questionId });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ turnId: answer.turnId, duplicate: true });
  });

  it("item 4: held inputs are events: message.held once per key, then message.delivered with the answer turn or message.discarded", async () => {
    const { sessionId, questionId } = await askedSession("item4-events", "a4".padEnd(64, "0"));
    const first = await (await postTurn(sessionId, "Use staging.", "held-1", { payload: { env: "staging" } })).json<{ heldId: string }>();
    const second = await (await postTurn(sessionId, "Keep it small.", "held-2")).json<{ heldId: string }>();
    await postTurn(sessionId, "Use staging.", "held-1", { payload: { env: "staging" } });
    let events = await eventsOf(sessionId);
    const held = events.filter((event) => event.type === "message.held");
    expect(held.map((event) => [event.turnId, event.data])).toEqual([
      [
        undefined,
        {
          heldId: first.heldId,
          questionId,
          input: "Use staging.",
          payload: { env: "staging" },
          receivedAt: expect.any(String),
        },
      ],
      [undefined, { heldId: second.heldId, questionId, input: "Keep it small.", receivedAt: expect.any(String) }],
    ]);
    const answer = await admitted(await postTurn(sessionId, "go [ask call-again]", "answer-1", { answers: questionId }));
    events = await waitForTurn(sessionId, answer.turnId, "completed");
    expect(events.filter((event) => event.type === "message.delivered").map((event) => event.data)).toEqual([
      { heldId: first.heldId, questionId, answerTurnId: answer.turnId, turnId: answer.turnId, as: "steering" },
      { heldId: second.heldId, questionId, answerTurnId: answer.turnId, turnId: answer.turnId, as: "steering" },
    ]);
    // Delivered after the answering turn's own message and answer.
    const types = events.map((event) => event.type);
    expect(types.indexOf("message.delivered")).toBeGreaterThan(types.indexOf("question.answered"));

    // The next question's held input is discarded by a stop.
    const next = (await snapshotOf(sessionId)).question!.id;
    const third = await (await postTurn(sessionId, "Never mind.", "held-3")).json<{ heldId: string }>();
    await env.SESSIONS.getByName(sessionId).applyControl({
      deliveryId: "delivery-stop-item4",
      kind: "stop",
      providerTime: new Date().toISOString(),
    });
    events = await eventsOf(sessionId);
    expect(events.filter((event) => event.type === "message.discarded").map((event) => event.data)).toEqual([
      { heldId: third.heldId, questionId: next, reason: "stopped" },
    ]);
  });

  it("item 5: dismiss closes the open question, runs held inputs as ordinary turns in order, is idempotent, and a stale id is 409 question_stale", async () => {
    const { sessionId, questionId } = await askedSession("item5-dismiss", "a5".padEnd(64, "0"));
    await postTurn(sessionId, "First held.", "held-1");
    await postTurn(sessionId, "Second held.", "held-2");
    const dismiss = (id: string) =>
      SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/questions/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
      });
    const stale = await dismiss("question_other");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "question_stale" } });

    const dismissed = await dismiss(questionId);
    expect(dismissed.status).toBe(200);
    const snapshot = await dismissed.json<SessionSnapshot>();
    expect(snapshot.question).toBeNull();
    const heldTurns = snapshot.turns.slice(1);
    expect(heldTurns.map((turn) => turn.input)).toEqual(["First held.", "Second held."]);
    const events = await eventsOf(sessionId);
    expect(events.find((event) => event.type === "question.closed")!.data).toEqual({ questionId, reason: "dismissed" });
    expect(
      events.filter((event) => event.type === "message.delivered").map((event) => [event.data.as, event.data.answerTurnId]),
    ).toEqual(heldTurns.map((turn) => ["turn", turn.id]));
    for (const turn of heldTurns) await waitForTurn(sessionId, turn.id, "completed");

    // Idempotent: the same answer, nothing new.
    const again = await dismiss(questionId);
    expect(again.status).toBe(200);
    expect((await again.json<SessionSnapshot>()).turns).toHaveLength(3);
    expect((await eventsOf(sessionId)).filter((event) => event.type === "question.closed")).toHaveLength(1);
    // A held key answers with the turn it became.
    expect(await (await postTurn(sessionId, "First held.", "held-1")).json()).toMatchObject({
      turnId: heldTurns[0]!.id,
      duplicate: true,
    });
  });

  it("item 5: interrupt leaves the open question alone; end closes it as ended and discards what it held", async () => {
    const { sessionId, questionId } = await askedSession("item5-end", "a6".padEnd(64, "0"));
    const held = await (await postTurn(sessionId, "Held.", "held-1")).json<{ heldId: string }>();
    const interrupted = await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/interrupt`, { method: "POST" });
    expect(interrupted.status).toBe(200);
    expect((await interrupted.json<SessionSnapshot>()).question?.id).toBe(questionId);
    expect((await eventsOf(sessionId)).some((event) => event.type === "question.closed")).toBe(false);

    const ended = await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    expect((await ended.json<SessionSnapshot>()).question).toBeNull();
    const events = await eventsOf(sessionId);
    expect(events.find((event) => event.type === "question.closed")!.data).toEqual({ questionId, reason: "ended" });
    expect(events.find((event) => event.type === "message.discarded")!.data).toEqual({
      heldId: held.heldId,
      questionId,
      reason: "ended",
    });
    const types = events.map((event) => event.type);
    expect(types.indexOf("question.closed")).toBeLessThan(types.indexOf("session.ended"));
    expect(await (await postTurn(sessionId, "Held.", "held-1")).json()).toMatchObject({ status: "discarded", questionId });
    const dismissAfter = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${sessionId}/questions/${encodeURIComponent(questionId)}/dismiss`,
      { method: "POST" },
    );
    expect(dismissAfter.status).toBe(409);
  });

  it("opens a new question when the answering turn asks again, and never closes one as replaced", async () => {
    const { sessionId, questionId } = await askedSession("ask-again", "4".repeat(64));
    const answer = await admitted(await postTurn(sessionId, "go [ask call-again]", "answer-1", { answers: questionId }));
    await waitForTurn(sessionId, answer.turnId, "completed");
    const events = await eventsOf(sessionId);
    const next = (await snapshotOf(sessionId)).question!;
    expect(next.id).toBe(await questionIdFor(answer.turnId, "call-again"));
    // The first question was answered at the answer's admission; the second
    // is a new question on an answered one.
    expect(events.filter((event) => event.type === "question.closed")).toEqual([]);
    expect(
      events.filter((event) => event.type.startsWith("question.")).map((event) => [event.type, (event.data as { questionId: string }).questionId]),
    ).toEqual([
      ["question.asked", questionId],
      ["question.answered", questionId],
      ["question.asked", next.id],
    ]);
    const rows = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; answered_by_turn_id: string | null; closed_reason: string | null }>(
          "SELECT id, answered_by_turn_id, closed_reason FROM questions ORDER BY rowid",
        )
        .toArray(),
    );
    expect(rows).toEqual([
      { id: questionId, answered_by_turn_id: answer.turnId, closed_reason: null },
      { id: next.id, answered_by_turn_id: null, closed_reason: null },
    ]);

    // Unreachable through admission; if the one-open-question invariant
    // ever broke, the stale question closes as stopped, never replaced.
    const { commitQuestion } = await import("../src/edge/questions.js");
    const broken = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      commitQuestion(
        state.storage.sql,
        { id: "question_new", turnId: "t", toolCallId: "c", text: "Another?", options: [], askedAt: new Date().toISOString() },
        (type, data) => ({ type, data }) as unknown as AgentEvent,
      ),
    );
    expect(broken).not.toHaveProperty("replaced");
    expect(broken.events.map((event) => [event.type, event.data])).toEqual([
      ["question.closed", { questionId: next.id, reason: "stopped" }],
      ["question.asked", { questionId: "question_new", text: "Another?", options: [] }],
    ]);
  });
});

describe("applyControl", () => {
  it("stops: discards held inputs, closes the question, confirms with Stopped., and a repeat changes nothing later", async () => {
    const { sessionId, questionId } = await askedSession("ask-stop", "5".repeat(64));
    await postTurn(sessionId, "Held one.", "held-1");
    await postTurn(sessionId, "Held two.", "held-2");
    enqueued.length = 0;
    const session = env.SESSIONS.getByName(sessionId);
    const control = { deliveryId: "delivery-stop-1", kind: "stop" as const, providerTime: "2026-10-02T10:00:00.000Z" };
    const result = await session.applyControl(control);
    expect(result).toEqual({
      deliveryId: "delivery-stop-1",
      duplicate: false,
      appliedAt: expect.any(String),
      discardedTurnKeys: ["held-1", "held-2"],
      closedQuestionId: questionId,
    });
    expect(enqueued.map((entry) => entry.activity)).toEqual([
      { kind: "terminal", content: { type: "error", body: "Stopped." } },
    ]);
    const events = await eventsOf(sessionId);
    expect(events.find((event) => event.type === "question.closed")!.data).toEqual({ questionId, reason: "stopped" });
    expect((await snapshotOf(sessionId)).question).toBeNull();
    expect(await (await postTurn(sessionId, "Held one.", "held-1")).json()).toEqual({
      status: "discarded",
      questionId,
      heldId: expect.any(String),
      duplicate: true,
    });

    // Work admitted after the stop is untouched by the stop's retry.
    const resumed = await admitted(await postTurn(sessionId, "Carry on. [stall 400ms]", "after-stop"));
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.turnId === resumed.turnId && event.type === "turn.started"),
    );
    enqueued.length = 0;
    const repeat = await session.applyControl(control);
    expect(repeat).toEqual({ ...result, duplicate: true });
    expect(enqueued).toEqual([]);
    await waitForTurn(sessionId, resumed.turnId, "completed");
    expect((await snapshotOf(sessionId)).turns.find((turn) => turn.id === resumed.turnId)!.status).toBe("completed");
  });

  it("interrupts the running turn and discards queued turns; the cancelled turn's settlement owns the confirmation", async () => {
    const sessionId = await createWorkerdSession("stop-running", "6".repeat(64));
    const running = await admitted(await postTurn(sessionId, "Work. [stall 5000ms]", "run-1"));
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.turnId === running.turnId && event.type === "turn.started"),
    );
    const queued = await admitted(await postTurn(sessionId, "Next.", "queued-1"));
    const result = await env.SESSIONS.getByName(sessionId).applyControl({
      deliveryId: "delivery-stop-2",
      kind: "stop",
      providerTime: "2026-10-02T10:00:00.000Z",
    });
    expect(result).toMatchObject({ interruptedTurnId: running.turnId, discardedTurnKeys: ["queued-1"], duplicate: false });
    expect(result.closedQuestionId).toBeUndefined();
    expect(enqueued).toEqual([]);
    const events = await waitForTurn(sessionId, running.turnId, "cancelled");
    expect(events.find((event) => event.turnId === running.turnId && event.type === "turn.cancelled")!.data).toMatchObject({
      reason: "stopped",
    });
    expect(events.find((event) => event.turnId === queued.turnId && event.type === "turn.cancelled")!.data).toEqual({
      reason: "stopped",
      discarded: true,
    });
  });
});

describe("outcome subscriptions", () => {
  it("delivers a turn that asked as turn.completed with outcome and question", async () => {
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Ask outcomes", slug: "ask-outcomes" }),
      }),
    );
    const coordinatorAgentId = project.agents[0]!.id;
    const workerAgentId = `${coordinatorAgentId}--worker`;
    const coordinator = await createWorkerdSession(coordinatorAgentId, "7".repeat(64));
    const worker = await createWorkerdSession(workerAgentId, "8".repeat(64));
    const created = await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: workerAgentId,
        events: ["turn.completed"],
        destination: { type: "session", sessionId: coordinator },
      }),
    });
    expect(created.status).toBe(201);
    (await created.json()) as { subscription: EventSubscription };

    const turn = await admitted(
      await postTurn(worker, "Plan. [stall 300ms] [ask-context The plan touches two files.] [ask call-sub]", "worker-ask"),
    );
    await waitForEvents(worker, (events) =>
      events.some((event) => event.turnId === turn.turnId && event.type === "turn.started"),
    );
    // Queued behind the asking turn, then held: subscribed, but owed no outcome.
    const queued = await admitted(await postTurn(worker, "Meanwhile.", "worker-queued"));
    await waitForTurn(worker, turn.turnId, "completed");
    await waitForTurn(worker, queued.turnId, "cancelled");
    const questionId = await questionIdFor(turn.turnId, "call-sub");
    let deliveries: TurnOutcomeDelivery[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await runDurableObjectAlarm(env.SESSIONS.getByName(worker));
      deliveries = (await snapshotOf(worker)).turns[0]!.deliveries ?? [];
      if (deliveries.length && deliveries.every((delivery) => delivery.status !== "pending")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(deliveries[0]).toMatchObject({ status: "delivered" });
    const heldTurn = (await snapshotOf(worker)).turns.find((entry) => entry.id === queued.turnId)!;
    expect(heldTurn).toMatchObject({ status: "cancelled", reason: "held", questionId });
    expect(heldTurn.deliveries).toBeUndefined();
    // The coordinator received the asking turn's outcome and nothing for the held one.
    const coordinatorTurns = (await snapshotOf(coordinator)).turns;
    expect(coordinatorTurns).toHaveLength(1);
    const target = deliveries[0]!.receipt!.turnId!;
    const input = await renderedInput(coordinator, target);
    expect(input.event).toMatchObject({
      type: "turn.completed",
      outcome: "question",
      question: {
        id: questionId,
        text: "Which approach?",
        options: [
          { label: "Go", value: "go" },
          { label: "Wait", value: "wait" },
        ],
        context: "The plan touches two files.",
      },
    });
    // The receiving model reads the context above the question.
    expect(await modelTextOf(coordinator, target)).toContain(
      `The turn ended by asking (question ${questionId}):\nThe plan touches two files.\n\nWhich approach?`,
    );
  });
});

describe("event turns on a Slack session (slack-ux P1)", () => {
  type Post = { url: string; body: string };
  let posts: Post[] = [];

  beforeEach(() => {
    posts = [];
    const realFetch = globalThis.fetch;
    // Slack is a fetch stub; everything else goes where it was going.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("https://slack.com/")) return realFetch(input, init);
        posts.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return Response.json({ ok: true, ts: "8.8", channel: "C-P1" });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const replies = () => posts.filter((post) => post.url.includes("chat.postMessage"));

  /** A Workerd session whose first turn came from a Slack thread and was answered there. */
  async function slackBoundSession(agentId: string, digest: string) {
    const sessionId = await createWorkerdSession(agentId, digest);
    const account = env.ACCOUNTS.getByName("local");
    const secret = "p1-signing-secret-0123456789abcdef";
    await account.createChannelApp({
      id: `app-${agentId}`,
      provider: "slack",
      externalAppId: `A-${agentId}`,
      agentId,
      alias: "development",
      signingSecret: secret,
      label: "P1",
    });
    const installed = await account.upsertAppInstallation({
      appId: `app-${agentId}`,
      provider: "slack",
      agentId,
      alias: "development",
      channelId: "slack",
      workspaceId: "T-P1",
      botToken: "xoxb-p1",
      signingSecret: secret,
    });
    const stub = env.SESSIONS.getByName(sessionId);
    const started = await stub.enqueueChannelTurn(
      { input: "Build it.", agentInput: { source: "channel", text: "Build it." }, idempotencyKey: "slack:p1-start" },
      {
        provider: "slack",
        connectionId: installed.id,
        externalUserId: "U-P1",
        deliveryRef: { channelId: "C-P1", threadTimestamp: "7.7" },
      },
    );
    const channelTurnId = (started as { turnId: string }).turnId;
    await waitForTurn(sessionId, channelTurnId, "completed");
    await settledDelivery(sessionId, channelTurnId);
    return { sessionId, stub, connectionId: installed.id, channelTurnId };
  }

  type DeliveryRow = {
    status: string;
    attempts: number;
    channel_id: string;
    thread_timestamp: string;
    provider: string;
    connected_account_id: string;
    external_user_id: string;
    delivery_ref: string;
  };

  function deliveryOf(sessionId: string, turnId: string): Promise<DeliveryRow | null> {
    return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<DeliveryRow>(
          `SELECT status, attempts, channel_id, thread_timestamp, provider,
                  connected_account_id, external_user_id, delivery_ref
           FROM slack_deliveries WHERE turn_id = ?`,
          turnId,
        )
        .toArray()[0] ?? null,
    );
  }

  async function settledDelivery(sessionId: string, turnId: string): Promise<DeliveryRow> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = await deliveryOf(sessionId, turnId);
      if (row && row.status !== "pending") return row;
      await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`delivery for ${turnId} never settled`);
  }

  function enqueueEvent(stub: ReturnType<typeof env.SESSIONS.getByName>, key: string, input: string) {
    return stub.enqueueTurn({
      input,
      idempotencyKey: key,
      mode: "queue",
      agentInput: {
        source: "event",
        event: {
          id: `evt-${key}`,
          type: "turn.completed",
          sessionId: "worker-session",
          turnId: `worker-turn-${key}`,
          agentId: "worker-agent",
          occurredAt: "2026-10-06T00:00:00.000Z",
          result: { text: input, truncated: false },
        },
      },
    });
  }

  it("posts a delivered outcome's reply in the thread the session last answered in", async () => {
    const { sessionId, stub, connectionId } = await slackBoundSession("p1-event", "e1".repeat(32));
    expect(replies()).toHaveLength(1);
    const event = await enqueueEvent(stub, "outcome-1", "The api stream landed.");
    const eventTurnId = (event as { turnId: string }).turnId;
    await waitForTurn(sessionId, eventTurnId, "completed");
    const row = await settledDelivery(sessionId, eventTurnId);
    expect(row).toMatchObject({
      status: "delivered",
      attempts: 1,
      channel_id: "C-P1",
      thread_timestamp: "7.7",
      provider: "slack",
      connected_account_id: connectionId,
      external_user_id: "U-P1",
    });
    expect(JSON.parse(row.delivery_ref)).toEqual({ channelId: "C-P1", threadTimestamp: "7.7" });
    expect(replies()).toHaveLength(2);
    const posted = decodeURIComponent(replies()[1]!.body);
    expect(posted).toContain("7.7");
    expect(posted).toContain("running in the Durable Object.");
    // The arrow link to the session rides along, as on any Slack answer.
    expect(posted).toContain(sessionId);
  });

  it("leaves a turn started from the API on a Slack-bound session without a reply row", async () => {
    const { sessionId } = await slackBoundSession("p1-api", "e2".repeat(32));
    const turn = await admitted(await postTurn(sessionId, "Asked from the dashboard.", "api-1"));
    await waitForTurn(sessionId, turn.turnId, "completed");
    await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
    expect(await deliveryOf(sessionId, turn.turnId)).toBeNull();
    expect(replies()).toHaveLength(1);
  });

  it("posts nothing for an event turn whose final text is empty", async () => {
    const { sessionId, stub } = await slackBoundSession("p1-silent", "e3".repeat(32));
    const event = await enqueueEvent(stub, "outcome-silent", "Still running. [silent]");
    const eventTurnId = (event as { turnId: string }).turnId;
    await waitForTurn(sessionId, eventTurnId, "completed");
    const row = await settledDelivery(sessionId, eventTurnId);
    // The row exists and is settled by the silence rule: delivered, nothing sent.
    expect(row).toMatchObject({ status: "delivered", thread_timestamp: "7.7" });
    expect(replies()).toHaveLength(1);
  });
});

describe("ask in Slack (slack-ux P2)", () => {
  type Call = { method: string; body: Record<string, unknown> };
  let calls: Call[] = [];
  let failPosts: string | null = null;
  let refuseCards = false;
  let tsCounter = 0;
  const SECRET = "p2-signing-secret-0123456789abcdef";
  const TOKEN = "p2-interactivity-token";
  const OWNER = "U-OWNER";

  beforeEach(() => {
    calls = [];
    failPosts = null;
    refuseCards = false;
    tsCounter = 0;
    const realFetch = globalThis.fetch;
    // Slack is a fetch stub; everything else goes where it was going. Each
    // post answers with a fresh `ts` on the current clock, as Slack does.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("https://slack.com/")) return realFetch(input, init);
        const method = url.split("/").at(-1)!.split("?")[0]!;
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ method, body });
        if (method === "chat.postMessage" && failPosts) return Response.json({ ok: false, error: failPosts });
        const hasButtons = JSON.stringify(body.blocks ?? []).includes('"actions"');
        if (method === "chat.postMessage" && refuseCards && hasButtons) {
          return Response.json({ ok: false, error: "invalid_blocks" });
        }
        tsCounter += 1;
        const ts = `${String(Math.floor(Date.now() / 1000))}.${String(tsCounter).padStart(6, "0")}`;
        return Response.json({ ok: true, ts, channel: "C-Q" });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const posts = () => calls.filter((call) => call.method === "chat.postMessage");
  const updates = () => calls.filter((call) => call.method === "chat.update");

  async function hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  type QuestionState = {
    channel_message_id: string | null;
    provider_asked_at: string | null;
    answered_by_turn_id: string | null;
    closed_reason: string | null;
  };

  function questionRow(sessionId: string, questionId: string): Promise<QuestionState> {
    return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<QuestionState>(
          "SELECT channel_message_id, provider_asked_at, answered_by_turn_id, closed_reason FROM questions WHERE id = ?",
          questionId,
        )
        .one(),
    );
  }

  /**
   * A Workerd session whose first turn came from a Slack thread through a
   * shared app and asked; the thread is bound to the session under its
   * person, as the ingress binds it. Returns once the card is out.
   */
  async function askedInSlack(agentId: string, digest: string, directive = "[ask call-ask]") {
    const sessionId = await createWorkerdSession(agentId, digest);
    const account = env.ACCOUNTS.getByName("local");
    const appId = `app-${agentId}`;
    await account.createChannelApp({
      id: appId,
      provider: "slack",
      externalAppId: `A-${agentId}`,
      agentId,
      alias: "development",
      signingSecret: SECRET,
      label: "P2",
    });
    await env.ACCOUNTS.getByName(`slack-app:${appId}`).setChannelAppRoute({
      accountId: "local",
      appId,
      webhookTokenHash: await hex(TOKEN),
      provider: "slack",
    });
    const installed = await account.upsertAppInstallation({
      appId,
      provider: "slack",
      agentId,
      alias: "development",
      channelId: "slack",
      workspaceId: "T-Q",
      botToken: "xoxb-p2",
      signingSecret: SECRET,
    });
    await account.setChannelThreadSession(installed.id, `${OWNER}:7.7`, sessionId);
    const stub = env.SESSIONS.getByName(sessionId);
    const asking = await stub.enqueueChannelTurn(
      {
        input: `Plan the change. ${directive}`,
        agentInput: { source: "channel", text: `Plan the change. ${directive}`, channel: { provider: "slack", connectionId: installed.id, userId: OWNER } },
        idempotencyKey: `slack:${agentId}-ask`,
      },
      {
        provider: "slack",
        connectionId: installed.id,
        externalUserId: OWNER,
        deliveryRef: { channelId: "C-Q", threadTimestamp: "7.7" },
      },
    );
    const askingTurnId = (asking as { turnId: string }).turnId;
    await waitForTurn(sessionId, askingTurnId, "completed");
    const questionId = (await snapshotOf(sessionId)).question!.id;
    return { sessionId, stub, appId, connectionId: installed.id, askingTurnId, questionId };
  }

  async function cardPosted(sessionId: string, questionId: string): Promise<QuestionState> {
    return until(
      async () => {
        await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
        return questionRow(sessionId, questionId);
      },
      (row) => row.channel_message_id !== null,
      "the question card",
    );
  }

  async function click(appId: string, questionId: string, index: number, user: string, actionTs: string) {
    const payload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        api_app_id: `A-${appId.slice(4)}`,
        team: { id: "T-Q" },
        user: { id: user },
        channel: { id: "C-Q" },
        message: { ts: "card", thread_ts: "7.7" },
        actions: [
          {
            action_id: `opencomputer_question_answer:${String(index)}`,
            value: `${questionId}:${String(index)}`,
            action_ts: actionTs,
          },
        ],
      }),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${payload}`)),
    );
    const response = await SELF.fetch(`https://example.com/v1/webhooks/slack/app/${appId}/${TOKEN}/interactivity`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      },
      body: payload,
    });
    expect(response.status).toBe(200);
  }

  /** What a Slack message from the person reaches the session with: its own `ts` as provider time. */
  function typed(stub: ReturnType<typeof env.SESSIONS.getByName>, connectionId: string, key: string, text: string, ts: string) {
    return stub.enqueueChannelTurn(
      {
        input: text,
        agentInput: { source: "channel", text, channel: { provider: "slack", connectionId, userId: OWNER } },
        idempotencyKey: `slack:${key}`,
        providerTime: slackTimestampIso(ts)!,
      },
      { provider: "slack", connectionId, externalUserId: OWNER, deliveryRef: { channelId: "C-Q", threadTimestamp: "7.7" } },
    );
  }

  const shiftTs = (ts: string, seconds: number) => {
    const [whole, fraction] = ts.split(".");
    return `${String(Number(whole) + seconds)}.${fraction ?? "000000"}`;
  };

  /** The asking turn's final text, as the card shows it above the question. */
  async function finalTextOf(sessionId: string, turnId: string): Promise<string> {
    const events = await eventsOf(sessionId);
    const completed = events.find((event) => event.turnId === turnId && event.type === "message.completed")!;
    return String((completed.data as { finalText?: string }).finalText ?? "").trim();
  }

  type Block = { type: string; text?: unknown; elements?: Array<Record<string, unknown>> };
  const blocksOf = (call: Call) => call.body.blocks as Block[];

  it("(1) posts a question with options as its text and one button per option, as the turn's only reply, and records the card's ts as the question's provider time", async () => {
    const { sessionId, questionId, askingTurnId } = await askedInSlack("p2-post", "c1".repeat(32));
    const row = await cardPosted(sessionId, questionId);
    const snapshotText = await finalTextOf(sessionId, askingTurnId);
    expect(snapshotText.length).toBeGreaterThan(0);
    // The card is the asking turn's only message in the thread.
    expect(posts()).toHaveLength(1);
    const card = posts()[0]!;
    expect(card.body).toMatchObject({ channel: "C-Q", thread_ts: "7.7" });
    const blocks = blocksOf(card);
    expect(blocks.map((block) => block.type)).toEqual(["markdown", "actions"]);
    // The turn's snapshot first, then the question, then the arrow link to
    // the session, as on any Slack answer.
    const markdown = String(blocks[0]!.text);
    expect(markdown.startsWith(`${snapshotText}\n\nWhich approach? [↗](`)).toBe(true);
    expect(markdown).toMatch(new RegExp(`Which approach\\? \\[↗\\]\\([^)]*${sessionId}\\)$`));
    expect(blocks[1]!.elements).toEqual([
      {
        type: "button",
        text: { type: "plain_text", text: "Go" },
        action_id: "opencomputer_question_answer:0",
        value: `${questionId}:0`,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Wait" },
        action_id: "opencomputer_question_answer:1",
        value: `${questionId}:1`,
      },
    ]);
    expect(row.provider_asked_at).toBe(slackTimestampIso(row.channel_message_id));
    expect((await snapshotOf(sessionId)).question?.id).toBe(questionId);
  });

  it("(2) a click by the session's person admits the answer turn with answers, keyed by the click, and rewrites the card with the choice and no buttons", async () => {
    const { sessionId, appId, connectionId, questionId, askingTurnId } = await askedInSlack("p2-click", "c2".repeat(32));
    await cardPosted(sessionId, questionId);
    await click(appId, questionId, 1, OWNER, "1700000000.000001");
    const snapshot = await until(() => snapshotOf(sessionId), (current) => current.turns.length === 2, "the answer turn");
    const answer = snapshot.turns[1]!;
    expect(answer.input).toBe("Wait");
    expect(snapshot.question).toBeNull();
    await waitForTurn(sessionId, answer.id, "completed");
    const input = await renderedInput(sessionId, answer.id);
    expect(input.answer).toEqual({ questionId, text: "Wait", value: "wait" });
    expect(input.channel).toMatchObject({ provider: "slack", connectionId, userId: OWNER, workspaceId: "T-Q", conversationId: "7.7" });
    const key = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql.exec<{ idempotency_key: string }>("SELECT idempotency_key FROM turns WHERE id = ?", answer.id).one(),
    );
    expect(key.idempotency_key).toBe(`slack-answer:${questionId}:1700000000.000001`);
    const update = await until(() => updates(), (current) => current.length > 0, "the card rewrite");
    const blocks = blocksOf(update[0]!);
    expect(blocks.map((block) => block.type)).toEqual(["markdown", "context"]);
    // The thread still reads as the snapshot after the decision.
    expect(String(blocks[0]!.text).startsWith(`${await finalTextOf(sessionId, askingTurnId)}\n\nWhich approach?`)).toBe(true);
    expect(JSON.stringify(blocks[1])).toContain(`chosen: Wait · by <@${OWNER}>`);
    // The answer turn answers in the thread the question was asked in.
    const reply = await until(() => posts(), (current) => current.length === 2, "the answer's reply");
    expect(reply[1]!.body).toMatchObject({ channel: "C-Q", thread_ts: "7.7" });
  });

  it("(3) ignores a click by anyone but the session's person and leaves the card as it was", async () => {
    const { sessionId, stub, appId, connectionId, questionId } = await askedInSlack("p2-other", "c3".repeat(32));
    await cardPosted(sessionId, questionId);
    // Through the route: nobody's session is bound under the other person here.
    await click(appId, questionId, 0, "U-OTHER", "1700000000.000002");
    // And straight at the session, as if the lookup had found it.
    expect(
      await stub.answerQuestionFromChannel({
        questionId,
        optionIndex: 0,
        externalUserId: "U-OTHER",
        actionTimestamp: "1700000000.000003",
        connectionId,
      }),
    ).toEqual({ outcome: "ignored", reason: "not_owner" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = await snapshotOf(sessionId);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.question?.id).toBe(questionId);
    expect(updates()).toEqual([]);
  });

  /** The question as a turn that runs beside it carries it (`openQuestion`). */
  const openQuestionOf = (questionId: string) => ({
    id: questionId,
    text: "Which approach?",
    options: [
      { label: "Go", value: "go" },
      { label: "Wait", value: "wait" },
    ],
  });

  it("(4a) flow: a typed reply written after the card runs as an ordinary turn that carries the open question, and its reply closes the question superseded", async () => {
    const { sessionId, stub, connectionId, questionId, askingTurnId } = await askedInSlack("p2-typed-after", "c4".repeat(32));
    const row = await cardPosted(sessionId, questionId);
    const reply = await typed(stub, connectionId, "after", "go", shiftTs(row.channel_message_id!, 5));
    expect(reply).toMatchObject({ status: "queued", duplicate: false });
    const turnId = (reply as { turnId: string }).turnId;
    const events = await waitForTurn(sessionId, turnId, "completed");
    const input = await renderedInput(sessionId, turnId);
    // Never the answer by its time: the model reads the message knowing the gate.
    expect(input.answer).toBeUndefined();
    expect(input.openQuestion).toEqual(openQuestionOf(questionId));
    expect(events.filter((event) => event.type === "question.answered")).toEqual([]);
    expect(events.filter((event) => event.type === "message.held")).toEqual([]);
    expect(
      events.filter((event) => event.type === "question.closed").map((event) => [event.turnId, event.data]),
    ).toEqual([[turnId, { questionId, reason: "superseded" }]]);
    expect((await snapshotOf(sessionId)).question).toBeNull();
    expect((await questionRow(sessionId, questionId)).closed_reason).toBe("superseded");
    // The card keeps its text, loses its buttons and says where it went.
    const update = await until(() => updates(), (current) => current.length > 0, "the card rewrite");
    const blocks = blocksOf(update[0]!);
    expect(blocks.map((block) => block.type)).toEqual(["markdown", "context"]);
    expect(String(blocks[0]!.text).startsWith(`${await finalTextOf(sessionId, askingTurnId)}\n\nWhich approach?`)).toBe(true);
    expect(JSON.stringify(blocks[1])).toContain("answered in the thread");
  });

  it("(4b) flow: a typed reply written before the card (an earlier ts) is never held either", async () => {
    const { sessionId, stub, connectionId, questionId } = await askedInSlack("p2-typed-before", "c5".repeat(32));
    const row = await cardPosted(sessionId, questionId);
    // Slack delivered it late: its own time is before the card's.
    const early = await typed(stub, connectionId, "before", "only touch the api", shiftTs(row.channel_message_id!, -5));
    expect(early).toMatchObject({ status: "queued", duplicate: false });
    const turnId = (early as { turnId: string }).turnId;
    const events = await waitForTurn(sessionId, turnId, "completed");
    expect((await renderedInput(sessionId, turnId)).openQuestion).toEqual(openQuestionOf(questionId));
    expect(events.filter((event) => event.type === "message.held")).toEqual([]);
    expect((await questionRow(sessionId, questionId)).closed_reason).toBe("superseded");
  });

  it("(5) a second click admits no second turn, and Slack's retry of the first returns the same turn", async () => {
    const { sessionId, stub, appId, connectionId, questionId } = await askedInSlack("p2-twice", "c6".repeat(32));
    await cardPosted(sessionId, questionId);
    await click(appId, questionId, 0, OWNER, "1700000000.000005");
    const first = await until(() => snapshotOf(sessionId), (current) => current.turns.length === 2, "the answer turn");
    const answerId = first.turns[1]!.id;
    // Slack retries the same click: the same turn.
    expect(
      await stub.answerQuestionFromChannel({
        questionId,
        optionIndex: 0,
        externalUserId: OWNER,
        actionTimestamp: "1700000000.000005",
        connectionId,
      }),
    ).toEqual({ outcome: "admitted", turnId: answerId, duplicate: true });
    // A second click that got through before the rewrite: stale, and the
    // card is rewritten to what was decided.
    const before = updates().length;
    expect(
      await stub.answerQuestionFromChannel({
        questionId,
        optionIndex: 1,
        externalUserId: OWNER,
        actionTimestamp: "1700000000.000006",
        connectionId,
      }),
    ).toEqual({ outcome: "stale" });
    await click(appId, questionId, 1, OWNER, "1700000000.000007");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await snapshotOf(sessionId)).turns).toHaveLength(2);
    expect((await eventsOf(sessionId)).filter((event) => event.type === "question.answered")).toHaveLength(1);
    expect(updates().length).toBeGreaterThan(before);
    expect(JSON.stringify(blocksOf(updates().at(-1)!))).toContain(`chosen: Go · by <@${OWNER}>`);
    expect(JSON.stringify(blocksOf(updates().at(-1)!))).not.toContain("actions");
  });

  it("(6) a stop, a dismiss and an end close the question and rewrite the card as closed, with no buttons", async () => {
    const stopped = await askedInSlack("p2-stop", "c7".repeat(32));
    await cardPosted(stopped.sessionId, stopped.questionId);
    await stopped.stub.applyControl({ deliveryId: "p2-stop-1", kind: "stop", providerTime: new Date().toISOString() });
    let update = await until(() => updates(), (current) => current.length === 1, "the stopped card");
    expect(blocksOf(update[0]!).map((block) => block.type)).toEqual(["markdown", "context"]);
    expect(JSON.stringify(blocksOf(update[0]!))).toContain("closed (stopped)");

    const dismissed = await askedInSlack("p2-dismiss", "c8".repeat(32));
    await cardPosted(dismissed.sessionId, dismissed.questionId);
    const dismiss = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${dismissed.sessionId}/questions/${encodeURIComponent(dismissed.questionId)}/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(200);
    update = await until(() => updates(), (current) => current.length === 2, "the dismissed card");
    expect(JSON.stringify(blocksOf(update[1]!))).toContain("closed (dismissed)");

    const ended = await askedInSlack("p2-end", "c9".repeat(32));
    await cardPosted(ended.sessionId, ended.questionId);
    const end = await SELF.fetch(`https://managedagents.test/v1/sessions/${ended.sessionId}/end`, { method: "POST" });
    expect(end.status).toBe(200);
    update = await until(() => updates(), (current) => current.length === 3, "the ended card");
    expect(JSON.stringify(blocksOf(update[2]!))).toContain("closed (ended)");
    // A click on the closed card admits nothing and rewrites it again.
    expect(
      await ended.stub.answerQuestionFromChannel({
        questionId: ended.questionId,
        optionIndex: 0,
        externalUserId: OWNER,
        actionTimestamp: "1700000000.000008",
        connectionId: ended.connectionId,
      }),
    ).toEqual({ outcome: "stale" });
    expect(JSON.stringify(blocksOf(updates().at(-1)!))).toContain("closed (ended)");
  });

  it("(8) a card Slack refuses degrades to a plain-text gate with the options listed, whose ts is the provider time; a typed reply runs as a turn that carries the question and supersedes it", async () => {
    refuseCards = true;
    const { sessionId, stub, connectionId, questionId, askingTurnId } = await askedInSlack("p2-text-gate", "cc".repeat(32));
    const row = await cardPosted(sessionId, questionId);
    // One refused card, one plain message: never silence.
    expect(posts()).toHaveLength(2);
    const gate = posts()[1]!;
    expect(JSON.stringify(gate.body.blocks ?? [])).not.toContain('"actions"');
    const markdown = String((blocksOf(gate)[0] ?? {}).text ?? gate.body.text);
    expect(markdown.startsWith(`${await finalTextOf(sessionId, askingTurnId)}\n\nWhich approach?`)).toBe(true);
    expect(markdown).toContain("Reply with one of: Go · Wait");
    const kind = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
      state.storage.sql
        .exec<{ channel_message_kind: string }>("SELECT channel_message_kind FROM questions WHERE id = ?", questionId)
        .one(),
    );
    expect(kind.channel_message_kind).toBe("text");
    expect(row.provider_asked_at).toBe(slackTimestampIso(row.channel_message_id));
    // A typed reply runs as an ordinary turn that knows the gate.
    const reply = await typed(stub, connectionId, "gate-after", "wait", shiftTs(row.channel_message_id!, 5));
    expect(reply).toMatchObject({ status: "queued", duplicate: false });
    const turnId = (reply as { turnId: string }).turnId;
    await waitForTurn(sessionId, turnId, "completed");
    const input = await renderedInput(sessionId, turnId);
    expect(input.answer).toBeUndefined();
    expect(input.openQuestion).toEqual(openQuestionOf(questionId));
    expect((await questionRow(sessionId, questionId)).closed_reason).toBe("superseded");
    // A text gate has no card to rewrite.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(updates()).toEqual([]);
  });

  it("(6b) when the card and its plain-text gate both fail for good, the question closes undeliverable and runs what it held", async () => {
    failPosts = "channel_not_found";
    const { sessionId, stub, connectionId, questionId } = await askedInSlack("p2-undeliverable", "ca".repeat(32));
    await until(
      async () => {
        await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));
        return questionRow(sessionId, questionId);
      },
      (row) => row.closed_reason !== null,
      "the undeliverable close",
    );
    expect((await questionRow(sessionId, questionId)).closed_reason).toBe("undeliverable");
    // The card, then the plain-text gate: both refused.
    expect(posts()).toHaveLength(2);
    expect(JSON.stringify(posts()[1]!.body)).toContain("Reply with one of: Go · Wait");
    expect((await snapshotOf(sessionId)).question).toBeNull();
    expect(updates()).toEqual([]);
    // With the question closed, the next message is an ordinary turn.
    failPosts = null;
    const next = await typed(stub, connectionId, "next", "hello", `${String(Math.floor(Date.now() / 1000))}.000001`);
    expect(next).toMatchObject({ status: "queued" });
  });

  it("(7) a question without options posts its text only", async () => {
    const { sessionId, questionId } = await askedInSlack("p2-plain", "cb".repeat(32), "[ask-plain call-plain]");
    await cardPosted(sessionId, questionId);
    expect(posts()).toHaveLength(1);
    const blocks = blocksOf(posts()[0]!);
    expect(blocks.map((block) => block.type)).toEqual(["markdown"]);
    expect(blocks[0]!.text).toContain("Which approach?");
  });

  it("(10) hold and flow side by side: the same message waits behind a question asked without a channel, and runs beside a Slack question", async () => {
    // hold: the question was asked by an API turn; nothing posted it anywhere.
    const held = await askedSession("modes-hold", "71".repeat(32));
    const heldReceipt = await postTurn(held.sessionId, "Use the staging database.", "modes-1");
    expect(heldReceipt.status).toBe(202);
    expect(await heldReceipt.json()).toEqual({
      status: "held",
      questionId: held.questionId,
      heldId: expect.any(String),
      duplicate: false,
    });
    const holdEvents = await eventsOf(held.sessionId);
    expect(holdEvents.filter((event) => event.type === "message.held")).toHaveLength(1);
    expect((await snapshotOf(held.sessionId)).turns).toHaveLength(1);
    expect((await snapshotOf(held.sessionId)).question?.id).toBe(held.questionId);

    // flow: the question was asked in a Slack thread and posted as a card.
    const flowing = await askedInSlack("modes-flow", "72".repeat(32));
    const row = await cardPosted(flowing.sessionId, flowing.questionId);
    const flowReceipt = await typed(
      flowing.stub,
      flowing.connectionId,
      "modes-1",
      "Use the staging database.",
      shiftTs(row.channel_message_id!, 5),
    );
    expect(flowReceipt).toMatchObject({ status: "queued", duplicate: false });
    const turnId = (flowReceipt as { turnId: string }).turnId;
    const flowEvents = await waitForTurn(flowing.sessionId, turnId, "completed");
    expect(flowEvents.filter((event) => event.type === "message.held")).toEqual([]);
    expect((await snapshotOf(flowing.sessionId)).turns).toHaveLength(2);
    expect((await questionRow(flowing.sessionId, flowing.questionId)).closed_reason).toBe("superseded");
    expect((await modelTextOf(flowing.sessionId, turnId)).startsWith('Open question: "Which approach?" (options: Go · Wait).')).toBe(true);
    // The held question is untouched by any of this, and its answer reads
    // as before: steering, no open question, no line in the model's text.
    expect((await snapshotOf(held.sessionId)).question?.id).toBe(held.questionId);
    const answer = await admitted(await postTurn(held.sessionId, "go", "modes-answer", { answers: held.questionId }));
    await waitForTurn(held.sessionId, answer.turnId, "completed");
    const answerInput = await renderedInput(held.sessionId, answer.turnId);
    expect(answerInput.openQuestion).toBeUndefined();
    expect((answerInput.steering as Array<{ text: string }>).map((entry) => entry.text)).toEqual([
      "Use the staging database.",
    ]);
    expect(await modelTextOf(held.sessionId, answer.turnId)).toBe("go");
  });

  it("(11) flow: a Slack message queued behind the asking turn is not held when the question opens; it runs with the question and supersedes it", async () => {
    const { sessionId, stub, connectionId, questionId: firstQuestion } = await askedInSlack("modes-queued", "73".repeat(32));
    await cardPosted(sessionId, firstQuestion);
    // The first question is answered by a click, so the thread starts clean.
    await stub.answerQuestionFromChannel({
      questionId: firstQuestion,
      optionIndex: 0,
      externalUserId: OWNER,
      actionTimestamp: "1700000000.000101",
      connectionId,
    });
    await until(() => snapshotOf(sessionId), (current) => current.turns.length === 2 && current.turns[1]!.status === "completed", "the answer turn");
    // A turn that works for a while and then asks, and a message written meanwhile.
    const asking = await typed(stub, connectionId, "queued-ask", "Plan. [stall 300ms] [ask call-second]", `${String(Math.floor(Date.now() / 1000))}.000201`);
    const askingTurnId = (asking as { turnId: string }).turnId;
    await waitForEvents(sessionId, (events) =>
      events.some((event) => event.turnId === askingTurnId && event.type === "turn.started"),
    );
    const meanwhile = await typed(stub, connectionId, "queued-meanwhile", "Written while it worked.", `${String(Math.floor(Date.now() / 1000))}.000202`);
    expect(meanwhile).toMatchObject({ status: "queued" });
    const meanwhileId = (meanwhile as { turnId: string }).turnId;
    await waitForTurn(sessionId, askingTurnId, "completed");
    const questionId = await questionIdFor(askingTurnId, "call-second");
    const events = await waitForTurn(sessionId, meanwhileId, "completed");
    // Never converted into a held input.
    expect(events.filter((event) => event.type === "message.held")).toEqual([]);
    expect(events.some((event) => event.turnId === meanwhileId && event.type === "turn.cancelled")).toBe(false);
    expect((await renderedInput(sessionId, meanwhileId)).openQuestion).toEqual(openQuestionOf(questionId));
    expect((await questionRow(sessionId, questionId)).closed_reason).toBe("superseded");
  });

  it("(12) a question a member agent answers (consult) still holds Slack messages behind it", async () => {
    const { sessionId, stub, connectionId, questionId } = await askedInSlack("modes-consult", "74".repeat(32));
    await cardPosted(sessionId, questionId);
    // The open question becomes a consult's: what decides is the
    // consultation row, whatever channel the turn replies on.
    await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
      commitConsultation(
        state.storage.sql,
        { questionId, memberRef: "reviewer", prompt: "Look." },
        new Date().toISOString(),
      );
    });
    const receipt = await typed(stub, connectionId, "consult-held", "Any news?", `${String(Math.floor(Date.now() / 1000) + 60)}.000001`);
    expect(receipt).toEqual({ status: "held", questionId, heldId: expect.any(String), duplicate: false });
    const events = await eventsOf(sessionId);
    expect(events.filter((event) => event.type === "message.held")).toHaveLength(1);
    expect((await snapshotOf(sessionId)).question?.id).toBe(questionId);
  });

  // K25: OpenCode writes one assistant message per model call, so an `ask`
  // the model makes in a step of its own is a response with no text. The
  // card, message.completed and the outcome carry the last text written.
  async function cardMarkdown(sessionId: string, questionId: string): Promise<string> {
    await cardPosted(sessionId, questionId);
    expect(posts()).toHaveLength(1);
    return String(blocksOf(posts()[0]!)[0]!.text);
  }

  it("(9a) text, then an ask in a model call of its own: the card's snapshot is the text", async () => {
    const { sessionId, questionId, askingTurnId } = await askedInSlack(
      "p2-own-step",
      "d1".repeat(32),
      "[ask-own-step] [ask call-ask]",
    );
    expect(await finalTextOf(sessionId, askingTurnId)).toBe("Managed OpenCode is");
    expect((await cardMarkdown(sessionId, questionId)).startsWith("Managed OpenCode is\n\nWhich approach? [↗](")).toBe(true);
  });

  it("(9b) text, a tool call, more text, then an ask in a model call of its own: the snapshot is the later text", async () => {
    const { sessionId, questionId, askingTurnId } = await askedInSlack(
      "p2-later-text",
      "d2".repeat(32),
      "[long-progress] [ask-own-step] [ask call-ask]",
    );
    expect(await finalTextOf(sessionId, askingTurnId)).toBe("Final answer: 42.");
    const markdown = await cardMarkdown(sessionId, questionId);
    expect(markdown.startsWith("Final answer: 42.\n\nWhich approach? [↗](")).toBe(true);
    expect(markdown).not.toContain("Progress:");
  });

  it("(9c) no text anywhere in the asking turn: the snapshot is empty and the card is the question alone", async () => {
    const { sessionId, questionId, askingTurnId } = await askedInSlack(
      "p2-no-text",
      "d3".repeat(32),
      "[silent] [ask-own-step] [ask call-ask]",
    );
    expect(await finalTextOf(sessionId, askingTurnId)).toBe("");
    expect((await cardMarkdown(sessionId, questionId)).startsWith("Which approach? [↗](")).toBe(true);
  });

  // K49: the agent's findings reach the card through the `ask` call's
  // `context` argument, which replaces the turn's final text as the snapshot.
  const CONTEXT = "Found *two* callers of the token: `api.ts` and `cli.ts`.";

  it("(13a) ask with context and no text: the card shows the context, then the question", async () => {
    const { sessionId, questionId, askingTurnId } = await askedInSlack(
      "p2-context-only",
      "f1".repeat(32),
      `[silent] [ask-own-step] [ask-context ${CONTEXT}] [ask call-ask]`,
    );
    expect(await finalTextOf(sessionId, askingTurnId)).toBe("");
    expect((await cardMarkdown(sessionId, questionId)).startsWith(`${CONTEXT}\n\nWhich approach? [↗](`)).toBe(true);
  });

  it("(13b) ask with context after earlier text: the context is the snapshot, not the text", async () => {
    const { sessionId, questionId, askingTurnId } = await askedInSlack(
      "p2-context-wins",
      "f2".repeat(32),
      `[ask-own-step] [ask-context ${CONTEXT}] [ask call-ask]`,
    );
    expect(await finalTextOf(sessionId, askingTurnId)).toBe("Managed OpenCode is");
    const markdown = await cardMarkdown(sessionId, questionId);
    expect(markdown.startsWith(`${CONTEXT}\n\nWhich approach? [↗](`)).toBe(true);
    expect(markdown).not.toContain("Managed OpenCode is");
  });

  it("(13c) the context stays on the card when a click answers it and when a typed reply supersedes it", async () => {
    const answered = await askedInSlack("p2-context-click", "f3".repeat(32), `[ask-context ${CONTEXT}] [ask call-ask]`);
    await cardPosted(answered.sessionId, answered.questionId);
    expect(String(blocksOf(posts()[0]!)[0]!.text).startsWith(`${CONTEXT}\n\nWhich approach?`)).toBe(true);
    await click(answered.appId, answered.questionId, 0, OWNER, "1700000000.000301");
    let update = await until(() => updates(), (current) => current.length === 1, "the answered card");
    expect(blocksOf(update[0]!).map((block) => block.type)).toEqual(["markdown", "context"]);
    expect(String(blocksOf(update[0]!)[0]!.text).startsWith(`${CONTEXT}\n\nWhich approach?`)).toBe(true);
    expect(JSON.stringify(blocksOf(update[0]!)[1])).toContain(`chosen: Go · by <@${OWNER}>`);

    const superseded = await askedInSlack("p2-context-typed", "f4".repeat(32), `[ask-context ${CONTEXT}] [ask call-ask]`);
    const row = await cardPosted(superseded.sessionId, superseded.questionId);
    const reply = await typed(superseded.stub, superseded.connectionId, "ctx-typed", "go", shiftTs(row.channel_message_id!, 5));
    await waitForTurn(superseded.sessionId, (reply as { turnId: string }).turnId, "completed");
    update = await until(() => updates(), (current) => current.length === 2, "the superseded card");
    expect(String(blocksOf(update[1]!)[0]!.text).startsWith(`${CONTEXT}\n\nWhich approach?`)).toBe(true);
    expect(JSON.stringify(blocksOf(update[1]!)[1])).toContain("answered in the thread");
  });

  it("(13d) a refused card's plain-text gate carries the context above the question", async () => {
    refuseCards = true;
    const { sessionId, questionId } = await askedInSlack("p2-context-gate", "f5".repeat(32), `[ask-context ${CONTEXT}] [ask call-ask]`);
    await cardPosted(sessionId, questionId);
    expect(posts()).toHaveLength(2);
    const gate = posts()[1]!;
    const markdown = String((blocksOf(gate)[0] ?? {}).text ?? gate.body.text);
    expect(markdown.startsWith(`${CONTEXT}\n\nWhich approach?`)).toBe(true);
    expect(markdown).toContain("Reply with one of: Go · Wait");
  });
});

describe("Linear service calls in a connection-owned session", () => {
  type Call = { connectionId: string; query: string; variables?: Record<string, unknown> };

  async function ownedBy(sessionId: string, userId: string): Promise<void> {
    await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET user_id = ?", userId);
    });
  }

  async function withStore(store: Partial<LinearConnectionStore>): Promise<void> {
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (instance) => {
      (instance as unknown as { linearConnections: LinearConnectionStore }).linearConnections = {
        ...unavailableLinearConnectionStore(),
        ...store,
      };
    });
  }

  async function callLinear(sessionId: string, body: Record<string, unknown>): Promise<Response> {
    return SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/connections/linear/fetch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeTokens.get(sessionId)!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ service: "linear", ...body }),
    });
  }

  /** A connection bound where the session runs, as `get` reports it. */
  async function boundTo(sessionId: string, connectionId: string): Promise<LinearConnectionStore["get"]> {
    const snapshot = await snapshotOf(sessionId);
    return (id) =>
      id === connectionId
        ? {
            id,
            projectId: snapshot.projectId,
            environment: snapshot.environment!,
            agentId: snapshot.agentId,
            name: "Example Agent",
            status: "connected",
            revision: 1,
            createdAt: "2026-10-02T10:00:00.000Z",
            updatedAt: "2026-10-02T10:00:00.000Z",
          }
        : null;
  }

  it("calls POST /graphql with the connection's app token and never a person's grant", async () => {
    const sessionId = await createWorkerdSession("linear-owned", "9".repeat(64), ["linear"]);
    await ownedBy(sessionId, linearConnectionPrincipal("conn-linear-1"));
    const calls: Call[] = [];
    const bound = await boundTo(sessionId, "conn-linear-1");
    await withStore({
      get: bound,
      graphql: async (connectionId, request) => {
        calls.push({ connectionId, ...request });
        return { outcome: "ok", data: { viewer: { id: "app-user" } } };
      },
    });
    const ok = await callLinear(sessionId, {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ query: "query { viewer { id } }", variables: { a: 1 } }),
    });
    expect(ok.status).toBe(200);
    const envelope = (await ok.json()) as { status: number; body: string };
    expect(envelope.status).toBe(200);
    expect(JSON.parse(envelope.body)).toEqual({ data: { viewer: { id: "app-user" } } });
    expect(calls).toEqual([{ connectionId: "conn-linear-1", query: "query { viewer { id } }", variables: { a: 1 } }]);

    const get = await callLinear(sessionId, { method: "GET", path: "/graphql" });
    expect(get.status).toBe(405);
    expect(await get.json()).toMatchObject({ error: { code: "linear_method_not_allowed" } });
    const elsewhere = await callLinear(sessionId, {
      method: "POST",
      path: "/oauth/token",
      body: JSON.stringify({ query: "x" }),
    });
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({ error: { code: "linear_path_not_allowed" } });
    expect(calls).toHaveLength(1);

    // An unavailable connection is a clear error, never a fallback to Composio.
    await withStore({ get: bound, graphql: async () => ({ outcome: "unavailable", reason: "revoked" }) });
    const revoked = await callLinear(sessionId, {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ query: "query { viewer { id } }" }),
    });
    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toMatchObject({ error: { code: "linear_connection_unavailable" } });
  });

  it("refuses with 403 when the owning connection is not bound to the session's project, environment and agent", async () => {
    const sessionId = await createWorkerdSession("linear-mismatch", "cd".repeat(32), ["linear"]);
    await ownedBy(sessionId, linearConnectionPrincipal("conn-linear-3"));
    const bound = await boundTo(sessionId, "conn-linear-3");
    const graphql = vi.fn(async () => ({ outcome: "ok" as const, data: {} }));
    for (const change of [{ projectId: "project_other" }, { environment: "production" as const }, { agentId: "agent_other" }]) {
      await withStore({ get: (id) => ({ ...bound(id)!, ...change }), graphql });
      const refused = await callLinear(sessionId, {
        method: "POST",
        path: "/graphql",
        body: JSON.stringify({ query: "query { viewer { id } }" }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "linear_connection_mismatch" } });
    }
    expect(graphql).not.toHaveBeenCalled();
  });

  it("requires the deployment to declare the service", async () => {
    const sessionId = await createWorkerdSession("linear-undeclared", "0".repeat(64));
    await ownedBy(sessionId, linearConnectionPrincipal("conn-linear-2"));
    await withStore({ graphql: async () => ({ outcome: "ok", data: {} }) });
    const refused = await callLinear(sessionId, {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ query: "query { viewer { id } }" }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "connection_not_declared" } });
  });

  it("leaves a person-owned session on today's path", async () => {
    const sessionId = await createWorkerdSession("linear-person", "ab".repeat(32), ["linear"]);
    const graphql = vi.fn(async () => ({ outcome: "ok" as const, data: {} }));
    await withStore({ graphql });
    const response = await callLinear(sessionId, {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ query: "query { viewer { id } }" }),
    });
    // No person grant exists here: today's answer, and the app token was never used.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "connection_not_found" } });
    expect(graphql).not.toHaveBeenCalled();
  });
});
