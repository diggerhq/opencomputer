import { describe, expect, it, vi } from "vitest";

import { type ComputerApiStub, matchApiRoute, routeComputerApi } from "../src/computer/api-http.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { accessOf, isOwner, mayChangeSession, mayManage, mayUse, membersOf, parseAccessInput, readApiAccessDefault, storedAccess } from "../src/computer/session-access.js";
import { memberId } from "../src/computer/session-ids.js";
import { caller, created, fixture, MO, OWNER, SID } from "./fixtures/computer-sessions-api.js";

/**
 * CTO-37, owner first: who may use and manage a session started from the dashboard, opc or the API.
 * owner | org | people, against the owner, a listed person, someone else and an admin outside it.
 * Only the owner manages a session; an admin is a member like any other.
 */

const PAT = "usr_01jpatpatpatpatpatpatpatp0";
const ADMIN = "usr_01jadminadminadminadminad0";
type Mode = "owner" | "org" | "people";
type Who = "owner" | "listed" | "other" | "admin";

const who: Record<Who, ReturnType<typeof caller>> = {
  owner: caller(OWNER),
  listed: caller(MO),
  other: caller(PAT),
  admin: caller(ADMIN, { admin: true }),
};

/** A fixture where every person has called once (so they can be named) and the owner made SID with `mode`. */
async function session(mode: Mode, options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  for (const c of Object.values(who)) await f.api.handle(c, { op: "me" });
  await created(f, SID, OWNER, mode === "people" ? { mode, people: [MO] } : { mode });
  return f;
}

const listed = async (f: Awaited<ReturnType<typeof session>>, c: ReturnType<typeof caller>) =>
  ((await f.api.handle(c, { op: "list", query: [["owner", "anyone"]] })).body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);

// Whether each person may use the session (get, history, send, list) in each mode.
const USES: Record<Mode, Record<Who, boolean>> = {
  owner: { owner: true, listed: false, other: false, admin: false },
  org: { owner: true, listed: true, other: true, admin: true },
  people: { owner: true, listed: true, other: false, admin: false },
};
// Whether each may change its access, rename it or archive it: the owner alone, in every mode.
const MANAGES: Record<Mode, Record<Who, boolean>> = {
  owner: { owner: true, listed: false, other: false, admin: false },
  org: { owner: true, listed: false, other: false, admin: false },
  people: { owner: true, listed: false, other: false, admin: false },
};

describe("the access matrix", () => {
  for (const mode of ["owner", "org", "people"] as const) {
    for (const w of ["owner", "listed", "other", "admin"] as const) {
      const uses = USES[mode][w];
      const manages = MANAGES[mode][w];
      it(`${mode} session, ${w}: ${uses ? "uses" : "does not use"} it, ${manages ? "manages" : "does not manage"} its access`, async () => {
        const f = await session(mode);
        const c = who[w];
        const get = await f.api.handle(c, { op: "get", sessionId: SID });
        expect(get.status).toBe(uses ? 200 : 404);
        if (uses) expect(get.body).toMatchObject({ session: { access: { mode }, canManageAccess: manages } });
        else expect(get.error).toMatchObject({ code: "session_not_found" });
        expect((await f.api.handle(c, { op: "access", sessionId: SID })).status).toBe(uses ? 200 : 404);
        f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "queued", duplicate: false, seq: 1 } }));
        expect((await f.api.handle(c, { op: "call", sessionId: SID, method: "turns.send", params: { input: "x" } })).status).toBe(uses ? 202 : 404);
        f.answers.set("sessions.interrupt", () => ({ result: { seq: 1 } }));
        expect((await f.api.handle(c, { op: "call", sessionId: SID, method: "sessions.interrupt", params: {} })).status === 404).toBe(!uses);
        expect(await listed(f, c)).toEqual(uses ? [SID] : []);
        const patch = await f.api.handle(c, { op: "patch", sessionId: SID, body: { access: { mode: "people", people: [MO, PAT] } } });
        if (manages) expect(patch.status).toBe(200);
        else expect(patch).toMatchObject(uses ? { status: 403, error: { code: "forbidden", reason: "owner_only" } } : { status: 404, error: { code: "session_not_found" } });
        expect(f.api.row(SID)!.accessMode).toBe(manages ? "people" : mode);
        f.answers.set("sessions.update", () => ({ result: { session: { title: "Renamed" }, seq: 2 } }));
        for (const body of [{ title: "Renamed" }, { archived: true }, { model: "claude-opus-5-5" }]) {
          const changed = await f.api.handle(c, { op: "patch", sessionId: SID, body });
          if (manages) expect(changed.status).toBe(200);
          else expect(changed).toMatchObject(uses ? { status: 403, error: { code: "forbidden", reason: "owner_only" } } : { status: 404 });
        }
      });
    }
  }
});

describe("admins: no powers inside someone else's session", () => {
  it("cannot see, share or add themselves to an owner-only session: they ask the owner", async () => {
    const f = await session("owner");
    const admin = who.admin;
    for (const access of [{ mode: "people", people: [ADMIN] }, { mode: "org" }]) {
      expect(await f.api.handle(admin, { op: "patch", sessionId: SID, body: { access } })).toMatchObject({ status: 404, error: { code: "session_not_found" } });
    }
    expect(await f.api.handle(admin, { op: "patch", sessionId: SID, body: { title: "Mine" } })).toMatchObject({ status: 404 });
    expect(f.api.row(SID)!.accessMode).toBe("owner");
    expect(await f.api.handle(admin, { op: "get", sessionId: SID })).toMatchObject({ status: 404 });
    expect(await listed(f, admin)).toEqual([]);
    expect(f.frames("api").filter((a) => a.method === "sessions.update")).toEqual([]);
  });

  it("in an org-wide session an admin is a member: uses it, changes nothing of it", async () => {
    const f = await session("org");
    const admin = who.admin;
    expect(await f.api.handle(admin, { op: "get", sessionId: SID })).toMatchObject({ status: 200, body: { session: { canManageAccess: false } } });
    for (const body of [{ access: { mode: "owner" } }, { access: { mode: "people", people: [ADMIN] } }, { title: "Mine" }, { archived: true }, { metadata: { a: "b" } }]) {
      expect(await f.api.handle(admin, { op: "patch", sessionId: SID, body })).toMatchObject({ status: 403, error: { reason: "owner_only" } });
    }
    expect(f.api.row(SID)!.accessMode).toBe("org");
  });

  it("the host's access list carries no admin bypass of its own: members are the session's", async () => {
    const f = await session("owner");
    await f.api.handle(who.admin, { op: "me" });
    f.sent.length = 0;
    f.api.onHello();
    expect(f.frames("access")[0]!.access).toEqual({ sessionId: SID, owner: OWNER, members: [] });
  });
});

describe("invited people", () => {
  it("use the session but change neither its access nor its settings", async () => {
    const f = await session("people");
    const mo = who.listed;
    f.answers.set("sessions.update", () => ({ result: { session: {}, seq: 1 } }));
    expect(await f.api.handle(mo, { op: "patch", sessionId: SID, body: { model: "claude-opus-5-5" } })).toMatchObject({ status: 403, error: { reason: "owner_only" } });
    expect(await f.api.handle(mo, { op: "patch", sessionId: SID, body: { access: { mode: "org" } } })).toMatchObject({ status: 403, error: { reason: "owner_only" } });
    expect(f.frames("api").filter((a) => a.method === "sessions.update")).toEqual([]);
    expect(await f.api.handle(mo, { op: "get", sessionId: SID })).toMatchObject({ status: 200, body: { session: { access: { mode: "people", people: [MO] }, canManageAccess: false } } });
  });

  it("the owner removing them locks them out", async () => {
    const f = await session("people");
    expect((await f.api.handle(who.owner, { op: "patch", sessionId: SID, body: { access: { mode: "owner" } } })).body).toMatchObject({ session: { canManageAccess: true } });
    expect((await f.api.handle(who.listed, { op: "get", sessionId: SID })).status).toBe(404);
  });
});

describe("create and patch bodies", () => {
  it("people as member ids, WorkOS user ids or emails; the owner and duplicates dropped; unknown people refused", async () => {
    const f = fixture();
    await f.api.handle(caller(MO, { email: "Mo@Example.com" }), { op: "me" });
    await f.api.handle(who.other, { op: "me" });
    const reply = await f.api.handle(who.owner, { op: "create", body: { id: SID, access: { mode: "people", people: ["mo@example.com", `user_${PAT.slice(4).toUpperCase()}`, OWNER, MO] } } });
    expect(reply).toMatchObject({ status: 201, body: { session: { access: { mode: "people", people: [MO, PAT].sort() }, canManageAccess: true } } });
    for (const people of [["nobody@example.com"], ["usr_01jnobodynobodynobodynob0"]]) {
      expect(await f.api.handle(who.owner, { op: "patch", sessionId: SID, body: { access: { mode: "people", people } } })).toMatchObject({
        status: 400,
        error: { code: "invalid_request", field: "access.people", reason: "unknown_member" },
      });
    }
    for (const access of [{ mode: "everyone" }, { mode: "org", people: [MO] }, { mode: "people", people: "mo" }, "org", { mode: "owner", extra: 1 }]) {
      expect(await f.api.handle(who.owner, { op: "patch", sessionId: SID, body: { access } })).toMatchObject({ status: 400, error: { code: "invalid_request" } });
    }
    expect(f.api.row(SID)!.accessMode).toBe("people");
  });

  it("each change sends the host the list its relay enforces: [] owner-only, null org-wide, the people", async () => {
    const f = await session("owner");
    const members = () => f.frames("access").at(-1)!.access.members;
    expect(members()).toEqual([]);
    await f.api.handle(who.owner, { op: "patch", sessionId: SID, body: { access: { mode: "org" } } });
    expect(members()).toBeNull();
    await f.api.handle(who.owner, { op: "patch", sessionId: SID, body: { access: { mode: "people", people: [MO] } } });
    expect(members()).toEqual([MO]);
    // The next hello sends the stored list.
    f.sent.length = 0;
    f.api.onHello();
    expect(f.frames("access").map((a) => a.access)).toEqual([{ sessionId: SID, owner: OWNER, members: [MO] }]);
  });

  it("access and other fields in one patch: both applied, the reply shows the new access", async () => {
    const f = await session("owner");
    f.answers.set("sessions.update", () => ({ result: { session: { title: "New" }, seq: 1 } }));
    const reply = await f.api.handle(who.owner, { op: "patch", sessionId: SID, body: { title: "New", access: { mode: "org" } } });
    expect(reply).toMatchObject({ status: 200, body: { session: { title: "New", access: { mode: "org" }, canManageAccess: true }, seq: 1 } });
  });
});

describe("organization default (Q5) and old sessions (Q3)", () => {
  it("new sessions are the owner's until an admin sets apiAccessDefault to org", async () => {
    const f = fixture();
    expect(await f.api.handle(who.other, { op: "settings.get" })).toEqual({ status: 200, body: { settings: { apiAccessDefault: "owner" } } });
    await created(f);
    expect((await f.api.handle(who.other, { op: "get", sessionId: SID })).status).toBe(404);
    expect(await f.api.handle(who.other, { op: "settings.patch", body: { apiAccessDefault: "org" } })).toMatchObject({ status: 403, error: { code: "admin_required" } });
    for (const body of [{}, { apiAccessDefault: "people" }, { accessDefault: "org" }, null]) {
      expect(await f.api.handle(who.admin, { op: "settings.patch", body })).toMatchObject({ status: 400 });
    }
    expect(await f.api.handle(who.admin, { op: "settings.patch", body: { apiAccessDefault: "org" } })).toEqual({ status: 200, body: { settings: { apiAccessDefault: "org" } } });
    expect(f.settings.get("accessDefault")).toBeUndefined();
    await created(f, "cs_2222222222222222");
    expect(await f.api.handle(who.other, { op: "get", sessionId: "cs_2222222222222222" })).toMatchObject({ status: 200, body: { session: { access: { mode: "org" } } } });
    // An explicit mode wins over the default.
    await created(f, "cs_3333333333333333", OWNER, { mode: "owner" });
    expect((await f.api.handle(who.other, { op: "get", sessionId: "cs_3333333333333333" })).status).toBe(404);
    expect(SID).not.toBe("cs_2222222222222222");
  });

  it("a session with no stored mode (from before access modes) is its owner's, never org-wide", async () => {
    const f = await session("org");
    f.sql.exec("UPDATE sessions SET access_mode = NULL, access_people = NULL WHERE session_id = ?", SID);
    expect((await f.api.handle(who.other, { op: "get", sessionId: SID })).status).toBe(404);
    expect(await listed(f, who.other)).toEqual([]);
    expect(await f.api.handle(who.owner, { op: "get", sessionId: SID })).toMatchObject({ status: 200, body: { session: { access: { mode: "owner", people: [] } } } });
    f.sent.length = 0;
    f.api.onHello();
    expect(f.frames("access")[0]!.access.members).toEqual([]);
  });

  it("once, on start: rows with no stored mode are written owner-only and the host is told; Slack rows and set modes untouched", async () => {
    const f = await session("org");
    await created(f, "cs_2222222222222222", OWNER, { mode: "people", people: [MO] });
    await created(f, "cs_3333333333333333");
    f.sql.exec("UPDATE sessions SET access_mode = NULL, access_people = NULL WHERE session_id IN (?, ?)", SID, "cs_3333333333333333");
    f.slackRow("T1:C1:1.2");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const api = f.reopen();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual({ event: "computer.session_access_migrated", sessions: 2, mode: "owner" });
    log.mockRestore();
    const modes = f.sql.exec("SELECT runner_key AS key, session_id AS id, access_mode AS mode FROM sessions ORDER BY runner_key").toArray();
    expect(modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: SID, mode: "owner" }),
      expect.objectContaining({ id: "cs_2222222222222222", mode: "people" }),
      expect.objectContaining({ id: "cs_3333333333333333", mode: "owner" }),
      expect.objectContaining({ key: "T1:C1:1.2", mode: null }),
    ]));
    f.sent.length = 0;
    await api.handle(who.owner, { op: "me" });
    expect(f.frames("access").find((a) => a.access.sessionId === SID)!.access.members).toEqual([]);
    // Nothing left to migrate: the next start writes nothing and pushes nothing.
    f.sent.length = 0;
    const again = f.reopen();
    await again.handle(who.owner, { op: "me" });
    expect(f.frames("access")).toEqual([]);
  });

  it("a Slack session's access is set in its thread, never over the API", async () => {
    const f = fixture();
    f.slackRow("T1:C1:1.2");
    f.state.links.set("U1", "user_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const slackId = (await f.api.slackDelivery("T1:C1:1.2", "U1"))!.sessionId;
    expect(await f.api.handle(who.owner, { op: "get", sessionId: slackId })).toMatchObject({ body: { session: { access: { mode: "owner", people: [] }, canManageAccess: false } } });
    expect(await f.api.handle(who.owner, { op: "patch", sessionId: slackId, body: { access: { mode: "org" } } })).toMatchObject({ status: 403, error: { reason: "access_in_slack" } });
    expect((await f.api.handle(who.admin, { op: "patch", sessionId: slackId, body: { access: { mode: "org" } } })).status).toBe(404);
    // Its owner may still rename or archive it.
    f.answers.set("sessions.update", () => ({ result: { session: {}, seq: 1 } }));
    expect((await f.api.handle(who.owner, { op: "patch", sessionId: slackId, body: { title: "Mine" } })).status).toBe(200);
  });

  it("HTTP: GET and PATCH /settings; reading needs no scope, changing needs sessions:write", async () => {
    expect(matchApiRoute("GET", "/settings")).toEqual({ op: "settings.get" });
    expect(matchApiRoute("PATCH", "/settings")).toEqual({ op: "settings.patch" });
    const seen: unknown[] = [];
    const stub: ComputerApiStub = { computerApi: vi.fn(async (_a, _c, op) => (seen.push(op), { status: 200, body: {} })) };
    const person = { kind: "user", organizationId: "org_1", userId: "user_1", role: "member" } as RequestIdentity;
    const scoped = (scopes: string[]) => ({ ...person, apiKey: { id: "key_1", hash: "a".repeat(64), name: "k", kind: "user" as const, expiresAt: null, createdAt: null, scopes } }) as RequestIdentity;
    const go = (identity: RequestIdentity, method: string, body?: string) =>
      routeComputerApi(new Request("https://blue.test/v1/computer/settings", { method, ...(body ? { body } : {}) }), {} as never, identity, "org_1", stub, "/settings");
    expect((await go(scoped([]), "GET")).status).toBe(200);
    expect((await go(scoped(["sessions:read"]), "PATCH", '{"apiAccessDefault":"org"}')).status).toBe(403);
    expect((await go(person, "PATCH", '{"apiAccessDefault":"org"}')).status).toBe(200);
    expect(seen).toEqual([{ op: "settings.get" }, { op: "settings.patch", body: { apiAccessDefault: "org" } }]);
  });
});

describe("session-access.ts", () => {
  const row = (accessMode: string | null, people: string[] = [], originType = "opc") => ({ originType, ownerUserId: OWNER, accessMode, accessPeople: people.length ? JSON.stringify(people) : null });

  it("reads modes, lists and defaults", () => {
    expect(accessOf(row(null))).toEqual({ mode: "owner", people: [] });
    expect(accessOf(row("everyone"))).toEqual({ mode: "owner", people: [] });
    expect(accessOf(row("org"))).toEqual({ mode: "org", people: [] });
    expect(accessOf(row("people", [MO]))).toEqual({ mode: "people", people: [MO] });
    expect(accessOf({ ...row("people"), accessPeople: "not json" })).toEqual({ mode: "people", people: [] });
    expect(membersOf(row("owner"))).toEqual([]);
    expect(membersOf(row(null))).toEqual([]);
    expect(membersOf(row("org"))).toBeNull();
    expect(mayUse(row(null), { member: MO })).toBe(false);
    expect(mayUse(row("org"), { member: MO })).toBe(true);
    expect(membersOf(row(null, [], "slack"))).toEqual([OWNER]);
    expect(mayUse(row("people", [MO]), { member: MO })).toBe(true);
    expect(mayUse(row("owner"), { member: MO })).toBe(false);
    for (const mode of ["owner", "org", "people", null]) {
      expect(mayManage(row(mode, [MO]), { member: MO })).toBe(false);
      expect(mayManage(row(mode, [MO]), { member: OWNER })).toBe(true);
      expect(mayChangeSession(row(mode, [MO]), { member: MO })).toBe(false);
      expect(mayChangeSession(row(mode, [MO]), { member: OWNER })).toBe(true);
    }
    expect(isOwner({ ownerUserId: null }, { member: "" })).toBe(false);
    expect(mayManage(row(null, [], "slack"), { member: OWNER })).toBe(false);
    expect(readApiAccessDefault(undefined)).toBe("owner");
    expect(readApiAccessDefault("org")).toBe("org");
    expect(storedAccess(OWNER, "people", [PAT, MO, OWNER, MO])).toEqual({ mode: "people", people: JSON.stringify([MO, PAT].sort()) });
    expect(storedAccess(OWNER, "org", [MO])).toEqual({ mode: "org", people: null });
  });

  it("validates bodies, naming the field", () => {
    expect(parseAccessInput({ mode: "people", people: [MO] })).toEqual({ value: { mode: "people", people: [MO] } });
    expect(parseAccessInput({ mode: "people", people: Array.from({ length: 51 }, (_, i) => `p${i}@x.com`) })).toMatchObject({ field: "access.people" });
    expect(parseAccessInput({ mode: "x" })).toMatchObject({ field: "access.mode" });
    expect(parseAccessInput({ mode: "org", other: 1 })).toMatchObject({ field: "access.other" });
    expect(parseAccessInput([])).toMatchObject({ field: "access" });
  });
});

describe("a session's own computer key (work 080)", () => {
  const OTHER = "cs_2222222222222222";
  const keyOf = { id: "key_c", hash: "c".repeat(64), name: "computer", kind: "user" as const, scopes: ["sessions:read", "sessions:write"], expiresAt: null, createdAt: null };
  /** Two org-wide sessions, SID and OTHER, and the computer key's caller for `onlySession`. */
  async function computer(onlySession?: string) {
    const f = await session("org");
    await created(f, OTHER, OWNER, { mode: "org" });
    const member = await memberId("computer");
    const c = caller(member, { apiKey: keyOf, ...(onlySession !== undefined ? { onlySession } : {}) });
    return { f, c };
  }
  const ids = async (f: Awaited<ReturnType<typeof computer>>["f"], c: ReturnType<typeof caller>) =>
    ((await f.api.handle(c, { op: "list", query: [["owner", "anyone"]] })).body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id).sort();

  it("HTTP: a computer principal's caller carries its session key, empty when it names none", async () => {
    const seen: unknown[] = [];
    const stub: ComputerApiStub = { computerApi: vi.fn(async (_a, c) => (seen.push(c.onlySession), { status: 200, body: {} })) };
    const base = { kind: "user", organizationId: "org_1", userId: "computer", role: "member", principal: "computer" } as RequestIdentity;
    for (const identity of [{ ...base, sessionKey: "T1:C1:1.2" }, base, { ...base, principal: undefined }]) {
      await routeComputerApi(new Request("https://blue.test/v1/computer/sessions"), {} as never, identity as RequestIdentity, "org_1", stub, "/sessions");
    }
    expect(seen).toEqual(["T1:C1:1.2", "", undefined]);
  });

  it("without the limit its synthetic member would use every org-wide session (the leak this closes)", async () => {
    const { f, c } = await computer();
    expect((await f.api.handle(c, { op: "get", sessionId: OTHER })).status).toBe(200);
    expect(await ids(f, c)).toEqual([SID, OTHER].sort());
  });

  it("naming no session, it reaches none: no get, list, write, ticket or new session", async () => {
    const { f, c } = await computer("");
    expect((await f.api.handle(c, { op: "get", sessionId: SID })).status).toBe(404);
    expect(await ids(f, c)).toEqual([]);
    f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "queued", duplicate: false, seq: 1 } }));
    expect((await f.api.handle(c, { op: "call", sessionId: SID, method: "turns.send", params: { input: "x" } })).status).toBe(404);
    expect(await f.api.handle(c, { op: "create", body: { id: "cs_3333333333333333" } })).toMatchObject({ status: 403, error: { reason: "computer_principal" } });
    expect(f.api.row("cs_3333333333333333")).toBeUndefined();
  });

  it("naming its session, it reaches that one alone, and its wire key is limited to it", async () => {
    const f0 = await computer("");
    const own = f0.f.api.row(SID)!.key;
    const { f, c } = await computer(own);
    expect((await f.api.handle(c, { op: "get", sessionId: SID })).status).toBe(200);
    expect((await f.api.handle(c, { op: "get", sessionId: OTHER })).status).toBe(404);
    expect(await ids(f, c)).toEqual([SID]);
    expect([...f.sql.exec("SELECT session_ids AS ids FROM wire_keys WHERE key_id = 'key_c'")]).toEqual([{ ids: JSON.stringify([SID]) }]);
  });

  it("an owner-only session stays its owner's even for its own key", async () => {
    const f = await session("owner");
    const c = caller(await memberId("computer"), { onlySession: f.api.row(SID)!.key });
    expect((await f.api.handle(c, { op: "get", sessionId: SID })).status).toBe(404);
  });
});

describe("tickets name only sessions the caller may use", () => {
  const key = { id: "key_1", hash: "a".repeat(64), name: "laptop", kind: "user" as const, scopes: ["sessions:read"], expiresAt: null, createdAt: null };

  it("a person: their own and shared sessions; someone else's owner-only one is refused at the mint", async () => {
    const f = fixture({ ticketKey: true });
    for (const c of Object.values(who)) await f.api.handle(c, { op: "me" });
    await created(f, SID, OWNER, { mode: "owner" });
    await created(f, "cs_2222222222222222", OWNER, { mode: "org" });
    await created(f, "cs_3333333333333333", PAT, { mode: "owner" });
    const mint = (c: ReturnType<typeof caller>, sessionIds: string[]) => f.api.handle({ ...c, apiKey: key }, { op: "ticket", body: { sessionIds } });
    expect((await mint(who.owner, [SID, "cs_2222222222222222"])).status).toBe(200);
    expect((await mint(who.other, ["cs_2222222222222222", "cs_3333333333333333"])).status).toBe(200);
    expect(await mint(who.other, [SID])).toMatchObject({ status: 404, error: { code: "session_not_found" } });
    expect(await mint(who.admin, [SID])).toMatchObject({ status: 404 });
    expect(await mint(who.owner, ["cs_3333333333333333"])).toMatchObject({ status: 404 });
    expect(await mint(who.owner, ["cs_9999999999999999"])).toMatchObject({ status: 404 });
  });

  it("a session's own key: its session only, named or not; none without one", async () => {
    const f = await session("org", { ticketKey: true });
    await created(f, "cs_2222222222222222", OWNER, { mode: "org" });
    const computerKey = { ...key, id: "key_c", hash: "c".repeat(64) };
    const member = await memberId("computer");
    const c = caller(member, { apiKey: computerKey, onlySession: f.api.row(SID)!.key });
    expect((await f.api.handle(c, { op: "ticket", body: {} })).status).toBe(200);
    expect((await f.api.handle(c, { op: "ticket", body: { sessionIds: [SID] } })).status).toBe(200);
    expect((await f.api.handle(c, { op: "ticket", body: { sessionIds: ["cs_2222222222222222"] } })).status).toBe(404);
    expect((await f.api.handle({ ...c, onlySession: "" }, { op: "ticket", body: {} })).status).toBe(404);
  });
});
