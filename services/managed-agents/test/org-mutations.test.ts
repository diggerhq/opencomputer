import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate, sqlOf, type Principal, type Sql } from "../src/actor/index.js";
import type { Summary } from "../src/actor/contracts.js";
import { addTrackAgent } from "../src/org/mutations/common.js";
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
  transact(sql, Date.now(), (tx) => {
    tx.sql.exec(
      "INSERT INTO track (id, owner, name, name_by, agent_session, position, created_by, version, audience) VALUES (?, 'usr_a', 'Dock', 'user:usr_a', ?, ?, 'user:usr_a', ?, 'member:usr_a')",
      tid(n),
      agentSid(n),
      tx.now,
      tx.version(),
    );
    addTrackAgent(tx, { id: agentSid(n), trackId: tid(n), owner: "usr_a", ownerName: null, ownerEmail: null, origin: { type: "api", client: null, slack: null }, machine: "org_t", by: "user:usr_a", name: "Dock", firstInput: "Go." });
    tx.sql.exec("UPDATE place SET track_id = ? WHERE session_id = ?", tid(n), thread);
    tx.stamp("place", thread);
  });
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
      expect(sql.exec("SELECT kind FROM gone WHERE id = ?", tid(1))).toEqual([{ kind: "track" }]);
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
