import { Validator, type Schema } from "@cfworker/json-schema";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, ApiEvent } from "../src/computer/api-types.js";
import type { SessionLogDurableObject } from "../src/computer/session-log.js";
import type { SessionLogRpc } from "../src/computer/session-log-contract.js";
import schema from "./fixtures/calvin/computer-api.v1.json" with { type: "json" };

/**
 * Work 084: the SessionLog Durable Object through its RPC surface: epoch fencing (stale, gap,
 * duplicates, a new epoch replacing the old one's tail), recovery, read-your-writes with `minSeq`,
 * the events filters and long-polls, R2 offload, and Turn/Ask/Event bodies against the schema.
 */

type Namespace = DurableObjectNamespace<SessionLogDurableObject>;
const testEnv = env as unknown as { SESSION_LOG: Namespace; SESSION_LOG_BLOBS: R2Bucket };

const ORG = "org_test";
const OWNER: Actor = { id: "usr_2k9d8f7a", name: "Owner", via: "opc", client: "opc/0.1.0" };
const T1 = "tn_4m8q2x7c1v9b";
const T2 = "tn_9x2c7v1b4m8q";
const T3 = "tn_1b4m8q9x2c7v";
const ASK = "ak_7c1v9b4m8q2x";

let sessions = 0;
/** A fresh log: a new `cs_` id (and so a new object) per call. */
function open() {
  const sessionId = `cs_${String(++sessions).padStart(16, "0")}`;
  // Typed by the contract: RPC's mapped stub types defeat narrowing on `ok`.
  const object = testEnv.SESSION_LOG.getByName(sessionId);
  const stub = object as unknown as SessionLogRpc;
  const identity = { sessionId, organizationId: ORG };
  let ms = Date.parse("2026-10-26T09:00:00.000Z");
  let ids = 0;
  const ev = (seq: number, type: string, turnId: string | null, data: unknown, actor: Actor | null = null): ApiEvent => ({
    id: `ev_${String(++ids).padStart(16, "0")}`,
    seq,
    createdAt: new Date((ms += 10)).toISOString(),
    sessionId,
    turnId,
    type,
    actor,
    data,
  });
  return { sessionId, stub, object, identity, ev };
}

function validator(def: string) {
  const v = new Validator({ $ref: `${schema.$id}#/$defs/${def}` } as Schema, "2020-12", false);
  v.addSchema(schema as unknown as Schema);
  return (value: unknown) => {
    const result = v.validate(value);
    if (!result.valid) throw new Error(`${def} invalid: ${JSON.stringify(result.errors.slice(0, 3))}`);
  };
}
const validTurn = validator("Turn");
const validAsk = validator("Ask");
const validEvent = validator("Event");

const received = (input: string, delivery = "started") => ({ input, ifBusy: "queue", delivery, interruptedTurnIds: [] });
const started = { model: "claude-opus-5-5", effort: "high", mode: "default" };
const tool = (callId: string) => ({ toolName: "Bash", callId, parentCallId: null, title: "npm test", input: { command: "npm test" }, inputTruncated: false });
const approval = (sessionId: string, turnId = T1) => ({
  id: ASK,
  sessionId,
  turnId,
  kind: "approval",
  status: "open",
  createdAt: "2026-10-26T09:00:00.500Z",
  closedAt: null,
  closedBy: null,
  answer: null,
  approval: { toolName: "Bash", callId: "toolu_01", input: { command: "rm -rf build" }, title: "rm -rf build", alwaysAllows: null },
  question: null,
  secret: null,
});

/** session.created, running, T1 started with an open tool call and an open ask, T2 queued: seqs 1..8. */
function busyLog(log: ReturnType<typeof open>) {
  const { ev, sessionId } = log;
  return [
    ev(1, "session.created", null, { title: "t", origin: { type: "opc", client: null, slack: null }, settings: started }, OWNER),
    ev(2, "session.status_changed", null, { from: null, to: "running" }),
    ev(3, "message.received", T1, received("first"), OWNER),
    ev(4, "turn.started", T1, started),
    ev(5, "tool.started", T1, tool("toolu_01")),
    ev(6, "ask.opened", T1, { ask: approval(sessionId) }),
    ev(7, "message.received", T2, received("second", "queued"), OWNER),
    ev(8, "turn.queued", T2, { position: 1 }),
  ];
}

describe("SessionLog append", () => {
  it("stores a batch, acks it, and serves it back with the summary", async () => {
    const log = open();
    const events = busyLog(log);
    const result = await log.stub.append(log.identity, 1, events);
    expect(result).toMatchObject({ ok: true, ack: 8 });
    if (!result.ok) throw new Error("refused");
    expect(result.summary).toMatchObject({
      lastSeq: 8,
      logEpoch: 1,
      epochStartSeq: 1,
      status: "running",
      title: "t",
      activeTurnId: T1,
    });
    expect(result.summary.queued.map((t) => t.id)).toEqual([T2]);
    expect(result.summary.asks.map((a) => a.id)).toEqual([ASK]);
    expect(result.summary.syncedAt).not.toBeNull();

    const page = await log.stub.events({});
    if (!page.ok) throw new Error("refused");
    expect(page.events).toEqual(events);
    expect(page).toMatchObject({ lastSeq: 8, hasMore: false });
    expect(page.syncedAt).toBe(result.summary.syncedAt);
    for (const event of page.events) validEvent(event);

    const turns = await log.stub.turns({});
    if (!turns.ok) throw new Error("refused");
    expect(turns.turns.map((t) => [t.id, t.status])).toEqual([
      [T2, "queued"],
      [T1, "running"],
    ]);
    for (const turn of turns.turns) validTurn(turn);
    const asks = await log.stub.asks({});
    if (!asks.ok) throw new Error("refused");
    expect(asks.asks.map((a) => a.id)).toEqual([ASK]);
    for (const ask of asks.asks) validAsk(ask);
    expect(await log.stub.ask(ASK)).toMatchObject({ ok: true, ask: { id: ASK, status: "open" } });
    expect(await log.stub.ask("ak_000000000000")).toEqual({ ok: false, error: "ask_not_found" });
    expect(await log.stub.turn("tn_000000000000", {})).toEqual({ ok: false, error: "turn_not_found" });
  });

  it("skips duplicates, and a duplicate seq with another id is skipped too", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 1, events.slice(0, 5));
    const before = await log.stub.summary();
    const liar = { ...events[2]!, id: "ev_zzzzzzzzzzzzzzzz" };
    const result = await log.stub.append(log.identity, 1, [events[1]!, liar, ...events.slice(3)]);
    expect(result).toMatchObject({ ok: true, ack: 8 });
    const page = await log.stub.events({});
    if (!page.ok) throw new Error("refused");
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(page.events[2]!.id).toBe(events[2]!.id);

    // An all-duplicate batch still counts as hearing from the writer.
    const again = await log.stub.append(log.identity, 1, events.slice(0, 3));
    if (!again.ok || !before.ok) throw new Error("refused");
    expect(again.ack).toBe(8);
    expect(again.summary.syncedAt! >= before.summary.syncedAt!).toBe(true);
  });

  it("refuses a gap, a non-contiguous batch and a stale epoch, storing nothing", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 2, events.slice(0, 3));
    expect(await log.stub.append(log.identity, 2, events.slice(4))).toEqual({ ok: false, reason: "gap", logEpoch: 2, ack: 3 });
    expect(await log.stub.append(log.identity, 2, [events[3]!, events[5]!])).toEqual({ ok: false, reason: "gap", logEpoch: 2, ack: 3 });
    expect(await log.stub.append(log.identity, 3, events.slice(4))).toEqual({ ok: false, reason: "gap", logEpoch: 2, ack: 3 });
    expect(await log.stub.append(log.identity, 1, events.slice(3))).toEqual({ ok: false, reason: "stale_epoch", logEpoch: 2, ack: 3 });
    const page = await log.stub.events({});
    if (!page.ok) throw new Error("refused");
    expect(page.lastSeq).toBe(3);
  });

  it("refuses another organization", async () => {
    const log = open();
    await log.stub.append(log.identity, 1, busyLog(log).slice(0, 1));
    const error = await log.stub.append({ ...log.identity, organizationId: "org_other" }, 1, []).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(error)).toMatch(/another organization/);
  });

  it("a new epoch replaces the old one's tail from its first seq and refolds", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 1, events);
    // Epoch 2 rewrites from seq 5: T1 completes; the tool call, the ask and T2 never happened.
    const replacement = [
      log.ev(5, "message.completed", T1, { blockId: "b1", parentCallId: null, text: "Done." }),
      log.ev(6, "turn.completed", T1, { text: "Done.", durationMs: 9 }),
      log.ev(7, "session.status_changed", null, { from: "running", to: "idle" }),
    ];
    const result = await log.stub.append(log.identity, 2, replacement);
    expect(result).toMatchObject({ ok: true, ack: 7 });
    if (!result.ok) throw new Error("refused");
    expect(result.summary).toMatchObject({ logEpoch: 2, epochStartSeq: 5, lastSeq: 7, status: "idle", activeTurnId: null, queued: [], asks: [], lastText: "Done." });
    expect(result.summary.lastTurn).toMatchObject({ id: T1, status: "completed" });

    const page = await log.stub.events({});
    if (!page.ok) throw new Error("refused");
    expect(page.events.map((e) => e.type)).toEqual([
      "session.created",
      "session.status_changed",
      "message.received",
      "turn.started",
      "message.completed",
      "turn.completed",
      "session.status_changed",
    ]);
    const turns = await log.stub.turns({});
    if (!turns.ok) throw new Error("refused");
    expect(turns.turns.map((t) => t.id)).toEqual([T1]);
    expect(await log.stub.asks({ status: "all" })).toMatchObject({ ok: true, asks: [] });
    // No open call left for a later recovery to settle.
    expect(await runInDurableObject(log.object, (_i, state) => state.storage.sql.exec("SELECT count(*) AS n FROM tools").one().n)).toBe(0);

    // The old epoch is fenced off now.
    expect(await log.stub.append(log.identity, 1, [log.ev(8, "x.y", null, {})])).toMatchObject({ ok: false, reason: "stale_epoch" });
  });
});

describe("SessionLog recover", () => {
  it("settles the open call, the open ask and the running turn under the next epoch", async () => {
    const log = open();
    await log.stub.append(log.identity, 1, busyLog(log));
    const at = "2026-10-26T10:00:00.000Z";
    expect(await log.stub.recover({ ...log.identity, epoch: 3, at })).toMatchObject({ ok: false, reason: "stale_epoch", logEpoch: 1 });

    const result = await log.stub.recover({ ...log.identity, epoch: 2, at });
    expect(result).toMatchObject({ ok: true, ack: 13 });
    if (!result.ok) throw new Error("refused");
    expect(result.summary).toMatchObject({ logEpoch: 2, epochStartSeq: 9, status: "suspended", activeTurnId: null, asks: [] });
    expect(result.summary.queued.map((t) => t.id)).toEqual([T2]);
    expect(result.summary.lastTurn).toMatchObject({ id: T1, status: "failed", error: { code: "runtime_lost" } });

    const page = await log.stub.events({ after: 8 });
    if (!page.ok) throw new Error("refused");
    expect(page.events.map((e) => [e.seq, e.type, e.turnId])).toEqual([
      [9, "tool.failed", T1],
      [10, "ask.closed", T1],
      [11, "turn.failed", T1],
      [12, "runtime.suspended", null],
      [13, "session.status_changed", null],
    ]);
    for (const event of page.events) {
      validEvent(event);
      expect(event.id).toMatch(/^ev_[0-9a-hjkmnp-tv-z]{16}$/);
      expect(event.createdAt).toBe(at);
      expect(event.actor).toEqual({ id: "system", name: "OpenComputer", via: "system", client: null });
    }
    expect(page.events[0]!.data).toEqual({ toolName: "Bash", callId: "toolu_01", parentCallId: null, title: "npm test", message: expect.any(String), settledBy: "turn.failed" });
    expect(page.events[1]!.data).toMatchObject({ ask: { id: ASK, status: "interrupted", closedAt: at, closedBy: null } });
    expect(page.events[2]!.data).toEqual({ error: { code: "runtime_lost", message: expect.any(String) } });
    expect(page.events[3]!.data).toEqual({ reason: "lost" });
    expect(page.events[4]!.data).toEqual({ from: "running", to: "suspended" });

    const ask = await log.stub.ask(ASK);
    if (!ask.ok) throw new Error("refused");
    expect(ask.ask).toMatchObject({ status: "interrupted", closedAt: at, closedBy: null });
    validAsk(ask.ask);
    const turn = await log.stub.turn(T1, {});
    if (!turn.ok) throw new Error("refused");
    expect(turn.turn).toMatchObject({ status: "failed", endedAt: at, error: { code: "runtime_lost" } });
    validTurn(turn.turn);

    // Nothing open, already suspended: only the suspension, in the next epoch.
    const again = await log.stub.recover({ ...log.identity, epoch: 3, at });
    expect(again).toMatchObject({ ok: true, ack: 14 });
    const tail = await log.stub.events({ after: 13 });
    if (!tail.ok) throw new Error("refused");
    expect(tail.events.map((e) => e.type)).toEqual(["runtime.suspended"]);

    // The lost writer's late batch is refused.
    expect(await log.stub.append(log.identity, 1, [log.ev(15, "x.y", null, {})])).toMatchObject({ ok: false, reason: "stale_epoch", logEpoch: 3 });
  });

  it("with nothing open records the suspension only", async () => {
    const log = open();
    await log.stub.append(log.identity, 1, busyLog(log).slice(0, 2));
    const result = await log.stub.recover({ ...log.identity, epoch: 2, at: "2026-10-26T10:00:00.000Z" });
    expect(result).toMatchObject({ ok: true, ack: 4, summary: { epochStartSeq: 3, status: "suspended" } });
    const page = await log.stub.events({ after: 2 });
    if (!page.ok) throw new Error("refused");
    expect(page.events.map((e) => e.type)).toEqual(["runtime.suspended", "session.status_changed"]);
    // The host's `epoch` frame: the recovery's events verbatim, from the epoch's first seq.
    if (!result.ok) throw new Error("refused");
    expect(result.tail).toEqual({ epoch: 2, startSeq: 3, lastSeq: 4, tail: page.events });
    expect(await log.stub.epochTail(log.identity)).toEqual(result.tail);
    // A host writing on under the new epoch at lastSeq + 1 moves the tail along.
    await log.stub.append(log.identity, 2, [log.ev(5, "x.y", null, { big: "z".repeat(9_000) })]);
    const later = await log.stub.epochTail(log.identity);
    expect(later).toMatchObject({ epoch: 2, startSeq: 3, lastSeq: 5 });
    expect(later!.tail.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect((later!.tail[2]!.data as { big: string }).big).toHaveLength(9_000);
    expect(await log.stub.epochTail({ ...log.identity, organizationId: "org_other" })).toBeNull();
  });
});

describe("SessionLog reads", () => {
  it("minSeq waits for the append that reaches it", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 1, events.slice(0, 2));
    const read = log.stub.events({ minSeq: 4 });
    const turn = log.stub.turns({ minSeq: 4 });
    await new Promise((r) => setTimeout(r, 50));
    await log.stub.append(log.identity, 1, events.slice(2, 4));
    const page = await read;
    if (!page.ok) throw new Error("refused");
    expect(page.lastSeq).toBe(4);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await turn).toMatchObject({ ok: true, turns: [{ id: T1, status: "running" }] });
  });

  it("minSeq not reached in time is unavailable", async () => {
    const log = open();
    await log.stub.append(log.identity, 1, busyLog(log).slice(0, 2));
    await runInDurableObject(log.object, (instance) => {
      (instance as SessionLogDurableObject).minSeqWaitMs = 50;
    });
    expect(await log.stub.events({ minSeq: 100 })).toEqual({ ok: false, error: "unavailable", lastSeq: 2, retryAfterMs: 500 });
    expect(await log.stub.summary(100)).toEqual({ ok: false, error: "unavailable", lastSeq: 2, retryAfterMs: 500 });
  });

  it("filters by type prefix and turn, pages with hasMore, and refuses a cursor ahead", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 1, events);

    const tools = await log.stub.events({ types: ["tool.*", "turn.queued"] });
    if (!tools.ok) throw new Error("refused");
    expect(tools.events.map((e) => e.type)).toEqual(["tool.started", "turn.queued"]);

    const t2 = await log.stub.events({ turnId: T2 });
    if (!t2.ok) throw new Error("refused");
    expect(t2.events.map((e) => e.seq)).toEqual([7, 8]);

    const first = await log.stub.events({ limit: 3 });
    expect(first).toMatchObject({ ok: true, hasMore: true, lastSeq: 8 });
    const rest = await log.stub.events({ after: 3, limit: 500 });
    if (!rest.ok) throw new Error("refused");
    expect(rest.events.map((e) => e.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(rest.hasMore).toBe(false);

    expect(await log.stub.events({ after: 9 })).toEqual({ ok: false, error: "cursor_ahead", lastSeq: 8, logEpoch: 1 });
  });

  it("tailTurns returns the last turns' events and the earlier turns, newest first", async () => {
    const log = open();
    const { ev } = log;
    const turnEvents = (seq: number, turnId: string, text: string) => [
      ev(seq, "message.received", turnId, received(text), OWNER),
      ev(seq + 1, "turn.started", turnId, started),
      ev(seq + 2, "turn.completed", turnId, { text, durationMs: 1 }),
    ];
    const events = [
      ev(1, "session.created", null, { title: "t", origin: { type: "opc", client: null, slack: null }, settings: started }, OWNER),
      ...turnEvents(2, T1, "one"),
      ...turnEvents(5, T2, "two"),
      ...turnEvents(8, T3, "three"),
    ];
    await log.stub.append(log.identity, 1, events);

    const tail = await log.stub.events({ tailTurns: 1 });
    if (!tail.ok) throw new Error("refused");
    expect(tail.events.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(tail.earlierTurns!.map((t) => t.id)).toEqual([T2, T1]);
    for (const turn of tail.earlierTurns!) validTurn(turn);

    const all = await log.stub.events({ tailTurns: 5 });
    if (!all.ok) throw new Error("refused");
    expect(all.events.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(all.earlierTurns).toEqual([]);

    // Turns page newest first with an opaque cursor.
    const page1 = await log.stub.turns({ limit: 2 });
    if (!page1.ok) throw new Error("refused");
    expect(page1.turns.map((t) => t.id)).toEqual([T3, T2]);
    const page2 = await log.stub.turns({ limit: 2, cursor: page1.nextCursor! });
    if (!page2.ok) throw new Error("refused");
    expect(page2.turns.map((t) => t.id)).toEqual([T1]);
    expect(page2.nextCursor).toBeNull();
    expect(await log.stub.turns({ cursor: "nope" })).toEqual({ ok: false, error: "invalid_cursor" });
    expect(await log.stub.turns({ status: ["running"] })).toMatchObject({ ok: true, turns: [] });
  });

  it("waitMs long-polls until an event lands past `after`, or answers empty at the timeout", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 1, events.slice(0, 2));

    const empty = await log.stub.events({ after: 2, waitMs: 50 });
    expect(empty).toMatchObject({ ok: true, events: [], lastSeq: 2 });

    const poll = log.stub.events({ after: 2, waitMs: 10_000 });
    const filtered = log.stub.events({ after: 2, waitMs: 10_000, types: ["turn.started"] });
    await new Promise((r) => setTimeout(r, 50));
    await log.stub.append(log.identity, 1, events.slice(2, 3));
    const page = await poll;
    if (!page.ok) throw new Error("refused");
    expect(page.events.map((e) => e.seq)).toEqual([3]);
    const turnPoll = log.stub.turn(T1, { waitMs: 10_000 });

    await log.stub.append(log.identity, 1, events.slice(3, 4));
    const started1 = await filtered;
    if (!started1.ok) throw new Error("refused");
    expect(started1.events.map((e) => e.seq)).toEqual([4]);

    // The turn poll waits for the end, past `running`.
    await log.stub.append(log.identity, 1, [log.ev(5, "turn.completed", T1, { text: "ok", durationMs: 3 })]);
    expect(await turnPoll).toMatchObject({ ok: true, turn: { id: T1, status: "completed", text: "ok" } });
  });

  it("turn long-poll with a status returns once the status differs", async () => {
    const log = open();
    const events = busyLog(log);
    await log.stub.append(log.identity, 1, events.slice(0, 3));
    const poll = log.stub.turn(T1, { waitMs: 10_000, status: "queued" });
    await new Promise((r) => setTimeout(r, 50));
    await log.stub.append(log.identity, 1, events.slice(3, 4));
    expect(await poll).toMatchObject({ ok: true, turn: { status: "running" }, lastSeq: 4 });
    expect(await log.stub.turn(T1, { waitMs: 50 })).toMatchObject({ ok: true, turn: { status: "running" } });
  });

  it("puts data over 8 KiB in R2 and inlines it on read", async () => {
    const log = open();
    const events = busyLog(log);
    const big = "x".repeat(20 * 1024);
    const completed = log.ev(9, "tool.completed", T1, {
      toolName: "Bash",
      callId: "toolu_01",
      parentCallId: null,
      title: "npm test",
      output: big,
      outputTruncated: false,
      fileChanges: null,
      durationMs: 3,
    });
    await log.stub.append(log.identity, 1, [...events, completed]);

    // Acked with the data inline; R2 after (off the append's path).
    const key = `sessions/${ORG}/${log.sessionId}/events/1-9.json`;
    const row = await runInDurableObject(log.object, async (instance, state) => {
      await (instance as unknown as SessionLogDurableObject).spilling;
      return state.storage.sql.exec("SELECT data, blob FROM events WHERE seq = 9").one();
    });
    expect(row).toEqual({ data: null, blob: key });
    expect(JSON.parse(await (await testEnv.SESSION_LOG_BLOBS.get(key))!.text())).toEqual(completed.data);

    const page = await log.stub.events({ after: 7 });
    if (!page.ok) throw new Error("refused");
    expect(page.events.at(-1)).toEqual(completed);
    // The fold saw the inline data: the call is closed.
    expect(await runInDurableObject(log.object, (_i, state) => state.storage.sql.exec("SELECT count(*) AS n FROM tools").one().n)).toBe(0);
  });
});

describe("SessionLog telemetry (work 084): the batch is the unit", () => {
  it("append answers its stats; a batch's R2 spills are one sessionlog.spill, never one per row or event; batches share a POST", async () => {
    const log = open();
    const posted: Array<Record<string, any>> = [];
    let posts = 0;
    // The test env has no Tinybird settings: switch them on for this object only, posts to a fake.
    await runInDurableObject(log.object, (instance) => {
      const o = instance as unknown as SessionLogDurableObject & { env: Record<string, unknown> };
      o.env = { ...o.env, TINYBIRD_API_URL: "https://tb.test", TINYBIRD_APPEND_TOKEN: "p.append" };
      o.telemetryFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        posts++;
        for (const l of String(init?.body).split("\n")) posted.push(JSON.parse(l));
        return new Response(null, { status: 202 });
      }) as typeof fetch;
    });
    const events = busyLog(log);
    const big = (n: number) => ({ toolName: "Bash", callId: "toolu_01", parentCallId: null, title: "t", output: "y".repeat(n), outputTruncated: false, fileChanges: null, durationMs: 1 });
    const result = await log.stub.append(log.identity, 1, [...events, log.ev(9, "tool.completed", T1, big(10 * 1024)), log.ev(10, "tool.progress", T1, big(12 * 1024))]);
    if (!result.ok) throw new Error("refused");
    expect(result.stats).toMatchObject({ rows: 10, dupes: 0, mismatches: 0, spillsDue: 2, syncSpills: 0 });
    expect(result.stats!.storageBytes).toBeGreaterThan(0);
    await runInDurableObject(log.object, async (instance) => {
      await (instance as unknown as SessionLogDurableObject).spilling;
    });
    // A second batch with a spill, inside the same telemetry window: its event joins the first's POST.
    const second = await log.stub.append(log.identity, 1, [log.ev(11, "tool.completed", T1, big(9 * 1024))]);
    if (!second.ok) throw new Error("refused");
    await runInDurableObject(log.object, async (instance) => {
      await (instance as unknown as SessionLogDurableObject).spilling;
    });
    // The batch is sent BATCH_MS after its first event, through waitUntil.
    for (let i = 0; i < 300 && posted.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posts).toBe(1);
    expect(posted.map((e) => e.event_name)).toEqual(["sessionlog.spill", "sessionlog.spill"]);
    expect(posted[0]).toMatchObject({ session_key: log.sessionId, org_id: ORG, outcome: "completed" });
    expect(JSON.parse(posted[0]!.data)).toMatchObject({ spills: 2, failed: 0 });
    expect(JSON.parse(posted[1]!.data)).toMatchObject({ spills: 1, failed: 0 });
    expect(JSON.stringify(posted)).not.toContain("yyyy");
    expect(JSON.stringify(posted)).not.toContain("sessions/");
  });
});

describe("SessionLog subagents", () => {
  const SA1 = "sa_4m8q2x7c1v9b";
  const SA2 = "sa_9x2c7v1b4m8q";
  const validSubagent = validator("Subagent");
  const spawn = (sessionId: string, id: string, name: string, background = false) => ({
    subagent: {
      id,
      sessionId,
      turnId: T1,
      callId: `toolu_${name}`,
      name,
      agentType: "general-purpose",
      background,
      status: "running",
      activity: null,
      toolCalls: 0,
      tokens: 0,
      createdAt: "2026-10-26T09:00:01.000Z",
      endedAt: null,
      durationMs: null,
      result: null,
      resultTruncated: false,
      error: null,
      stoppedBy: null,
    },
  });
  function withSubagents(log: ReturnType<typeof open>) {
    const { ev, sessionId } = log;
    return [
      ev(1, "session.created", null, { title: "t", origin: { type: "opc", client: null, slack: null }, settings: started }, OWNER),
      ev(2, "session.status_changed", null, { from: null, to: "running" }),
      ev(3, "message.received", T1, received("first"), OWNER),
      ev(4, "turn.started", T1, started),
      ev(5, "subagent.started", T1, spawn(sessionId, SA1, "explore")),
      ev(6, "subagent.started", T1, spawn(sessionId, SA2, "tests", true)),
    ];
  }

  it("folds started/ended, keeps running ones in the summary, cuts long results and serves them whole", async () => {
    const log = open();
    const result = await log.stub.append(log.identity, 1, withSubagents(log));
    if (!result.ok) throw new Error("refused");
    expect(result.summary.subagents.map((s) => [s.id, s.status])).toEqual([
      [SA1, "running"],
      [SA2, "running"],
    ]);
    for (const s of result.summary.subagents) validSubagent(s);

    const long = "x".repeat(20_000);
    const ended = await log.stub.append(log.identity, 1, [
      log.ev(7, "subagent.ended", T1, {
        subagent: { ...spawn(log.sessionId, SA1, "explore").subagent, status: "completed", endedAt: "2026-10-26T09:00:09.000Z", durationMs: 8000, result: long, toolCalls: 4, tokens: 900 },
      }),
    ]);
    if (!ended.ok) throw new Error("refused");
    expect(ended.summary.subagents.map((s) => s.id)).toEqual([SA2]);

    const page = await log.stub.subagents({ status: "all" });
    if (!page.ok) throw new Error("refused");
    expect(page.subagents.map((s) => [s.id, s.status])).toEqual([
      [SA2, "running"],
      [SA1, "completed"],
    ]);
    const listed = page.subagents[1]!;
    expect(listed.resultTruncated).toBe(true);
    expect(listed.result!.length).toBeLessThan(long.length);
    for (const s of page.subagents) validSubagent(s);

    const running = await log.stub.subagents({ status: "running" });
    if (!running.ok) throw new Error("refused");
    expect(running.subagents.map((s) => s.id)).toEqual([SA2]);

    // Newest first by start, ended or not (calvin's order); a cursor is bound to its status filter.
    const first = await log.stub.subagents({ status: "all", limit: 1 });
    if (!first.ok || !first.nextCursor) throw new Error("refused");
    expect(first.subagents.map((s) => s.id)).toEqual([SA2]);
    const second = await log.stub.subagents({ status: "all", limit: 1, cursor: first.nextCursor });
    if (!second.ok) throw new Error("refused");
    expect([second.subagents.map((s) => s.id), second.nextCursor]).toEqual([[SA1], null]);
    expect(await log.stub.subagents({ status: "running", cursor: first.nextCursor })).toEqual({ ok: false, error: "invalid_cursor" });

    const one = await log.stub.subagent(SA1);
    if (!one.ok) throw new Error("refused");
    expect(one.subagent).toMatchObject({ status: "completed", result: long, resultTruncated: false, toolCalls: 4, tokens: 900 });
    validSubagent(one.subagent);
    expect(await log.stub.subagent("sa_000000000000")).toEqual({ ok: false, error: "subagent_not_found" });

    // A resent start never reopens an ended subagent.
    const resent = await log.stub.append(log.identity, 1, [log.ev(8, "subagent.started", T1, spawn(log.sessionId, SA1, "explore"))]);
    if (!resent.ok) throw new Error("refused");
    expect(resent.summary.subagents.map((s) => s.id)).toEqual([SA2]);
  });

  it("merges progress into reads for a running subagent of the current epoch only", async () => {
    const log = open();
    await log.stub.append(log.identity, 1, withSubagents(log));
    await log.stub.progress(log.identity, 1, [
      { subagentId: SA2, activity: "Running npm test", toolCalls: 3, tokens: 1200 },
      { subagentId: "sa_000000000000", activity: "ghost", toolCalls: 1, tokens: 1 },
    ]);
    await log.stub.progress(log.identity, 0, [{ subagentId: SA1, activity: "stale", toolCalls: 9, tokens: 9 }]);
    const summary = await log.stub.summary();
    if (!summary.ok) throw new Error("refused");
    expect(summary.summary.subagents.map((s) => [s.id, s.activity, s.toolCalls, s.tokens])).toEqual([
      [SA1, null, 0, 0],
      [SA2, "Running npm test", 3, 1200],
    ]);
    const one = await log.stub.subagent(SA2);
    if (!one.ok) throw new Error("refused");
    expect(one.subagent).toMatchObject({ activity: "Running npm test", toolCalls: 3 });
  });

  it("recover ends running subagents as failed runtime_lost", async () => {
    const log = open();
    await log.stub.append(log.identity, 1, withSubagents(log));
    const at = "2026-10-26T10:00:00.000Z";
    const result = await log.stub.recover({ ...log.identity, epoch: 2, at });
    if (!result.ok) throw new Error("refused");
    expect(result.summary.subagents).toEqual([]);
    const page = await log.stub.events({ after: 6 });
    if (!page.ok) throw new Error("refused");
    const ends = page.events.filter((e) => e.type === "subagent.ended");
    expect(ends.length).toBe(2);
    for (const e of page.events) validEvent(e);
    const all = await log.stub.subagents({ status: "all" });
    if (!all.ok) throw new Error("refused");
    for (const s of all.subagents) {
      expect(s).toMatchObject({ status: "failed", endedAt: at, error: { code: "runtime_lost" } });
      validSubagent(s);
    }
  });
});
