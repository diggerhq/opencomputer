import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate, sqlOf, type Principal, type Sql } from "../src/actor/index.js";
import type { Summary } from "../src/actor/contracts.js";
import { runMutation, type MutationOutcome } from "../src/org/mutations/index.js";
import { STEPS } from "../src/org/schema.js";
import { emptySummary, transact } from "../src/org/tx.js";

/** Org's mutations (spec 19.2, 39), on a real Durable Object's storage. */

const ORGS = (env as unknown as { ORGS: DurableObjectNamespace }).ORGS;
let seq = 0;

async function withOrg<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  seq += 1;
  return runInDurableObject(ORGS.getByName(`mut-${seq}-${Math.random()}`), async (_instance, state) => {
    const sql = sqlOf(state.storage);
    migrate(sql, STEPS);
    sql.exec("UPDATE meta SET org = 'org_t'");
    return fn(sql);
  });
}

const base = { org: "org_t", admin: false, credential: { id: "c", expiresAt: null } };
const member = (subject: string, admin = false): Principal => ({
  ...base,
  admin,
  subject,
  kind: "member",
  via: "app",
  scopes: ["sessions:read", "sessions:write", "work:read", "work:write"] as Principal["scopes"],
  audiences: ["org", `member:${subject}`],
});
const agent = (session: string): Principal => ({ ...base, subject: session, session, kind: "agent", via: "agent", scopes: ["work:read", "work:write"] as Principal["scopes"], audiences: [] });

const A = member("usr_a");
const B = member("usr_b");
const sid = (n: number) => `cs_${String(n).padStart(16, "0")}`;
const tid = (n: number) => `trk_${String(n).padStart(16, "0")}`;
const agentSid = (n: number) => `cs_A${String(n).padStart(15, "0")}`;

function seedThread(sql: Sql, id: string, owner = "usr_a", o: { parent?: string; role?: "start"; summary?: Partial<Summary> } = {}): void {
  transact(sql, Date.now(), (tx) => {
    const s = tx.addSession({
      id,
      owner,
      origin: { type: "api", client: null, slack: null },
      machine: "org_t",
      role: o.role ?? null,
      createdBy: o.parent ? `agent:${o.parent}` : `user:${owner}`,
      summary: { ...emptySummary({}, "First words"), ...o.summary },
    });
    tx.addPlace({ sessionId: id, placedBy: o.parent ? `agent:${o.parent}` : `user:${owner}`, parentSession: o.parent ?? null, audience: s.audience });
  });
}

const run = (sql: Sql, p: Principal, name: string, args: Record<string, unknown>): MutationOutcome =>
  transact(sql, Date.now(), (tx) => runMutation(tx, p, name, args));
const ok = (out: MutationOutcome) => {
  expect(out).toMatchObject({ ok: true });
  return out as { ok: true; value?: { op?: string } };
};
const place = (sql: Sql, id: string) => sql.exec<Record<string, unknown>>("SELECT * FROM place WHERE session_id = ?", id)[0];
const owedCalls = (sql: Sql) => sql.exec<{ call: string; body: string }>("SELECT call, body FROM _owed ORDER BY n").map((r) => `${r.call} ${r.body}`);
const occurrences = (sql: Sql) => sql.exec<{ kind: string }>("SELECT kind FROM occurrence ORDER BY n").map((r) => r.kind);

/** A track owned by usr_a with thread `sid(1)` in it. */
function seedTrack(sql: Sql, n = 1, thread = sid(n)): void {
  seedThread(sql, thread);
  ok(run(sql, A, "track.create", { tid: tid(n), agentSessionId: agentSid(n), name: "Dock", sid: thread }));
}

describe("thread mutations: the happy paths", () => {
  const cases: { name: string; args: (s: string) => Record<string, unknown>; by?: (s: string) => Principal; check: (sql: Sql, s: string) => void; summary?: Partial<Summary> }[] = [
    {
      name: "thread.done",
      args: (s) => ({ sid: s, outcome: "done" }),
      summary: { status: "running" },
      check: (sql, s) => {
        expect(place(sql, s)).toMatchObject({ outcome: "done", done_by: "user:usr_a" });
        expect(place(sql, s)!.done_at).not.toBeNull();
        expect(place(sql, s)!.earlier_at).not.toBeNull();
        expect(occurrences(sql)).toEqual(["thread.done"]);
        expect(owedCalls(sql).some((c) => c.startsWith("SessionLog.accept") && c.includes('"interrupt"'))).toBe(true);
      },
    },
    {
      name: "thread.keep",
      args: (s) => ({ sid: s, keep: true }),
      check: (sql, s) => expect(place(sql, s)).toMatchObject({ keep: 1, earlier_at: null }),
    },
    {
      name: "thread.reopen",
      args: (s) => ({ sid: s }),
      check: (sql, s) => {
        expect(place(sql, s)).toMatchObject({ done_at: null, outcome: null });
        expect(place(sql, s)!.brought_back_at).not.toBeNull();
      },
    },
    {
      name: "thread.writers",
      args: (s) => ({ sid: s, writers: ["user:usr_a", "user:usr_c"] }),
      check: (sql, s) => {
        expect(sql.exec("SELECT writers FROM session WHERE id = ?", s)).toEqual([{ writers: '["user:usr_a","user:usr_c"]' }]);
        expect(owedCalls(sql).filter((c) => c.includes("setAccess")).length).toBe(2);
      },
    },
    {
      name: "thread.ready",
      by: (s) => agent(s),
      args: (s) => ({ sid: s, what: "PR open" }),
      summary: { lastSeq: 42 },
      check: (sql, s) => {
        expect(place(sql, s)).toMatchObject({ ready_seq: 42, ready_what: "PR open" });
        expect(occurrences(sql)).toEqual(["thread.ready"]);
      },
    },
    {
      name: "thread.attention",
      by: (s) => agent(s),
      args: (s) => ({ sid: s, what: "Which branch?" }),
      check: (sql, s) => {
        expect(place(sql, s)).toMatchObject({ attention: "Which branch?" });
        expect(sql.exec("SELECT blocked FROM session WHERE id = ?", s)).toEqual([{ blocked: 1 }]);
        expect(occurrences(sql)).toEqual(["thread.attention"]);
      },
    },
    {
      name: "thread.delete",
      args: (s) => ({ sid: s }),
      check: (sql, s) => {
        expect(sql.exec("SELECT id FROM session WHERE id = ?", s)).toEqual([]);
        expect(place(sql, s)).toBeUndefined();
        expect(sql.exec("SELECT kind FROM gone ORDER BY kind")).toEqual([{ kind: "place" }, { kind: "session" }]);
        const calls = owedCalls(sql);
        expect(calls.some((c) => c.startsWith("Computer.stop"))).toBe(true);
        expect(calls.some((c) => c.startsWith("SessionLog.destroy"))).toBe(true);
      },
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      await withOrg((sql) => {
        seedThread(sql, sid(1), "usr_a", { summary: c.summary });
        sql.exec("DELETE FROM _owed");
        ok(run(sql, c.by?.(sid(1)) ?? A, c.name, c.args(sid(1))));
        c.check(sql, sid(1));
      });
    });
  }

  it("thread.place into a track and out, which dissolves the emptied track (T14)", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      seedThread(sql, sid(2));
      sql.exec("DELETE FROM _owed");
      ok(run(sql, A, "thread.place", { sid: sid(2), trackId: tid(1) }));
      expect(place(sql, sid(2))).toMatchObject({ track_id: tid(1), placed_by: "user:usr_a" });
      expect(occurrences(sql)).toContain("thread.placed");
      const calls = owedCalls(sql);
      expect(calls.some((c) => c.startsWith("SessionLog.setAccess") && c.includes(sid(2)))).toBe(true);
      expect(calls.some((c) => c.startsWith("SessionLog.setAccess") && c.includes(agentSid(1)))).toBe(true);

      ok(run(sql, A, "thread.place", { sid: sid(1), trackId: null }));
      expect(sql.exec("SELECT id FROM track")).toHaveLength(1);
      ok(run(sql, A, "thread.place", { sid: sid(2), trackId: null }));
      expect(sql.exec("SELECT id FROM track")).toEqual([]);
      expect(sql.exec("SELECT id FROM session WHERE id = ?", agentSid(1))).toEqual([]);
      expect(sql.exec("SELECT kind FROM gone WHERE id = ? ORDER BY kind", tid(1))).toEqual([{ kind: "doc" }, { kind: "track" }]);
      expect(owedCalls(sql).some((c) => c.startsWith("Computer.stop") && c.includes(agentSid(1)))).toBe(true);
    });
  });
});

describe("thread mutations: 19.2's refusals", () => {
  it("another member, an agent where a member is meant, a member where an agent is meant: not_found", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      seedThread(sql, sid(2), "usr_a", { parent: sid(1) });
      for (const [p, name, args] of [
        [B, "thread.done", { sid: sid(1) }],
        [B, "thread.rename", { sid: sid(1), title: "x" }],
        [B, "thread.writers", { sid: sid(1), writers: "members" }],
        [agent(sid(1)), "thread.done", { sid: sid(1) }],
        [agent(sid(1)), "thread.delete", { sid: sid(2) }],
        [agent(sid(1)), "thread.ready", { sid: sid(2), what: "x" }],
        [A, "thread.ready", { sid: sid(1), what: "x" }],
        [A, "thread.attention", { sid: sid(1), what: "x" }],
        [agent(sid(9)), "thread.keep", { sid: sid(1), keep: true }],
        [A, "thread.done", { sid: sid(7) }],
      ] as [Principal, string, Record<string, unknown>][]) {
        expect(run(sql, p, name, args), `${p.subject} ${name}`).toMatchObject({ ok: false, code: "not_found" });
      }
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 2 }]);
    });
  });

  it("an admin may set writers on another's thread", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      ok(run(sql, member("usr_b", true), "thread.writers", { sid: sid(1), writers: "members" }));
    });
  });

  it("a track's agent places a thread it started, never one a person placed or one that is marked", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      const bot = agent(agentSid(1));
      seedThread(sql, sid(2), "usr_a", { parent: agentSid(1) });
      ok(run(sql, bot, "thread.place", { sid: sid(2), trackId: tid(1) }));
      expect(place(sql, sid(2))).toMatchObject({ track_id: tid(1), placed_by: `agent:${agentSid(1)}` });
      // sid(1) was placed by the person who made the track.
      expect(run(sql, bot, "thread.place", { sid: sid(1), trackId: null })).toMatchObject({ ok: false, code: "refused", reason: "user_set" });
      // A thread it neither started nor holds.
      seedThread(sql, sid(3));
      expect(run(sql, bot, "thread.place", { sid: sid(3), trackId: tid(1) })).toMatchObject({ ok: false, code: "not_found" });
      // Unread: the agent wrote past the owner's read mark.
      seedThread(sql, sid(4), "usr_a", { parent: agentSid(1), summary: { lastAgentSeq: 5 } });
      expect(run(sql, bot, "thread.place", { sid: sid(4), trackId: tid(1) })).toMatchObject({ ok: false, code: "refused", reason: "marked" });
    });
  });

  it("a start-box session places itself once, before its first turn ends, into its owner's open track", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      seedThread(sql, sid(5), "usr_a", { role: "start" });
      ok(run(sql, agent(sid(5)), "thread.place", { sid: sid(5), trackId: tid(1) }));
      ok(run(sql, A, "thread.place", { sid: sid(5), trackId: null }));
      expect(run(sql, agent(sid(5)), "thread.place", { sid: sid(5), trackId: tid(1) })).toMatchObject({ ok: false });
    });
  });
});

const track = (sql: Sql, id: string) => sql.exec<Record<string, unknown>>("SELECT * FROM track WHERE id = ?", id)[0];

describe("track mutations", () => {
  it("track.create by a person wraps a thread (40.7): track, empty doc, agent session, place, first input, op", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      sql.exec("DELETE FROM _owed");
      const out = ok(run(sql, A, "track.create", { tid: tid(1), agentSessionId: agentSid(1), name: "Dock", sid: sid(1) }));
      expect(out.value).toMatchObject({ trackId: tid(1) });
      expect(track(sql, tid(1))).toMatchObject({ owner: "usr_a", name: "Dock", name_by: "user:usr_a", agent_session: agentSid(1), created_by: "user:usr_a", audience: "member:usr_a" });
      expect(sql.exec("SELECT rev, text FROM doc WHERE track_id = ?", tid(1))).toEqual([{ rev: 0, text: "" }]);
      expect(sql.exec("SELECT role, writers, audience FROM session WHERE id = ?", agentSid(1))).toEqual([{ role: "track", writers: '["user:usr_a"]', audience: "member:usr_a" }]);
      expect(place(sql, agentSid(1))).toBeUndefined();
      expect(place(sql, sid(1))).toMatchObject({ track_id: tid(1) });
      const calls = owedCalls(sql);
      expect(calls.some((c) => c.startsWith("Computer.start") && c.includes(agentSid(1)))).toBe(true);
      const first = calls.find((c) => c.startsWith("SessionLog.accept") && c.includes(agentSid(1)))!;
      expect(first).toContain("made by user:usr_a");
      expect(first).toContain(sid(1));
      expect(first).toContain("Do not start threads");
      expect(sql.exec("SELECT name FROM op")).toEqual([{ name: "track.create" }]);
      expect(run(sql, A, "track.create", { tid: tid(1), agentSessionId: agentSid(2) })).toMatchObject({ ok: false, code: "taken" });
    });
  });

  it("track.create by an agent: its own thread (G3), or from the start box, which removes the calling thread (J5)", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      expect(run(sql, agent(sid(2)), "track.create", { tid: tid(1), agentSessionId: agentSid(1), sid: sid(1) })).toMatchObject({ ok: false, code: "not_found" });
      ok(run(sql, agent(sid(1)), "track.create", { tid: tid(1), agentSessionId: agentSid(1), sid: sid(1) }));
      expect(track(sql, tid(1))).toMatchObject({ owner: "usr_a", created_by: `agent:${sid(1)}`, name: null });
      expect(owedCalls(sql).find((c) => c.startsWith("SessionLog.accept") && c.includes(agentSid(1)))).toContain("You may start threads");

      seedThread(sql, sid(5), "usr_a", { role: "start" });
      ok(run(sql, agent(sid(5)), "track.create", { tid: tid(2), agentSessionId: agentSid(2), firstInput: "Ship the dock redesign" }));
      expect(track(sql, tid(2))).toMatchObject({ owner: "usr_a" });
      expect(sql.exec("SELECT id FROM session WHERE id = ?", sid(5))).toEqual([]);
      expect(owedCalls(sql).find((c) => c.startsWith("SessionLog.accept") && c.includes(agentSid(2)))).toContain("Ship the dock redesign");
      // A plain thread's agent cannot start a track with no thread.
      seedThread(sql, sid(6));
      expect(run(sql, agent(sid(6)), "track.create", { tid: tid(3), agentSessionId: agentSid(3) })).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  const owned: { name: string; args: Record<string, unknown>; check: (sql: Sql) => void; op: boolean }[] = [
    {
      name: "track.rename",
      args: { name: "Harbor" },
      op: true,
      check: (sql) => {
        expect(track(sql, tid(1))).toMatchObject({ name: "Harbor", name_by: "user:usr_a", former_names: '["Dock"]' });
        expect(sql.exec("SELECT title FROM session WHERE id = ?", agentSid(1))).toEqual([{ title: "Harbor" }]);
      },
    },
    { name: "track.set_stand", args: { stand: "Waiting on review" }, op: false, check: (sql) => expect(track(sql, tid(1))).toMatchObject({ stand: "Waiting on review" }) },
    {
      name: "track.done",
      args: { outcome: "shipped" },
      op: true,
      check: (sql) => {
        expect(track(sql, tid(1))).toMatchObject({ outcome: "shipped" });
        expect(place(sql, sid(1))).toMatchObject({ outcome: "shipped", done_by: "user:usr_a" });
        expect(occurrences(sql)).toContain("thread.done");
      },
    },
    { name: "track.reopen", args: {}, op: true, check: (sql) => expect(track(sql, tid(1))).toMatchObject({ done_at: null }) },
    { name: "track.keep", args: { keep: true }, op: true, check: (sql) => expect(track(sql, tid(1))).toMatchObject({ keep: 1 }) },
    {
      name: "track.dissolve",
      args: { threads: "keep" },
      op: true,
      check: (sql) => {
        expect(track(sql, tid(1))).toBeUndefined();
        expect(sql.exec("SELECT 1 FROM doc")).toEqual([]);
        expect(place(sql, sid(1))).toMatchObject({ track_id: null });
        expect(sql.exec("SELECT id FROM session WHERE id = ?", agentSid(1))).toEqual([]);
      },
    },
    {
      name: "track.delete",
      args: {},
      op: false,
      check: (sql) => {
        expect(track(sql, tid(1))).toBeUndefined();
        expect(sql.exec("SELECT id FROM session")).toEqual([]);
        expect(sql.exec("SELECT id FROM op")).toEqual([]);
      },
    },
  ];
  for (const c of owned) {
    it(`${c.name}: the owner does it; another member and the track's agent${c.name === "track.rename" || c.name === "track.set_stand" ? " (on a person's name)" : ""} cannot`, async () => {
      await withOrg((sql) => {
        seedTrack(sql);
        const args = { tid: tid(1), ...c.args };
        expect(run(sql, B, c.name, args)).toMatchObject({ ok: false, code: "not_found" });
        if (c.name !== "track.set_stand") expect(run(sql, agent(agentSid(1)), c.name, args)).toMatchObject({ ok: false, code: c.name === "track.rename" ? "refused" : "not_found" });
        const before = sql.exec("SELECT COUNT(*) AS n FROM op")[0]!.n as number;
        ok(run(sql, A, c.name, args));
        c.check(sql);
        if (c.name !== "track.delete") expect(sql.exec("SELECT COUNT(*) AS n FROM op")[0]!.n).toBe(before + (c.op ? 1 : 0));
      });
    });
  }

  it("the track's agent sets the stand and renames a track it named", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      ok(run(sql, A, "track.create", { tid: tid(1), agentSessionId: agentSid(1), sid: sid(1) }));
      ok(run(sql, agent(agentSid(1)), "track.set_stand", { tid: tid(1), stand: "Two threads running" }));
      ok(run(sql, agent(agentSid(1)), "track.rename", { tid: tid(1), name: "Dock" }));
      expect(track(sql, tid(1))).toMatchObject({ name: "Dock", name_by: `agent:${agentSid(1)}`, stand: "Two threads running" });
    });
  });

  it("track.dissolve with threads: 'stop' interrupts the working threads", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1), "usr_a", { summary: { status: "running" } });
      ok(run(sql, A, "track.create", { tid: tid(1), agentSessionId: agentSid(1), sid: sid(1) }));
      sql.exec("DELETE FROM _owed");
      ok(run(sql, A, "track.dissolve", { tid: tid(1), threads: "stop" }));
      expect(owedCalls(sql).some((c) => c.startsWith("SessionLog.accept") && c.includes('"interrupt"') && c.includes(sid(1)))).toBe(true);
    });
  });
});

const doc = (sql: Sql) => sql.exec<{ rev: number; text: string; spans: string }>("SELECT rev, text, spans FROM doc WHERE track_id = ?", tid(1))[0]!;
const proposals = (sql: Sql) => sql.exec<{ id: string; kind: string; state: string }>("SELECT id, kind, state FROM proposal ORDER BY id");

describe("doc.save (22.3)", () => {
  it("a person saves with spans; a stale base is a conflict with the current rev and text", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      expect(ok(run(sql, A, "doc.save", { tid: tid(1), baseRev: 0, text: "Goal\nShip it", spans: [{ from: 0, to: 2, by: "user:usr_a" }] })).value).toEqual({ rev: 1 });
      expect(doc(sql)).toMatchObject({ rev: 1, text: "Goal\nShip it" });
      expect(sql.exec("SELECT rev, by FROM doc_rev")).toEqual([{ rev: 1, by: "user:usr_a" }]);
      expect(run(sql, A, "doc.save", { tid: tid(1), baseRev: 0, text: "x", spans: [] })).toMatchObject({ ok: false, code: "conflict", rev: 1, text: "Goal\nShip it" });
      expect(run(sql, B, "doc.save", { tid: tid(1), baseRev: 1, text: "x", spans: [] })).toMatchObject({ ok: false, code: "not_found" });
      expect(run(sql, agent(sid(1)), "doc.save", { tid: tid(1), baseRev: 1, text: "x" })).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  it("the track's agent adds lines around a person's (span moved), and a change to them becomes an edit proposal; accepting it saves", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      const bot = agent(agentSid(1));
      ok(run(sql, A, "doc.save", { tid: tid(1), baseRev: 0, text: "Goal: ship", spans: [{ from: 0, to: 1, by: "user:usr_a" }] }));
      ok(run(sql, bot, "doc.save", { tid: tid(1), baseRev: 1, text: "# Dock\nGoal: ship\nPlan: two threads" }));
      expect(JSON.parse(doc(sql).spans)).toEqual([{ from: 1, to: 2, by: "user:usr_a" }]);

      const out = run(sql, bot, "doc.save", { tid: tid(1), baseRev: 2, text: "# Dock\nGoal: ship by Friday\nPlan: two threads" });
      expect(out).toMatchObject({ ok: false, code: "refused", reason: "proposed" });
      expect(doc(sql).rev).toBe(2);
      const [p] = proposals(sql);
      expect(p).toMatchObject({ kind: "edit", state: "open", id: (out as unknown as { proposalId: string }).proposalId });
      expect(occurrences(sql)).toContain("proposal.created");

      ok(run(sql, A, "proposal.accept", { proposalId: p!.id }));
      expect(doc(sql)).toMatchObject({ rev: 3, text: "# Dock\nGoal: ship by Friday\nPlan: two threads" });
      expect(proposals(sql)[0]).toMatchObject({ state: "accepted" });
    });
  });

  it("an edit proposal whose base moved is voided on accept, with the conflict", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      ok(run(sql, A, "doc.save", { tid: tid(1), baseRev: 0, text: "Mine", spans: [{ from: 0, to: 1, by: "user:usr_a" }] }));
      run(sql, agent(agentSid(1)), "doc.save", { tid: tid(1), baseRev: 1, text: "Not yours" });
      ok(run(sql, A, "doc.save", { tid: tid(1), baseRev: 1, text: "Mine, edited", spans: [{ from: 0, to: 1, by: "user:usr_a" }] }));
      const [p] = proposals(sql);
      expect(run(sql, A, "proposal.accept", { proposalId: p!.id })).toMatchObject({ ok: false, code: "conflict", rev: 2 });
      expect(proposals(sql)[0]).toMatchObject({ state: "void" });
    });
  });
});

describe("read, pref, result, review", () => {
  it("read.set keeps the max; pref.set is the member's own; agents may do neither", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      ok(run(sql, A, "read.set", { sid: sid(1), seq: 7 }));
      ok(run(sql, A, "read.set", { sid: sid(1), seq: 3 }));
      expect(sql.exec("SELECT member, read_seq, audience FROM read")).toEqual([{ member: "usr_a", read_seq: 7, audience: "member:usr_a" }]);
      ok(run(sql, A, "pref.set", { key: "list.width", value: 320 }));
      expect(sql.exec("SELECT member, key, value FROM pref")).toEqual([{ member: "usr_a", key: "list.width", value: "320" }]);
      expect(run(sql, agent(sid(1)), "read.set", { sid: sid(1), seq: 9 })).toMatchObject({ ok: false, code: "not_found" });
      expect(run(sql, agent(sid(1)), "pref.set", { key: "k", value: 1 })).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  it("result.add upserts on (session, kind, ref) with result.changed; review.save; the agent's own session only", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      const pr = { sid: sid(1), kind: "pr", ref: "https://github.com/o/r/pull/1", title: "Fix login" };
      expect(ok(run(sql, agent(sid(1)), "result.add", { resultId: "res_0000000000000001", ...pr })).value).toEqual({ resultId: "res_0000000000000001" });
      expect(ok(run(sql, agent(sid(1)), "result.add", { resultId: "res_0000000000000002", ...pr, title: "Fix login redirect" })).value).toEqual({ resultId: "res_0000000000000001" });
      expect(sql.exec("SELECT id, title FROM result")).toEqual([{ id: "res_0000000000000001", title: "Fix login redirect" }]);
      expect(occurrences(sql)).toEqual(["result.changed", "result.changed"]);
      ok(run(sql, agent(sid(1)), "review.save", { resultId: "res_0000000000000001", head: "abc123", parts: [{ title: "Redirect" }] }));
      expect(sql.exec("SELECT head FROM review")).toEqual([{ head: "abc123" }]);
      expect(run(sql, A, "result.add", { resultId: "res_0000000000000003", ...pr })).toMatchObject({ ok: false, code: "not_found" });
      expect(run(sql, agent(sid(2)), "review.save", { resultId: "res_0000000000000001", head: "x", parts: [] })).toMatchObject({ ok: false, code: "not_found" });
    });
  });
});

describe("proposals", () => {
  const pid = (n: number) => `prp_${String(n).padStart(16, "0")}`;

  it("proposal.create voids an older open one of the same kind and target, and writes proposal.created", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      ok(run(sql, agent(sid(1)), "proposal.create", { proposalId: pid(1), kind: "done", target: sid(1), what: "PR merged" }));
      ok(run(sql, agent(sid(1)), "proposal.create", { proposalId: pid(2), kind: "done", target: sid(1), what: "PR merged, tests pass" }));
      expect(proposals(sql).map((p) => p.state)).toEqual(["void", "open"]);
      expect(occurrences(sql)).toEqual(["proposal.created", "proposal.created"]);
      expect(run(sql, A, "proposal.create", { proposalId: pid(3), kind: "done", target: sid(1), what: "x" })).toMatchObject({ ok: false, code: "not_found" });
      expect(run(sql, agent(sid(2)), "proposal.create", { proposalId: pid(3), kind: "done", target: sid(1), what: "x" })).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  it("proposal.accept runs the proposed mutation as the person, with its op; only the owner may accept or dismiss", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      seedThread(sql, sid(2));
      seedThread(sql, sid(3));
      ok(run(sql, agent(sid(2)), "proposal.create", { proposalId: pid(1), kind: "done", target: sid(2), what: "Done" }));
      expect(run(sql, B, "proposal.accept", { proposalId: pid(1) })).toMatchObject({ ok: false, code: "not_found" });
      expect(run(sql, agent(sid(2)), "proposal.accept", { proposalId: pid(1) })).toMatchObject({ ok: false, code: "not_found" });
      ok(run(sql, A, "proposal.accept", { proposalId: pid(1) }));
      expect(place(sql, sid(2))).toMatchObject({ done_by: "user:usr_a" });
      expect(sql.exec("SELECT name, by FROM op WHERE session_id = ?", sid(2))).toEqual([{ name: "thread.done", by: "user:usr_a" }]);
      expect(run(sql, A, "proposal.accept", { proposalId: pid(1) })).toMatchObject({ ok: false, code: "refused", reason: "not_open" });

      ok(run(sql, agent(sid(3)), "proposal.create", { proposalId: pid(2), kind: "wrap", target: sid(3), what: "Several pieces of work", args: { name: "Login" } }));
      ok(run(sql, A, "proposal.accept", { proposalId: pid(2) }));
      expect(sql.exec("SELECT name FROM track WHERE id != ?", tid(1))).toEqual([{ name: "Login" }]);

      ok(run(sql, agent(agentSid(1)), "proposal.create", { proposalId: pid(3), kind: "done", target: tid(1), what: "All shipped" }));
      ok(run(sql, A, "proposal.dismiss", { proposalId: pid(3) }));
      expect(sql.exec("SELECT state FROM proposal WHERE id = ?", pid(3))).toEqual([{ state: "dismissed" }]);
    });
  });

  it("a move proposal accepted places the thread", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      seedThread(sql, sid(2));
      ok(run(sql, agent(sid(2)), "proposal.create", { proposalId: pid(1), kind: "move", target: sid(2), what: "Belongs in Dock", args: { trackId: tid(1) } }));
      ok(run(sql, A, "proposal.accept", { proposalId: pid(1) }));
      expect(place(sql, sid(2))).toMatchObject({ track_id: tid(1), placed_by: "user:usr_a" });
    });
  });
});

const state = (sql: Sql) => ({
  place: sql.exec("SELECT session_id, track_id, placed_by, done_at, outcome, done_by, keep, earlier_at, brought_back_at FROM place ORDER BY session_id"),
  track: sql.exec("SELECT id, name, name_by, former_names, keep, done_at, outcome FROM track ORDER BY id"),
  session: sql.exec("SELECT id, title, title_by, writers FROM session WHERE role IS NULL ORDER BY id"),
  doc: sql.exec("SELECT track_id, rev, text FROM doc ORDER BY track_id"),
});
const opOf = (out: MutationOutcome) => (ok(out).value as { op: string }).op;

describe("undo (19.3)", () => {
  // Each mutation with an inverse, from a track with sid(1) and a thread sid(2) on its own.
  const cases: [string, Record<string, unknown>][] = [
    ["thread.rename", { sid: sid(2), title: "Login" }],
    ["thread.place", { sid: sid(2), trackId: tid(1) }],
    ["thread.place", { sid: sid(1), trackId: null }],
    ["thread.done", { sid: sid(1) }],
    ["thread.keep", { sid: sid(2), keep: true }],
    ["thread.writers", { sid: sid(2), writers: ["user:usr_a"] }],
    ["track.create", { tid: tid(2), agentSessionId: agentSid(2), sid: sid(2), name: "Login" }],
    ["track.rename", { tid: tid(1), name: "Harbor" }],
    ["track.done", { tid: tid(1), outcome: "shipped" }],
    ["track.keep", { tid: tid(1), keep: true }],
    ["track.dissolve", { tid: tid(1), threads: "keep" }],
  ];
  for (const [name, args] of cases) {
    it(`${name} ${JSON.stringify(args)} is undone back to the rows before it`, async () => {
      await withOrg((sql) => {
        seedTrack(sql);
        seedThread(sql, sid(2));
        ok(run(sql, A, "doc.save", { tid: tid(1), baseRev: 0, text: "Goal", spans: [] }));
        const before = state(sql);
        const op = opOf(run(sql, A, name, args));
        expect(run(sql, B, "undo", { opId: op })).toMatchObject({ ok: false, code: "not_found" });
        expect(run(sql, agent(sid(1)), "undo", { opId: op })).toMatchObject({ ok: false, code: "not_found" });
        ok(run(sql, A, "undo", { opId: op }));
        expect(state(sql)).toEqual(before);
        expect(sql.exec("SELECT undone_by FROM op WHERE id = ?", op)).toEqual([{ undone_by: "user:usr_a" }]);
        expect(run(sql, A, "undo", { opId: op })).toMatchObject({ ok: false, code: "refused", reason: "undone" });
      });
    });
  }

  it("thread.reopen is undone", async () => {
    await withOrg((sql) => {
      seedThread(sql, sid(1));
      ok(run(sql, A, "thread.done", { sid: sid(1) }));
      const before = state(sql);
      ok(run(sql, A, "undo", { opId: opOf(run(sql, A, "thread.reopen", { sid: sid(1) })) }));
      expect(state(sql)).toEqual(before);
    });
  });

  it("a field changed since is refused `changed` with what a reversal would do; `force` does it; undo of the undo redoes", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      const op = opOf(run(sql, A, "track.rename", { tid: tid(1), name: "Harbor" }));
      ok(run(sql, A, "track.rename", { tid: tid(1), name: "Port" }));
      expect(run(sql, A, "undo", { opId: op })).toMatchObject({
        ok: false,
        code: "refused",
        reason: "changed",
        would: expect.arrayContaining([{ row: `track:${tid(1)}`, column: "name", now: "Port", op: "Harbor", back: "Dock" }]),
      });
      const back = opOf(run(sql, A, "undo", { opId: op, resolution: "force" }));
      expect(track(sql, tid(1))).toMatchObject({ name: "Dock" });
      ok(run(sql, A, "undo", { opId: back }));
      expect(track(sql, tid(1))).toMatchObject({ name: "Port" });
      expect(sql.exec("SELECT undone_by FROM op WHERE id = ?", op)).toEqual([{ undone_by: null }]);
    });
  });

  it("track.dissolve's undo restores the track, its Doc and places, with a new agent session", async () => {
    await withOrg((sql) => {
      seedTrack(sql);
      ok(run(sql, A, "doc.save", { tid: tid(1), baseRev: 0, text: "Goal", spans: [] }));
      const op = opOf(run(sql, A, "track.dissolve", { tid: tid(1), threads: "keep" }));
      sql.exec("DELETE FROM _owed");
      ok(run(sql, A, "undo", { opId: op }));
      const t = track(sql, tid(1))!;
      expect(t).toMatchObject({ name: "Dock" });
      expect(t.agent_session).not.toBe(agentSid(1));
      expect(doc(sql)).toMatchObject({ rev: 1, text: "Goal" });
      expect(place(sql, sid(1))).toMatchObject({ track_id: tid(1) });
      expect(owedCalls(sql).some((c) => c.startsWith("Computer.start") && c.includes(t.agent_session as string))).toBe(true);
    });
  });

  it("T8u: undo of a wrap whose agent started threads asks keep or stop", async () => {
    for (const threads of ["keep", "stop"] as const) {
      await withOrg((sql) => {
        seedThread(sql, sid(1));
        const op = opOf(run(sql, agent(sid(1)), "track.create", { tid: tid(1), agentSessionId: agentSid(1), sid: sid(1) }));
        seedThread(sql, sid(3), "usr_a", { parent: agentSid(1) });
        ok(run(sql, agent(agentSid(1)), "thread.place", { sid: sid(3), trackId: tid(1) }));
        expect(run(sql, A, "undo", { opId: op })).toMatchObject({ ok: false, code: "refused", reason: "choose_threads", threads: [sid(3)] });
        ok(run(sql, A, "undo", { opId: op, threads }));
        expect(track(sql, tid(1))).toBeUndefined();
        expect(place(sql, sid(1))).toMatchObject({ track_id: null });
        if (threads === "keep") expect(place(sql, sid(3))).toMatchObject({ track_id: null });
        else expect(place(sql, sid(3))).toBeUndefined();
      });
    }
  });
});
