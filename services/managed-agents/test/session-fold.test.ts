import { Validator, type Schema } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";

import type { Actor, ApiEvent } from "../src/computer/api-types.js";
import { addDecimal, foldEvents, publicTurn } from "../src/computer/session-fold.js";
import schema from "./fixtures/calvin/computer-api.v1.json" with { type: "json" };

/** Work 084: the session log's pure fold, events → Turns, Asks and the LogSummary, checked against the schema. */

const SESSION = "cs_7f3a9k2m4q8r1t6v";
const T1 = "tn_4m8q2x7c1v9b";
const T2 = "tn_9x2c7v1b4m8q";
const T3 = "tn_1b4m8q9x2c7v";
const ASK = "ak_7c1v9b4m8q2x";
const OWNER: Actor = { id: "usr_2k9d8f7a", name: "Owner", via: "opc", client: "opc/0.1.0" };
const MO: Actor = { id: "usr_mo", name: "Mo", via: "slack", client: null };

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
const validSummary = validator("TurnSummary");
const validEvent = validator("Event");

function log() {
  const events: ApiEvent[] = [];
  let ms = Date.parse("2026-10-26T09:00:00.000Z");
  const add = (type: string, turnId: string | null, data: unknown, actor: Actor | null = null) => {
    const event: ApiEvent = {
      id: `ev_${String(events.length + 1).padStart(16, "0")}`,
      seq: events.length + 1,
      createdAt: new Date((ms += 10)).toISOString(),
      sessionId: SESSION,
      turnId,
      type,
      actor,
      data,
    };
    events.push(event);
    return event;
  };
  return { events, add };
}

const usage = (input: number, cost: string | null, used: number) => ({
  model: "claude-opus-5-5",
  inputTokens: input,
  outputTokens: 10,
  reasoningTokens: 0,
  cachedTokens: 5,
  cacheWriteTokens: 1,
  costUsd: cost,
  firstTokenMs: 100,
  durationMs: 900,
  usedTokens: used,
  windowTokens: 200_000,
});

const approval = {
  id: ASK,
  sessionId: SESSION,
  turnId: T1,
  kind: "approval",
  status: "open",
  createdAt: "2026-10-26T09:00:00.500Z",
  closedAt: null,
  closedBy: null,
  answer: null,
  approval: { toolName: "Bash", callId: "toolu_01", input: { command: "terraform plan" }, title: "terraform plan", alwaysAllows: null },
  question: null,
  secret: null,
};

describe("session fold", () => {
  it("derives a completed turn, its usage, and the session summary", () => {
    const { events, add } = log();
    add("session.created", null, { title: "Fix the flake", origin: { type: "opc", client: "opc/0.1.0", slack: null }, settings: { model: "claude-opus-5-5", effort: "high", mode: "default" } }, OWNER);
    add("session.status_changed", null, { from: null, to: "running" });
    add("message.received", T1, { input: "fix it", ifBusy: "queue", delivery: "started", interruptedTurnIds: [] }, OWNER);
    add("turn.started", T1, { model: "claude-opus-5-5", effort: "high", mode: "default" });
    add("tool.started", T1, { toolName: "Bash", callId: "toolu_01", parentCallId: null, title: "npm test", input: { command: "npm test" }, inputTruncated: false });
    add("usage.recorded", T1, usage(100, "0.0312", 1000));
    add("tool.completed", T1, { toolName: "Bash", callId: "toolu_01", parentCallId: null, title: "npm test", output: "ok", outputTruncated: false, fileChanges: null, durationMs: 5 });
    add("message.completed", T1, { blockId: "b1", parentCallId: null, text: "Done. ".repeat(50) });
    add("usage.recorded", T1, usage(50, "0.0088", 1500));
    add("session.updated", null, { changes: { title: { from: "Fix the flake", to: "Flake fixed" }, effort: { from: "high", to: "low" }, speed: { from: null, to: "standard" } } }, OWNER);
    const done = add("turn.completed", T1, { text: "Done.", durationMs: 1200 });
    add("session.status_changed", null, { from: "running", to: "idle" });
    add("future.thing", null, { whatever: true });
    for (const event of events) validEvent(event);

    const { store, summary } = foldEvents(SESSION, events, { logEpoch: 1, syncedAt: "2026-10-26T09:01:00.000Z" });
    const t = store.turns.get(T1)!;
    expect(t.turn).toMatchObject({ status: "completed", text: "Done.", input: "fix it", author: OWNER, endedAt: done.createdAt });
    const shown = publicTurn(t);
    validTurn(shown);
    expect(shown.usage).toEqual({ inputTokens: 150, outputTokens: 20, reasoningTokens: 0, cachedTokens: 10, cacheWriteTokens: 2, costUsd: "0.0400" });
    expect(store.tools.size).toBe(0);

    expect(summary).toMatchObject({
      lastSeq: events.length,
      logEpoch: 1,
      status: "idle",
      title: "Flake fixed",
      settings: { model: "claude-opus-5-5", effort: "low", mode: "default", speed: "standard" },
      activeTurnId: null,
      queued: [],
      asks: [],
      lastText: "Done.",
      context: { usedTokens: 1500, windowTokens: 200_000 },
      lastActiveAt: events.at(-1)!.createdAt,
      syncedAt: "2026-10-26T09:01:00.000Z",
    });
    expect(summary.lastTurn).toEqual({ id: T1, status: "completed", endedAt: done.createdAt, text: "Done.", error: null, reason: null, forced: null });
    validSummary(summary.lastTurn);
  });

  it("exposes usage only once a turn ended, and validates every Turn against the schema", () => {
    const { events, add } = log();
    add("message.received", T1, { input: "go", ifBusy: "queue", delivery: "started", interruptedTurnIds: [] }, OWNER);
    add("turn.started", T1, { model: null, effort: null, mode: null });
    add("usage.recorded", T1, usage(10, null, 100));
    let folded = foldEvents(SESSION, events);
    const running = folded.store.turns.get(T1)!;
    expect(running.turn.usage).toBeNull();
    expect(folded.summary.activeTurnId).toBe(T1);
    validTurn(running.turn);

    add("turn.failed", T1, { error: { code: "model_rejected", message: "no" } });
    folded = foldEvents(SESSION, events);
    const failed = folded.summary.lastTurn!;
    expect(failed).toMatchObject({ status: "failed", error: { code: "model_rejected", message: "no" } });
    validSummary(failed);
  });

  it("a steered message that declines an open ask is the turn's once read: no new turn when it ends", () => {
    const { events, add } = log();
    add("message.received", T1, { input: "first", ifBusy: "queue", delivery: "started", interruptedTurnIds: [] }, OWNER);
    add("turn.started", T1, { model: null, effort: null, mode: null });
    add("ask.opened", T1, { ask: approval });
    const steer = add("message.received", T1, { input: "no, do X", ifBusy: "steer", delivery: "steered", interruptedTurnIds: [], declinedAskIds: [ASK] }, MO);
    add("ask.closed", T1, { ask: { ...approval, status: "declined", closedAt: null, closedBy: null, answer: { message: "no, do X", messageSeq: steer.seq } } }, MO);
    add("turn.steered", T1, { messageSeq: steer.seq });
    add("turn.completed", T1, { text: "done", durationMs: 5 });
    add("turn.queued", T2, { position: 1 });
    const folded = foldEvents(SESSION, events);
    expect(folded.summary.asks).toEqual([]);
    expect(folded.store.asks.get(ASK)!.ask).toMatchObject({ status: "declined", closedBy: MO, answer: { message: "no, do X" } });
    expect(folded.store.turns.get(T1)!.turn.steering).toEqual([{ input: "no, do X", author: MO, createdAt: steer.createdAt }]);
    // T2 is not the steered message's: it was read.
    expect(folded.store.turns.get(T2)!.turn.input).not.toBe("no, do X");
  });

  it("turn.steered.messageSeq names the message read: the other, unread one gets its own turn", () => {
    const { events, add } = log();
    add("message.received", T1, { input: "first", ifBusy: "queue", delivery: "started", interruptedTurnIds: [] }, OWNER);
    add("turn.started", T1, { model: null, effort: null, mode: null });
    add("message.received", T1, { input: "older", ifBusy: "steer", delivery: "steered", interruptedTurnIds: [] }, MO);
    const newer = add("message.received", T1, { input: "newer", ifBusy: "steer", delivery: "steered", interruptedTurnIds: [] }, MO);
    // Not FIFO: the writer says it read the newer one.
    add("turn.steered", T1, { messageSeq: newer.seq });
    add("turn.completed", T1, { text: null, durationMs: 5 });
    add("turn.queued", T2, { position: 1 });
    const folded = foldEvents(SESSION, events);
    expect(folded.store.turns.get(T2)!.turn).toMatchObject({ input: "older", ifBusy: "steer" });
  });

  it("queues, steers, interrupts, and gives an unread steered message its own turn", () => {
    const { events, add } = log();
    add("message.received", T1, { input: "first", ifBusy: "queue", delivery: "started", interruptedTurnIds: [] }, OWNER);
    add("turn.started", T1, { model: null, effort: null, mode: null });
    add("message.received", T2, { input: "second", ifBusy: "queue", delivery: "queued", interruptedTurnIds: [] }, MO);
    add("turn.queued", T2, { position: 1 });
    const steer = add("message.received", T1, { input: "also this", ifBusy: "steer", delivery: "steered", interruptedTurnIds: [] }, MO);

    let folded = foldEvents(SESSION, events);
    expect(folded.summary.activeTurnId).toBe(T1);
    expect(folded.summary.queued.map((t) => t.id)).toEqual([T2]);
    const t1 = folded.store.turns.get(T1)!.turn;
    expect(t1.steering).toEqual([{ input: "also this", author: MO, createdAt: steer.createdAt }]);
    for (const r of folded.store.turns.values()) validTurn(r.turn);

    // T1 ends before reading the steered message: it starts T3 at once, and leaves T1's steering.
    add("turn.completed", T1, { text: null, durationMs: 5 });
    add("turn.queued", T3, { position: 2 });
    folded = foldEvents(SESSION, events);
    expect(folded.store.turns.get(T1)!.turn.steering).toEqual([]);
    expect(folded.store.turns.get(T3)!.turn).toMatchObject({ input: "also this", author: MO, ifBusy: "steer", status: "queued", createdAt: steer.createdAt });
    expect(folded.summary.queued.map((t) => t.id)).toEqual([T2, T3]);

    // An interrupt cancels both queued turns.
    add("message.received", "tn_aaaaaaaaaaaa", { input: "stop", ifBusy: "interrupt", delivery: "started", interruptedTurnIds: [T2, T3] }, OWNER);
    add("turn.cancelled", T2, { reason: "interrupted", forced: false, input: "second" });
    add("turn.cancelled", T3, { reason: "interrupted", forced: false, input: "also this" });
    add("turn.started", "tn_aaaaaaaaaaaa", { model: null, effort: null, mode: null });
    add("turn.status_changed", "tn_aaaaaaaaaaaa", { from: "running", to: "cancelling" });
    folded = foldEvents(SESSION, events);
    expect(folded.summary.queued).toEqual([]);
    expect(folded.summary.activeTurnId).toBe("tn_aaaaaaaaaaaa");
    expect(folded.store.turns.get("tn_aaaaaaaaaaaa")!.turn.status).toBe("cancelling");
    expect(folded.summary.lastTurn).toMatchObject({ id: T3, status: "cancelled", reason: "interrupted", forced: false });
    for (const r of folded.store.turns.values()) validTurn(r.turn);
  });

  it("opens and closes asks with the schema's Ask", () => {
    const { events, add } = log();
    add("message.received", T1, { input: "plan", ifBusy: "queue", delivery: "started", interruptedTurnIds: [] }, OWNER);
    add("turn.started", T1, { model: null, effort: null, mode: null });
    add("ask.opened", T1, { ask: approval });
    let folded = foldEvents(SESSION, events);
    expect(folded.summary.asks).toEqual([approval]);
    validAsk(folded.summary.asks[0]);

    const closed = add("ask.closed", T1, { ask: { ...approval, status: "answered", closedAt: null, closedBy: null, answer: { decision: "allow", message: null } } }, MO);
    folded = foldEvents(SESSION, events);
    const ask = folded.store.asks.get(ASK)!.ask;
    expect(ask).toMatchObject({ status: "answered", closedAt: closed.createdAt, closedBy: MO, answer: { decision: "allow", message: null }, approval: approval.approval });
    expect(folded.summary.asks).toEqual([]);
    validAsk(ask);
  });

  it("gives a turn no one sent a null author and input, and a stopped subagent the Actor who stopped it", () => {
    const { events, add } = log();
    add("turn.queued", T1, { trigger: "subagent", subagentId: "sa_4m8q2x7c1v9b", position: 0 });
    add("turn.started", T1, { model: null, effort: null, mode: null, trigger: "subagent", subagentId: "sa_4m8q2x7c1v9b" });
    add("turn.started", T2, { model: null, effort: null, mode: null }); // no message, no trigger: no orphan to adopt
    add("subagent.started", T1, { subagent: { id: "sa_2", name: "explore", background: true } });
    add("subagent.ended", T1, { subagent: { id: "sa_2", status: "stopped" } }, OWNER);
    add("subagent.started", T1, { subagent: { id: "sa_3", name: "legacy", background: true } });
    add("subagent.ended", T1, { subagent: { id: "sa_3", status: "stopped", stoppedBy: "usr_mo" } });
    const { store } = foldEvents(SESSION, events);
    expect(store.turns.get(T1)!.turn).toMatchObject({ trigger: "subagent", subagentId: "sa_4m8q2x7c1v9b", input: null, author: null });
    expect(store.turns.get(T2)!.turn).toMatchObject({ input: null, author: null });
    expect(store.subagents.get("sa_2")!.subagent.stoppedBy).toEqual(OWNER);
    expect(store.subagents.get("sa_3")!.subagent.stoppedBy).toMatchObject({ id: "usr_mo" });
    for (const r of store.turns.values()) validTurn(r.turn);
  });

  it("adds decimal costs exactly", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal(null, "1.5")).toBe("1.5");
    expect(addDecimal("0.0312", "0.0088")).toBe("0.0400");
  });
});
