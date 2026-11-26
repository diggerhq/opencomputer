// The HTTP API of tracks and threads (spec 37), slice 1: the principal, the session directory
// through Org, the four writes through the inbox (200 delivered, 202 waking) and the session reads
// with cursors. The actors are fakes behind fake namespaces.

import { describe, expect, it, vi } from "vitest";

import type { Principal } from "../src/actor/principal.js";
import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { principalClaim } from "../src/edge/computer-principal.js";

const ORG = "org_1";
const USER = "user_01JABCDEFGHJKMNPQRSTVWXYZ0";
const MEMBER = "usr_01jabcdefghjkmnpqrstvwxyz0";
const SID = "cs_0123456789abcdef";
const OTHER = "cs_fedcba9876543210";

const memberP: Principal = {
  org: ORG, subject: MEMBER, kind: "member", via: "dashboard",
  scopes: ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"],
  audiences: ["org", `member:${MEMBER}`], admin: false, credential: { id: `login:${USER}`, expiresAt: null },
};
const member = { kind: "user", userId: USER, accountId: ORG, organizationId: ORG, ocPrincipal: memberP } as RequestIdentity;
const key = (scopes: string[]) =>
  ({
    ...member,
    apiKey: { id: "key_1", hash: "a".repeat(64), name: "k", kind: "user", scopes, expiresAt: "2030-01-01T00:00:00.000Z", createdAt: null },
    ocPrincipal: { ...memberP, kind: "key", via: "api", scopes: scopes as Principal["scopes"], credential: { id: "key_1", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") } },
  }) as RequestIdentity;
const agent = {
  ...member,
  apiKey: { id: "key_2", hash: "b".repeat(64), name: "s", kind: "user", scopes: ["sessions:read", "sessions:write"], expiresAt: null, createdAt: null },
  ocPrincipal: {
    org: ORG, subject: OTHER, kind: "agent", via: "agent", session: OTHER,
    scopes: ["sessions:read", "sessions:write", "work:read", "work:write"], audiences: [], admin: false,
    credential: { id: "key_2", expiresAt: null },
  },
} as RequestIdentity;

const ns = (make: (name: string) => unknown) => ({ getByName: vi.fn((name: string) => make(name)) });
const row = (id = SID) => ({ id, title: "t", lastSeq: 3, status: "idle", settings: { model: null, effort: null, mode: "default", speed: null }, asks: [], queued: [], subagents: [] });

interface Fakes {
  org?: Record<string, unknown>;
  log?: Record<string, unknown>;
  computer?: Record<string, unknown>;
}

function setup(f: Fakes) {
  const env = {
    ORGS: ns(() => f.org ?? {}),
    SESSION_LOG: ns(() => f.log ?? {}),
    COMPUTERS: ns(() => f.computer ?? {}),
  };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; identity?: RequestIdentity } = {}) => {
    const url = new URL(`https://blue.test/v1/computer${path}`);
    const res = await routeComputerApi(
      new Request(url, {
        method,
        headers: { "content-type": "application/json", ...opts.headers },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      env as never,
      opts.identity ?? member,
      ORG,
      stub,
      url.pathname.slice("/v1/computer".length),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { env, call, stub };
}

const delivered = (result: unknown) => ({ drain: vi.fn(async (_sid: string, _o: unknown) => ({ state: "delivered", results: [{ id: "*", result }] })) });

/** A log whose accept echoes the entry's id, and a computer that delivers it with `result`. */
function inbox(result: unknown = { turn: { id: "tn" }, delivery: "started", seq: 4 }, state: "delivered" | "waking" = "delivered") {
  const entries: { p: Principal; entry: { id: string; kind: string; body: unknown; trace?: string } }[] = [];
  const log = {
    accept: vi.fn(async (p: Principal, entry: { id: string; kind: string; body: unknown; trace?: string }) => {
      entries.push({ p, entry });
      return { ok: true, id: entry.id, duplicate: false, machine: ORG };
    }),
    entry: vi.fn(async (_id: string): Promise<unknown> => ({ state: "waiting" })),
  };
  const computer = {
    drain: vi.fn(async () => (state === "waking" ? { state } : { state, results: [{ id: entries.at(-1)!.entry.id, result }] })),
  };
  return { log, computer, entries };
}

/**
 * The machine is up and the SessionLog's own drain (started by `accept`) delivers the entry before the
 * edge's: the edge's drain finds nothing waiting. The host's turn carries the `turnId` it was sent, the entry's id.
 */
function ownDrain() {
  const entries: { id: string; kind: string; body: unknown }[] = [];
  const outcomes = new Map<string, unknown>();
  const log = {
    accept: vi.fn(async (_p: Principal, entry: { id: string; kind: string; body: unknown }) => {
      entries.push(entry);
      outcomes.set(entry.id, { state: "delivered", result: { turn: { id: entry.id, status: "running" }, delivery: "started", duplicate: false, seq: 5 } });
      return { ok: true, id: entry.id, duplicate: false, machine: ORG };
    }),
    entry: vi.fn(async (id: string) => outcomes.get(id) ?? null),
  };
  const computer = { drain: vi.fn(async () => ({ state: "delivered", results: [] })) };
  return { log, computer, entries, outcomes };
}

describe("one turn id, and the result to the caller that accepted the entry (spec 37.2, 40.2)", () => {
  const org = { createSession: vi.fn(async () => ({ ok: true, session: row(), place: null, duplicate: false })) };

  it("POST /sessions with input, the machine up, the log's own drain first: 201 with the host's turn, its id the entry's", async () => {
    const up = ownDrain();
    const { call } = setup({ org, ...up });
    const r = await call("POST", "/sessions", { body: { id: SID, input: "hello" } });
    const id = up.entries[0]!.id;
    expect(id).toMatch(/^tn_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(r).toEqual({ status: 201, body: { session: row(), turn: { id, status: "running" }, delivery: "started", duplicate: false, seq: 5 } });
    expect(up.log.entry).toHaveBeenCalledWith(id);
  });

  it("POST /sessions/{id}/turns, the machine up, the log's own drain first: 200 with SendResult, its turn's id the entry's", async () => {
    const up = ownDrain();
    const { call } = setup(up);
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { input: "go on" } });
    const id = up.entries[0]!.id;
    expect(r).toEqual({ status: 200, body: { turn: { id, status: "running" }, delivery: "started", duplicate: false, seq: 5 } });
    // Refused by whichever drain took it: the error, not 202.
    up.log.accept.mockImplementationOnce(async (_p, entry) => {
      up.outcomes.set(entry.id, { state: "refused", error: { code: "queue_full", message: "full" } });
      return { ok: true, id: entry.id, duplicate: false, machine: ORG };
    });
    expect(await call("POST", `/sessions/${SID}/turns`, { body: { input: "more" } })).toMatchObject({ status: 429, body: { error: { code: "queue_full" } } });
    // The host's own status and fields, as the inbox kept them.
    up.log.accept.mockImplementationOnce(async (_p, entry) => {
      up.outcomes.set(entry.id, { state: "refused", error: { code: "session_busy", message: "a turn is running", status: 409, feature: "x" } });
      return { ok: true, id: entry.id, duplicate: false, machine: ORG };
    });
    expect(await call("POST", `/sessions/${SID}/turns`, { body: { input: "busy" } })).toMatchObject({ status: 409, body: { error: { code: "session_busy", feature: "x" } } });
    // Still waiting behind a drain that answered: 202 with the entry's id.
    up.log.accept.mockImplementationOnce(async (_p, entry) => ({ ok: true, id: entry.id, duplicate: false, machine: ORG }));
    up.log.entry.mockImplementationOnce(async () => ({ state: "waiting" }));
    const waits = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_zzzzzzzzzzzz", input: "later" } });
    expect(waits).toEqual({ status: 202, body: { accepted: true, id: "tn_zzzzzzzzzzzz" } });
  });

  it("a caller's turnId is the entry's id and the turn's, on a create and on a turn (as `turnId` or `id`)", async () => {
    const up = ownDrain();
    const { call } = setup({ org, ...up });
    const created = await call("POST", "/sessions", { body: { id: SID, input: "hello", turnId: "tn_0123456789ab" } });
    expect(created.body.turn).toEqual({ id: "tn_0123456789ab", status: "running" });
    const byTurnId = await call("POST", `/sessions/${SID}/turns`, { body: { input: "go", turnId: "tn_abcdefghjkmn" } });
    expect(byTurnId).toMatchObject({ status: 200, body: { turn: { id: "tn_abcdefghjkmn" } } });
    const byId = await call("POST", `/sessions/${SID}/turns`, { body: { input: "go", id: "tn_bcdefghjkmnp" } });
    expect(byId).toMatchObject({ status: 200, body: { turn: { id: "tn_bcdefghjkmnp" } } });
    expect(up.entries.map((e) => [e.id, e.body])).toEqual([
      ["tn_0123456789ab", { input: "hello", ifBusy: "queue" }],
      ["tn_abcdefghjkmn", { input: "go" }],
      ["tn_bcdefghjkmnp", { input: "go" }],
    ]);
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "go", turnId: "turn-1" } })).body.error).toMatchObject({ code: "invalid_request", field: "turnId" });
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "go", id: "tn_bcdefghjkmnp", turnId: "tn_abcdefghjkmn" } })).status).toBe(400);
  });
});

describe("the principal (spec 34.3)", () => {
  it("is the assertion's oc_principal; a request without one is refused", async () => {
    const { call, stub } = setup({});
    const { ocPrincipal: _, ...bare } = member;
    expect(await call("GET", "/sessions", { identity: bare as RequestIdentity })).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    expect(await call("POST", `/sessions/${SID}/compact`, { identity: bare as RequestIdentity, body: {} })).toMatchObject({ status: 401 });
    expect(stub.computerApi).not.toHaveBeenCalled();
  });

  it("is the edge's oc_principal claim when the assertion has one; a bad or foreign claim is refused", async () => {
    const claim = { org: ORG, subject: MEMBER, kind: "member", via: "app", scopes: ["sessions:read", "nope"], audiences: ["org"], admin: false, credential: { id: "c", expiresAt: 5 } };
    const p = principalClaim(claim, ORG)!;
    expect(p).toEqual({ ...claim, scopes: ["sessions:read"] });
    expect(principalClaim(undefined, ORG)).toBeUndefined();
    expect(principalClaim({ ...claim, org: "org_2" }, ORG)).toBeNull();
    expect(principalClaim({ ...claim, kind: "platform" }, ORG)).toBeNull();
    expect(principalClaim({ ...claim, credential: { id: "c", expiresAt: "soon" } }, ORG)).toBeNull();
  });

  it("x-oc-principal must name the credential's principal", async () => {
    const org = { listSessions: vi.fn(async () => ({ ok: true, sessions: [], nextCursor: null })) };
    const { call } = setup({ org });
    expect((await call("GET", "/sessions", { headers: { "x-oc-principal": `${ORG}/${MEMBER}` } })).status).toBe(200);
    const bad = await call("GET", "/sessions", { headers: { "x-oc-principal": `${ORG}/usr_someoneelse` } });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toMatchObject({ code: "principal_mismatch" });
    expect(org.listSessions).toHaveBeenCalledTimes(1);
  });

  it("scopes are checked per route", async () => {
    const { call } = setup({});
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { input: "hi" }, identity: key(["sessions:read"]) });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: "forbidden", reason: "missing_scope", scope: "sessions:write" });
    const a = await call("POST", `/sessions/${SID}/asks/ak_0123456789ab/answer`, { body: { decision: "allow" }, identity: key(["sessions:write"]) });
    expect(a.body.error).toMatchObject({ scope: "asks:answer" });
  });
});

describe("the session directory through Org", () => {
  it("GET /sessions passes the query and the principal; answers Org's page", async () => {
    const org = { listSessions: vi.fn(async () => ({ ok: true, sessions: [row()], nextCursor: "p1.x" })) };
    const { call } = setup({ org });
    const r = await call("GET", "/sessions?status=idle,running&archived=false&limit=5&slackThread=https%3A%2F%2Fx.slack.com%2Farchives%2FC1%2Fp1");
    expect(r).toEqual({ status: 200, body: { sessions: [row()], nextCursor: "p1.x" } });
    expect(org.listSessions).toHaveBeenCalledWith(expect.objectContaining({ subject: MEMBER, kind: "member" }), {
      status: ["idle", "running"], archived: false, limit: 5, slackThread: "https://x.slack.com/archives/C1/p1",
    });
    expect((await call("GET", "/sessions?limit=0")).status).toBe(400);
  });

  it("GET /sessions/{id} lays the log's newer summary over Org's row; Org's not_found is 404", async () => {
    const org = { getSession: vi.fn(async (_p: Principal, id: string) => (id === SID ? { ok: true, session: row() } : { ok: false, code: "not_found" })) };
    const log = { summary: vi.fn(async () => ({ ok: true, summary: { lastSeq: 9, status: "running", activeTurnId: "tn_x", queued: [], asks: [], subagents: [], lastTurn: null, lastText: "hey", context: { usedTokens: 1, windowTokens: 2 }, lastActiveAt: null, syncedAt: null, settings: null } })) };
    const { call } = setup({ org, log });
    const r = await call("GET", `/sessions/${SID}?minSeq=9`);
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ id: SID, title: "t", lastSeq: 9, status: "running", activeTurnId: "tn_x", lastText: "hey" });
    expect(log.summary).toHaveBeenCalledWith(9, expect.objectContaining({ subject: MEMBER }));
    const missing = await call("GET", `/sessions/${OTHER}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });

  it("POST /sessions without input: Org creates; 201, a duplicate 200; a refusal is its status", async () => {
    let duplicate = false;
    const org = { createSession: vi.fn(async () => ({ ok: true, session: row(), place: null, duplicate })) };
    const { call } = setup({ org });
    const r = await call("POST", "/sessions", { body: { id: SID, title: "x", trackId: "trk_0123456789abcdef" } });
    expect(r).toEqual({ status: 201, body: { session: row(), turn: null, delivery: null, duplicate: false, seq: 3 } });
    expect(org.createSession).toHaveBeenCalledWith(expect.objectContaining({ kind: "member" }), { id: SID, title: "x", trackId: "trk_0123456789abcdef", person: { name: null, email: null } });
    duplicate = true;
    expect((await call("POST", "/sessions", { body: { id: SID } })).status).toBe(200);
    org.createSession.mockResolvedValueOnce({ ok: false, code: "taken" } as never);
    const taken = await call("POST", "/sessions", { body: { id: SID } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("taken");
    expect((await call("POST", "/sessions", { body: { parent: OTHER } })).status).toBe(400);
  });

  it("POST /sessions: Session.owner's name and email are the credential's; a body cannot name them", async () => {
    const org = { createSession: vi.fn(async () => ({ ok: true, session: row(), place: null, duplicate: false })) };
    const { call } = setup({ org });
    const named = { ...member, userName: "Ada Lovelace", userEmail: "ada@example.com" } as RequestIdentity;
    expect((await call("POST", "/sessions", { body: { id: SID, person: { name: "Mallory", email: null } }, identity: named })).status).toBe(400);
    await call("POST", "/sessions", { body: { id: SID }, identity: named });
    expect(org.createSession).toHaveBeenCalledWith(expect.anything(), { id: SID, person: { name: "Ada Lovelace", email: "ada@example.com" } });
  });

  it("POST /sessions from an agent: parent is the caller's own session; role is a member's only", async () => {
    const org = { createSession: vi.fn(async () => ({ ok: true, session: row(), place: null, duplicate: false })) };
    const { call } = setup({ org });
    await call("POST", "/sessions", { body: { title: "child" }, identity: agent });
    expect(org.createSession).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), { title: "child", parent: OTHER });
    const role = await call("POST", "/sessions", { body: { role: "start" }, identity: agent });
    expect(role.status).toBe(403);
    await call("POST", "/sessions", { body: { role: "start" } });
    expect(org.createSession).toHaveBeenLastCalledWith(expect.anything(), { role: "start", person: { name: null, email: null } });
  });

  it("POST /sessions with input sends the turn through the inbox: delivered 201, waking 202", async () => {
    const org = { createSession: vi.fn(async () => ({ ok: true, session: row(), place: null, duplicate: false })) };
    const up = inbox({ turn: { id: "tn_0123456789ab" }, delivery: "started", seq: 4 });
    const { call } = setup({ org, ...up });
    const r = await call("POST", "/sessions", { body: { id: SID, input: "hello", turnId: "tn_0123456789ab" }, headers: { "x-oc-trace": "tr_0123456789abcdef" } });
    expect(r).toEqual({ status: 201, body: { session: row(), turn: { id: "tn_0123456789ab" }, delivery: "started", duplicate: false, seq: 4 } });
    expect(org.createSession).toHaveBeenCalledWith(expect.anything(), { id: SID, input: "hello", person: { name: null, email: null } });
    expect(up.entries[0]!.entry).toEqual({ id: "tn_0123456789ab", kind: "turn", body: { input: "hello", ifBusy: "queue" }, trace: "tr_0123456789abcdef" });
    expect(up.computer.drain).toHaveBeenCalledWith(SID, { wait: true });

    const down = inbox(undefined, "waking");
    const w = setup({ org, ...down });
    const r2 = await w.call("POST", "/sessions", { body: { id: SID, input: "hello" } });
    expect(r2.status).toBe(202);
    expect(r2.body).toEqual({ accepted: true, id: down.entries[0]!.entry.id, session: row() });
    // No turnId: derived from the session, so a retried create is the same turn.
    await w.call("POST", "/sessions", { body: { id: SID, input: "hello" } });
    expect(down.entries[1]!.entry.id).toBe(down.entries[0]!.entry.id);
    expect(down.entries[0]!.entry.id).toMatch(/^tn_[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it("POST /sessions with an Idempotency-Key and no id: the id is the key's hash", async () => {
    const org = { createSession: vi.fn(async (_p: Principal, body: { id?: string }) => ({ ok: true, session: row(body.id), place: null, duplicate: false })) };
    const { call } = setup({ org });
    await call("POST", "/sessions", { body: {}, headers: { "idempotency-key": "k1" } });
    await call("POST", "/sessions", { body: {}, headers: { "idempotency-key": "k1" } });
    await call("POST", "/sessions", { body: {}, headers: { "idempotency-key": "k2" } });
    const ids = org.createSession.mock.calls.map((c) => c[1].id);
    expect(ids[0]).toMatch(/^cs_[0-9a-hjkmnp-tv-z]{16}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});

describe("the writes through the inbox (spec 37.2, 40.2)", () => {
  it("a turn delivered is 200 with the host's result; waking is 202 { accepted, id }", async () => {
    const up = inbox({ turn: { id: "tn_0123456789ab", status: "running" }, delivery: "started", seq: 7 });
    const { call } = setup(up);
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_0123456789ab", input: "go", ifBusy: "steer" } });
    expect(r).toEqual({ status: 200, body: { turn: { id: "tn_0123456789ab", status: "running" }, delivery: "started", seq: 7 } });
    expect(up.entries[0]!.entry).toEqual({ id: "tn_0123456789ab", kind: "turn", body: { input: "go", ifBusy: "steer" } });
    expect(up.entries[0]!.p).toMatchObject({ subject: MEMBER });

    const down = inbox(undefined, "waking");
    const w = setup(down);
    const r2 = await w.call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } });
    expect(r2.status).toBe(202);
    expect(r2.body).toEqual({ accepted: true, id: down.entries[0]!.entry.id });
    expect(r2.body.id).toMatch(/^tn_[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it("an Idempotency-Key without id is hashed into the turn id: a retry lands on the same entry", async () => {
    const down = inbox(undefined, "waking");
    const { call } = setup(down);
    const send = (k: string, identity?: RequestIdentity) => call("POST", `/sessions/${SID}/turns`, { body: { input: "go" }, headers: { "idempotency-key": k }, ...(identity ? { identity } : {}) });
    const a = (await send("retry-1")).body.id;
    const b = (await send("retry-1")).body.id;
    const c = (await send("retry-2")).body.id;
    const d = (await send("retry-1", agent)).body.id;
    expect(a).toMatch(/^tn_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    // Without a key, every send is a new turn.
    const e = (await call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } })).body.id;
    const f = (await call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } })).body.id;
    expect(e).not.toBe(f);
  });

  it("a repeat already delivered answers the stored result without draining", async () => {
    const log = { accept: vi.fn(async () => ({ ok: true, id: "tn_0123456789ab", duplicate: true, machine: ORG, result: { delivery: "queued" } })) };
    const computer = { drain: vi.fn() };
    const { call } = setup({ log, computer });
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_0123456789ab", input: "go" } });
    expect(r).toEqual({ status: 200, body: { delivery: "queued" } });
    expect(computer.drain).not.toHaveBeenCalled();
  });

  it("drains the machine accept names", async () => {
    const log = { accept: vi.fn(async () => ({ ok: true, id: "tn_0123456789ab", duplicate: false, machine: "mc_0123456789abcdef" })), entry: vi.fn(async () => null) };
    const computer = delivered({ ok: 1 });
    const { call, env } = setup({ log, computer });
    await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_0123456789ab", input: "go" } });
    expect(env.COMPUTERS.getByName).toHaveBeenCalledWith("mc_0123456789abcdef");
  });

  it("refusals: accept's codes and the host's error are HTTP errors", async () => {
    const log = { accept: vi.fn(async () => ({ ok: false, code: "not_found" })) };
    const { call } = setup({ log });
    const nf = await call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } });
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("not_found");
    log.accept.mockResolvedValueOnce({ ok: false, code: "forbidden" });
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } })).body.error.code).toBe("not_found");
    log.accept.mockResolvedValueOnce({ ok: false, code: "idempotency_conflict" });
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } })).status).toBe(409);
    log.accept.mockResolvedValueOnce({ ok: false, code: "inbox_full" });
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } })).status).toBe(429);

    const host = inbox();
    host.computer.drain = vi.fn(async () => ({ state: "delivered", results: [{ id: host.entries.at(-1)!.entry.id, error: { code: "queue_full", message: "full", requestId: "x", retryable: true, status: 429 } }] })) as never;
    const h = setup(host);
    const r = await h.call("POST", `/sessions/${SID}/turns`, { body: { input: "go" } });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ code: "queue_full", message: "full" });
    host.computer.drain = vi.fn(async () => ({ state: "delivered", results: [{ id: host.entries.at(-1)!.entry.id, error: { code: "ask_closed", message: "closed", requestId: "x", retryable: false } }] })) as never;
    expect((await h.call("POST", `/sessions/${SID}/asks/ak_0123456789ab/answer`, { body: { decision: "allow" } })).status).toBe(409);
  });

  it("validates the body before the inbox", async () => {
    const up = inbox();
    const { call } = setup(up);
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "" } })).status).toBe(400);
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "x", id: "tn_bad" } })).body.error.field).toBe("id");
    expect((await call("POST", `/sessions/${SID}/turns`, { body: { input: "x", other: 1 } })).body.error.field).toBe("other");
    expect((await call("POST", `/sessions/cs_bad/turns`, { body: { input: "x" } })).status).toBe(404);
    expect(up.log.accept).not.toHaveBeenCalled();
  });

  it("answer, dismiss and interrupt are entries of their kind", async () => {
    const up = inbox({ ask: { id: "ak_0123456789ab", status: "answered" } });
    const { call } = setup(up);
    const a = await call("POST", `/sessions/${SID}/asks/ak_0123456789ab/answer`, { body: { decision: "allow" }, headers: { "idempotency-key": "a1" } });
    expect(a).toEqual({ status: 200, body: { ask: { id: "ak_0123456789ab", status: "answered" } } });
    await call("POST", `/sessions/${SID}/asks/ak_0123456789ab/dismiss`, { body: { message: "no" } });
    await call("POST", `/sessions/${SID}/interrupt`, { body: {} });
    expect(up.entries.map((e) => [e.entry.kind, e.entry.body])).toEqual([
      ["answer", { askId: "ak_0123456789ab", answer: { decision: "allow" } }],
      ["dismiss", { askId: "ak_0123456789ab", message: "no" }],
      ["interrupt", {}],
    ]);
    expect(up.entries[0]!.entry.id).toMatch(/^ie_[0-9a-hjkmnp-tv-z]{16}$/);
    const again = inbox(undefined, "waking");
    const w = setup(again);
    const first = await w.call("POST", `/sessions/${SID}/asks/ak_0123456789ab/answer`, { body: { decision: "allow" }, headers: { "idempotency-key": "a1" } });
    expect(first).toEqual({ status: 202, body: { accepted: true, id: up.entries[0]!.entry.id } });
  });
});

describe("the session reads (spec 37.1)", () => {
  const event = (seq: number) => ({ id: `ev_${seq}`, seq, createdAt: new Date().toISOString() });

  it("events: after is an opaque cursor passed through with the principal; the answer carries cursor", async () => {
    const log = { events: vi.fn(async () => ({ ok: true, events: [event(5)], lastSeq: 5, cursor: "e1.2.5" })) };
    const { call } = setup({ log });
    const r = await call("GET", `/sessions/${SID}/events?after=e1.2.4&limit=10`);
    expect(r).toEqual({ status: 200, body: { events: [event(5)].map((e) => ({ ...e, createdAt: expect.any(String) })), lastSeq: 5, cursor: "e1.2.5" } });
    expect(log.events).toHaveBeenCalledWith({ after: "e1.2.4", limit: 10 }, expect.objectContaining({ subject: MEMBER }));
  });

  it("events: a bare seq or an unreadable cursor is 409 reset with cursor null; the log's reset carries cursor and seq", async () => {
    const log = { events: vi.fn(async () => ({ ok: false, error: "reset", cursor: "e1.3.99", seq: 99 })) };
    const { call } = setup({ log });
    const bare = await call("GET", `/sessions/${SID}/events?after=12`);
    expect(bare.status).toBe(409);
    expect(bare.body.error).toMatchObject({ code: "reset", cursor: null });
    expect(log.events).not.toHaveBeenCalled();
    const reset = await call("GET", `/sessions/${SID}/events?after=e1.2.120`);
    expect(reset.status).toBe(409);
    expect(reset.body.error).toMatchObject({ code: "reset", cursor: "e1.3.99", seq: 99 });
  });

  it("events: a session the caller may not read is not_found", async () => {
    const log = { events: vi.fn(async () => ({ ok: false, error: "forbidden" })) };
    const { call } = setup({ log });
    const r = await call("GET", `/sessions/${SID}/events`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });

  it("reads answer at once: no long-poll, and minSeq not reached is 503 with retryAfterMs", async () => {
    const log = {
      events: vi.fn(async () => ({ ok: true, events: [], lastSeq: 4, cursor: "e1.2.4" })),
      summary: vi.fn(async () => ({ ok: false, error: "unavailable", lastSeq: 4, retryAfterMs: 500 })),
    };
    const org = { getSession: vi.fn(async () => ({ ok: true, session: row() })) };
    const { call } = setup({ log, org });
    const r = await call("GET", `/sessions/${SID}/events?after=e1.2.4&waitMs=20000`);
    expect(r.body).toEqual({ events: [], lastSeq: 4, cursor: "e1.2.4" });
    expect(log.events).toHaveBeenCalledTimes(1);
    const behind = await call("GET", `/sessions/${SID}?minSeq=9`);
    expect(behind.status).toBe(503);
    expect(behind.body.error).toMatchObject({ code: "unavailable", retryAfterMs: 500 });
    expect(log.summary).toHaveBeenCalledTimes(1);
  });

  it("turns, asks and subagents read the log as the principal", async () => {
    const p = expect.objectContaining({ subject: MEMBER });
    const log = {
      turns: vi.fn(async () => ({ ok: true, turns: [], nextCursor: null, lastSeq: 1 })),
      turn: vi.fn(async () => ({ ok: true, turn: { id: "tn_0123456789ab" } })),
      asks: vi.fn(async () => ({ ok: true, asks: [], nextCursor: null, lastSeq: 1 })),
      ask: vi.fn(async () => ({ ok: false, error: "ask_not_found" })),
      subagents: vi.fn(async () => ({ ok: true, subagents: [], nextCursor: null, lastSeq: 1 })),
      subagent: vi.fn(async () => ({ ok: true, subagent: { id: "sa_0123" } })),
    };
    const { call } = setup({ log });
    expect((await call("GET", `/sessions/${SID}/turns?limit=2`)).body).toEqual({ turns: [], nextCursor: null, lastSeq: 1 });
    expect(log.turns).toHaveBeenCalledWith({ limit: 2 }, p);
    expect((await call("GET", `/sessions/${SID}/turns/tn_0123456789ab`)).body).toEqual({ turn: { id: "tn_0123456789ab" } });
    expect(log.turn).toHaveBeenCalledWith("tn_0123456789ab", {}, p);
    await call("GET", `/sessions/${SID}/asks`);
    expect(log.asks).toHaveBeenCalledWith({ status: "open" }, p);
    expect((await call("GET", `/sessions/${SID}/asks/ak_0123456789ab`)).status).toBe(404);
    expect(log.ask).toHaveBeenCalledWith("ak_0123456789ab", undefined, p);
    await call("GET", `/sessions/${SID}/subagents?status=all`);
    expect(log.subagents).toHaveBeenCalledWith({ status: "all" }, p);
    expect((await call("GET", `/sessions/${SID}/subagents/sa_0123?minSeq=3`)).body).toEqual({ subagent: { id: "sa_0123" } });
    expect(log.subagent).toHaveBeenCalledWith("sa_0123", 3, p);
  });
});
