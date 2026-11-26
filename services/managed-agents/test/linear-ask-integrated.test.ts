import { env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { questionIdFor } from "../src/ask.js";
import { OPENROUTER_MODEL_CATALOG_CACHE_KEY } from "../src/edge/model-catalog.js";
import type { AgentDeployment, AgentEvent, SessionSnapshot } from "../src/protocol.js";
import {
  artifactBundle,
  artifactDigest,
  LINEAR_ASK_MODEL,
} from "./fixtures/linear-ask-integrated-fixture.mjs";
import {
  BASE,
  connectLinear,
  createProject,
  deliver,
  driveAccount,
  installFakeLinear,
  ledger,
  recordedActivityCreatedAt,
  shiftToNow,
  until,
  type FakeLinear,
} from "./linear-playback.js";

/**
 * Work 037 Phase 2a: one `ask` end to end on the real Workerd host. A
 * recorded Linear `created` enters through the edge route and the Account
 * ledger; the Session object runs the turn on the real host (the real
 * OpenCode loop against a scripted model); the agent's render selects `ask`,
 * the model calls it, the host's tool records the question and the loop is
 * interrupted after the call's success; the Session object settles the turn
 * `completed` with outcome `question`, appends `question.asked`, and its
 * activity queue posts the elicitation to the fake Linear API. A reply
 * written after the elicitation then answers it on the same session.
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
  await caches.default.put(
    OPENROUTER_MODEL_CATALOG_CACHE_KEY,
    Response.json(
      { fetchedAt: Date.now(), ids: ["anthropic/claude-sonnet-4.6", LINEAR_ASK_MODEL] },
      { headers: { "cache-control": "public, max-age=3600" } },
    ),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

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

async function admitted(deliveryId: string): Promise<{ sessionId: string; turnId: string }> {
  let receipt = "";
  await driveAccount(async () => {
    const row = await ledger(deliveryId);
    receipt = row?.receipt_json ?? "";
    return row?.state === "admitted";
  }, `delivery ${deliveryId} to be admitted`, 30_000);
  return JSON.parse(receipt) as { sessionId: string; turnId: string };
}

async function settled(sessionId: string, turnId: string): Promise<AgentEvent[]> {
  let events: AgentEvent[] = [];
  await until(
    async () => {
      events = await eventsOf(sessionId);
      return events.some(
        (event) =>
          event.turnId === turnId &&
          (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled"),
      );
    },
    `turn ${turnId} to settle`,
    [sessionId],
    45_000,
  );
  const failed = events.find((event) => event.turnId === turnId && event.type === "turn.failed");
  if (failed) throw new Error(`Turn failed: ${JSON.stringify(failed.data)}`);
  return events;
}

describe("ask on the real Workerd host, from Linear", () => {
  it("settles the asking turn completed with outcome question, appends question.asked, and posts the elicitation", async () => {
    const project = await createProject("linear-ask-real-host");
    const digest = await artifactDigest();
    const deployed = await SELF.fetch(`${BASE}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: project.agentId,
        alias: "development",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: { bucket: "test-artifacts", key: digest, digest, size: artifactBundle.byteLength },
        models: [{ provider: "openrouter", model: LINEAR_ASK_MODEL }],
      }),
    });
    expect(deployed.status, await deployed.clone().text()).toBe(201);
    expect((await deployed.json<AgentDeployment>()).runtimeMode).not.toBe("microvm");
    const fixture = await connectLinear(project);

    const created = await deliver(fixture, 0, { shiftMs: shiftToNow(0) });
    const first = await admitted(created.deliveryId);
    const events = await settled(first.sessionId, first.turnId);
    const snapshot = await snapshotOf(first.sessionId);
    expect(snapshot.executionMode).toBe("workerd");

    // The render selected `ask`; the model called it; the host ended the turn.
    const rendered = events.find((event) => event.turnId === first.turnId && event.type === "agent.rendered")!;
    expect((rendered.data as { enabledTools: string[] }).enabledTools).toEqual(["ask"]);
    const questionId = await questionIdFor(first.turnId, "call-linear-ask");
    const ofTurn = events.filter((event) => event.turnId === first.turnId);
    expect(ofTurn.find((event) => event.type === "turn.completed")?.data).toEqual({
      outcome: "question",
      questionId,
    });
    expect(ofTurn.some((event) => event.type === "turn.failed" || event.type === "turn.cancelled")).toBe(false);
    const options = [
      { label: "Go", value: "go" },
      { label: "Plan first", value: "plan" },
    ];
    expect(events.find((event) => event.type === "question.asked")?.data).toEqual({
      questionId,
      text: "Ship it as described, or plan first?",
      options,
    });
    const types = ofTurn.map((event) => event.type);
    expect(types.indexOf("question.asked")).toBeLessThan(types.indexOf("turn.completed"));
    expect(snapshot.turns[0]).toMatchObject({ id: first.turnId, status: "completed", outcome: "question" });
    expect(snapshot.question).toMatchObject({ id: questionId, text: "Ship it as described, or plan first?", options });

    // The elicitation was enqueued in the settlement and posted after the
    // acknowledgement, with its options as Linear's select signal.
    const queue = await runInDurableObject(env.SESSIONS.getByName(first.sessionId), (_instance, state) =>
      state.storage.sql
        .exec("SELECT kind, question_id, turn_id, content_json FROM linear_activities ORDER BY seq")
        .toArray(),
    );
    expect(queue).toEqual([
      {
        kind: "terminal",
        question_id: questionId,
        turn_id: first.turnId,
        content_json: JSON.stringify({ type: "elicitation", body: "Ship it as described, or plan first?" }),
      },
    ]);
    await until(async () => linear.posted(created.agentSessionId).length >= 2, "the elicitation to post", [first.sessionId]);
    const thread = linear.posted(created.agentSessionId);
    expect(thread.map((activity) => activity.content.type)).toEqual(["thought", "elicitation"]);
    expect(thread[1]).toMatchObject({ signal: "select", signalMetadata: { options } });

    // A reply written after the elicitation (33, recorded 5 minutes after
    // the elicitation at 30) answers it on the same session.
    const shiftMs = Date.parse(thread[1]!.createdAt) - Date.parse(recordedActivityCreatedAt(30));
    const reply = await deliver(fixture, 33, { shiftMs });
    const answer = await admitted(reply.deliveryId);
    expect(answer.sessionId).toBe(first.sessionId);
    const answerEvents = await settled(first.sessionId, answer.turnId);
    const expected = `Answer received: ${JSON.stringify({ questionId, text: "go", value: "go" })} Steering: []`;
    expect(answerEvents.find((event) => event.turnId === answer.turnId && event.type === "message.completed")?.data)
      .toMatchObject({ text: expected });
    await until(async () => linear.posted(created.agentSessionId).length >= 3, "the response to post", [first.sessionId]);
    expect(linear.posted(created.agentSessionId).map((activity) => `${activity.content.type}:${activity.content.body ?? ""}`)).toEqual([
      "thought:Reading the issue.",
      "elicitation:Ship it as described, or plan first?",
      `response:${expected}`,
    ]);
  });
});
