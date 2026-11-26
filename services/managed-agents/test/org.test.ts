import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate, owed, sqlOf, type Principal, type Sql } from "../src/actor/index.js";
import { runMutation } from "../src/org/mutations/index.js";
import { STEPS } from "../src/org/schema.js";
import { changesAt, emptySummary, sessionRow, readSession, transact } from "../src/org/tx.js";

/** Org's transaction helpers and one mutation, on a real Durable Object's storage (spec 35.1, 37.3). */

const ORGS = (env as unknown as { ORGS: DurableObjectNamespace }).ORGS;

export async function withOrg<T>(name: string, fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  return runInDurableObject(ORGS.getByName(name), async (_instance, state) => {
    const sql = sqlOf(state.storage);
    migrate(sql, STEPS);
    return fn(sql);
  });
}

export const member = (subject: string, org = "org_t"): Principal => ({
  org,
  subject,
  kind: "member",
  via: "app",
  scopes: ["sessions:read", "sessions:write", "work:read", "work:write"] as Principal["scopes"],
  audiences: ["org", `member:${subject}`],
  admin: false,
  credential: { id: "c", expiresAt: null },
});

/** A thread owned by `owner`, with its place. */
export function seedThread(sql: Sql, id: string, owner: string): void {
  transact(sql, Date.now(), (tx) => {
    const s = tx.addSession({ id, owner, origin: { type: "api", client: null, slack: null }, machine: "org_t", createdBy: `user:${owner}`, summary: emptySummary({}, "First words") });
    tx.addPlace({ sessionId: id, placedBy: `user:${owner}`, audience: s.audience });
  });
}

describe("Org's transaction", () => {
  it("stamps one version, writes the op row and owes the publish", async () => {
    await withOrg("tx-rename", (sql) => {
      seedThread(sql, "cs_0000000000000001", "usr_a");
      expect(changesAt(sql, 1).rows.map((r) => r.kind).sort()).toEqual(["place", "session"]);
      expect(owed.has(sql, "live:feed")).toBe(true);

      const out = transact(sql, Date.now(), (tx) => runMutation(tx, member("usr_a"), "thread.rename", { sid: "cs_0000000000000001", title: "Fix the login redirect" }));
      expect(out.ok).toBe(true);
      const changed = changesAt(sql, 2);
      expect(changed.rows.map((r) => r.kind).sort()).toEqual(["op", "session"]);
      const row = sessionRow(sql, readSession(sql, "cs_0000000000000001")!);
      expect(row).toMatchObject({ kind: "session", title: "Fix the login redirect", titleBy: "user:usr_a", agentTitle: "First words", status: "starting", version: 2, audience: "org" });
      expect(changed.rows.find((r) => r.kind === "op")).toMatchObject({ name: "thread.rename", sessionId: "cs_0000000000000001", inverse: { title: null, titleBy: null } });
    });
  });

  it("answers not_found to another member and leaves no write", async () => {
    await withOrg("tx-refuse", (sql) => {
      seedThread(sql, "cs_0000000000000002", "usr_a");
      const out = transact(sql, Date.now(), (tx) => runMutation(tx, member("usr_b"), "thread.rename", { sid: "cs_0000000000000002", title: "Mine" }));
      expect(out).toMatchObject({ ok: false, code: "not_found" });
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 1 }]);
    });
  });

  it("undoes the writes of an attempt that refuses, and its version", async () => {
    await withOrg("tx-attempt", (sql) => {
      seedThread(sql, "cs_0000000000000003", "usr_a");
      transact(sql, Date.now(), (tx) => {
        const out = tx.attempt(() => {
          tx.sql.exec("UPDATE session SET title = 'x' WHERE id = 'cs_0000000000000003'");
          tx.stamp("session", "cs_0000000000000003");
          tx.occurFor("thread.done", readSession(tx.sql, "cs_0000000000000003")!, "platform");
          return { ok: false as const };
        });
        expect(out.ok).toBe(false);
        expect(tx.changed).toBe(false);
      });
      expect(sql.exec("SELECT title, version FROM session")).toEqual([{ title: null, version: 1 }]);
      expect(sql.exec("SELECT version, occ FROM meta")).toEqual([{ version: 1, occ: 0 }]);
      expect(owed.has(sql, "poke:wake")).toBe(false);
    });
  });
});

// ------------------------------------------------------------------ the actor, with fakes for the others

import type { ExportedSession, FeedFrame, FeedPush, Summary, SummaryPub } from "../src/actor/index.js";
import type { OrgDurableObject, OrgOut } from "../src/org/durable-object.js";

type Page = { rows: ExportedSession[]; next: string | null; newestCreatedAt: number };
type Fakes = { calls: [string, ...unknown[]][]; exportSessions: (after: string | null) => Promise<Page> };

/** Run `fn` on the Org named `name`, every call out replaced by a recorder. */
async function withActor<T>(name: string, fn: (org: OrgDurableObject, fakes: Fakes, sql: Sql) => Promise<T>, fakes: Fakes = { calls: [], exportSessions: async () => ({ rows: [], next: null, newestCreatedAt: 0 }) }): Promise<T> {
  return runInDurableObject(ORGS.getByName(name), async (instance, state) => {
    const org = instance as unknown as OrgDurableObject;
    const rec = (call: string) => async (...args: unknown[]) => void fakes.calls.push([call, ...args]);
    const out: OrgOut = {
      computer: () => ({ start: rec("Computer.start"), stop: rec("Computer.stop"), setAccess: rec("Computer.setAccess"), changed: rec("Computer.changed"), exportSessions: (after) => fakes.exportSessions(after) }),
      log: () => ({ setAccess: rec("SessionLog.setAccess"), destroy: rec("SessionLog.destroy"), accept: async (_p, entry) => (fakes.calls.push(["SessionLog.accept", entry]), { ok: true, id: entry.id, duplicate: false, machine: name }) }),
      slack: () => ({ announce: async (child) => (fakes.calls.push(["Slack.announce", child]), { threadKey: "T1:C1:1.2" }) }),
      delivery: (kind) => ({ poke: async (head) => void fakes.calls.push(["Delivery.poke", kind, head]) }),
      live: () => ({ publish: async (stream, frame) => (fakes.calls.push(["Live.publish", stream, frame]), { head: "" }) }),
      created: rec("usage.created"),
      workIndex: () => null,
    };
    org.out = out;
    return fn(org, fakes, sqlOf(state.storage));
  });
}

const summary = (over: Partial<Summary>): Summary => ({ ...emptySummary({}, null), ...over });
const pub = (sessionId: string, revision: number, over: Partial<Summary> = {}, occurrences: SummaryPub["occurrences"] = []): SummaryPub => ({ sessionId, revision, summary: summary({ ...over, revision }), occurrences });
const kindsOf = (frame: FeedFrame) => frame.rows.map((r) => `${r.kind}:${r.id}:${r.version}`).sort();
const frameOf = (read: FeedFrame | { reset: true; cursor: null }): FeedFrame => {
  if ("reset" in read) throw new Error("reset");
  return read;
};

describe("Org.createSession", () => {
  it("creates once, answers a repeat as a duplicate and another body as taken, and owes the calls", async () => {
    await withActor("create", async (org, fakes) => {
      const a = member("usr_a", "create");
      const body = { id: "cs_0000000000000010", input: "Fix the login redirect", person: { name: "Ann", email: "ann@example.com" } };
      const first = await org.createSession(a, body);
      expect(first).toMatchObject({ ok: true, duplicate: false, session: { id: body.id, title: "Fix the login redirect", status: "starting", archived: false, machine: "create" }, place: { trackId: null } });
      await org.drain();
      const names = fakes.calls.map((c) => c[0]);
      expect(names).toEqual(expect.arrayContaining(["Computer.start", "Computer.setAccess", "SessionLog.setAccess", "usage.created", "Live.publish"]));
      const start = fakes.calls.find((c) => c[0] === "Computer.start")![1] as { session: { id: string }; role: unknown };
      expect(start).toMatchObject({ session: { id: body.id }, role: null });
      const push = fakes.calls.find((c) => c[0] === "Live.publish")![2] as FeedPush;
      expect(push.rows.map((r) => `${r.kind}:${r.audience}`).sort()).toEqual(["place:org", "session:org"]);
      expect(fakes.calls.find((c) => c[0] === "usage.created")).toEqual(["usage.created", body.id, expect.any(Number)]);

      expect(await org.createSession(a, body)).toMatchObject({ ok: true, duplicate: true, session: { id: body.id } });
      expect(await org.createSession(a, { ...body, input: "Something else" })).toMatchObject({ ok: false, code: "taken", status: 409 });
      expect(await org.createSession(member("usr_b", "create"), body)).toMatchObject({ ok: false, code: "taken" });

      expect(await org.getSession(member("usr_b", "create"), body.id)).toMatchObject({ ok: true, session: { owner: { id: "usr_a", name: "Ann" } } });
      const list = await org.listSessions(a, {});
      expect(list).toMatchObject({ ok: true, sessions: [{ id: body.id }], nextCursor: null });
      expect(await org.access(body.id)).toMatchObject({ owner: "usr_a", audience: "org", writers: "members", machine: "create" });
    });
  });
});

describe("Org.feed", () => {
  it("answers a snapshot, then deltas by version, to the row's audience only", async () => {
    await withActor("feed", async (org) => {
      const a = member("usr_a", "feed");
      const b = member("usr_b", "feed");
      await org.createSession(a, { id: "cs_0000000000000020", input: "One" });
      await org.createSession(a, { id: "cs_0000000000000021", input: "Private", origin: { type: "slack", client: null, slack: null } });

      const snap = frameOf(await org.feed(a, { sum: true }));
      expect(snap).toMatchObject({ protocol: 1, org: "feed", subject: "usr_a", from: null, to: "f1.2", more: false, gone: [], counts: { earlier: 0, trackEarlier: {} } });
      expect(kindsOf(snap)).toEqual(["place:cs_0000000000000020:1", "place:cs_0000000000000021:2", "session:cs_0000000000000020:1", "session:cs_0000000000000021:2"]);
      expect(snap.sum).toMatch(/^[0-9a-f]{16}$/);
      expect(snap.rows[0]).not.toHaveProperty("audience");
      expect(kindsOf(frameOf(await org.feed(b, {})))).toEqual(["place:cs_0000000000000020:1", "session:cs_0000000000000020:1"]);
      expect(frameOf(await org.feed(a, { after: snap.to }))).toMatchObject({ from: "f1.2", to: "f1.2", rows: [], more: false });

      // The summary slot: a newer revision is taken, the same or an older one is not.
      const occurrences = [{ epoch: 1, seq: 5, kind: "turn.completed", by: "agent:cs_0000000000000020", at: Date.now() }];
      expect(await org.acceptSummary(pub("cs_0000000000000020", 3, { status: "idle", lastSeq: 5, lastText: "Done." }, occurrences))).toEqual({ accepted: true, revision: 3 });
      expect(await org.acceptSummary(pub("cs_0000000000000020", 3, { status: "running" }))).toEqual({ accepted: false, revision: 3 });
      expect(await org.acceptSummary(pub("cs_0000000000000020", 2, { status: "running" }))).toEqual({ accepted: false, revision: 3 });
      const delta = frameOf(await org.feed(b, { after: "f1.2" }));
      expect(delta).toMatchObject({ from: "f1.2", to: "f1.3", rows: [{ kind: "session", id: "cs_0000000000000020", version: 3, status: "idle", lastText: "Done." }] });
      expect(delta.counts).toBeUndefined();

      const stream = await org.occurrences({ ...a, kind: "platform", subject: "platform", audiences: [] }, {});
      expect(stream).toMatchObject({ entries: [{ n: "1", key: "cs_0000000000000020:1:5", kind: "turn.completed", sessionId: "cs_0000000000000020" }], to: "o1.1" });

      expect(await org.feed(a, { after: "nonsense" })).toEqual({ reset: true, cursor: null });
      expect(await org.feed(a, { after: "f1.99" })).toEqual({ reset: true, cursor: null });
    });
  });

  it("stops at 2,000 rows with `more`, and resets below the floor", async () => {
    await withActor("feed-more", async (org, _fakes, sql) => {
      const a = member("usr_a", "feed-more");
      await org.adopt();
      for (let i = 0; i < 1_001; i += 1) seedThread(sql, `cs_1${String(i).padStart(15, "0")}`, "usr_a");
      const first = frameOf(await org.feed(a, {}));
      expect(first).toMatchObject({ to: "f1.1000", more: true });
      expect(first.rows).toHaveLength(2_000);
      const rest = frameOf(await org.feed(a, { after: first.to }));
      expect(rest).toMatchObject({ from: "f1.1000", to: "f1.1001", more: false });
      expect(rest.rows).toHaveLength(2);
      sql.exec("UPDATE meta SET floor = 500");
      expect(await org.feed(a, { after: "f1.499" })).toEqual({ reset: true, cursor: null });
      expect(frameOf(await org.feed(a, { after: "f1.1001" })).rows).toEqual([]);
    });
  });
});

describe("Org.mutate", () => {
  it("applies in order, answers a repeat and a gap, and records a refusal for the client", async () => {
    await withActor("mutate", async (org, fakes, sql) => {
      const a = member("usr_a", "mutate");
      await org.createSession(a, { id: "cs_0000000000000030", input: "Mine" });
      await org.createSession(member("usr_b", "mutate"), { id: "cs_0000000000000031", input: "Theirs" });
      const rename = (sid: string, n: number) => org.mutate(a, { name: "thread.rename", args: { sid, title: `Title ${n}` }, client: { id: "cl_1", n } });

      expect(await rename("cs_0000000000000030", 1)).toMatchObject({ protocol: 1, lastMutation: 1 });
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 3 }]);
      expect(await rename("cs_0000000000000030", 1)).toEqual({ protocol: 1, lastMutation: 1 });
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 3 }]);
      expect(await rename("cs_0000000000000030", 3)).toEqual({ error: { code: "out_of_order", lastMutation: 1 } });
      expect(await rename("cs_0000000000000031", 2)).toMatchObject({ error: { code: "not_found", lastMutation: 2 } });
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 3 }]);
      expect(await org.mutate(member("usr_b", "mutate"), { name: "thread.rename", args: {}, client: { id: "cl_1", n: 1 } })).toEqual({ error: { code: "principal_mismatch" } });

      expect(frameOf(await org.feed(a, { after: "f1.3", clientId: "cl_1" }))).toMatchObject({ lastMutation: 2, errors: [{ n: 2, code: "not_found", reason: "not_found" }] });
      expect(frameOf(await org.feed(a, { after: "f1.3", clientId: "cl_1", ack: 2 }))).toMatchObject({ lastMutation: 2, errors: [] });

      // The refusal is confirmed to the client's sockets with no row.
      await org.drain();
      const pushes = fakes.calls.filter((c) => c[0] === "Live.publish").map((c) => c[2] as FeedPush);
      expect(pushes[pushes.length - 1]).toMatchObject({ from: "f1.3", to: "f1.3", rows: [], mutations: [{ clientId: "cl_1", n: 2 }] });

      // A key's mutation, by its idempotency key: the first answer again, another body refused.
      const key = { ...a, kind: "key" as const, credential: { id: "key_1", expiresAt: null } };
      const once = await org.mutate(key, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "By key" }, idem: "k1" });
      expect(once).toMatchObject({ protocol: 1 });
      expect(await org.mutate(key, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "By key" }, idem: "k1" })).toEqual(once);
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 4 }]);
      expect(await org.mutate(key, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "Other" }, idem: "k1" })).toEqual({ error: { code: "idempotency_conflict" } });
    });
  });
});

describe("Org's adoption", () => {
  const exported = (id: string, over: Partial<ExportedSession> = {}): ExportedSession => ({
    id,
    owner: "usr_a",
    origin: { type: "api", client: null, slack: null },
    title: `Old ${id.slice(-1)}`,
    archived: false,
    metadata: {},
    asideRef: null,
    writers: "members",
    slackThreadKey: null,
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    lastActiveAt: Date.now() - 1_000,
    summary: null,
    createHash: null,
    ...over,
  });

  it("adopts in pages, answers `adopting` when a page fails and resumes from the cursor", async () => {
    const asked: (string | null)[] = [];
    let fail = true;
    const fakes: Fakes = {
      calls: [],
      exportSessions: async (after) => {
        asked.push(after);
        if (after === null) return { rows: [exported("cs_0000000000000041"), exported("cs_0000000000000042", { archived: true })], next: "page2", newestCreatedAt: 50 };
        if (fail) {
          fail = false;
          throw new Error("Computer is away");
        }
        return { rows: [exported("cs_0000000000000042"), exported("cs_0000000000000043", { lastActiveAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 })], next: null, newestCreatedAt: 60 };
      },
    };
    await withActor(
      "adopt",
      async (org, _f, sql) => {
        const a = member("usr_a", "adopt");
        expect(await org.listSessions(a, {})).toMatchObject({ ok: false, code: "adopting", status: 503 });
        await expect(org.feed(a, {})).resolves.toMatchObject({ rows: expect.any(Array) });
        expect(asked).toEqual([null, "page2", "page2"]);
        expect(sql.exec("SELECT adopted, adopt_after, adopted_at FROM meta")).toEqual([{ adopted: 1, adopt_after: null, adopted_at: 60 }]);
        const list = await org.listSessions(a, { archived: "all" });
        expect(list.ok && list.sessions.map((s) => `${s.id}:${s.archived}`).sort()).toEqual(["cs_0000000000000041:false", "cs_0000000000000042:true", "cs_0000000000000043:false"]);
        expect(sql.exec("SELECT session_id, placed_by, earlier_at IS NOT NULL AS earlier FROM place ORDER BY session_id")).toEqual([
          { session_id: "cs_0000000000000041", placed_by: "rule:adopt", earlier: 0 },
          { session_id: "cs_0000000000000042", placed_by: "rule:adopt", earlier: 1 },
          { session_id: "cs_0000000000000043", placed_by: "rule:adopt", earlier: 1 },
        ]);
        // A snapshot leaves the Earlier threads out and counts them.
        const snap = frameOf(await org.feed(a, {}));
        expect(kindsOf(snap).map((k) => k.split(":").slice(0, 2).join(":"))).toEqual(["place:cs_0000000000000041", "session:cs_0000000000000041"]);
        expect(snap.counts).toEqual({ earlier: 2, trackEarlier: {} });
      },
      fakes,
    );
  });
});

import { age } from "../src/org/work.js";

describe("Org: a track, its agent, a pull request and the work reads", () => {
  it("starts the track's agent with its role, applies the rules and answers the reads", async () => {
    await withActor("work", async (org, fakes, sql) => {
      const a = member("usr_a", "work");
      const thread = "cs_0000000000000050";
      const agentSession = "cs_0000000000000051";
      const agent: Principal = { ...a, subject: thread, kind: "agent", via: "agent", audiences: [], session: thread };
      const url = "https://github.com/o/r/pull/1";
      await org.createSession(a, { id: thread, input: "Fix the login redirect" });
      expect(await org.mutate(a, { name: "track.create", args: { tid: "trk_0001", agentSessionId: agentSession, name: "Login", sid: thread } })).toMatchObject({ protocol: 1 });
      await org.drain();
      const starts = fakes.calls.filter((c) => c[0] === "Computer.start").map((c) => c[1] as { session: { id: string }; role: unknown });
      expect(starts.find((s) => s.session.id === agentSession)).toMatchObject({ role: { name: "track", trackId: "trk_0001" } });
      expect(await org.access(thread)).toMatchObject({ agents: [`agent:${agentSession}`], readers: [`agent:${agentSession}`] });
      expect(await org.trackAgent(agent)).toBe(agentSession);

      expect(await org.mutate(agent, { name: "result.add", args: { resultId: "res_0001", sid: thread, kind: "pr", ref: url, title: "Login PR" }, idem: "r1" })).toMatchObject({ protocol: 1 });
      await org.acceptSummary(pub(thread, 1, { status: "idle", lastSeq: 4, lastText: "Opened the pull request." }));

      // rule:pr-merged, then rule:reply.
      await org.acceptPull({ url, state: "merged", checks: null, title: "Login PR", at: Date.now() });
      expect(sql.exec("SELECT done_by, outcome, done_at IS NOT NULL AS done FROM place WHERE session_id = ?", thread)).toEqual([{ done_by: "rule:pr-merged", outcome: "done", done: 1 }]);
      expect(sql.exec("SELECT state FROM result WHERE id = 'res_0001'")).toEqual([{ state: "merged" }]);
      await org.acceptSummary(pub(thread, 2, { status: "running", lastSeq: 5 }, [{ epoch: 1, seq: 5, kind: "message.received", by: "user:usr_a", at: Date.now() }]));
      expect(sql.exec("SELECT done_at FROM place WHERE session_id = ?", thread)).toEqual([{ done_at: null }]);

      const changed = sql.exec<{ n: number }>("SELECT n FROM occurrence WHERE kind = 'result.changed' ORDER BY n DESC LIMIT 1")[0]!.n;
      expect(await org.wakeTargets(changed)).toEqual([agentSession]);
      expect(await org.digest(agentSession, 1, changed)).toContain("Fix the login redirect");

      const page = await org.threads(a, {});
      expect([...new Set(page.rows.map((r) => r.kind))].sort()).toEqual(["place", "result", "session"]);
      expect(page.next).toBeNull();
      expect((await org.search(a, { q: "LOGIN" })).rows.map((r) => r.kind).sort()).toEqual(["place", "result", "session", "track"]);
      expect(await org.overview(a)).toMatchObject({ tracks: [{ id: "trk_0001", name: "Login" }], threads: [{ id: thread, trackId: "trk_0001", results: [{ id: "res_0001", state: "merged" }] }] });
      expect(await org.overview(agent)).toMatchObject({ tracks: [{ id: "trk_0001" }], threads: [{ id: thread }] });
      expect(await org.result(member("usr_b", "work"), "res_0001")).toMatchObject({ kind: "result", type: "pr", ref: url });
      expect(await org.docRevisions(a, "trk_0001")).toEqual(expect.any(Array));

      // The machine: a preview opens and closes; an older revision is not taken.
      const machine = { machine: "work", state: "ready" as const, newestCreatedAt: 0 };
      expect(await org.acceptMachine({ ...machine, revision: 1, previews: [{ sessionId: thread, name: "web", url: "https://web.example" }] })).toEqual({ accepted: true });
      expect(sql.exec("SELECT kind, ref, title FROM result WHERE kind = 'preview'")).toEqual([{ kind: "preview", ref: "https://web.example", title: "web" }]);
      expect(await org.acceptMachine({ ...machine, revision: 2, previews: [] })).toEqual({ accepted: true });
      expect(sql.exec("SELECT 1 FROM result WHERE kind = 'preview'")).toEqual([]);
      expect(await org.acceptMachine({ ...machine, revision: 2, previews: [] })).toEqual({ accepted: false });
      const machineOcc = sql.exec<{ n: number }>("SELECT n FROM occurrence WHERE kind = 'machine.changed'");
      expect(machineOcc).toHaveLength(1);
      expect(await org.echo(machineOcc[0]!.n)).toBeNull();

      // Ageing: quiet and read for 7 days goes to Earlier; not while working.
      age(sql, Date.now() + 8 * 24 * 60 * 60 * 1_000);
      expect(sql.exec("SELECT earlier_at FROM place WHERE session_id = ?", thread)).toEqual([{ earlier_at: null }]);
      await org.acceptSummary(pub(thread, 3, { status: "idle", lastSeq: 6, lastActiveAt: new Date().toISOString() }));
      age(sql, Date.now() + 8 * 24 * 60 * 60 * 1_000);
      expect(sql.exec("SELECT earlier_at IS NOT NULL AS earlier FROM place WHERE session_id = ?", thread)).toEqual([{ earlier: 1 }]);
      expect((await org.threads(a, { earlier: true })).rows.filter((r) => r.kind === "session")).toHaveLength(1);

      await org.linkPerson("slack:T1:U1", "usr_a");
    });
  });
});
