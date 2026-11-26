import { describe, expect, it } from "vitest";

import { cursor } from "../src/actor/index.js";
import type { Blobs } from "../src/computer/session-log.js";
import { accessOf, agent, MATE_ID, member, openLog, OWNER_ID, platform } from "./session-log-kit.js";

/** Tracks and threads, spec 36.2, 37.1, 40.4, 40.10: who may read a log, the events cursor and `reset`, the publish to Live. */

const at = (epoch: number, seq: number) => cursor.encode("e", [epoch, seq]);
type Log = Awaited<ReturnType<typeof openLog>>;
const fill = (log: Log, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => log.ev(from + i, "x.y", null, { n: from + i }));

describe("a principal's reads", () => {
  it("answer only who may read the session, on every read", async () => {
    const log = await openLog({ access: accessOf({ audience: `member:${OWNER_ID}`, readers: ["agent:cs_parent"] }) });
    await log.stub.append(log.identity, 1, fill(log, 1, 3));
    const reads = (p: Parameters<typeof log.stub.accept>[0]) =>
      Promise.all([
        log.stub.summary(undefined, p),
        log.stub.events({}, p),
        log.stub.turns({}, p),
        log.stub.turn("tn_none", {}, p),
        log.stub.asks({}, p),
        log.stub.ask("ak_none", undefined, p),
        log.stub.subagents({}, p),
        log.stub.subagent("sa_none", undefined, p),
      ]);
    const errors = async (p: Parameters<typeof log.stub.accept>[0]) => (await reads(p)).map((r) => (r.ok ? "ok" : r.error));
    const allowed = ["ok", "ok", "ok", "turn_not_found", "ok", "ask_not_found", "ok", "subagent_not_found"];
    const refused = Array.from({ length: 8 }, () => "not_found");
    expect(await errors(member())).toEqual(allowed);
    expect(await errors(platform)).toEqual(allowed);
    expect(await errors(agent(log.sessionId))).toEqual(allowed);
    expect(await errors(agent("cs_parent"))).toEqual(allowed);
    // The audience is the owner's alone; another agent; another organization.
    expect(await errors(member(MATE_ID))).toEqual(refused);
    expect(await errors(agent("cs_stranger"))).toEqual(refused);
    expect(await errors(member(OWNER_ID, { org: "org_other" }))).toEqual(refused);
  });

  it("answer a person it is shared with, beyond the audience", async () => {
    const log = await openLog({ access: accessOf({ audience: `member:${OWNER_ID}`, writers: [`user:${OWNER_ID}`, `user:${MATE_ID}`], readers: [`user:${MATE_ID}`] }) });
    await log.stub.append(log.identity, 1, fill(log, 1, 2));
    expect((await log.stub.events({}, member(MATE_ID))).ok).toBe(true);
    expect((await log.stub.events({}, member("usr_stranger"))).ok).toBe(false);
    // Stopping it: a person who reads it; not one who does not.
    expect(await log.stub.accept(member(MATE_ID), { id: "in_mate", kind: "interrupt", body: {} })).toMatchObject({ ok: true });
    expect(await log.stub.accept(member("usr_stranger"), { id: "in_stranger", kind: "interrupt", body: {} })).toEqual({ ok: false, code: "forbidden" });
  });

  it("answer not_found for a session Org does not have", async () => {
    const log = await openLog({ access: null });
    expect(await log.stub.events({}, member())).toEqual({ ok: false, error: "not_found" });
    expect(await log.stub.watch(member(), Date.now() + 60_000)).toBeNull();
  });

  it("carry the summary Org receives, and never wait", async () => {
    const log = await openLog();
    await log.stub.append(log.identity, 1, fill(log, 1, 2));
    await log.stub.accept(member(), { id: "tn_a", kind: "turn", body: { input: "hello" } });
    expect(await log.stub.summary(undefined, member())).toMatchObject({ ok: true, summary: { lastSeq: 2, revision: 2, lastAgentSeq: 0, agentTitle: null, inbox: [{ id: "tn_a", text: "hello" }] } });
    const began = Date.now();
    expect(await log.stub.summary(9, member())).toMatchObject({ ok: false, error: "unavailable", lastSeq: 2 });
    expect(await log.stub.events({ after: at(1, 2) }, member())).toMatchObject({ ok: true, events: [], cursor: at(1, 2) });
    expect(Date.now() - began).toBeLessThan(1_000);
  });
});

describe("the events read", () => {
  it("pages by cursor: after the last event returned, or the one given", async () => {
    const log = await openLog();
    await log.stub.append(log.identity, 1, fill(log, 1, 5));
    const first = await log.stub.events({ limit: 2 }, member());
    expect(first).toMatchObject({ ok: true, cursor: at(1, 2), hasMore: true });
    if (!first.ok) throw new Error("refused");
    const rest = await log.stub.events({ after: first.cursor }, member());
    expect(rest).toMatchObject({ ok: true, cursor: at(1, 5), hasMore: false });
    if (!rest.ok) throw new Error("refused");
    expect(rest.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(await log.stub.events({ after: rest.cursor }, member())).toMatchObject({ ok: true, events: [], cursor: at(1, 5) });
  });

  it("answers reset for what is no cursor, and for one past the log's end", async () => {
    const log = await openLog();
    await log.stub.append(log.identity, 1, fill(log, 1, 5));
    for (const after of ["3", "nonsense", "f1.3", at(2, 1)]) expect(await log.stub.events({ after }, member())).toEqual({ ok: false, error: "reset", cursor: null });
    expect(await log.stub.events({ after: at(1, 6) }, member())).toEqual({ ok: false, error: "reset", cursor: at(1, 5), seq: 5 });
  });

  it("across an epoch change: reads on below the new epoch's first seq, reset at or past it", async () => {
    const log = await openLog();
    await log.stub.append(log.identity, 1, fill(log, 1, 6));
    // The new epoch starts at seq 5: the old 5 and 6 are gone.
    await log.stub.append(log.identity, 2, fill(log, 5, 7));
    const on = await log.stub.events({ after: at(1, 3) }, member());
    expect(on).toMatchObject({ ok: true, cursor: at(2, 7) });
    if (!on.ok) throw new Error("refused");
    expect(on.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(await log.stub.events({ after: at(1, 4) }, member())).toMatchObject({ ok: true, cursor: at(2, 7) });
    // What the reader holds past seq 4 is not in the log any more: it may keep up to 4.
    expect(await log.stub.events({ after: at(1, 5) }, member())).toEqual({ ok: false, error: "reset", cursor: at(2, 4), seq: 4 });
    expect(await log.stub.events({ after: at(1, 6) }, member())).toEqual({ ok: false, error: "reset", cursor: at(2, 4), seq: 4 });
    // Following the reset reads the new epoch's events.
    expect(await log.stub.events({ after: at(2, 4) }, member())).toMatchObject({ ok: true, events: [{ seq: 5 }, { seq: 6 }, { seq: 7 }] });
    // A later epoch that starts higher does not hide what the one between rewrote.
    await log.stub.append(log.identity, 3, fill(log, 8, 8));
    expect(await log.stub.events({ after: at(1, 6) }, member())).toEqual({ ok: false, error: "reset", cursor: at(3, 4), seq: 4 });
    expect(await log.stub.events({ after: at(2, 6) }, member())).toMatchObject({ ok: true, events: [{ seq: 7 }, { seq: 8 }], cursor: at(3, 8) });
  });
});

describe("watch and the publish to Live", () => {
  it("publishes an append's events while Live holds the lease, and not after", async () => {
    const log = await openLog();
    await log.stub.append(log.identity, 1, fill(log, 1, 2));
    await log.flush();
    expect(log.fakes.published).toEqual([]);
    expect(await log.stub.watch(member(MATE_ID, { audiences: [] }), Date.now() + 60_000)).toBeNull();
    expect(await log.stub.watch(member(), Date.now() + 60_000)).toEqual({ head: at(1, 2), machine: "mc_0000000000000001" });
    const events = fill(log, 3, 4);
    await log.stub.append(log.identity, 1, events);
    await log.flush();
    expect(log.fakes.published).toEqual([{ topic: `events:${log.sessionId}`, value: { from: at(1, 2), to: at(1, 4), events } }]);
    // The lease passes: nothing more.
    await log.inside((instance) => {
      (instance as unknown as { meta: { watchedUntil: number } }).meta.watchedUntil = Date.now() - 1;
    });
    await log.stub.append(log.identity, 1, fill(log, 5, 5));
    await log.flush();
    expect(log.fakes.published.length).toBe(1);
  });

  it("retries with the head alone", async () => {
    const log = await openLog({ publishFails: true });
    await log.stub.watch(member(), Date.now() + 600_000);
    await log.stub.append(log.identity, 1, fill(log, 1, 2));
    await log.flush(Date.now());
    log.fakes.publishFails = false;
    await log.flush();
    expect(log.fakes.published).toEqual([{ topic: `events:${log.sessionId}`, value: { head: at(1, 2) } }]);
    const owes = (l: Log) => l.inside((_, state) => state.storage.sql.exec("SELECT 1 FROM _owed WHERE key = 'live:events'").toArray().length);
    expect(await owes(log)).toBe(0);
  });
});

describe("destroy", () => {
  it("empties the log's storage and removes its blobs", async () => {
    const log = await openLog();
    const store = new Map<string, string>();
    const blobs: Blobs = {
      put: async (key, json) => void store.set(key, json),
      get: async (key) => store.get(key) ?? null,
      removeAll: async (prefix) => {
        for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
      },
    };
    store.set("sessions/org_test/cs_other/events/1-1.json", "{}");
    await log.inside((instance) => {
      instance.blobs = blobs;
    });
    await log.stub.append(log.identity, 1, [log.ev(1, "x.y", null, { big: "z".repeat(9_000) })]);
    await log.inside((instance) => instance.spilling);
    await log.stub.accept(member(), { id: "tn_a", kind: "turn", body: { input: "a" } });
    expect([...store.keys()].filter((key) => key.includes(log.sessionId)).length).toBe(1);
    await log.stub.destroy();
    expect([...store.keys()]).toEqual(["sessions/org_test/cs_other/events/1-1.json"]);
    expect(await log.stub.inbox()).toEqual({ entries: [], epoch: 0, lastSeq: 0 });
    expect(await log.stub.events({}, member())).toMatchObject({ ok: true, events: [], lastSeq: 0 });
    expect(await log.inside((_, state) => state.storage.sql.exec("SELECT 1 FROM _owed").toArray().length)).toBe(0);
  });
});
