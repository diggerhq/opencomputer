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
      expect(row).toMatchObject({ kind: "session", title: "Fix the login redirect", titleBy: "user:usr_a", agentTitle: "First words", status: "idle", version: 2, audience: "org" });
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
      expect(sql.exec("SELECT call FROM _owed WHERE call IN ('SessionLog.wake', 'Slack.notify')")).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ the actor, with fakes for the others

import type { FeedFrame, FeedPush, Summary, SummaryPub } from "../src/actor/index.js";
import type { OrgDurableObject, OrgOut } from "../src/org/durable-object.js";
import type { StoredRepository, TokenMinter } from "../src/org/repository.js";

type Fakes = {
  calls: [string, ...unknown[]][];
  boardRepository?: StoredRepository;
  account?: TokenMinter;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

/** Run `fn` on the Org named `name`, every call out replaced by a recorder. */
async function withActor<T>(name: string, fn: (org: OrgDurableObject, fakes: Fakes, sql: Sql) => Promise<T>, fakes: Fakes = { calls: [] }): Promise<T> {
  return runInDurableObject(ORGS.getByName(name), async (instance, state) => {
    const org = instance as unknown as OrgDurableObject;
    const rec = (call: string) => async (...args: unknown[]) => void fakes.calls.push([call, ...args]);
    const out: OrgOut = {
      computer: () => ({ start: rec("Computer.start"), stop: rec("Computer.stop"), setAccess: rec("Computer.setAccess"), changed: rec("Computer.changed") }),
      log: () => ({ setAccess: rec("SessionLog.setAccess"), destroy: rec("SessionLog.destroy"), accept: async (_p, entry) => (fakes.calls.push(["SessionLog.accept", entry]), { ok: true, id: entry.id, duplicate: false, machine: name }) }),
      slack: () => ({ announce: async (child) => (fakes.calls.push(["Slack.announce", child]), { threadKey: "T1:C1:1.2" }), notify: rec("Slack.notify") }),
      live: () => ({ publish: async (stream, frame) => (fakes.calls.push(["Live.publish", stream, frame]), { head: "" }) }),
      created: rec("usage.created"),
      boardRepository: async () => fakes.boardRepository ?? null,
      account: () => fakes.account ?? null,
      fetch: (url, init) => (fakes.fetch ?? fetch)(url, init),
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
      expect(first).toMatchObject({ ok: true, duplicate: false, session: { id: body.id, title: "Fix the login redirect", status: "idle", archived: false, machine: "create" }, place: { trackId: null } });
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

      const snap = frameOf(await org.feed(a, {}));
      expect(snap).toMatchObject({ protocol: 1, org: "feed", subject: "usr_a", from: null, to: "f1.2", more: false, gone: [], counts: { earlier: 0, trackEarlier: {} } });
      expect(kindsOf(snap)).toEqual(["place:cs_0000000000000020:1", "place:cs_0000000000000021:2", "session:cs_0000000000000020:1", "session:cs_0000000000000021:2"]);
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
      await org.feed(a, {});
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
  it("names each mutation by its Idempotency-Key: two tabs both land, a refusal wedges nothing, a retry gets the first reply", async () => {
    await withActor("mutate", async (org, fakes, sql) => {
      const a = member("usr_a", "mutate");
      await org.createSession(a, { id: "cs_0000000000000030", input: "Mine" });
      await org.createSession(member("usr_b", "mutate"), { id: "cs_0000000000000031", input: "Theirs" });

      // Two tabs of one person, each with its own key: both writes land, each reply names its version.
      const renamed = await org.mutate(a, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "Tab A" }, idem: "ib_a" });
      expect(renamed).toMatchObject({ protocol: 1, version: 3 });
      expect(await org.mutate(a, { name: "thread.keep", args: { sid: "cs_0000000000000030", keep: true }, idem: "ib_b" })).toMatchObject({ protocol: 1, version: 4 });
      const place = frameOf(await org.feed(a, {})).rows.find((r) => r.kind === "place" && r.id === "cs_0000000000000030");
      expect(place).toMatchObject({ keep: true });
      expect(frameOf(await org.feed(a, { after: "f1.3" }))).toMatchObject({ to: "f1.4", version: 4 });

      // A retry, from a new sign-in too, is the first reply; nothing is applied again.
      const again = { ...a, credential: { id: "ses_other", expiresAt: null } };
      expect(await org.mutate(again, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "Tab A" }, idem: "ib_a" })).toEqual(renamed);
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 4 }]);

      // A refusal is the reply and leaves nothing behind: the next mutation applies.
      expect(await org.mutate(a, { name: "thread.rename", args: { sid: "cs_0000000000000031", title: "No" }, idem: "ib_c" })).toMatchObject({ error: { code: "not_found" } });
      expect(await org.mutate(a, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "After" }, idem: "ib_d" })).toMatchObject({ protocol: 1, version: 5 });

      await org.drain();
      const pushes = fakes.calls.filter((c) => c[0] === "Live.publish").map((c) => c[2] as FeedPush);
      expect(pushes[pushes.length - 1]).toMatchObject({ from: "f1.4", to: "f1.5", version: 5 });

      // A key's mutation, by its idempotency key: the first answer again, another body refused.
      const key = { ...a, kind: "key" as const, credential: { id: "key_1", expiresAt: null } };
      const once = await org.mutate(key, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "By key" }, idem: "k1" });
      expect(once).toMatchObject({ protocol: 1 });
      expect(await org.mutate(key, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "By key" }, idem: "k1" })).toEqual(once);
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 6 }]);
      expect(await org.mutate(key, { name: "thread.rename", args: { sid: "cs_0000000000000030", title: "Other" }, idem: "k1" })).toEqual({ error: { code: "idempotency_conflict" } });
    });
  });
});

describe("Org's knowledge repository", () => {
  const board: StoredRepository = { installationId: "12", owner: "acme", name: "knowledge", branch: "main", id: 7 };
  const account: TokenMinter = {
    mintGitHubInstallationToken: async () => ({ outcome: "minted", token: "ghs_test", expiresAt: "2099-01-01T00:00:00Z" }),
    getGitHubInstallation: () => ({ accountLogin: "acme" }),
    listGitHubInstallations: () => [],
  };
  const github = async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/repos/acme/notes") return Response.json({ id: 8, name: "notes", owner: { login: "acme" }, default_branch: "main" });
    if (path === "/repos/acme/notes/git/ref/heads/main") return Response.json({ object: { sha: "abc" } });
    return Response.json({}, { status: 404 });
  };

  it("copies the board's setting once, on the alarm its migration arms, and hands it to the host", async () => {
    const fakes: Fakes = { calls: [], boardRepository: board };
    await withActor(
      "knowledge-board",
      async (org, _f, sql) => {
        const a = member("usr_a", "knowledge-board");
        expect(await org.repository(a)).toBeNull();
        expect(sql.exec("SELECT purpose FROM _alarm WHERE purpose = 'board'")).toEqual([{ purpose: "board" }]);
        await org.alarm();
        expect(sql.exec("SELECT purpose FROM _alarm WHERE purpose = 'board'")).toEqual([]);
        expect(await org.repository(a)).toMatchObject({ installationId: "12", owner: "acme", name: "knowledge", branch: "main", problem: null });
        expect((await org.forHost("knowledge-board")).knowledge).toBe("acme/knowledge");
        await org.drain();
        expect(fakes.calls.some((c) => c[0] === "Computer.changed")).toBe(true);
      },
      fakes,
    );
  });

  it("stores a checked choice, owes Computer `changed`, and refuses an agent", async () => {
    const fakes: Fakes = { calls: [], account, fetch: github };
    await withActor(
      "knowledge-set",
      async (org) => {
        const a = member("usr_a", "knowledge-set");
        expect(await org.repository(a)).toBeNull();
        expect(await org.setRepository(a, { installationId: "12", owner: "acme", name: "nope" })).toMatchObject({ ok: false, status: 400, reason: "repository_not_found" });
        expect(await org.setRepository(a, { installationId: "12", owner: "acme", name: "notes" })).toMatchObject({ ok: true, repository: { owner: "acme", name: "notes", branch: "main" } });
        expect((await org.forHost("knowledge-set")).knowledge).toBe("acme/notes");
        await org.drain();
        expect(fakes.calls.some((c) => c[0] === "Computer.changed")).toBe(true);
        expect(await org.setRepository({ ...a, kind: "agent" }, { installationId: "12", owner: "acme", name: "notes" })).toMatchObject({ ok: false, code: "forbidden", status: 403 });
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

      // The result's change and the reply wake the track's agent, as one turn when it is due.
      expect(sql.exec("SELECT grp, call FROM _owed WHERE call = 'SessionLog.wake'")).toEqual([{ grp: `wake:${agentSession}`, call: "SessionLog.wake" }]);
      sql.exec("UPDATE _owed SET at = 0 WHERE call = 'SessionLog.wake'");
      await org.drain();
      const wakes = fakes.calls.filter((c) => c[0] === "SessionLog.accept" && (c[1] as { kind: string; body: { input?: string } }).body.input?.startsWith(`Thread ${thread}`));
      expect(wakes).toHaveLength(1);

      const page = await org.threads(a, {});
      expect([...new Set(page.rows.map((r) => r.kind))].sort()).toEqual(["place", "result", "session"]);
      expect(page.next).toBeNull();
      expect((await org.search(a, { q: "LOGIN" })).rows.map((r) => r.kind).sort()).toEqual(["place", "result", "session", "track"]);
      expect(await org.overview(a)).toMatchObject({ tracks: [{ id: "trk_0001", name: "Login" }], threads: [{ id: thread, trackId: "trk_0001", results: [{ id: "res_0001", state: "merged" }] }] });
      expect(await org.overview(agent)).toMatchObject({ tracks: [{ id: "trk_0001" }], threads: [{ id: thread }] });
      expect(await org.result(member("usr_b", "work"), "res_0001")).toMatchObject({ kind: "result", type: "pr", ref: url });
      expect(await org.docRevisions(a, "trk_0001")).toEqual(expect.any(Array));

      // The machine: a preview opens and closes; an older revision is not taken.
      const machine = { machine: "work", state: "ready" as const };
      expect(await org.acceptMachine({ ...machine, revision: 1, previews: [{ sessionId: thread, name: "web", url: "https://web.example" }] })).toEqual({ accepted: true });
      expect(sql.exec("SELECT kind, ref, title FROM result WHERE kind = 'preview'")).toEqual([{ kind: "preview", ref: "https://web.example", title: "web" }]);
      expect(await org.acceptMachine({ ...machine, revision: 2, previews: [] })).toEqual({ accepted: true });
      expect(sql.exec("SELECT 1 FROM result WHERE kind = 'preview'")).toEqual([]);
      expect(await org.acceptMachine({ ...machine, revision: 2, previews: [] })).toEqual({ accepted: false });
      const machineOcc = sql.exec<{ n: number }>("SELECT n FROM occurrence WHERE kind = 'machine.changed'");
      expect(machineOcc).toHaveLength(1);
      // No Slack thread waits on the machine: the echo is owed and sends nothing.
      await org.drain();
      expect(sql.exec("SELECT 1 FROM _owed WHERE call = 'Slack.notify'")).toEqual([]);
      expect(fakes.calls.filter((c) => c[0] === "Slack.notify")).toEqual([]);

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

describe("Org: wakes and the Slack echo (spec 40.6)", () => {
  it("gathers a track agent's wakes into one turn, not woken by its own act, retried while its inbox is full", async () => {
    await withActor("wake", async (org, fakes, sql) => {
      const a = member("usr_a", "wake");
      const thread = "cs_0000000000000060";
      const agentSession = "cs_0000000000000061";
      await org.createSession(a, { id: thread, input: "Fix the login redirect" });
      await org.mutate(a, { name: "track.create", args: { tid: "trk_0002", agentSessionId: agentSession, name: "Login", sid: thread } });
      await org.drain();
      const wakeRows = () => sql.exec<{ body: string; at: number; tries: number }>("SELECT body, at, tries FROM _owed WHERE call = 'SessionLog.wake'").map((r) => ({ ...JSON.parse(r.body), at: r.at, tries: r.tries }));
      const occ = (seq: number, kind: string, by: string) => [{ epoch: 1, seq, kind, by, at: Date.now() }];
      const turns = () => fakes.calls.filter((c) => c[0] === "SessionLog.accept" && (c[1] as { kind: string }).kind === "turn").map((c) => c[1] as { id: string; body: { input: string; ifBusy: string } });
      expect(wakeRows()).toEqual([]);
      fakes.calls.length = 0;

      await org.acceptSummary(pub(thread, 1, { status: "idle", lastSeq: 1, lastText: "Opened it." }, occ(1, "turn.completed", `agent:${thread}`)));
      const [first] = wakeRows();
      expect(first).toMatchObject({ sessionId: agentSession, fromN: expect.any(Number), tries: 0 });
      expect(first!.id).toMatch(/^tn_[0-9a-z]{12}$/);
      expect(first!.at).toBeGreaterThan(Date.now() + 15_000);
      await org.acceptSummary(pub(thread, 2, { status: "idle", lastSeq: 2 }, occ(2, "ask.opened", `agent:${thread}`)));
      // The track's agent's own act wakes nobody.
      await org.acceptSummary(pub(thread, 3, { status: "idle", lastSeq: 3 }, occ(3, "turn.completed", `agent:${agentSession}`)));
      const [merged, ...more] = wakeRows();
      expect(more).toEqual([]);
      expect(merged).toMatchObject({ id: first!.id, fromN: first!.fromN, toN: first!.fromN + 1, at: first!.at });

      // Debounced: nothing goes before it is due.
      await org.drain();
      expect(turns()).toEqual([]);

      // Due, and the inbox full: it stays owed with the same id, and goes on the retry.
      const accept = org.out.log;
      let full = true;
      org.out = {
        ...org.out,
        log: (sessionId) => ({
          ...accept(sessionId),
          accept: async (p, entry) => (full ? ((full = false), { ok: false, code: "inbox_full" }) : accept(sessionId).accept(p, entry)),
        }),
      };
      sql.exec("UPDATE _owed SET at = 0 WHERE call = 'SessionLog.wake'");
      await org.drain();
      expect(turns()).toEqual([]);
      expect(wakeRows()).toMatchObject([{ id: first!.id, tries: 1 }]);
      sql.exec("UPDATE _owed SET at = 0 WHERE call = 'SessionLog.wake'");
      await org.drain();
      expect(turns()).toMatchObject([{ id: first!.id, body: { ifBusy: "queue", input: expect.stringContaining(`Thread ${thread} "Fix the login redirect"`) } }]);
      expect(wakeRows()).toEqual([]);

      // What comes after it is a new wake.
      await org.acceptSummary(pub(thread, 4, { status: "idle", lastSeq: 4 }, occ(4, "turn.completed", `agent:${thread}`)));
      expect(wakeRows()).toMatchObject([{ fromN: first!.fromN + 3, toN: first!.fromN + 3 }]);
    });
  });

  it("echoes a machine's change to the Slack threads waiting on it", async () => {
    await withActor("echo", async (org, fakes, sql) => {
      const a = member("usr_a", "echo");
      const thread = "cs_0000000000000070";
      await org.createSession(a, { id: thread, input: "Fix the login redirect" });
      await org.acceptSummary(pub(thread, 1, { status: "running" }));
      sql.exec("UPDATE session SET slack_thread_key = 'T1:C1:1.2' WHERE id = ?", thread);
      await org.acceptMachine({ machine: "echo", state: "ready", revision: 1, previews: [] });
      await org.drain();
      expect(fakes.calls.filter((c) => c[0] === "Slack.notify")).toEqual([["Slack.notify", { kind: "machine", state: "ready", threadKeys: ["T1:C1:1.2"] }]]);
    });
  });
});
