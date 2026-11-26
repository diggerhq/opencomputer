import { describe, expect, it } from "vitest";

import type { Actor } from "../src/api-objects/objects.js";
import { SLOT_REFRESH_MS } from "../src/actors/session-log/durable-object.js";
import { member, openLog, OWNER_ID } from "./session-log-kit.js";

/** Tracks and threads, spec 35.2 and 40.3: the summary slot the log owes Org, and the occurrences that go with it. */

const OWNER: Actor = { id: OWNER_ID, name: "Owner", via: "opc", client: "opc/0.1.0" };
const T1 = "tn_4m8q2x7c1v9b";
const received = (input: string) => ({ input, ifBusy: "queue", delivery: "started", interruptedTurnIds: [] });
const started = { model: "claude-opus-5-5", effort: "high", mode: "default" };

type Log = Awaited<ReturnType<typeof openLog>>;
const revision = (log: Log) => log.inside((_, state) => state.storage.sql.exec<{ revision: number }>("SELECT revision FROM meta").one().revision);
const pending = (log: Log) => log.inside((_, state) => state.storage.sql.exec<{ seq: number; kind: string }>("SELECT seq, kind FROM occ_pending ORDER BY seq").toArray());
const owes = (log: Log) => log.inside((_, state) => state.storage.sql.exec("SELECT 1 FROM _owed WHERE key = 'summary'").toArray().length);
/** A running turn: seqs 1..4. */
const running = (log: Log) => [
  log.ev(1, "session.created", null, { title: "t", origin: { type: "opc", client: null, slack: null }, settings: started }, OWNER),
  log.ev(2, "session.status_changed", null, { from: null, to: "running" }),
  log.ev(3, "message.received", T1, received("first"), OWNER),
  log.ev(4, "turn.started", T1, started),
];

describe("the summary slot", () => {
  it("bumps the revision by the rules of 40.3, and not for any other append", async () => {
    const log = await openLog();
    await log.stub.accept(member(), { id: T1, kind: "turn", body: { input: "first" } });
    expect(await revision(log)).toBe(1);
    await log.stub.delivered(T1, { ok: true });
    expect(await revision(log)).toBe(2);
    // An occurrence, a status and a title.
    await log.stub.append(log.identity, 1, running(log));
    expect(await revision(log)).toBe(3);
    // A running turn's other events: nothing, until the slot is 30 s old.
    await log.stub.append(log.identity, 1, [log.ev(5, "tool.started", T1, { toolName: "Bash", callId: "c1", parentCallId: null, title: "x", input: {}, inputTruncated: false })]);
    await log.stub.append(log.identity, 1, [log.ev(6, "tool.completed", T1, { callId: "c1" })]);
    expect(await revision(log)).toBe(3);
    await log.inside((instance) => {
      (instance as unknown as { meta: { slotAt: number } }).meta.slotAt -= SLOT_REFRESH_MS + 1;
    });
    await log.stub.append(log.identity, 1, [log.ev(7, "x.y", T1, {})]);
    expect(await revision(log)).toBe(4);
    await log.stub.append(log.identity, 1, [log.ev(8, "x.y", T1, {})]);
    expect(await revision(log)).toBe(4);
    // The turn ends (an occurrence); after it nothing runs, so an old slot alone does not count.
    await log.stub.append(log.identity, 1, [log.ev(9, "message.completed", T1, { text: "Done.", parentCallId: null }), log.ev(10, "turn.completed", T1, { text: "Done." })]);
    expect(await revision(log)).toBe(5);
    await log.inside((instance) => {
      (instance as unknown as { meta: { slotAt: number } }).meta.slotAt -= SLOT_REFRESH_MS + 1;
    });
    await log.stub.append(log.identity, 1, [log.ev(11, "x.y", null, {})]);
    expect(await revision(log)).toBe(5);

    // Org holds the last revision, with what the appends since changed nothing of.
    await log.flush();
    const last = log.fakes.summaries.at(-1)!;
    expect(last).toMatchObject({ sessionId: log.sessionId, revision: 5, summary: { revision: 5, lastAgentSeq: 10, agentTitle: "t", title: "t", lastText: "Done.", inbox: [] } });
    expect(await owes(log)).toBe(0);
  });

  it("carries the inbox entries that wait or were refused", async () => {
    const log = await openLog();
    await log.stub.accept(member(), { id: "tn_a", kind: "turn", body: { input: "a".repeat(400) } });
    await log.stub.accept(member(), { id: "tn_b", kind: "turn", body: { input: "second" } });
    await log.stub.accept(member(), { id: "in_c", kind: "interrupt", body: {} });
    await log.stub.accept(member(), { id: "tn_d", kind: "turn", body: { input: "fourth" } });
    await log.stub.delivered("tn_a", { ok: false, code: "queue_full", message: "The queue is full." });
    await log.stub.delivered("tn_b", { ok: true });
    await log.flush();
    const { summary } = log.fakes.summaries.at(-1)!;
    expect(summary.revision).toBe(6);
    expect(summary.inbox).toEqual([
      { id: "tn_a", kind: "turn", by: `user:${OWNER_ID}`, at: expect.any(String), text: "a".repeat(280), error: "queue_full" },
      { id: "in_c", kind: "interrupt", by: `user:${OWNER_ID}`, at: expect.any(String), text: null, error: null },
      { id: "tn_d", kind: "turn", by: `user:${OWNER_ID}`, at: expect.any(String), text: "fourth", error: null },
    ]);
    // A dismiss naming the refused entry takes it out of the summary.
    await log.stub.accept(member(), { id: "ds_1", kind: "dismiss", body: { entryId: "tn_a" } });
    await log.flush();
    expect(log.fakes.summaries.at(-1)!.summary).toMatchObject({ revision: 7, inbox: [{ id: "in_c" }, { id: "tn_d" }] });
  });

  it("is one owed call, replaced by a newer one, whose body is built when it is sent", async () => {
    const log = await openLog({
      orgAnswers: () => {
        throw new Error("Org is down");
      },
    });
    await log.stub.append(log.identity, 1, running(log));
    await log.stub.append(log.identity, 1, [log.ev(5, "turn.completed", T1, { text: "Done." })]);
    await log.flush(Date.now());
    expect(await revision(log)).toBe(2);
    expect(await log.inside((_, state) => state.storage.sql.exec("SELECT 1 FROM _owed WHERE grp = 'summary'").toArray().length)).toBe(1);
    expect(log.fakes.summaries).toEqual([]);
    log.fakes.orgAnswers = null;
    await log.flush();
    // One send, of the latest revision, with every occurrence since Org last answered.
    expect(log.fakes.summaries.length).toBe(1);
    expect(log.fakes.summaries[0]).toMatchObject({ revision: 2, summary: { lastSeq: 5, status: "running", activeTurnId: null } });
    expect(log.fakes.summaries[0]!.occurrences).toEqual([
      { epoch: 1, seq: 3, kind: "message.received", by: `user:${OWNER_ID}`, at: expect.any(Number) },
      { epoch: 1, seq: 5, kind: "turn.completed", by: null, at: expect.any(Number) },
    ]);
    expect(await owes(log)).toBe(0);
    expect(await pending(log)).toEqual([]);
  });

  it("keeps the occurrences and the call until Org answers that revision", async () => {
    // Org answers the revision it holds: an older one means it did not take this one.
    const log = await openLog({ orgAnswers: (pub) => pub.revision - 1 });
    await log.stub.append(log.identity, 1, running(log));
    await log.flush();
    expect(log.fakes.summaries.length).toBeGreaterThan(0);
    expect(await pending(log)).toEqual([{ seq: 3, kind: "message.received" }]);
    expect(await owes(log)).toBe(1);
    // A later revision while that one is owed: the next send carries both occurrences.
    await log.stub.append(log.identity, 1, [log.ev(5, "turn.failed", T1, { error: { code: "agent_failed", message: "x" } })]);
    log.fakes.orgAnswers = null;
    await log.flush();
    expect(log.fakes.summaries.at(-1)).toMatchObject({ revision: 2, occurrences: [{ seq: 3 }, { seq: 5, kind: "turn.failed" }] });
    expect(await pending(log)).toEqual([]);
    expect(await owes(log)).toBe(0);
    // Nothing owed: nothing more is sent.
    const sent = log.fakes.summaries.length;
    await log.flush();
    expect(log.fakes.summaries.length).toBe(sent);
  });

  it("sends again when the revision moved while Org was answering", async () => {
    const log = await openLog();
    let once = true;
    log.fakes.orgAnswers = async (pub, instance) => {
      // While this call is in flight, the log's summary changes again.
      if (once) {
        once = false;
        await instance.delivered("tn_a", { ok: true });
      }
      return pub.revision;
    };
    await log.stub.accept(member(), { id: "tn_a", kind: "turn", body: { input: "a" } });
    await log.flush();
    await log.flush();
    expect(log.fakes.summaries.map((s) => s.revision)).toEqual([1, 2]);
    expect(log.fakes.summaries.at(-1)!.summary.inbox).toEqual([]);
    expect(await owes(log)).toBe(0);
  });
});
