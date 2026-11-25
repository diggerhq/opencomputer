import { describe, expect, it, vi } from "vitest";

import { type ComputerApiStub, matchApiRoute, routeComputerApi } from "../src/computer/api-http.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { accessOf, mayManage, mayUse, membersOf, parseAccessInput, readApiAccessDefault, storedAccess } from "../src/computer/session-access.js";
import { caller, created, fixture, MO, OWNER, SID } from "./fixtures/computer-sessions-api.js";

/**
 * CTO-37: who may use and manage a session started from the dashboard, opc or the API.
 * owner | org | people, against the owner, a listed person, someone else and an admin outside it.
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
async function session(mode: Mode) {
  const f = fixture();
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
// Whether each may change its access.
const MANAGES: Record<Mode, Record<Who, boolean>> = {
  owner: { owner: true, listed: false, other: false, admin: true },
  org: { owner: true, listed: false, other: false, admin: true },
  people: { owner: true, listed: true, other: false, admin: true },
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
        else expect(patch).toMatchObject(uses ? { status: 403, error: { code: "forbidden", reason: "not_member" } } : { status: 404, error: { code: "session_not_found" } });
        expect(f.api.row(SID)!.accessMode).toBe(manages ? "people" : mode);
      });
    }
  }
});

describe("admins (Q4)", () => {
  it("change an owner-only session's access without seeing it, then get in only by adding themselves", async () => {
    const f = await session("owner");
    const admin = who.admin;
    // Nothing but access: any other field is as if the session did not exist.
    expect(await f.api.handle(admin, { op: "patch", sessionId: SID, body: { title: "Mine", access: { mode: "people", people: [MO] } } })).toMatchObject({ status: 404 });
    expect(f.api.row(SID)!.accessMode).toBe("owner");
    const shared = await f.api.handle(admin, { op: "patch", sessionId: SID, body: { access: { mode: "people", people: [MO] } } });
    expect(shared).toEqual({ status: 200, body: { session: null, access: { mode: "people", people: [MO] }, canManageAccess: true, seq: 0 } });
    expect((await f.api.handle(admin, { op: "get", sessionId: SID })).status).toBe(404);
    expect(await listed(f, admin)).toEqual([]);
    const added = await f.api.handle(admin, { op: "patch", sessionId: SID, body: { access: { mode: "people", people: [MO, ADMIN] } } });
    expect(added).toMatchObject({ status: 200, body: { session: { id: SID, access: { mode: "people", people: [ADMIN, MO].sort() }, canManageAccess: true } } });
    expect((await f.api.handle(admin, { op: "get", sessionId: SID })).status).toBe(200);
  });

  it("a non-admin's admin flag from the body counts for nothing: the caller's role decides", async () => {
    const f = await session("owner");
    expect((await f.api.handle(caller(ADMIN, { admin: false }), { op: "patch", sessionId: SID, body: { access: { mode: "org" } } })).status).toBe(404);
  });
});

describe("invited people (Q7)", () => {
  it("change the access and the model like the owner", async () => {
    const f = await session("people");
    const mo = who.listed;
    f.answers.set("sessions.update", () => ({ result: { session: {}, seq: 1 } }));
    const model = await f.api.handle(mo, { op: "patch", sessionId: SID, body: { model: "claude-opus-5-5" } });
    expect(model).toMatchObject({ status: 200 });
    expect(f.frames("api").at(-1)).toMatchObject({ method: "sessions.update", member: MO });
    const opened = await f.api.handle(mo, { op: "patch", sessionId: SID, body: { access: { mode: "org" } } });
    expect(opened).toMatchObject({ status: 200, body: { session: { access: { mode: "org", people: [] }, canManageAccess: false } } });
    // In an org-wide session a member is no manager any more.
    expect(await f.api.handle(mo, { op: "patch", sessionId: SID, body: { access: { mode: "owner" } } })).toMatchObject({ status: 403, error: { reason: "not_member" } });
  });

  it("removing themselves locks them out", async () => {
    const f = await session("people");
    expect((await f.api.handle(who.listed, { op: "patch", sessionId: SID, body: { access: { mode: "owner" } } })).body).toMatchObject({ session: null, canManageAccess: false });
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
    expect(f.frames("access").map((a) => a.access)).toEqual([{ sessionId: SID, owner: OWNER, members: [MO], admins: [ADMIN] }]);
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

  it("a session from before access modes (access_mode NULL) stays org-wide", async () => {
    const f = await session("owner");
    f.sql.exec("UPDATE sessions SET access_mode = NULL, access_people = NULL WHERE session_id = ?", SID);
    expect(await f.api.handle(who.other, { op: "get", sessionId: SID })).toMatchObject({ status: 200, body: { session: { access: { mode: "org", people: [] } } } });
    f.sent.length = 0;
    f.api.onHello();
    expect(f.frames("access")[0]!.access.members).toBeNull();
  });

  it("a Slack session's access is set in its thread, never over the API", async () => {
    const f = fixture();
    f.slackRow("T1:C1:1.2");
    f.state.links.set("U1", "user_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const slackId = (await f.api.slackDelivery("T1:C1:1.2", "U1"))!.sessionId;
    expect(await f.api.handle(who.owner, { op: "get", sessionId: slackId })).toMatchObject({ body: { session: { access: { mode: "owner", people: [] }, canManageAccess: false } } });
    expect(await f.api.handle(who.owner, { op: "patch", sessionId: slackId, body: { access: { mode: "org" } } })).toMatchObject({ status: 403, error: { reason: "access_in_slack" } });
    expect((await f.api.handle(who.admin, { op: "patch", sessionId: slackId, body: { access: { mode: "org" } } })).status).toBe(404);
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
    expect(accessOf(row(null))).toEqual({ mode: "org", people: [] });
    expect(accessOf(row("people", [MO]))).toEqual({ mode: "people", people: [MO] });
    expect(accessOf({ ...row("people"), accessPeople: "not json" })).toEqual({ mode: "people", people: [] });
    expect(membersOf(row("owner"))).toEqual([]);
    expect(membersOf(row(null))).toBeNull();
    expect(membersOf(row(null, [], "slack"))).toEqual([OWNER]);
    expect(mayUse(row("people", [MO]), { member: MO })).toBe(true);
    expect(mayUse(row("owner"), { member: MO, admin: true })).toBe(false);
    expect(mayManage(row("owner"), { member: MO, admin: true })).toBe(true);
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
