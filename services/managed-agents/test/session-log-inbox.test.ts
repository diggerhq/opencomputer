import { describe, expect, it } from "vitest";

import { AGENT_TURNS_MAX, INBOX_KEEP_MS, INBOX_MAX_WAITING } from "../src/computer/session-log.js";
import { accessOf, agent, MACHINE, MATE_ID, member, openLog, platform } from "./session-log-kit.js";

/** Tracks and threads, spec 36.2 and 40.2: the log's access, its inbox, and the drain it owes its machine. */

const turn = (id: string, input = "hello") => ({ id, kind: "turn" as const, body: { input } });

describe("access", () => {
  it("reads Org once when it holds none, and answers not_found when Org has none", async () => {
    const log = await openLog();
    expect(await log.stub.accept(member(), turn("tn_a"))).toMatchObject({ ok: true, machine: MACHINE });
    expect(await log.stub.accept(member(), turn("tn_b"))).toMatchObject({ ok: true });
    expect(log.fakes.accessReads).toBe(1);

    const none = await openLog({ access: null });
    expect(await none.stub.accept(member(), turn("tn_a"))).toEqual({ ok: false, code: "not_found" });
    // Nothing was learned: the next call asks again.
    none.fakes.access = accessOf();
    expect(await none.stub.accept(member(), turn("tn_a"))).toMatchObject({ ok: true });
  });

  it("answers another organization's principal not_found", async () => {
    const log = await openLog();
    await log.stub.accept(member(), turn("tn_a"));
    expect(await log.stub.accept(member("usr_x", { org: "org_other" }), turn("tn_b"))).toEqual({ ok: false, code: "not_found" });
  });

  it("keeps a pushed access only when its revision is newer", async () => {
    const log = await openLog();
    await log.stub.setAccess(accessOf({ revision: 5, writers: [`user:${MATE_ID}`] }));
    await log.stub.setAccess(accessOf({ revision: 4, writers: "members" }));
    await log.stub.append(log.identity, 1, []);
    expect(await log.stub.accept(member(), turn("tn_a"))).toEqual({ ok: false, code: "forbidden" });
    expect(await log.stub.accept(member(MATE_ID), turn("tn_a"))).toMatchObject({ ok: true });
    expect(log.fakes.accessReads).toBe(0);
    await log.stub.setAccess(accessOf({ revision: 6, writers: "members" }));
    expect(await log.stub.accept(member(), turn("tn_b"))).toMatchObject({ ok: true });
  });
});

describe("accept", () => {
  it("authorizes by kind", async () => {
    const log = await openLog({ access: accessOf({ writers: [`user:${MATE_ID}`, "agent:cs_parent"] }) });
    const owner = member();
    const mate = member(MATE_ID);
    // A turn, an answer, a dismiss: the writers and the platform.
    for (const kind of ["turn", "answer", "dismiss"] as const) {
      expect(await log.stub.accept(owner, { id: `o_${kind}`, kind, body: {} })).toEqual({ ok: false, code: "forbidden" });
      expect(await log.stub.accept(mate, { id: `m_${kind}`, kind, body: {} })).toMatchObject({ ok: true });
      expect(await log.stub.accept(agent("cs_parent"), { id: `a_${kind}`, kind, body: {} })).toMatchObject({ ok: true });
      expect(await log.stub.accept(agent("cs_stranger"), { id: `s_${kind}`, kind, body: {} })).toEqual({ ok: false, code: "forbidden" });
      expect(await log.stub.accept(platform, { id: `p_${kind}`, kind, body: {} })).toMatchObject({ ok: true });
    }
    // An interrupt: any person who reached the session, and a listed agent.
    expect(await log.stub.accept(owner, { id: "o_int", kind: "interrupt", body: {} })).toMatchObject({ ok: true });
    expect(await log.stub.accept(agent("cs_stranger"), { id: "s_int", kind: "interrupt", body: {} })).toEqual({ ok: false, code: "forbidden" });
    // Settings: the owner and the people who write it; never an agent or the platform.
    expect(await log.stub.accept(owner, { id: "o_set", kind: "settings", body: { model: "x" } })).toMatchObject({ ok: true });
    expect(await log.stub.accept(mate, { id: "m_set", kind: "settings", body: { model: "x" } })).toMatchObject({ ok: true });
    expect(await log.stub.accept(agent("cs_parent"), { id: "a_set", kind: "settings", body: { model: "x" } })).toEqual({ ok: false, code: "forbidden" });
    expect(await log.stub.accept(platform, { id: "p_set", kind: "settings", body: { model: "x" } })).toEqual({ ok: false, code: "forbidden" });
  });

  it("lets in the agent that started a thread its members write: a member-owned track's agent starts a thread (spec 40.7)", async () => {
    // What Org.access answers for a thread the track's agent started with start_thread: `writers` stays
    // 'members' (the owner's sessions), and the agent is in `agents` and `readers`.
    const thread = accessOf({ writers: "members", agents: ["agent:cs_track"], readers: ["agent:cs_track"] });
    const log = await openLog({ access: thread });
    expect(await log.stub.accept(agent("cs_track"), turn("tn_first", "the brief"))).toMatchObject({ ok: true });
    expect(await log.stub.accept(agent("cs_track"), { id: "in_1", kind: "interrupt", body: {} })).toMatchObject({ ok: true });
    expect(await log.stub.accept(agent("cs_stranger"), turn("tn_stranger"))).toEqual({ ok: false, code: "forbidden" });
    // `agents` never widens settings, which stay the owner's and the members'.
    expect(await log.stub.accept(agent("cs_track"), { id: "st_1", kind: "settings", body: { model: "x" } })).toEqual({ ok: false, code: "forbidden" });
  });

  it("reads Org again when its stored access predates `agents`", async () => {
    const log = await openLog({ access: accessOf({ writers: "members", agents: ["agent:cs_track"], readers: ["agent:cs_track"] }) });
    expect(await log.stub.accept(member(), turn("tn_before"))).toMatchObject({ ok: true });
    const reads = log.fakes.accessReads;
    // A row stored by the previous version (same revision, no agents column), loaded as at a restart.
    await log.inside((instance, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO access (k, owner, audience, writers, readers, machine, revision) VALUES (1, ?, 'org', '\"members\"', '[]', ?, 1)", accessOf().owner, MACHINE);
      (instance as unknown as { open(): void }).open();
    });
    expect(await log.stub.accept(agent("cs_track"), turn("tn_after"))).toMatchObject({ ok: true });
    expect(log.fakes.accessReads).toBe(reads + 1);
  });

  it("is idempotent on the id: duplicate with the stored result, conflict on another body", async () => {
    const log = await openLog();
    expect(await log.stub.accept(member(), turn("tn_a"))).toEqual({ ok: true, id: "tn_a", duplicate: false, machine: MACHINE });
    expect(await log.stub.accept(member(), turn("tn_a"))).toEqual({ ok: true, id: "tn_a", duplicate: true, machine: MACHINE });
    expect(await log.stub.accept(member(), turn("tn_a", "other"))).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(await log.stub.accept(member(), { id: "tn_a", kind: "answer", body: { input: "hello" } })).toEqual({ ok: false, code: "idempotency_conflict" });
    await log.stub.delivered("tn_a", { ok: true, result: { turn: { id: "tn_a", status: "running" } } });
    expect(await log.stub.accept(member(), turn("tn_a"))).toEqual({ ok: true, id: "tn_a", duplicate: true, machine: MACHINE, result: { turn: { id: "tn_a", status: "running" } } });
    // The entry's outcome, for the caller that accepted it, whichever drain delivered it.
    expect(await log.stub.entry("tn_a")).toEqual({ state: "delivered", result: { turn: { id: "tn_a", status: "running" } } });
    expect(await log.stub.entry("tn_none")).toBeNull();
    await log.stub.accept(member(), turn("tn_b"));
    expect(await log.stub.entry("tn_b")).toEqual({ state: "waiting" });
    await log.stub.delivered("tn_b", { ok: false, code: "queue_full", message: "full" });
    expect(await log.stub.entry("tn_b")).toEqual({ state: "refused", error: { code: "queue_full", message: "full" } });
    // The host's status and fields are kept: the caller that reads the outcome later answers as the drain did.
    await log.stub.accept(member(), { id: "ie_c", kind: "cancel", body: { turnId: "tn_b" } });
    await log.stub.delivered("ie_c", { ok: false, code: "turn_not_cancellable", message: "the turn is running", status: 409, turn: { id: "tn_b", status: "running" } });
    expect(await log.stub.entry("ie_c")).toEqual({ state: "refused", error: { code: "turn_not_cancellable", message: "the turn is running", status: 409, turn: { id: "tn_b", status: "running" } } });
    expect((await log.stub.inbox()).entries).toEqual([]);
  });

  it(`refuses the entry after ${INBOX_MAX_WAITING} waiting, and takes one again when one is delivered`, async () => {
    const log = await openLog();
    for (let i = 0; i < INBOX_MAX_WAITING; i++) expect(await log.stub.accept(member(), turn(`tn_${i}`))).toMatchObject({ ok: true });
    expect(await log.stub.accept(member(), turn("tn_more"))).toEqual({ ok: false, code: "inbox_full" });
    // A duplicate of a waiting entry is still answered.
    expect(await log.stub.accept(member(), turn("tn_3"))).toMatchObject({ ok: true, duplicate: true });
    await log.stub.delivered("tn_0", { ok: true });
    expect(await log.stub.accept(member(), turn("tn_more"))).toMatchObject({ ok: true, duplicate: false });
  });

  it(`refuses an agent's turn after ${AGENT_TURNS_MAX} since a person's`, async () => {
    const log = await openLog({ access: accessOf({ writers: ["agent:cs_parent", `user:${MATE_ID}`] }) });
    const send = async (p: Parameters<typeof log.stub.accept>[0], id: string) => {
      const answer = await log.stub.accept(p, turn(id));
      if (answer.ok) await log.stub.delivered(id, { ok: true });
      return answer;
    };
    for (let i = 0; i < AGENT_TURNS_MAX; i++) expect(await send(i % 2 ? platform : agent("cs_parent"), `tn_${i}`)).toMatchObject({ ok: true });
    expect(await send(agent("cs_parent"), "tn_over")).toEqual({ ok: false, code: "agent_turns" });
    expect(await send(platform, "tn_over2")).toEqual({ ok: false, code: "agent_turns" });
    // Not a turn: not counted.
    expect(await log.stub.accept(agent("cs_parent"), { id: "ak_1", kind: "answer", body: {} })).toMatchObject({ ok: true });
    // A person's turn starts the count again.
    expect(await send(member(MATE_ID), "tn_person")).toMatchObject({ ok: true });
    expect(await send(agent("cs_parent"), "tn_again")).toMatchObject({ ok: true });
  });
});

describe("inbox", () => {
  it("lists the waiting entries in order, with who sent them and where the log is", async () => {
    const log = await openLog();
    await log.stub.append(log.identity, 1, [log.ev(1, "x.y", null, {}), log.ev(2, "x.y", null, {})]);
    await log.stub.accept(member(), { ...turn("tn_a"), trace: "00-abc-def-01" });
    await log.stub.accept(platform, { id: "in_b", kind: "interrupt", body: { turnId: "tn_a" } });
    await log.stub.accept(member(MATE_ID, { via: "slack" }), turn("tn_c"));
    await log.stub.delivered("in_b", { ok: true });
    const inbox = await log.stub.inbox();
    expect(inbox).toMatchObject({ epoch: 1, lastSeq: 2 });
    expect(inbox.entries.map((e) => e.id)).toEqual(["tn_a", "tn_c"]);
    expect(inbox.entries[0]).toEqual({
      id: "tn_a",
      kind: "turn",
      body: { input: "hello" },
      by: "user:usr_owner00000001",
      actor: { subject: "usr_owner00000001", kind: "member", via: "app", admin: false },
      trace: "00-abc-def-01",
      at: expect.any(Number),
    });
    expect(inbox.entries[1]).toMatchObject({ by: `user:${MATE_ID}`, actor: { via: "slack" }, trace: null });
  });

  it("drops a refused entry when a dismiss names it, and done entries after 24 h", async () => {
    const log = await openLog();
    await log.stub.accept(member(), turn("tn_a"));
    await log.stub.accept(member(), turn("tn_b"));
    await log.stub.delivered("tn_a", { ok: false, code: "queue_full", message: "The queue is full." });
    await log.stub.delivered("tn_b", { ok: true });
    const states = () => log.inside((_, state) => state.storage.sql.exec<{ id: string; state: string }>("SELECT id, state FROM inbox ORDER BY n").toArray());
    expect(await states()).toEqual([{ id: "tn_a", state: "refused" }, { id: "tn_b", state: "delivered" }]);
    // The dismiss is done at once: nothing of it goes to the host.
    expect(await log.stub.accept(member(), { id: "ds_1", kind: "dismiss", body: { entryId: "tn_a" } })).toMatchObject({ ok: true, duplicate: false });
    expect(await states()).toEqual([{ id: "tn_b", state: "delivered" }, { id: "ds_1", state: "delivered" }]);
    expect((await log.stub.inbox()).entries).toEqual([]);
    // 24 h on, the sweep removes what is done.
    await log.inside(async (instance, state) => {
      state.storage.sql.exec("UPDATE inbox SET done_at = done_at - ?", INBOX_KEEP_MS + 1);
      state.storage.sql.exec("UPDATE _alarm SET at = 0 WHERE purpose = 'sweep'");
      await instance.alarm();
    });
    expect(await states()).toEqual([]);
  });
});

describe("the owed drain", () => {
  it("is sent to the session's machine at once, and stays owed until nothing waits", async () => {
    const log = await openLog();
    const owes = () => log.inside((_, state) => state.storage.sql.exec("SELECT 1 FROM _owed WHERE key = 'drain'").toArray().length);
    await log.stub.accept(member(), turn("tn_a"));
    await log.flush(Date.now());
    expect(log.fakes.drains).toEqual([MACHINE]);
    // `waking`: still owed, and sent again when due.
    expect(await owes()).toBe(1);
    await log.flush();
    expect(log.fakes.drains.length).toBe(2);
    expect(await owes()).toBe(1);
    // The machine drains: it reports each entry, and the call is owed no more.
    log.fakes.drain = async (instance) => {
      for (const entry of (await instance.inbox()).entries) await instance.delivered(entry.id, { ok: true, result: { id: entry.id } });
      return { state: "delivered", results: [] };
    };
    await log.stub.accept(member(), turn("tn_b"));
    await log.flush();
    expect(await owes()).toBe(0);
    expect((await log.stub.inbox()).entries).toEqual([]);
    const sent = log.fakes.drains.length;
    await log.flush();
    expect(log.fakes.drains.length).toBe(sent);
  });

  it("is dropped when the host reports the last entry by itself", async () => {
    const log = await openLog({ drain: () => Promise.reject(new Error("machine unreachable")) });
    await log.stub.accept(member(), turn("tn_a"));
    await log.flush(Date.now());
    await log.stub.delivered("tn_a", { ok: true });
    expect(await log.inside((_, state) => state.storage.sql.exec("SELECT 1 FROM _owed WHERE key = 'drain'").toArray().length)).toBe(0);
  });
});
