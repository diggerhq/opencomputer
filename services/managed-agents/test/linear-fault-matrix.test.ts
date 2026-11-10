import { abortAllDurableObjects, env, reset, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { questionIdFor } from "../src/ask.js";
import { SINGLE_ENVIRONMENT } from "../src/edge/project-scope.js";
import type { AgentEvent, SessionSnapshot } from "../src/protocol.js";
import {
  account,
  BASE,
  connectLinear,
  createProject,
  deliver,
  driveAccount,
  elapse,
  installFakeLinear,
  ledger,
  ledgerRows,
  mapEntries,
  recordedActivity,
  recordedActivityCreatedAt,
  recordedDelivery,
  shiftToNow,
  until,
  type FakeLinear,
  type LinearFixture,
} from "./linear-playback.js";

/**
 * Work 037 Phase 2a: the fault matrix, end to end inside the Workers test
 * harness. Each case plays the provider spike's recorded deliveries (re-signed,
 * moved to now with their createdAt relations intact) into the real edge
 * route; the Account object's ledger and alarm admit them into the Session
 * object, which runs turns on the fake Workerd runtime and posts activities
 * through its queue to a fake Linear API. Test names are the matrix's lines.
 *
 * Playback indices (test/fixtures/linear/spike-playback.json): 0 `created`
 * on Linear session 00000000-0000-4000-8000-000000000004; 31, 33, 36, 39, 46, 55, 57 `prompted` on it
 * (57 written before the elicitation at 54, 55 after it); 42 its `stop`;
 * 59 `created` and 64 `prompted` on session 00000000-0000-4000-8000-00000000005d; 66 Linear's
 * "Argument Validation Error".
 */

let linear: FakeLinear;

beforeEach(async () => {
  linear = installFakeLinear();
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

/**
 * A project whose agent runs on the fake Workerd runtime, with a connected
 * Linear connection. New projects are single-environment: the deploy route
 * resolves an alias to the project's one scope before registering, so this
 * direct registration names that scope itself. The connection keeps
 * `development`, which admission resolves to the same scope.
 */
async function linearAgent(slug: string): Promise<LinearFixture> {
  const project = await createProject(slug);
  await account().registerDeployment({
    agentId: project.agentId,
    accountId: "local",
    alias: SINGLE_ENVIRONMENT,
    runtimeMode: "workerd-lazy-sandbox",
    channels: [],
    connections: [],
    artifact: {
      bucket: "managed-agent-artifacts",
      key: `accounts/local/agents/${project.agentId}/artifact.json`,
      digest: "f".repeat(64),
      size: 512,
    },
    imageArn: "test-image",
    imageVersion: "1",
  });
  return connectLinear(project);
}

async function eventsOf(sessionId: string): Promise<AgentEvent[]> {
  const response = await SELF.fetch(`${BASE}/v1/sessions/${encodeURIComponent(sessionId)}/events`);
  expect(response.status).toBe(200);
  return (await response.json<{ events: AgentEvent[] }>()).events;
}

async function snapshotOf(sessionId: string): Promise<SessionSnapshot> {
  const response = await SELF.fetch(`${BASE}/v1/sessions/${encodeURIComponent(sessionId)}`);
  expect(response.status).toBe(200);
  return response.json<SessionSnapshot>();
}

interface ActivityRow {
  id: string;
  seq: number;
  kind: string;
  state: string;
  content_json: string;
  turn_id: string | null;
  question_id: string | null;
  error: string | null;
}

async function queueOf(sessionId: string): Promise<ActivityRow[]> {
  return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
    const exists = state.storage.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'linear_activities'")
      .toArray().length;
    return exists
      ? (state.storage.sql.exec("SELECT * FROM linear_activities ORDER BY seq").toArray() as unknown as ActivityRow[])
      : [];
  });
}

/** Linear's view: the type and body of each activity it holds for a session. */
function thread(agentSessionId: string): string[] {
  return linear.posted(agentSessionId).map((activity) => `${activity.content.type}:${activity.content.body ?? activity.content.action ?? ""}`);
}

async function admittedTurn(deliveryId: string): Promise<{ sessionId: string; turnId: string }> {
  let row = await ledger(deliveryId);
  await driveAccount(async () => {
    row = await ledger(deliveryId);
    return row?.state === "admitted";
  }, `delivery ${deliveryId} to be admitted`);
  const receipt = JSON.parse(row!.receipt_json!) as { sessionId: string; turnId: string };
  return receipt;
}

async function turnSettled(sessionId: string, turnId: string, status: string): Promise<AgentEvent[]> {
  let events: AgentEvent[] = [];
  await until(
    async () => {
      events = await eventsOf(sessionId);
      return events.some((event) => event.turnId === turnId && event.type === `turn.${status}`);
    },
    `turn ${turnId} to be ${status}`,
    [sessionId],
  );
  return events;
}

async function posted(agentSessionId: string, count: number, sessionIds: string[]): Promise<string[]> {
  await until(async () => linear.posted(agentSessionId).length >= count, `${String(count)} Linear activities`, sessionIds);
  return thread(agentSessionId);
}


/** The question the fake runtime's `[ask call-…]` directive asks. */
const ASKED = { text: "Which approach?", options: [{ label: "Go", value: "go" }, { label: "Wait", value: "wait" }] };

/** Append a fake-runtime directive to a created delivery's prompt context (the turn's text). */
function directive(text: string) {
  return (body: { promptContext?: string | null }) => {
    body.promptContext = `${body.promptContext ?? ""} ${text}`;
  };
}

/** Append a fake-runtime directive to a prompt's body (the turn's text). */
function promptDirective(text: string) {
  return (body: { agentActivity?: { content: { body: string } } }) => {
    body.agentActivity!.content.body = `${body.agentActivity!.content.body} ${text}`;
  };
}

async function renderedInput(sessionId: string, turnId: string): Promise<Record<string, unknown>> {
  let events: AgentEvent[] = [];
  await until(async () => {
    events = await eventsOf(sessionId);
    return events.some((event) => event.turnId === turnId && event.type === "agent.rendered");
  }, `turn ${turnId} to render`, [sessionId]);
  const rendered = events.find((event) => event.turnId === turnId && event.type === "agent.rendered")!;
  return (rendered.data as { input: Record<string, unknown> }).input;
}

/**
 * Wrap the Account object's view of the Session objects (its ingress is
 * rebuilt over the wrapped namespace): `intercept` may replace any RPC the
 * ledger makes. Returns the restore.
 */
type SessionRpc = (real: Record<string, (...args: unknown[]) => Promise<unknown>>, ...args: unknown[]) => Promise<unknown>;

async function interceptSessions(intercept: Record<string, SessionRpc>): Promise<() => Promise<void>> {
  let original: unknown;
  await runInDurableObject(account(), (instance) => {
    const host = instance as unknown as { env: Record<string, unknown>; linearIngressInstance?: unknown };
    original = host.env;
    const sessions = host.env.SESSIONS as { getByName(name: string): Record<string, (...args: unknown[]) => Promise<unknown>> };
    host.env = {
      ...host.env,
      SESSIONS: new Proxy(sessions, {
        get(target, property) {
          if (property !== "getByName") {
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
          return (name: string) => {
            const real = target.getByName(name);
            return new Proxy(real, {
              get(stub, method) {
                const handler = typeof method === "string" ? intercept[method] : undefined;
                if (handler) return (...args: unknown[]) => handler(real, ...args);
                // RPC stub methods are called through the stub, never bound.
                return (...args: unknown[]) => (stub as Record<string | symbol, (...a: unknown[]) => unknown>)[method]!(...args);
              },
            });
          };
        },
      }),
    };
    host.linearIngressInstance = undefined;
  });
  return async () => {
    await runInDurableObject(account(), (instance) => {
      const host = instance as unknown as { env: unknown; linearIngressInstance?: unknown };
      host.env = original;
      host.linearIngressInstance = undefined;
    });
  };
}

async function controlsOf(sessionId: string): Promise<Array<{ delivery_id: string; applied_at: string }>> {
  return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
    state.storage.sql.exec("SELECT delivery_id, applied_at FROM controls").toArray() as Array<{
      delivery_id: string;
      applied_at: string;
    }>,
  );
}

/** Start the recorded session 00000000-0000-4000-8000-000000000004 and wait for its first turn to be running or settled. */
async function startSession(
  fixture: LinearFixture,
  text: string,
): Promise<{ sessionId: string; turnId: string; agentSessionId: string; deliveryId: string }> {
  const created = await deliver(fixture, 0, { shiftMs: shiftToNow(0), edit: directive(text) });
  const { sessionId, turnId } = await admittedTurn(created.deliveryId);
  return { sessionId, turnId, agentSessionId: created.agentSessionId, deliveryId: created.deliveryId };
}

/** Run a turn that asks (`[ask call-intake]`) and wait for the elicitation to post; returns its Linear createdAt. */
async function askedSession(fixture: LinearFixture) {
  const started = await startSession(fixture, "[ask call-intake]");
  await turnSettled(started.sessionId, started.turnId, "completed");
  const questionId = await questionIdFor(started.turnId, "call-intake");
  await posted(started.agentSessionId, 2, [started.sessionId]);
  const elicitation = linear.posted(started.agentSessionId).find((activity) => activity.content.type === "elicitation")!;
  return { ...started, questionId, elicitation };
}

describe("Linear fault matrix (work 037 Phase 2a)", () => {
  it("a replayed delivery (same Linear-Delivery) changes nothing", async () => {
    const fixture = await linearAgent("lfm-replay");
    const created = await deliver(fixture, 0, { shiftMs: shiftToNow(0) });
    expect(created.accepted).toMatchObject({ ok: true, deliveryId: created.deliveryId, kind: "conversational" });

    // Redelivered before anything was enacted: the stored answer, nothing new.
    const early = await created.send();
    expect(await early.json()).toMatchObject({ ok: true, deliveryId: created.deliveryId, duplicate: true });
    expect(await ledgerRows()).toHaveLength(1);

    const { sessionId, turnId } = await admittedTurn(created.deliveryId);
    await turnSettled(sessionId, turnId, "completed");
    expect(await posted(created.agentSessionId, 2, [sessionId])).toEqual([
      "thought:Reading the issue.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
    const before = await ledger(created.deliveryId);
    const turnsBefore = (await snapshotOf(sessionId)).turns;
    const attemptsBefore = linear.attempts.length;

    // Redelivered after it was admitted and answered.
    const late = await created.send();
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ ok: true, deliveryId: created.deliveryId, duplicate: true });
    await runDurableObjectAlarm(account());
    await runDurableObjectAlarm(env.SESSIONS.getByName(sessionId));

    expect(await ledger(created.deliveryId)).toEqual(before);
    expect(await ledgerRows()).toHaveLength(1);
    expect(await mapEntries()).toHaveLength(1);
    expect((await snapshotOf(sessionId)).turns).toEqual(turnsBefore);
    expect(linear.attempts).toHaveLength(attemptsBefore);
    expect(thread(created.agentSessionId)).toHaveLength(2);
  });

  it("a prompt created before the elicitation is held, then delivered with the answer as steering", async () => {
    const fixture = await linearAgent("lfm-steering");
    const asked = await askedSession(fixture);
    expect(asked.elicitation).toMatchObject({
      content: { type: "elicitation", body: ASKED.text },
      signal: "select",
      signalMetadata: { options: ASKED.options },
    });
    // The recorded relation: 57 was written 30 s before the elicitation at
    // 54 and released later; 55 (the answer) was written after it.
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(54));
    const steering = await deliver(fixture, 57, { shiftMs });
    expect(Date.parse(steering.promptCreatedAt!)).toBeLessThan(Date.parse(asked.elicitation.createdAt));
    await driveAccount(async () => (await ledger(steering.deliveryId))?.state === "admitted", "the steering prompt");
    expect(JSON.parse((await ledger(steering.deliveryId))!.receipt_json!)).toEqual({
      sessionId: asked.sessionId,
      held: true,
      questionId: asked.questionId,
      duplicate: false,
      supersession: 0,
    });
    // Held: no turn of its own, the question still open.
    expect((await snapshotOf(asked.sessionId)).turns).toHaveLength(1);
    expect((await snapshotOf(asked.sessionId)).question?.id).toBe(asked.questionId);
    // Replayed with its key while held: the held receipt again.
    const frozen = JSON.parse(((await ledger(steering.deliveryId)) as unknown as { input_json: string }).input_json) as {
      text: string;
      agentInput: never;
    };
    const replayHeld = () =>
      env.SESSIONS.getByName(asked.sessionId).enqueueTurn({
        input: frozen.text,
        idempotencyKey: `linear:${steering.deliveryId}`,
        agentInput: frozen.agentInput,
        providerTime: steering.promptCreatedAt!,
      });
    expect(await replayHeld()).toEqual({
      status: "held",
      questionId: asked.questionId,
      heldId: expect.any(String),
      duplicate: true,
    });

    const answer = await deliver(fixture, 55, { shiftMs });
    expect(Date.parse(answer.promptCreatedAt!)).toBeGreaterThan(Date.parse(asked.elicitation.createdAt));
    const answered = await admittedTurn(answer.deliveryId);
    expect(answered.sessionId).toBe(asked.sessionId);
    const input = await renderedInput(asked.sessionId, answered.turnId);
    expect(input.answer).toEqual({ questionId: asked.questionId, text: "held" });
    expect(input.steering).toEqual([
      expect.objectContaining({ text: "Fixture message.", providerTime: steering.promptCreatedAt }),
    ]);
    // Replayed once delivered: the receipt of the turn that carried it.
    expect(await replayHeld()).toMatchObject({ turnId: answered.turnId, duplicate: true });
    const events = await turnSettled(asked.sessionId, answered.turnId, "completed");
    expect(events.find((event) => event.type === "question.answered")?.data).toMatchObject({
      questionId: asked.questionId,
    });
    expect(await posted(asked.agentSessionId, 3, [asked.sessionId])).toEqual([
      "thought:Reading the issue.",
      `elicitation:${ASKED.text}`,
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });

  it("the Session object evicted while a question is open, then a reply, continues the same session", async () => {
    const fixture = await linearAgent("lfm-evicted");
    const asked = await askedSession(fixture);
    await abortAllDurableObjects();
    const revived = await snapshotOf(asked.sessionId);
    expect(revived.question?.id).toBe(asked.questionId);

    // 33 ("go") was written 5 minutes after the elicitation recorded at 30.
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(30));
    const reply = await deliver(fixture, 33, { shiftMs });
    const answered = await admittedTurn(reply.deliveryId);
    expect(answered.sessionId).toBe(asked.sessionId);
    expect(await mapEntries()).toEqual([
      expect.objectContaining({ session_id: asked.sessionId, supersession: 0 }),
    ]);
    const input = await renderedInput(asked.sessionId, answered.turnId);
    expect(input.answer).toEqual({ questionId: asked.questionId, text: "go", value: "go" });
    await turnSettled(asked.sessionId, answered.turnId, "completed");
    const snapshot = await snapshotOf(asked.sessionId);
    expect(snapshot.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(snapshot.question ?? null).toBeNull();
    expect(await posted(asked.agentSessionId, 3, [asked.sessionId])).toEqual([
      "thought:Reading the issue.",
      `elicitation:${ASKED.text}`,
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });

  it("a stop with two queued prompts is applied before \"Stopped.\" is posted and discards both", async () => {
    const fixture = await linearAgent("lfm-stop-queued");
    const started = await startSession(fixture, "[stall 30000ms]");
    await until(
      async () => (await snapshotOf(started.sessionId)).turns[0]?.status === "running",
      "the first turn to run",
      [started.sessionId],
    );
    const shiftMs = shiftToNow(42);
    const queued: string[] = [];
    for (const index of [36, 39]) {
      const prompt = await deliver(fixture, index, { shiftMs });
      queued.push((await admittedTurn(prompt.deliveryId)).turnId);
    }
    expect((await snapshotOf(started.sessionId)).turns.map((turn) => turn.status)).toEqual([
      "running",
      "queued",
      "queued",
    ]);

    const stop = await deliver(fixture, 42, { shiftMs });
    expect(stop.accepted).toMatchObject({ kind: "control" });
    expect(stop.body.agentActivity!.signal).toBe("stop");
    await driveAccount(async () => (await ledger(stop.deliveryId))?.state === "confirmed", "the stop to be confirmed");
    const events = await turnSettled(started.sessionId, started.turnId, "cancelled");
    for (const turnId of queued) {
      expect(events.find((event) => event.turnId === turnId && event.type === "turn.cancelled")?.data).toEqual({
        reason: "stopped",
        discarded: true,
      });
      expect(events.some((event) => event.turnId === turnId && event.type === "agent.rendered")).toBe(false);
    }
    const receipt = JSON.parse((await ledger(stop.deliveryId))!.receipt_json!) as {
      control: { interruptedTurnId: string; discardedTurnKeys: string[] };
    };
    expect(receipt.control).toMatchObject({ interruptedTurnId: started.turnId, duplicate: false });
    expect(receipt.control.discardedTurnKeys).toHaveLength(2);

    const thread = await posted(started.agentSessionId, 2, [started.sessionId]);
    expect(thread).toEqual(["thought:Reading the issue.", "error:Stopped."]);
    const stopped = linear.posted(started.agentSessionId).find((activity) => activity.content.body === "Stopped.")!;
    const [control] = await controlsOf(started.sessionId);
    expect(control!.delivery_id).toBe(stop.deliveryId);
    expect(Date.parse(control!.applied_at)).toBeLessThanOrEqual(Date.parse(stopped.createdAt));
    // Settled: nothing more is posted for the discarded prompts.
    await runDurableObjectAlarm(env.SESSIONS.getByName(started.sessionId));
    expect(thread).toEqual(await posted(started.agentSessionId, 2, [started.sessionId]));
    expect(linear.posted(started.agentSessionId)).toHaveLength(2);
  });

  it("a stop whose RPC response is lost is retried after the user has resumed, and the resumed work is untouched", async () => {
    const fixture = await linearAgent("lfm-stop-lost");
    const started = await startSession(fixture, "[stall 30000ms]");
    await until(
      async () => (await snapshotOf(started.sessionId)).turns[0]?.status === "running",
      "the first turn to run",
      [started.sessionId],
    );
    // The Session object applies the stop; the Account never hears back.
    let lose = true;
    const restore = await interceptSessions({
      applyControl: async (real, input) => {
        const result = await real.applyControl!(input);
        if (lose) {
          lose = false;
          throw new Error("Network connection lost.");
        }
        return result;
      },
    });
    const shiftMs = shiftToNow(42);
    const stop = await deliver(fixture, 42, { shiftMs });
    await driveAccount(async () => ((await ledger(stop.deliveryId))?.attempts ?? 0) >= 1, "the stop's first attempt");
    expect(await ledger(stop.deliveryId)).toMatchObject({ state: "accepted", error: "Network connection lost." });
    await turnSettled(started.sessionId, started.turnId, "cancelled");
    await posted(started.agentSessionId, 2, [started.sessionId]);

    // The user resumes: 46 was written after the stop.
    const resume = await deliver(fixture, 46, { shiftMs, edit: promptDirective("[stall 1500ms]") });
    expect(Date.parse(resume.promptCreatedAt!)).toBeGreaterThan(Date.parse(stop.body.agentActivity!.createdAt));
    // The stop is retried (its backoff elapsed); its recorded result comes back.
    await elapse(stop.deliveryId);
    const resumed = await admittedTurn(resume.deliveryId);
    expect(resumed.sessionId).toBe(started.sessionId);
    const stopRow = (await ledger(stop.deliveryId))!;
    expect(stopRow.state).toBe("confirmed");
    expect(JSON.parse(stopRow.receipt_json!)).toMatchObject({
      control: { deliveryId: stop.deliveryId, duplicate: true, interruptedTurnId: started.turnId },
    });
    await restore();

    // Any further retry of the same stop, while the resumed turn runs, is the
    // recorded result and touches nothing.
    await until(
      async () => (await snapshotOf(started.sessionId)).turns.find((turn) => turn.id === resumed.turnId)?.status === "running",
      "the resumed turn to run",
      [started.sessionId],
    );
    const again = await env.SESSIONS.getByName(started.sessionId).applyControl({
      deliveryId: stop.deliveryId,
      kind: "stop",
      providerTime: stop.body.agentActivity!.createdAt,
    });
    expect(again).toMatchObject({ duplicate: true, interruptedTurnId: started.turnId });
    await turnSettled(started.sessionId, resumed.turnId, "completed");
    expect(await posted(started.agentSessionId, 3, [started.sessionId])).toEqual([
      "thought:Reading the issue.",
      "error:Stopped.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
    expect(await controlsOf(started.sessionId)).toHaveLength(1);
  });

  it("a prompt still pending in the ledger when a stop is applied is invalidated and never admitted", async () => {
    const fixture = await linearAgent("lfm-stop-pending");
    const started = await startSession(fixture, "");
    await turnSettled(started.sessionId, started.turnId, "completed");
    await posted(started.agentSessionId, 2, [started.sessionId]);
    // The prompt's admission fails before it reaches the Session object, so
    // it waits in the ledger for its retry.
    const restore = await interceptSessions({
      enqueueTurn: async () => {
        throw new Error("Network connection lost.");
      },
    });
    const shiftMs = shiftToNow(42);
    const pending = await deliver(fixture, 39, { shiftMs });
    await driveAccount(async () => ((await ledger(pending.deliveryId))?.attempts ?? 0) >= 1, "the prompt's failed attempt");
    expect(await ledger(pending.deliveryId)).toMatchObject({ state: "acknowledged" });

    const stop = await deliver(fixture, 42, { shiftMs });
    await driveAccount(async () => (await ledger(stop.deliveryId))?.state === "confirmed", "the stop");
    await restore();
    expect(await ledger(pending.deliveryId)).toMatchObject({
      state: "invalidated",
      next_attempt_at: null,
      error: `stopped by ${stop.deliveryId}`,
    });
    // A prompt written before the stop and released by Linear after it
    // (spike part 5) is invalidated as it is accepted.
    const released = await deliver(fixture, 36, { shiftMs });
    expect(await ledger(released.deliveryId)).toMatchObject({ state: "invalidated", next_attempt_at: null });

    await elapse(pending.deliveryId);
    await runDurableObjectAlarm(account());
    const session = env.SESSIONS.getByName(started.sessionId);
    expect(await session.findTurn(`linear:${pending.deliveryId}`)).toBeNull();
    expect(await session.findTurn(`linear:${released.deliveryId}`)).toBeNull();
    expect((await snapshotOf(started.sessionId)).turns).toHaveLength(1);
    // The stop reached an idle session: confirmed once, by the Session object.
    expect(await posted(started.agentSessionId, 3, [started.sessionId])).toEqual([
      "thought:Reading the issue.",
      "response:Managed OpenCode is running in the Durable Object.",
      "error:Stopped.",
    ]);
  });

  it("an elicitation with an invalid payload is marked permanently failed and the next response still posts", async () => {
    const fixture = await linearAgent("lfm-invalid-elicitation");
    // Linear refuses the elicitation as recorded at 66.
    let refused = false;
    linear.reject = (input) => {
      if (input.content.type !== "elicitation" || refused) return undefined;
      refused = true;
      return recordedActivity(66).response;
    };
    const started = await startSession(fixture, "[ask call-intake]");
    await turnSettled(started.sessionId, started.turnId, "completed");
    let queue: ActivityRow[] = [];
    await until(async () => {
      queue = await queueOf(started.sessionId);
      return queue.some((row) => row.state === "failed_permanent");
    }, "the elicitation to fail", [started.sessionId]);
    const failed = queue.find((row) => row.question_id)!;
    expect(failed).toMatchObject({ kind: "terminal", state: "failed_permanent" });
    expect(failed.error).toContain("Argument Validation Error");
    const events = await eventsOf(started.sessionId);
    expect(events.find((event) => event.type === "delivery.failed")?.data).toMatchObject({
      channel: "linear",
      activityId: failed.id,
      contentType: "elicitation",
      state: "failed_permanent",
    });
    expect(linear.attempts.filter((attempt) => attempt.input.content.type === "elicitation")).toHaveLength(1);

    // The person replies anyway (33, written now, after the failed
    // elicitation): the conversation goes on.
    const reply = await deliver(fixture, 33, {
      shiftMs: Date.now() - Date.parse(recordedDelivery(33).body.agentActivity!.createdAt),
    });
    const next = await admittedTurn(reply.deliveryId);
    expect(next.sessionId).toBe(started.sessionId);
    await turnSettled(started.sessionId, next.turnId, "completed");
    expect(await posted(started.agentSessionId, 2, [started.sessionId])).toEqual([
      "thought:Reading the issue.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });

  it("a `prompted` arriving before its `created` creates the session once and the late `created` adds no turn", async () => {
    const fixture = await linearAgent("lfm-prompt-first");
    linear.issueCreator = "00000000-0000-4000-8000-000000000003";
    linear.issueParent = { id: "00000000-0000-4000-8000-000000000006", identifier: "OPE-102" };
    const shiftMs = shiftToNow(64);
    const prompt = await deliver(fixture, 64, { shiftMs });
    const first = await admittedTurn(prompt.deliveryId);
    const input = await renderedInput(first.sessionId, first.turnId);
    expect(input).toMatchObject({
      text: "plan",
      payload: {
        action: "prompted",
        origin: { parent: { id: linear.issueParent.id, identifier: "OPE-102" }, createdByAgent: true },
      },
    });
    expect(linear.queries.some((query) => /agentSession\s*\(/.test(query.query))).toBe(true);
    await turnSettled(first.sessionId, first.turnId, "completed");

    const late = await deliver(fixture, 59, { shiftMs });
    await driveAccount(async () => (await ledger(late.deliveryId))?.state === "invalidated", "the late created");
    expect(JSON.parse((await ledger(late.deliveryId))!.receipt_json!)).toMatchObject({
      superseded: true,
      reason: "created_after_prompted",
      sessionId: first.sessionId,
      by: prompt.deliveryId,
    });
    expect(await mapEntries()).toEqual([
      expect.objectContaining({
        agent_session_id: prompt.agentSessionId,
        session_id: first.sessionId,
        origin_delivery_id: prompt.deliveryId,
        prompt_context: late.body.promptContext,
      }),
    ]);
    expect((await snapshotOf(first.sessionId)).turns).toHaveLength(1);
    expect(await posted(prompt.agentSessionId, 1, [first.sessionId])).toEqual([
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
    await runDurableObjectAlarm(account());
    expect(thread(prompt.agentSessionId)).toHaveLength(1);
  });

  it("a crash between accepting a delivery and acknowledging it is recovered by the alarm", async () => {
    const fixture = await linearAgent("lfm-crash");
    // The acknowledgement reaches Linear, which stores it, and the Account
    // object dies before the answer comes back.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    linear.delay = (input) => (input.content.type === "thought" ? held : undefined);
    const created = await deliver(fixture, 0, { shiftMs: shiftToNow(0) });
    const accepted = (await ledger(created.deliveryId))!;
    expect(accepted).toMatchObject({ state: "accepted", ack_state: "pending" });
    const ackId = accepted.ack_activity_id!;
    const inFlight = runDurableObjectAlarm(account()).catch(() => false);
    await until(async () => linear.activities.has(ackId), "the acknowledgement to reach Linear");
    await abortAllDurableObjects();
    release();
    await inFlight;
    linear.delay = undefined;
    expect(await ledger(created.deliveryId)).toMatchObject({ state: "accepted", ack_state: "pending" });

    // The alarm, once the crashed attempt's lease has run out, finishes it:
    // the same activity id, reconciled as already posted.
    await elapse(created.deliveryId);
    const { sessionId, turnId } = await admittedTurn(created.deliveryId);
    expect(await ledger(created.deliveryId)).toMatchObject({ ack_state: "posted", ack_activity_id: ackId });
    expect(linear.attempts.filter((attempt) => attempt.input.id === ackId).map((attempt) => attempt.outcome)).toEqual([
      "created",
      "conflict",
    ]);
    await turnSettled(sessionId, turnId, "completed");
    expect(await posted(created.agentSessionId, 2, [sessionId])).toEqual([
      "thought:Reading the issue.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
    expect(await mapEntries()).toHaveLength(1);
  });

  it("a turn replayed with the same key returns its original receipt", async () => {
    const fixture = await linearAgent("lfm-turn-replay");
    const started = await startSession(fixture, "");
    await turnSettled(started.sessionId, started.turnId, "completed");
    // The Session object admits the prompt; its answer is lost on the way back.
    let lose = true;
    let original: unknown;
    const restore = await interceptSessions({
      enqueueTurn: async (real, input) => {
        const result = await real.enqueueTurn!(input);
        if (lose) {
          lose = false;
          original = result;
          throw new Error("Network connection lost.");
        }
        return result;
      },
    });
    const prompt = await deliver(fixture, 31, { shiftMs: shiftToNow(31) });
    await driveAccount(async () => ((await ledger(prompt.deliveryId))?.attempts ?? 0) >= 1, "the lost admission");
    expect(original).toMatchObject({ duplicate: false });
    const firstTurnId = (original as { turnId: string }).turnId;
    await elapse(prompt.deliveryId);
    const replayed = await admittedTurn(prompt.deliveryId);
    await restore();
    expect(JSON.parse((await ledger(prompt.deliveryId))!.receipt_json!)).toEqual({
      sessionId: started.sessionId,
      turnId: firstTurnId,
      duplicate: true,
      supersession: 0,
    });
    expect(replayed.turnId).toBe(firstTurnId);
    // The Session object answers a direct replay with the same turn.
    const frozen = (await ledger(prompt.deliveryId)) as unknown as { input_json: string };
    const { text, agentInput } = JSON.parse(frozen.input_json) as { text: string; agentInput: never };
    const again = await env.SESSIONS.getByName(started.sessionId).enqueueTurn({
      input: text,
      idempotencyKey: `linear:${prompt.deliveryId}`,
      agentInput,
      providerTime: prompt.promptCreatedAt!,
    });
    expect(again).toMatchObject({ turnId: firstTurnId, duplicate: true });
    await turnSettled(started.sessionId, firstTurnId, "completed");
    expect((await snapshotOf(started.sessionId)).turns).toHaveLength(2);
    expect(await posted(started.agentSessionId, 3, [started.sessionId])).toEqual([
      "thought:Reading the issue.",
      "response:Managed OpenCode is running in the Durable Object.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });
});

/** Events of one type, as data. */
async function eventData(sessionId: string, type: string): Promise<Array<Record<string, unknown>>> {
  return (await eventsOf(sessionId)).filter((event) => event.type === type).map((event) => event.data);
}

/** Admitted into the Session object, held or as a turn: the ledger's receipt. */
async function receiptOf(deliveryId: string): Promise<Record<string, unknown>> {
  await driveAccount(async () => (await ledger(deliveryId))?.state === "admitted", `delivery ${deliveryId}`);
  return JSON.parse((await ledger(deliveryId))!.receipt_json!) as Record<string, unknown>;
}

describe("Linear fault matrix: the question fix pass (work 037)", () => {
  it("item 1: a reply that arrives before the elicitation's time is known is reclassified as the answer once it is", async () => {
    const fixture = await linearAgent("lfm-item1-reclassify");
    // Linear's clock runs three minutes behind ours, and it refuses the
    // elicitation (rate limited) until the replies have arrived.
    linear.skewMs = -3 * 60_000;
    let blocked = true;
    linear.reject = (input) =>
      input.content.type === "elicitation" && blocked
        ? { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }
        : undefined;
    const started = await startSession(fixture, "[ask call-intake]");
    await turnSettled(started.sessionId, started.turnId, "completed");
    const questionId = await questionIdFor(started.turnId, "call-intake");
    await until(
      async () => (await queueOf(started.sessionId)).some((row) => row.question_id && row.state === "failed_transient"),
      "the elicitation's first attempt",
    );
    const askedAt = Date.parse((await snapshotOf(started.sessionId)).question!.askedAt);
    // The reply (55) a minute before asked_at by our clock; 57, as recorded,
    // about two and a half minutes before it.
    const shiftMs = askedAt - 60_000 - Date.parse(recordedDelivery(55).body.agentActivity!.createdAt);
    // One at a time: the ledger admits a Linear session's rows in provider
    // order, and a row behind a pending older one waits out a hold.
    const steering = await deliver(fixture, 57, { shiftMs });
    expect(await receiptOf(steering.deliveryId)).toMatchObject({ held: true, questionId, sessionId: started.sessionId });
    const reply = await deliver(fixture, 55, { shiftMs });
    expect(Date.parse(reply.promptCreatedAt!)).toBeLessThan(askedAt);
    expect(await receiptOf(reply.deliveryId)).toMatchObject({ held: true, questionId, sessionId: started.sessionId });
    expect((await snapshotOf(started.sessionId)).turns).toHaveLength(1);

    // Linear takes the post: its time is recorded and the reply answers.
    blocked = false;
    await runInDurableObject(env.SESSIONS.getByName(started.sessionId), (_instance, state) => {
      state.storage.sql.exec("UPDATE linear_activities SET next_attempt_at_ms = ? WHERE state = 'failed_transient'", Date.now() - 1);
    });
    await until(
      async () => (await eventData(started.sessionId, "question.answered")).length > 0,
      "the held reply to answer",
      [started.sessionId],
    );
    const elicitation = linear.posted(started.agentSessionId).find((activity) => activity.content.type === "elicitation")!;
    // By Linear's clock the reply came after the elicitation and 57 before it.
    expect(Date.parse(reply.promptCreatedAt!)).toBeGreaterThan(Date.parse(elicitation.createdAt));
    expect(Date.parse(steering.promptCreatedAt!)).toBeLessThan(Date.parse(elicitation.createdAt));
    const events = await eventsOf(started.sessionId);
    const answerTurnId = events.find((event) => event.type === "question.answered")!.turnId!;
    expect(events.filter((event) => event.type === "message.delivered").map((event) => [event.data.as, event.data.answerTurnId])).toEqual([
      ["answer", answerTurnId],
      ["steering", answerTurnId],
    ]);
    const input = await renderedInput(started.sessionId, answerTurnId);
    expect(input.answer).toEqual({ questionId, text: "held" });
    expect(input.steering).toEqual([
      expect.objectContaining({ text: "Fixture message.", providerTime: steering.promptCreatedAt }),
    ]);
    await turnSettled(started.sessionId, answerTurnId, "completed");
    expect(await posted(started.agentSessionId, 3, [started.sessionId])).toEqual([
      "thought:Reading the issue.",
      `elicitation:${ASKED.text}`,
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });

  it("item 1: an elicitation Linear refuses closes the question undeliverable and a prompt held behind it runs as its own turn", async () => {
    const fixture = await linearAgent("lfm-item1-undeliverable");
    let refused = false;
    linear.reject = (input) => {
      if (input.content.type !== "elicitation" || refused) return undefined;
      refused = true;
      return recordedActivity(66).response;
    };
    const started = await startSession(fixture, "[stall 1500ms] [ask call-intake]");
    await until(
      async () => (await snapshotOf(started.sessionId)).turns[0]?.status === "running",
      "the asking turn to run",
      [started.sessionId],
    );
    // Queued behind the asking turn: held when it asks.
    const queued = await deliver(fixture, 36, { shiftMs: shiftToNow(36) });
    const queuedTurnId = (await admittedTurn(queued.deliveryId)).turnId;
    await turnSettled(started.sessionId, started.turnId, "completed");
    const questionId = await questionIdFor(started.turnId, "call-intake");
    await until(
      async () => (await eventData(started.sessionId, "question.closed")).length > 0,
      "the question to close",
      [started.sessionId],
    );
    expect(await eventData(started.sessionId, "question.closed")).toEqual([{ questionId, reason: "undeliverable" }]);
    const delivered = await eventData(started.sessionId, "message.delivered");
    expect(delivered).toEqual([expect.objectContaining({ questionId, as: "turn" })]);
    const ownTurnId = delivered[0]!.answerTurnId as string;
    expect((await eventData(started.sessionId, "message.held"))[0]).toMatchObject({ turnId: queuedTurnId, input: "yes" });
    expect((await renderedInput(started.sessionId, ownTurnId)).text).toBe("yes");
    await turnSettled(started.sessionId, ownTurnId, "completed");
    expect((await snapshotOf(started.sessionId)).question).toBeNull();
    expect(await posted(started.agentSessionId, 2, [started.sessionId])).toEqual([
      "thought:Reading the issue.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });

  it("item 2: a held prompt too large for steering runs as its own turn after the answer, and the answer is admitted", async () => {
    const fixture = await linearAgent("lfm-item2-overflow");
    const asked = await askedSession(fixture);
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(54));
    const big = "x".repeat(70 * 1024);
    const steering = await deliver(fixture, 57, {
      shiftMs,
      edit: (body) => {
        body.agentActivity!.content.body = big;
      },
    });
    expect(await receiptOf(steering.deliveryId)).toMatchObject({ held: true, questionId: asked.questionId });
    const answer = await deliver(fixture, 55, { shiftMs });
    const answered = await admittedTurn(answer.deliveryId);
    const input = await renderedInput(asked.sessionId, answered.turnId);
    expect(input.answer).toEqual({ questionId: asked.questionId, text: "held" });
    expect(input.steering).toBeUndefined();
    const delivered = await eventData(asked.sessionId, "message.delivered");
    expect(delivered).toEqual([expect.objectContaining({ questionId: asked.questionId, as: "turn" })]);
    const ownTurnId = delivered[0]!.answerTurnId as string;
    expect(((await renderedInput(asked.sessionId, ownTurnId)).text as string).length).toBe(big.length);
    await turnSettled(asked.sessionId, ownTurnId, "completed");
    const turns = (await snapshotOf(asked.sessionId)).turns.map((turn) => turn.id);
    expect(turns.slice(1)).toEqual([answered.turnId, ownTurnId]);
    expect(await posted(asked.agentSessionId, 4, [asked.sessionId])).toEqual([
      "thought:Reading the issue.",
      `elicitation:${ASKED.text}`,
      "response:Managed OpenCode is running in the Durable Object.",
      "response:Managed OpenCode is running in the Durable Object.",
    ]);
  });

  it("item 3: a Linear turn replayed with the same key and a question reference is an idempotency conflict", async () => {
    const fixture = await linearAgent("lfm-item3-fingerprint");
    const asked = await askedSession(fixture);
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(54));
    const answer = await deliver(fixture, 55, { shiftMs });
    const answered = await admittedTurn(answer.deliveryId);
    const frozen = JSON.parse(((await ledger(answer.deliveryId)) as unknown as { input_json: string }).input_json) as {
      text: string;
      agentInput: never;
    };
    const session = env.SESSIONS.getByName(asked.sessionId);
    const replay = () =>
      session.enqueueTurn({
        input: frozen.text,
        idempotencyKey: `linear:${answer.deliveryId}`,
        agentInput: frozen.agentInput,
        providerTime: answer.promptCreatedAt!,
      });
    // Inside the object, so the refusal is caught where it is thrown.
    const conflict = await runInDurableObject(session, async (instance) => {
      try {
        await (instance as unknown as { enqueueTurn(input: Record<string, unknown>): Promise<unknown> }).enqueueTurn({
          input: frozen.text,
          idempotencyKey: `linear:${answer.deliveryId}`,
          agentInput: frozen.agentInput,
          providerTime: answer.promptCreatedAt!,
          answers: asked.questionId,
        });
        return "admitted";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(conflict).toMatch(/^idempotency_conflict/);
    expect(await replay()).toMatchObject({ turnId: answered.turnId, duplicate: true });
    await turnSettled(asked.sessionId, answered.turnId, "completed");
    expect((await snapshotOf(asked.sessionId)).turns).toHaveLength(2);
  });

  it("item 4: a held prompt is one message.held however often it is redelivered, then message.delivered or message.discarded", async () => {
    const fixture = await linearAgent("lfm-item4-events");
    const asked = await askedSession(fixture);
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(54));
    const steering = await deliver(fixture, 57, { shiftMs });
    await receiptOf(steering.deliveryId);
    // Redelivered by Linear, and replayed into the Session object.
    expect(await (await steering.send()).json()).toMatchObject({ duplicate: true });
    await runDurableObjectAlarm(account());
    const frozen = JSON.parse(((await ledger(steering.deliveryId)) as unknown as { input_json: string }).input_json) as {
      text: string;
      agentInput: never;
    };
    const replayed = await env.SESSIONS.getByName(asked.sessionId).enqueueTurn({
      input: frozen.text,
      idempotencyKey: `linear:${steering.deliveryId}`,
      agentInput: frozen.agentInput,
      providerTime: steering.promptCreatedAt!,
    });
    expect(replayed).toMatchObject({ status: "held", duplicate: true });
    const held = await eventData(asked.sessionId, "message.held");
    expect(held).toEqual([
      {
        heldId: (replayed as { heldId: string }).heldId,
        questionId: asked.questionId,
        input: "Fixture message.",
        payload: expect.objectContaining({ action: "prompted" }),
        receivedAt: expect.any(String),
        providerTime: steering.promptCreatedAt,
      },
    ]);
    // Answered: delivered with the answering turn.
    const answer = await deliver(fixture, 55, { shiftMs });
    const answered = await admittedTurn(answer.deliveryId);
    expect(await eventData(asked.sessionId, "message.delivered")).toEqual([
      {
        heldId: held[0]!.heldId,
        questionId: asked.questionId,
        answerTurnId: answered.turnId,
        turnId: answered.turnId,
        as: "steering",
      },
    ]);
    expect(await eventData(asked.sessionId, "message.discarded")).toEqual([]);
    await turnSettled(asked.sessionId, answered.turnId, "completed");
  });

  it("item 4: a stop discards a held prompt with message.discarded", async () => {
    const fixture = await linearAgent("lfm-item4-discarded");
    const asked = await askedSession(fixture);
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(54));
    const steering = await deliver(fixture, 57, { shiftMs });
    await receiptOf(steering.deliveryId);
    const heldId = (await eventData(asked.sessionId, "message.held"))[0]!.heldId;
    // The stop is moved after the question.
    const stop = await deliver(fixture, 42, { shiftMs: Date.now() - Date.parse(recordedDelivery(42).body.agentActivity!.createdAt) });
    await driveAccount(async () => (await ledger(stop.deliveryId))?.state === "confirmed", "the stop");
    expect(await eventData(asked.sessionId, "message.discarded")).toEqual([
      { heldId, questionId: asked.questionId, reason: "stopped" },
    ]);
    expect(await eventData(asked.sessionId, "question.closed")).toEqual([{ questionId: asked.questionId, reason: "stopped" }]);
    expect(await eventData(asked.sessionId, "message.delivered")).toEqual([]);
  });

  it("item 5: dismissing the open question runs the held prompt as its own turn; interrupt leaves a question alone and end closes it", async () => {
    const fixture = await linearAgent("lfm-item5-dismiss");
    const asked = await askedSession(fixture);
    const shiftMs = Date.parse(asked.elicitation.createdAt) - Date.parse(recordedActivityCreatedAt(54));
    // The held prompt asks again when it runs.
    const steering = await deliver(fixture, 57, { shiftMs, edit: promptDirective("[ask call-again]") });
    await receiptOf(steering.deliveryId);
    const dismiss = (questionId: string) =>
      SELF.fetch(`${BASE}/v1/sessions/${asked.sessionId}/questions/${encodeURIComponent(questionId)}/dismiss`, {
        method: "POST",
      });
    const dismissed = await dismiss(asked.questionId);
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json<SessionSnapshot>()).question).toBeNull();
    expect((await dismiss(asked.questionId)).status).toBe(200);
    expect(await eventData(asked.sessionId, "question.closed")).toEqual([{ questionId: asked.questionId, reason: "dismissed" }]);
    const ownTurnId = (await eventData(asked.sessionId, "message.delivered"))[0]!.answerTurnId as string;
    await turnSettled(asked.sessionId, ownTurnId, "completed");
    const next = await questionIdFor(ownTurnId, "call-again");
    expect((await snapshotOf(asked.sessionId)).question?.id).toBe(next);
    // A repeat for the dismissed question changes nothing; the new one stays open.
    expect((await dismiss(asked.questionId)).status).toBe(200);
    expect((await snapshotOf(asked.sessionId)).question?.id).toBe(next);
    expect((await dismiss("question_other")).status).toBe(409);

    const interrupted = await SELF.fetch(`${BASE}/v1/sessions/${asked.sessionId}/interrupt`, { method: "POST" });
    expect((await interrupted.json<SessionSnapshot>()).question?.id).toBe(next);
    const ended = await SELF.fetch(`${BASE}/v1/sessions/${asked.sessionId}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    expect((await ended.json<SessionSnapshot>()).question).toBeNull();
    expect(await eventData(asked.sessionId, "question.closed")).toEqual([
      { questionId: asked.questionId, reason: "dismissed" },
      { questionId: next, reason: "ended" },
    ]);
    expect(await posted(asked.agentSessionId, 3, [asked.sessionId])).toEqual([
      "thought:Reading the issue.",
      `elicitation:${ASKED.text}`,
      `elicitation:${ASKED.text}`,
    ]);
  });
});
