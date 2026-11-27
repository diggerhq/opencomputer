import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/durable/migrations.js";
import { owed } from "../src/durable/outbox.js";
import { sqlOf, type Sql } from "../src/durable/sql.js";
import { type Principal } from "../src/auth/principal.js";
import { runMutation } from "../src/actors/org/mutations/run.js";
import { STEPS } from "../src/actors/org/schema.js";
import { sessionRow } from "../src/actors/org/feed-rows.js";
import { readSession } from "../src/actors/org/records.js";
import { emptySummary } from "../src/actors/org/summary.js";
import { changesAt, transact } from "../src/actors/org/tx.js";

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

import type { FeedFrame, FeedPush, SummaryPub } from "../src/actors/org/contract.js";
import type { Summary } from "../src/actors/session-log/contract.js";
import type { OrgDurableObject, OrgOut } from "../src/actors/org/durable-object.js";
import type { StoredRepository, TokenMinter } from "../src/actors/org/repository.js";
import type { AccessCarry } from "../src/actors/computer/contract.js";
import { firstTurnId } from "../src/ids/session-ids.js";

type Fakes = {
  calls: [string, ...unknown[]][];
  boardRepository?: StoredRepository;
  accessCarry?: AccessCarry;
  account?: TokenMinter;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

/** Run `fn` on the Org named `name`, every call out replaced by a recorder. */
async function withActor<T>(name: string, fn: (org: OrgDurableObject, fakes: Fakes, sql: Sql) => Promise<T>, fakes: Fakes = { calls: [] }): Promise<T> {
  return runInDurableObject(ORGS.getByName(name), async (instance, state) => {
    const org = instance as unknown as OrgDurableObject;
    const rec = (call: string) => async (...args: unknown[]) => void fakes.calls.push([call, ...args]);
    const out: OrgOut = {
      computer: () => ({ start: rec("Computer.start"), stop: rec("Computer.stop"), setAccess: rec("Computer.setAccess"), changed: rec("Computer.changed"), accessCarry: async () => fakes.accessCarry ?? { accessDefault: null, apiAccessDefault: null } }),
      log: () => ({ setAccess: rec("SessionLog.setAccess"), destroy: rec("SessionLog.destroy"), accept: async (p, entry) => (fakes.calls.push(["SessionLog.accept", entry, p]), { ok: true, id: entry.id, duplicate: false, outcome: { state: "waiting" } }) }),
      slack: () => ({ announce: async (child) => (fakes.calls.push(["Slack.announce", child]), { threadKey: "T1:C1:1.2" }), notify: rec("Slack.notify") }),
      live: () => ({ publish: async (stream, frame) => (fakes.calls.push(["Live.publish", stream, frame]), { head: "" }) }),
      created: rec("usage.created"),
      installationIndexed: rec("installation.indexed"),
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
      // The organization's default access is `owner`: the owner's audience, written by the owner.
      expect(push.rows.map((r) => `${r.kind}:${r.audience}`).sort()).toEqual(["place:member:usr_a", "session:member:usr_a"]);
      expect(fakes.calls.find((c) => c[0] === "usage.created")).toEqual(["usage.created", body.id, expect.any(Number)]);

      expect(await org.createSession(a, body)).toMatchObject({ ok: true, duplicate: true, session: { id: body.id } });
      expect(await org.createSession(a, { ...body, input: "Something else" })).toMatchObject({ ok: false, code: "taken", status: 409 });
      expect(await org.createSession(member("usr_b", "create"), body)).toMatchObject({ ok: false, code: "taken" });

      expect(await org.getSession(a, body.id)).toMatchObject({ ok: true, session: { owner: { id: "usr_a", name: "Ann" }, access: { mode: "owner", people: [] }, canManageAccess: true } });
      expect(await org.getSession(member("usr_b", "create"), body.id)).toMatchObject({ ok: false, code: "session_not_found" });
      const list = await org.listSessions(a, {});
      expect(list).toMatchObject({ ok: true, sessions: [{ id: body.id }], nextCursor: null });
      expect(await org.access(body.id)).toMatchObject({ owner: "usr_a", audience: "member:usr_a", writers: ["user:usr_a"], machine: "create" });
    });
  });
});

describe("Org: one path for a create's first turn and a patch's settings", () => {
  const accepted = (fakes: Fakes) => fakes.calls.filter((c) => c[0] === "SessionLog.accept").map((c) => ({ entry: c[1], by: (c[2] as Principal).subject }));

  it("owes the first turn with the session, from its creator, once whatever retries", async () => {
    await withActor("first-turn", async (org, fakes) => {
      const a = member("usr_a", "first-turn");
      const named = { id: "cs_0000000000000070", input: "Fix it", turnId: "tn_0123456789ab", trace: "tr_1" };
      expect(await org.createSession(a, named)).toMatchObject({ ok: true, duplicate: false });
      // A retry with another trace is the same create; with another turn id it is not.
      expect(await org.createSession(a, { ...named, trace: "tr_2" })).toMatchObject({ ok: true, duplicate: true });
      expect(await org.createSession(a, { ...named, turnId: "tn_bcdefghjkmnp" })).toMatchObject({ ok: false, code: "taken" });
      const derived = "cs_0000000000000071";
      await org.createSession(a, { id: derived, input: "And this" });
      await org.createSession(a, { id: "cs_0000000000000072" });
      await org.drain();
      expect(accepted(fakes)).toEqual([
        { entry: { id: "tn_0123456789ab", kind: "turn", body: { input: "Fix it", ifBusy: "queue" }, trace: "tr_1" }, by: "usr_a" },
        { entry: { id: firstTurnId(derived), kind: "turn", body: { input: "And this", ifBusy: "queue" } }, by: "usr_a" },
      ]);
      expect(await org.createSession(a, { id: "cs_0000000000000073", turnId: "tn_0123456789ab" })).toMatchObject({ ok: false, code: "invalid_request", field: "turnId" });
    });
  });

  it("applies every field of a patch with its settings entry, or none of them", async () => {
    await withActor("patch-all", async (org, fakes) => {
      const a = member("usr_a", "patch-all");
      const sid = "cs_0000000000000074";
      await org.createSession(a, { id: sid, title: "Before" });
      await org.drain();
      fakes.calls.length = 0;
      const settings = { id: "ie_0123456789abcdef", body: { model: "claude-opus-5-5" }, trace: "tr_3" };
      expect(await org.patchSession(a, sid, { title: "After", archived: true, metadata: { k: "v" }, settings })).toMatchObject({ ok: true, session: { title: "After", archived: true, metadata: { k: "v" } } });
      await org.drain();
      expect(accepted(fakes)).toEqual([{ entry: { id: settings.id, kind: "settings", body: settings.body, trace: "tr_3" }, by: "usr_a" }]);

      // Settings are a person's: an agent's patch with them changes nothing, its metadata included.
      fakes.calls.length = 0;
      const agent: Principal = { ...a, subject: sid, kind: "agent", via: "agent", audiences: [], session: sid };
      expect(await org.patchSession(agent, sid, { metadata: { k: "w" }, settings: { ...settings, id: "ie_1123456789abcdef" } })).toMatchObject({ ok: false, code: "forbidden", reason: "settings_writer_only" });
      await org.drain();
      expect(accepted(fakes)).toEqual([]);
      expect(await org.getSession(a, sid)).toMatchObject({ ok: true, session: { title: "After", metadata: { k: "v" } } });
    });
  });
});

describe("Org: session access (spec 36.2)", () => {
  const SID = "cs_0000000000000030";
  const slackOrigin = { type: "slack" as const, client: null, slack: null };
  const slackMember = (subject: string, org: string): Principal => ({ ...member(subject, org), via: "slack" });

  it("carries the Computer's defaults over once, where Org has none, and a new Slack session takes the Slack one", async () => {
    const fakes: Fakes = { calls: [], accessCarry: { accessDefault: "owner", apiAccessDefault: "org" } };
    await withActor(
      "access-carry",
      async (org, _f, sql) => {
        const a = member("usr_a", "access-carry");
        await org.createSession(a, { id: "cs_0000000000000040", origin: slackOrigin });
        expect(sql.exec("SELECT purpose FROM _alarm WHERE purpose = 'accessCarry'")).toEqual([{ purpose: "accessCarry" }]);
        expect((await org.access("cs_0000000000000040"))?.writers).toBe("members");
        await org.alarm();
        expect(sql.exec("SELECT purpose FROM _alarm WHERE purpose = 'accessCarry'")).toEqual([]);
        expect(await org.settings(a)).toEqual({ apiAccessDefault: "org" });
        await org.createSession(a, { id: "cs_0000000000000041", origin: slackOrigin });
        expect((await org.access("cs_0000000000000041"))?.writers).toEqual(["user:usr_a"]);
        // An explicit list is kept; an API session is unaffected.
        await org.createSession(a, { id: "cs_0000000000000042", origin: slackOrigin, writers: "members" });
        expect((await org.access("cs_0000000000000042"))?.writers).toBe("members");
        // What Org holds is not replaced by a later carry.
        fakes.accessCarry = { accessDefault: "open", apiAccessDefault: "owner" };
        sql.exec("INSERT INTO _alarm (purpose, at) VALUES ('accessCarry', 0)");
        await org.alarm();
        expect(await org.settings(a)).toEqual({ apiAccessDefault: "org" });
        expect(sql.exec("SELECT slack_access_default AS v FROM meta")).toEqual([{ v: "owner" }]);
      },
      fakes,
    );
  });

  it("moves a person's Slack sessions, their writers and tracks to the member they are linked to", async () => {
    await withActor("link-person", async (org, _f, sql) => {
      const name = "link-person";
      const raw = "user_01KAW3QZ8N9Y5C7D2E4F6G8H0J";
      const slack = slackMember(raw, name);
      await org.createSession(slack, { id: "cs_0000000000000045", origin: slackOrigin, writers: [`user:${raw}`, "user:usr_b"] });
      await org.mutate(slack, { name: "track.create", args: { tid: "trk_0045", agentSessionId: "cs_0000000000000046", name: "Linked", sid: "cs_0000000000000045" } });
      const me = member("usr_01kaw3qz8n9y5c7d2e4f6g8h0j", name);
      expect((await org.threads(me, {})).rows.filter((r) => r.kind === "session")).toEqual([]);

      await org.linkPerson(raw, me.subject);
      expect(sql.exec("SELECT owner, writers, audience FROM session WHERE id = 'cs_0000000000000045'")).toEqual([
        { owner: me.subject, writers: JSON.stringify([`user:${me.subject}`, "user:usr_b"]), audience: `member:${me.subject}` },
      ]);
      expect(sql.exec("SELECT owner, audience FROM track WHERE id = 'trk_0045'")).toEqual([{ owner: me.subject, audience: `member:${me.subject}` }]);
      expect((await org.threads(me, { trackId: "trk_0045" })).rows.filter((r) => r.kind === "session").map((r) => r.id)).toEqual(["cs_0000000000000045"]);
    });
  });

  it("lets only an admin change the Slack default, a Slack principal named by Org's admins too", async () => {
    await withActor("access-slack-default", async (org, _f, sql) => {
      const name = "access-slack-default";
      await org.settings({ ...member("usr_boss", name), admin: true });
      expect(await org.setSlackAccessDefault(slackMember("usr_a", name), "owner")).toMatchObject({ ok: false, code: "admin_required", status: 403 });
      expect(await org.setSlackAccessDefault(slackMember(`slack:T1:U9`, name), "owner")).toMatchObject({ ok: false, code: "admin_required" });
      // A Slack principal is never `admin`; it does not unmake the admin Org saw.
      expect(await org.setSlackAccessDefault(slackMember("usr_boss", name), "owner")).toEqual({ ok: true, value: "owner" });
      expect(sql.exec("SELECT slack_access_default AS v FROM meta")).toEqual([{ v: "owner" }]);
      await org.createSession(slackMember("usr_a", name), { id: "cs_0000000000000043", origin: slackOrigin });
      expect((await org.access("cs_0000000000000043"))?.writers).toEqual(["user:usr_a"]);
      expect(await org.setSlackAccessDefault(slackMember("usr_boss", name), "open")).toEqual({ ok: true, value: "open" });
      await org.createSession(slackMember("usr_a", name), { id: "cs_0000000000000044", origin: slackOrigin });
      expect((await org.access("cs_0000000000000044"))?.writers).toBe("members");
    });
  });

  it("defaults from the organization's setting, which only an admin changes", async () => {
    await withActor("access-default", async (org) => {
      const a = member("usr_a", "access-default");
      const admin = { ...member("usr_boss", "access-default"), admin: true };
      expect(await org.settings(a)).toEqual({ apiAccessDefault: "owner" });
      expect(await org.setSettings(a, { apiAccessDefault: "org" })).toMatchObject({ ok: false, code: "admin_required", status: 403 });
      expect(await org.setSettings(admin, { apiAccessDefault: "everyone" as never })).toMatchObject({ ok: false, code: "invalid_request", field: "apiAccessDefault" });
      expect(await org.setSettings(admin, { apiAccessDefault: "org" })).toEqual({ ok: true, settings: { apiAccessDefault: "org" } });
      expect(await org.createSession(a, { id: SID })).toMatchObject({ ok: true, session: { access: { mode: "org", people: [] } } });
      expect(await org.getSession(member("usr_b", "access-default"), SID)).toMatchObject({ ok: true, session: { canManageAccess: false } });
      // A Slack session is its owner's whatever the default, and takes no `access`.
      const slack = { type: "slack" as const, client: null, slack: null };
      expect(await org.createSession(a, { id: "cs_0000000000000031", origin: slack })).toMatchObject({ ok: true, session: { access: { mode: "owner" }, canManageAccess: false } });
      expect(await org.createSession(a, { id: "cs_0000000000000032", origin: slack, access: { mode: "org" } })).toMatchObject({ ok: false, code: "invalid_request", field: "access" });
      expect(await org.createSession(a, { id: "cs_0000000000000033", role: "start", access: { mode: "org" } })).toMatchObject({ ok: false, code: "invalid_request", field: "access" });
    });
  });

  it("shares with people: they read, list and drive it, but only the owner changes its access (owner first)", async () => {
    await withActor("access-people", async (org, fakes) => {
      const a = member("usr_a", "access-people");
      const b = member("usr_b", "access-people");
      const c = member("usr_c", "access-people");
      await org.createSession(c, { id: "cs_0000000000000034", person: { name: "Cy", email: "Cy@Example.com" } });
      const bad = (people: unknown) => org.createSession(a, { id: SID, access: { mode: "people", people } as never });
      expect(await bad(["nobody@example.com"])).toMatchObject({ ok: false, status: 400, field: "access.people", reason: "unknown_member" });
      expect(await bad(Array.from({ length: 51 }, (_, i) => `usr_${i}`))).toMatchObject({ ok: false, field: "access.people" });
      expect(await org.createSession(a, { id: SID, access: { mode: "owner", people: ["usr_b"] } })).toMatchObject({ ok: false, field: "access.people" });

      const made = await org.createSession(a, { id: SID, access: { mode: "people", people: ["usr_b", "cy@example.com", "usr_a"] } });
      expect(made).toMatchObject({ ok: true, session: { access: { mode: "people", people: ["usr_b", "usr_c"] }, canManageAccess: true } });
      expect(await org.access(SID)).toMatchObject({ audience: "member:usr_a", writers: ["user:usr_a", "user:usr_b", "user:usr_c"], readers: ["user:usr_b", "user:usr_c"] });
      expect(await org.getSession(b, SID)).toMatchObject({ ok: true, session: { canManageAccess: false } });
      expect((await org.listSessions(b, { owner: "anyone" })) as { sessions: { id: string }[] }).toMatchObject({ sessions: [{ id: SID }] });
      const d = member("usr_d", "access-people");
      expect(await org.getSession(d, SID)).toMatchObject({ ok: false, code: "session_not_found" });
      expect(((await org.listSessions(d, { owner: "anyone" })) as { sessions: unknown[] }).sessions).toEqual([]);
      expect(await org.patchSession(d, SID, { access: { mode: "org" } })).toMatchObject({ ok: false, code: "session_not_found" });

      // A person it is shared with uses it but changes nothing of it: not its access, title, archive, metadata or settings.
      expect(await org.patchSession(b, SID, { access: { mode: "org" } })).toMatchObject({ ok: false, code: "forbidden", status: 403, reason: "owner_only" });
      const settings = { id: "ie_0123456789abcdee", body: { model: "claude-opus-5-5" } };
      for (const patch of [{ title: "Mine" }, { archived: true }, { metadata: { a: "b" } }, { settings }]) {
        expect(await org.patchSession(b, SID, patch)).toMatchObject({ ok: false, code: "forbidden", status: 403, reason: "owner_only" });
      }
      expect(await org.getSession(b, SID)).toMatchObject({ ok: true, session: { access: { mode: "people", people: ["usr_b", "usr_c"] }, archived: false, canManageAccess: false } });
      // The owner removing them locks them out.
      fakes.calls.length = 0;
      expect(await org.patchSession(a, SID, { access: { mode: "people", people: ["usr_c", "usr_d"] } })).toMatchObject({ ok: true, session: { access: { mode: "people", people: ["usr_c", "usr_d"] }, canManageAccess: true } });
      await org.drain();
      expect(fakes.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["Computer.setAccess", "SessionLog.setAccess"]));
      expect(await org.getSession(b, SID)).toMatchObject({ ok: false, code: "session_not_found" });
      expect(await org.getSession(d, SID)).toMatchObject({ ok: true });
    });
  });

  it("moves the rows when the audience changes; an admin has no power in someone else's session (owner first)", async () => {
    await withActor("access-move", async (org) => {
      const a = member("usr_a", "access-move");
      const b = member("usr_b", "access-move");
      const admin = { ...member("usr_boss", "access-move"), admin: true };
      await org.createSession(a, { id: SID, access: { mode: "org" } });
      const before = frameOf(await org.feed(b, {}));
      expect(kindsOf(before).map((k) => k.split(":")[0])).toEqual(["place", "session"]);
      // Someone who uses it but does not manage it.
      expect(await org.patchSession(b, SID, { access: { mode: "owner" } })).toMatchObject({ ok: false, code: "forbidden", status: 403, reason: "owner_only" });
      // In an org-wide session an admin is a member: uses it, changes nothing of it.
      expect(await org.getSession(admin, SID)).toMatchObject({ ok: true, session: { canManageAccess: false } });
      for (const patch of [{ access: { mode: "owner" as const } }, { access: { mode: "people" as const, people: ["usr_boss"] } }, { title: "Mine" }, { archived: true }, { metadata: { a: "b" } }]) {
        expect(await org.patchSession(admin, SID, patch)).toMatchObject({ ok: false, code: "forbidden", status: 403, reason: "owner_only" });
      }

      expect(await org.patchSession(a, SID, { access: { mode: "owner" } })).toMatchObject({ ok: true, session: { access: { mode: "owner" } } });
      const after = frameOf(await org.feed(b, { after: before.to }));
      expect(after.rows).toEqual([]);
      expect(after.gone.map((g) => g.kind).sort()).toEqual(["place", "session"]);
      expect(kindsOf(frameOf(await org.feed(a, { after: before.to }))).map((k) => k.split(":")[0])).toEqual(["place", "session"]);

      // Owner-only now: the admin cannot see, share or add themselves to it; they ask the owner.
      expect(await org.getSession(admin, SID)).toMatchObject({ ok: false, code: "session_not_found" });
      for (const access of [{ mode: "people" as const, people: ["usr_boss"] }, { mode: "org" as const }]) {
        expect(await org.patchSession(admin, SID, { access })).toMatchObject({ ok: false, code: "session_not_found", status: 404 });
      }
      expect(await org.patchSession(admin, SID, { title: "Mine" })).toMatchObject({ ok: false, code: "session_not_found" });
      expect(((await org.listSessions(admin, { owner: "anyone" })) as { sessions: unknown[] }).sessions).toEqual([]);
      expect(await org.getSession(a, SID)).toMatchObject({ ok: true, session: { access: { mode: "owner" } } });
      expect(await org.patchSession(a, SID, { access: { mode: "org" } })).toMatchObject({ ok: true, session: { access: { mode: "org" } } });
      expect(kindsOf(frameOf(await org.feed(b, { after: before.to }))).map((k) => k.split(":")[0])).toEqual(["place", "session"]);
    });
  });

  it("leaves a Slack session's access to Slack", async () => {
    await withActor("access-slack", async (org) => {
      const a = member("usr_a", "access-slack");
      await org.createSession(a, { id: SID, origin: { type: "slack", client: null, slack: null } });
      expect(await org.patchSession(a, SID, { access: { mode: "org" } })).toMatchObject({ ok: false, code: "forbidden", reason: "access_in_slack" });
      // Its drivers (`!access`, `thread.writers`) read it as its owner does; the API still shows `owner`.
      const b = member("usr_b", "access-slack");
      expect(await org.getSession(b, SID)).toMatchObject({ ok: false, code: "session_not_found" });
      expect(await org.mutate(a, { name: "thread.writers", args: { sid: SID, writers: ["user:usr_a", "user:usr_b"] }, idem: "w1" })).toMatchObject({ protocol: 1 });
      expect(await org.getSession(b, SID)).toMatchObject({ ok: true, session: { access: { mode: "owner", people: [] }, canManageAccess: false } });
      expect(await org.access(SID)).toMatchObject({ audience: "member:usr_a", readers: ["user:usr_b"] });
      // Its owner still renames or archives it.
      expect(await org.patchSession(a, SID, { title: "Mine" })).toMatchObject({ ok: true, session: { title: "Mine" } });
      expect(await org.patchSession(b, SID, { title: "Theirs" })).toMatchObject({ ok: false, code: "forbidden", reason: "owner_only" });
    });
  });

  it("gives an agent's thread its parent's access, whatever the default", async () => {
    await withActor("access-child", async (org) => {
      const a = member("usr_a", "access-child");
      const b = member("usr_b", "access-child");
      const child = "cs_0000000000000035";
      const other = "cs_0000000000000036";
      await org.createSession(a, { id: SID, access: { mode: "people", people: ["usr_b"] } });
      const agent: Principal = { ...a, subject: SID, kind: "agent", via: "agent", audiences: [], session: SID };
      expect(await org.createSession(agent, { id: child, input: "Look into it" })).toMatchObject({ ok: true, session: { access: { mode: "people", people: ["usr_b"] } } });
      expect(await org.getSession(b, child)).toMatchObject({ ok: true });
      expect(await org.createSession(agent, { id: other, access: { mode: "org" } })).toMatchObject({ ok: false, code: "invalid_request", field: "access" });
    });
  });

  it("lets a key read and change its member's sessions with sessions:read alone, and keeps Work for work:read (spec 34.3)", async () => {
    await withActor("access-key", async (org, _fakes, sql) => {
      const a = member("usr_a", "access-key");
      const key = (subject: string, scopes: Principal["scopes"] = ["sessions:read", "sessions:write"]): Principal => ({ ...member(subject, "access-key"), kind: "key", via: "api", scopes, credential: { id: `key_${subject}`, expiresAt: null } });
      const keyA = key("usr_a");
      const keyB = key("usr_b");
      // The organization's default: owner, so the session's rows are `member:usr_a`.
      expect(await org.createSession(keyA, { id: SID, input: "Mine" })).toMatchObject({ ok: true, session: { access: { mode: "owner", people: [] } } });
      expect(await org.getSession(keyA, SID)).toMatchObject({ ok: true, session: { id: SID } });
      const listed = await org.listSessions(keyA, {});
      expect(listed.ok && listed.sessions.map((s) => s.id)).toEqual([SID]);
      // The feed: the session row, not its place (a Work kind).
      expect(kindsOf(frameOf(await org.feed(keyA, {}))).map((k) => k.split(":").slice(0, 2).join(":"))).toEqual([`session:${SID}`]);
      expect(await org.patchSession(keyA, SID, { title: "Renamed by key" })).toMatchObject({ ok: true, session: { title: "Renamed by key" } });

      // Another member's key: not found, not listed, not in its feed.
      expect(await org.getSession(keyB, SID)).toMatchObject({ ok: false, code: "session_not_found", status: 404 });
      expect(await org.patchSession(keyB, SID, { title: "Theirs" })).toMatchObject({ ok: false, code: "session_not_found" });
      const theirs = await org.listSessions(keyB, { owner: "anyone" });
      expect(theirs.ok && theirs.sessions).toEqual([]);
      expect(frameOf(await org.feed(keyB, {})).rows).toEqual([]);

      // A track of usr_a (`member:usr_a`): Work proper, so not to a key without work:read.
      const thread = "cs_0000000000000038";
      await org.createSession(a, { id: thread, input: "Plan" });
      expect(await org.mutate(a, { name: "track.create", args: { tid: "trk_0009", agentSessionId: "cs_0000000000000039", name: "Launch", sid: thread } })).toMatchObject({ protocol: 1 });
      const kinds = new Set(frameOf(await org.feed(keyA, {})).rows.map((r) => r.kind));
      expect([...kinds].sort()).toEqual(["session"]);
      expect(await org.doc(keyA, "trk_0009")).toBeNull();
      expect(await org.docRevisions(keyA, "trk_0009")).toEqual([]);
      expect(await org.doc(a, "trk_0009")).not.toBeNull();
      // Occurrences: its sessions', not a track's own.
      transact(sql, Date.now(), (tx) => {
        tx.occur({ key: "turn", kind: "turn.completed", sessionId: SID, by: "platform", audience: "member:usr_a" });
        tx.occur({ key: "quiet", kind: "track.quiet", trackId: "trk_0009", by: "rule:age", audience: "member:usr_a" });
      });
      const occ = await org.occurrences(keyA, {});
      expect("entries" in occ && occ.entries.map((e) => e.kind)).toContain("turn.completed");
      expect("entries" in occ && occ.entries.map((e) => e.kind)).not.toContain("track.quiet");
      const memberOcc = await org.occurrences(a, {});
      expect("entries" in memberOcc && memberOcc.entries.map((e) => e.kind)).toContain("track.quiet");
      // With work:read the key reads Work as its member does.
      const worker = key("usr_a", ["sessions:read", "work:read"]);
      expect(await org.doc(worker, "trk_0009")).not.toBeNull();
      expect(new Set(frameOf(await org.feed(worker, {})).rows.map((r) => r.kind))).toEqual(new Set(frameOf(await org.feed(a, {})).rows.map((r) => r.kind)));
    });
  });
});

describe("Org.feed", () => {
  it("answers a snapshot, then deltas by version, to the row's audience only", async () => {
    await withActor("feed", async (org) => {
      const a = member("usr_a", "feed");
      const b = member("usr_b", "feed");
      await org.createSession(a, { id: "cs_0000000000000020", input: "One", access: { mode: "org" } });
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
        // The carried setting's installation is indexed for the App's webhooks, as a choice's is.
        expect(fakes.calls).toContainEqual(["installation.indexed", "12"]);
      },
      fakes,
    );
  });

  it("indexes a stored repository's installation in D1 github_installation_orgs, owed until written", async () => {
    await runInDurableObject(ORGS.getByName("knowledge-index"), async (instance, state) => {
      const org = instance as unknown as OrgDurableObject & { env: Record<string, unknown> };
      const writes: unknown[][] = [];
      let down = true;
      org.env.SERVERLESS_AGENTS_DB = {
        prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { if (down) throw new Error("D1 down"); writes.push([sql, ...args]); return {}; } }) }),
      } as unknown as D1Database;
      org.out = {
        ...org.out,
        account: () => ({ ...account, getGitHubInstallation: () => ({ accountLogin: "acme", githubInstallationId: 42 }) }),
        fetch: github,
        computer: () => ({ changed: async () => undefined }) as never,
      };
      const a = member("usr_a", "knowledge-index");
      expect(await org.setRepository(a, { installationId: "12", owner: "acme", name: "notes" })).toMatchObject({ ok: true });
      await org.drain().catch(() => undefined);
      expect(writes).toEqual([]);
      const sql = sqlOf(state.storage);
      expect(owed.has(sql, "installation:org")).toBe(true);
      down = false;
      sql.exec("UPDATE _owed SET at = 0");
      await org.drain();
      expect(writes).toEqual([[expect.stringContaining("github_installation_orgs"), 42, "knowledge-index", "12"]]);
      expect(owed.has(sql, "installation:org")).toBe(false);
    });
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
        expect(fakes.calls).toContainEqual(["installation.indexed", "12"]);
        expect(await org.setRepository({ ...a, kind: "agent" }, { installationId: "12", owner: "acme", name: "notes" })).toMatchObject({ ok: false, code: "forbidden", status: 403 });
      },
      fakes,
    );
  });
});

import { age } from "../src/actors/org/work.js";

describe("Org: a track, its agent, a pull request and the work reads", () => {
  it("starts the track's agent with its role, applies the rules and answers the reads", async () => {
    await withActor("work", async (org, fakes, sql) => {
      const a = member("usr_a", "work");
      const thread = "cs_0000000000000050";
      const agentSession = "cs_0000000000000051";
      const agent: Principal = { ...a, subject: thread, kind: "agent", via: "agent", audiences: [], session: thread };
      const url = "https://github.com/o/r/pull/1";
      await org.createSession(a, { id: thread, input: "Fix the login redirect", access: { mode: "org" } });
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
      expect((await org.thread(a, thread))!.rows.map((r) => r.kind).sort()).toEqual(["place", "result", "session"]);
      expect(await org.thread({ ...a, audiences: [] }, thread)).toBeNull();
      expect(await org.thread(a, "cs_0000000000000099")).toBeNull();
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

describe("Org: a merge made with the button (work 118)", () => {
  it("records the merge as its person's line, leaves the thread open, and takes a revert; an agent and someone outside the thread do not", async () => {
    await withActor("merge", async (org, _fakes, sql) => {
      const a = member("usr_a", "merge");
      const thread = "cs_0000000000000060";
      const agent: Principal = { ...a, subject: thread, kind: "agent", via: "agent", audiences: [], session: thread };
      const url = "https://github.com/o/r/pull/1";
      const facts = { number: 1, base: "main", method: "squash" as const, sha: "b".repeat(40), branchDeleted: true };
      await org.createSession(a, { id: thread, input: "Fix the login redirect", access: { mode: "owner" } });
      await org.mutate(agent, { name: "result.add", args: { resultId: "res_0001", sid: thread, kind: "pr", ref: url, title: "Login PR" } });
      await org.acceptPull({ url, state: "open", checks: "success", title: "Login PR", head: "a".repeat(40), draft: false, at: Date.now() });
      expect((await org.result(a, "res_0001"))!.meta).toMatchObject({ head: "a".repeat(40), draft: false });

      expect(await org.mergeStart(agent, "res_0001", "merge")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await org.mergeStart(member("usr_b", "merge"), "res_0001", "merge")).toMatchObject({ ok: false, code: "not_found" });
      // Only the edge says GitHub merged it: a body's claim is not one.
      expect(await org.mutate(a, { name: "result.merge", args: { resultId: "res_0001", github: facts } })).toMatchObject({ error: { code: "refused", reason: "unmerged" } });
      expect(sql.exec("SELECT state FROM result WHERE id = 'res_0001'")).toEqual([{ state: "open" }]);

      expect(await org.mergeStart(a, "res_0001", "merge")).toMatchObject({ ok: true, result: { id: "res_0001", meta: { merging: { by: "user:usr_a" } } } });
      // GitHub's webhook comes first or last: either way the merge is this person's and the thread stays open.
      await org.acceptPull({ url, state: "merged", checks: "success", title: "Login PR", head: "a".repeat(40), draft: false, at: Date.now() });
      expect(sql.exec("SELECT done_at FROM place WHERE session_id = ?", thread)).toEqual([{ done_at: null }]);
      const merged = await org.mutate(a, { name: "result.merge", args: { resultId: "res_0001" }, github: facts, idem: "m1" });
      expect(merged).toMatchObject({ protocol: 1 });
      expect(await org.mutate(a, { name: "result.merge", args: { resultId: "res_0001" }, github: facts, idem: "m1" })).toEqual(merged);
      const row = (await org.result(a, "res_0001"))!;
      expect(row).toMatchObject({ state: "merged", meta: { merge: { by: "user:usr_a", method: "squash", base: "main", branchDeleted: true } } });
      expect((row.meta as Record<string, unknown>).merging).toBeUndefined();
      const ops = () => sql.exec<{ id: string; name: string; undone_by: string | null }>("SELECT id, name, undone_by FROM op WHERE name LIKE 'result.%' AND name != 'result.add' ORDER BY version");
      expect(ops()).toMatchObject([{ name: "result.merge", undone_by: null }]);
      expect(sql.exec("SELECT done_at FROM place WHERE session_id = ?", thread)).toEqual([{ done_at: null }]);

      // Undo is the revert, on GitHub: not Org's undo.
      expect(await org.mutate(a, { name: "undo", args: { opId: ops()[0]!.id } })).toMatchObject({ error: { code: "refused", reason: "on_github" } });
      expect(await org.mutate(a, { name: "result.revert", args: { resultId: "res_0001" }, github: { number: 2, url: "https://github.com/o/r/pull/2", merged: false } })).toMatchObject({ value: { merged: false, number: 2 } });
      expect(ops()).toHaveLength(1);
      expect(await org.mutate(a, { name: "result.revert", args: { resultId: "res_0001" }, github: { number: 2, url: "https://github.com/o/r/pull/2", merged: true } })).toMatchObject({ protocol: 1 });
      expect(ops()).toMatchObject([{ name: "result.merge", undone_by: expect.any(String) }, { name: "result.revert" }]);
      expect((await org.result(a, "res_0001"))!.meta).toMatchObject({ revert: { number: 2, merged: true, by: "user:usr_a" } });
    });
  });

  it("a merge found already made on GitHub is state only: no line, and the thread is Done by the rule", async () => {
    await withActor("merge-found", async (org, _fakes, sql) => {
      const a = member("usr_a", "merge-found");
      const thread = "cs_0000000000000061";
      const url = "https://github.com/o/r/pull/3";
      await org.createSession(a, { id: thread, input: "Fix it", access: { mode: "org" } });
      const agent: Principal = { ...a, subject: thread, kind: "agent", via: "agent", audiences: [], session: thread };
      await org.mutate(agent, { name: "result.add", args: { resultId: "res_0002", sid: thread, kind: "pr", ref: url, title: "PR" } });
      await org.acceptPull({ url, state: "merged", checks: null, title: "PR", at: Date.now() });
      expect(sql.exec("SELECT done_by FROM place WHERE session_id = ?", thread)).toEqual([{ done_by: "rule:pr-merged" }]);
      expect(await org.mutate(a, { name: "result.merge", args: { resultId: "res_0002" }, github: { number: 3, base: "main", method: null, sha: null, branchDeleted: false } })).toMatchObject({ protocol: 1 });
      expect(sql.exec("SELECT 1 FROM op WHERE name = 'result.merge'")).toEqual([]);
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
