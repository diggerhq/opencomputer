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
  InitializeSessionResult,
  Project,
  SessionSnapshot,
} from "../src/protocol.js";
import { AccountDurableObject } from "../src/edge/account-do.js";
import { SessionDurableObject } from "../src/edge/session-do.js";
import { questionIdFor } from "../src/ask.js";
import {
  json,
  waitForEvents,
  createWorkerdSession,
  fakeRuntimeOf,
  terminalEventsOf,
  postTurn,
  snapshotOf,
  workerdToolIdentity,
} from "./managed-session-workerd-helpers.js";

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
