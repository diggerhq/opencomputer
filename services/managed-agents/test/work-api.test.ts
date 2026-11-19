import { describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import type { Session } from "../src/computer/api-types.js";
import type { ApiCaller, ApiRow } from "../src/computer/sessions-api.js";
import { branchName, itemAttention } from "../src/computer/work/api.js";
import { type SessionBrief, type WorkContextOp, workContext, workStamp, workStampSetup } from "../src/computer/work/briefs.js";
import type { TokenMinter } from "../src/computer/work/github.js";
import { REQUEST_TIMEOUT_MS } from "../src/computer/work/github.js";
import { READ_WAIT_MS, WorkIndex } from "../src/computer/work/index.js";
import type { WorkIndexRpc } from "../src/computer/work/index-contract.js";
import { memberId } from "../src/computer/session-ids.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { sqlStorage } from "./fixtures/computer-sql.js";
import { FakeRepo } from "./fixtures/fake-github-repo.js";
import { FakeClock, indexStore } from "./fixtures/work-platform.js";

/** Work tracking 3.10: the Work API's routes, scopes and composition in the Worker. */

const ORG = "acct_1";
const ME = await memberId("user_me");
const BO = await memberId("user_bo");
const SID = { mine: "cs_0000000000000001", bos: "cs_0000000000000002", slack: "cs_0000000000000003", private: "cs_0000000000000004", idle: "cs_0000000000000005" };

const person = { kind: "user", accountId: ORG, organizationId: ORG, userId: "user_me", role: "member", userName: "Me", userEmail: "Me@Acme.test" } as RequestIdentity;
const key = { id: "key_1", hash: "a".repeat(64), name: "laptop", kind: "user" as const, expiresAt: null, createdAt: null };
const withKey = (scopes: string[], extra: Partial<RequestIdentity> = {}) => ({ ...person, apiKey: { ...key, scopes }, ...extra }) as RequestIdentity;

interface FakeSession {
  row: Partial<ApiRow> & { key: string; sessionId: string; originType: string; ownerUserId: string | null; ownerName: string | null };
  status: Session["status"];
  asks?: { status: string; createdAt: string }[];
  lastActiveAt?: string;
}

/** The Computer object's side: sessions and people in SQL, `work.context` as durable-object.ts dispatches it. */
function computer(sessions: FakeSession[]) {
  const sql = sqlStorage();
  sql.exec(`CREATE TABLE sessions (runner_key TEXT, session_id TEXT, owner_id TEXT, owner_user_id TEXT, owner_name TEXT, owner_email TEXT, updated_at INTEGER);
    CREATE TABLE people (slack_user_id TEXT PRIMARY KEY, dir TEXT, git_name TEXT, git_email TEXT, updated_at INTEGER);`);
  workStampSetup(sql);
  for (const s of sessions) {
    sql.exec("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 1)", s.row.key, s.row.sessionId, s.row.ownerId ?? null, s.row.ownerUserId, s.row.ownerName, s.row.ownerEmail ?? null);
  }
  sql.exec("INSERT INTO people VALUES ('U_ME', 'me', 'Me', 'me.git@acme.test', 1)");
  sql.exec("INSERT INTO people VALUES ('U_CY', 'cy', 'Cy Git', 'cy@acme.test', 1)");
  const find = (id: string) => sessions.find((s) => s.row.sessionId === id);
  const api = {
    row: (id: string) => find(id)?.row as ApiRow | undefined,
    rowByKey: (k: string) => sessions.find((s) => s.row.key === k)?.row as ApiRow | undefined,
    visible: (caller: ApiCaller, id: string) => {
      const s = find(id);
      return s && !(s.row.originType === "slack" && s.row.ownerUserId !== caller.member) ? (s.row as ApiRow) : undefined;
    },
    compose: (row: ApiRow) => {
      const s = find(row.sessionId)!;
      return { id: row.sessionId, title: `Session ${row.sessionId.slice(-1)}`, status: s.status, asks: s.asks ?? [], lastActiveAt: s.lastActiveAt ?? "2026-11-19T09:00:00.000Z" } as unknown as Session;
    },
  };
  const ops: WorkContextOp[] = [];
  const stub: ComputerApiStub = {
    computerApi: vi.fn(async (_account, caller, op) => {
      if (op.op === "work.stamp") return workStamp(sql);
      if (op.op !== "work.context") throw new Error(`unexpected ${op.op}`);
      ops.push(op as WorkContextOp);
      return workContext({ sql, api }, caller, op as WorkContextOp);
    }),
  };
  return { stub, ops, sql };
}

/** A Work index over a fake GitHub, as the binding answers it. */
async function workIndex(repo: FakeRepo, over: Partial<TokenMinter> = {}) {
  const pending: Promise<unknown>[] = [];
  const account: TokenMinter = {
    mintGitHubInstallationToken: async () => ({ outcome: "minted", token: "ghs_test", expiresAt: "2099-01-01T00:00:00Z" }),
    getGitHubInstallation: () => ({ accountLogin: "acme" }),
    listGitHubInstallations: () => [{ id: "12", githubInstallationId: 9012, accountLogin: "acme", accountType: "Organization", state: "active" }],
    ...over,
  };
  const clock = new FakeClock();
  const index = new WorkIndex({ store: indexStore(), clock, scheduler: { arm: async () => {}, waitUntil: (p) => void pending.push(p) }, account: () => account, fetch: repo.fetch });
  const rpc: WorkIndexRpc = {
    repository: (a) => index.getRepository(a),
    setRepository: (a, c, by) => index.setRepository(a, c, by),
    repositories: (a) => index.repositories(a),
    items: (a, q) => index.items(a, q),
    item: (a, n) => index.item(a, n),
    history: (a, n, c) => index.history(a, n, c),
    poke: (a) => index.poke(a),
    stamp: (a) => index.stamp(a),
  };
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return { rpc, settle, clock, index, env: { WORK_INDEX: { getByName: () => rpc } } };
}

function call(env: unknown, stub: ComputerApiStub, identity: RequestIdentity, method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const request = new Request(`https://blue.test/v1/computer${path}`, { method, ...init });
  return routeComputerApi(request, env as never, identity, ORG, stub, new URL(request.url).pathname.slice("/v1/computer".length));
}
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const doc = (n: number, title: string, owner?: string, extra = "") =>
  `${owner ? `---\nowner: ${owner}\n---\n` : ""}# ${n}. ${title}\n\nState of ${title}.\n${extra}`;

/** A repository with items linked to sessions of every kind, connected and built. */
async function board() {
  const repo = new FakeRepo({ "work/1-mine.md": doc(1, "Mine", "me.git@acme.test"), "work/2-bos.md": doc(2, "Bo's", "bo@acme.test"), "done/3-old.md": doc(3, "Old") });
  const w = await workIndex(repo);
  const c = computer([
    { row: { key: "k1", sessionId: SID.mine, originType: "api", ownerUserId: ME, ownerName: "Me", ownerId: "U_ME", ownerEmail: "me@acme.test" }, status: "waiting", asks: [{ status: "open", createdAt: "2026-11-19T08:00:00.000Z" }] },
    { row: { key: "k2", sessionId: SID.bos, originType: "api", ownerUserId: BO, ownerName: "Bo", ownerEmail: "bo@acme.test" }, status: "running", asks: [{ status: "open", createdAt: "2026-11-19T07:00:00.000Z" }] },
    // My Slack session, named in the trailer by its key.
    { row: { key: "T1:C1:111", sessionId: SID.slack, originType: "slack", ownerUserId: ME, ownerName: "Me" }, status: "running", lastActiveAt: "2026-11-19T09:30:00.000Z" },
    // Bo's Slack session: private to Bo.
    { row: { key: "T1:C2:222", sessionId: SID.private, originType: "slack", ownerUserId: BO, ownerName: "Bo" }, status: "waiting", asks: [{ status: "open", createdAt: "2026-11-19T06:00:00.000Z" }] },
    { row: { key: "k5", sessionId: SID.idle, originType: "api", ownerUserId: BO, ownerName: "Bo" }, status: "idle" },
  ]);
  const put = await call(w.env, c.stub, person, "PUT", "/work/repository", { body: JSON.stringify({ installationId: 12, owner: "acme", name: "knowledge" }) });
  expect(put.status).toBe(200);
  await w.settle();
  // Commits after the build, which the index advances over and links.
  const commits: [Record<string, string>, string, { name: string; email: string }?][] = [
    [{ "work/1-mine.md": doc(1, "Mine", "me.git@acme.test", "more") }, `Update 1\n\nSession: ${SID.mine}\nSession: ${SID.bos}`],
    [{ "work/2-bos.md": doc(2, "Bo's", "bo@acme.test", "more") }, `Update 2\n\nSession: T1:C1:111\nSession: ${SID.private}`],
    [{ "work/4-new.md": doc(4, "New", "cy@acme.test") }, `Add 4\n\nSession: ${SID.idle}`, { name: "Cy", email: "cy@acme.test" }],
  ];
  for (const [changes, message, author] of commits) {
    repo.commit(changes, message, author);
    await w.rpc.poke(ORG);
    await w.settle();
  }
  return { repo, w, c };
}

describe("Work API scopes", () => {
  const env = { WORK_INDEX: { getByName: () => ({ repository: async () => null, setRepository: async () => ({ ok: true, value: null }), repositories: async () => ({ ok: true, installations: [] }) }) } };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  const status = async (identity: RequestIdentity, method = "GET", path = "/work/repository", body?: string) => {
    const res = await call(env, stub, identity, method, path, body ? { body } : {});
    return { status: res.status, error: res.status >= 400 ? (await json(res)).error : undefined };
  };
  const choice = JSON.stringify({ installationId: "inst_1", owner: "acme", name: "knowledge" });

  it("needs work:read to read and work:write to change; sessions:read and wildcards grant neither", async () => {
    expect(await status(withKey(["sessions:read"]))).toMatchObject({ status: 403, error: { reason: "missing_scope", scope: "work:read" } });
    expect(await status(withKey(["sandbox:*"]))).toMatchObject({ status: 403, error: { scope: "work:read" } });
    expect((await status(withKey(["work:read"]))).status).toBe(200);
    expect(await status(withKey(["work:read"]), "PUT", "/work/repository", choice)).toMatchObject({ status: 403, error: { scope: "work:write" } });
    expect((await status(withKey(["work:write"]), "PUT", "/work/repository", choice)).status).toBe(200);
    expect(await status(withKey(["sessions:read"]), "GET", "/work/repositories")).toMatchObject({ status: 403, error: { scope: "work:read" } });
    expect((await status(withKey(["work:read"]), "GET", "/work/repositories")).status).toBe(200);
  });

  it("lets the dashboard read and write", async () => {
    expect((await status(person)).status).toBe(200);
    expect((await status(person, "PUT", "/work/repository", choice)).status).toBe(200);
  });

  it("refuses a session's key on writes whatever it names, and lets it read", async () => {
    const session = withKey(["work:read", "work:write"], { principal: "computer" } as Partial<RequestIdentity>);
    expect(await status(session, "PUT", "/work/repository", choice)).toMatchObject({ status: 403, error: { reason: "computer_principal" } });
    expect((await status(session)).status).toBe(200);
  });

  it("answers 200 with a null repository, and 503 unavailable when the index is not bound", async () => {
    const res = await call(env, stub, person, "GET", "/work/repository");
    expect(await json(res)).toEqual({ repository: null });
    const unbound = await call({}, stub, person, "GET", "/work/items?stage=open");
    expect(unbound.status).toBe(503);
    expect((await json(unbound)).error).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("routes only the Work routes", async () => {
    expect((await call(env, stub, person, "DELETE", "/work/repository")).status).toBe(404);
    expect((await call(env, stub, person, "POST", "/work/items/1/close")).status).toBe(404);
    expect((await call(env, stub, person, "GET", "/work/files")).status).toBe(404);
    expect((await call(env, stub, person, "POST", "/work/repositories")).status).toBe(404);
    expect((await call(env, stub, person, "GET", "/work/repositories/1")).status).toBe(404);
  });
});

describe("Work API requests", () => {
  const env = { WORK_INDEX: { getByName: () => ({ repository: async () => null, setRepository: vi.fn(async (_a: string, c: unknown) => ({ ok: true, value: c })), items: async () => ({ ok: false, error: "invalid_cursor" }), item: async () => ({ ok: true, item: null, body: null, asOf: null }) }) } };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  const err = async (res: Response) => ({ status: res.status, ...(await json(res)).error });

  it("refuses unknown query parameters, a missing stage, and paging on the open list", async () => {
    expect(await err(await call(env, stub, person, "GET", "/work/items?stage=open&owner=me"))).toMatchObject({ status: 400, code: "invalid_request", field: "owner" });
    expect(await err(await call(env, stub, person, "GET", "/work/repository?x=1"))).toMatchObject({ status: 400, field: "x" });
    expect(await err(await call(env, stub, person, "GET", "/work/items"))).toMatchObject({ status: 400, field: "stage" });
    expect(await err(await call(env, stub, person, "GET", "/work/items?stage=open&limit=5"))).toMatchObject({ status: 400, field: "limit" });
    expect(await err(await call(env, stub, person, "GET", "/work/items?stage=closed&limit=101"))).toMatchObject({ status: 400, field: "limit" });
    expect(await err(await call(env, stub, person, "GET", "/work/items?stage=closed&cursor=zz"))).toMatchObject({ status: 400, code: "invalid_cursor" });
  });

  it("answers item_not_found for a missing item or a number that is not one", async () => {
    for (const n of ["9", "0", "abc", "01"]) expect(await err(await call(env, stub, person, "GET", `/work/items/${n}`))).toMatchObject({ status: 404, code: "item_not_found" });
  });

  it("checks the PUT body: known fields only, the installation id as a string or a number", async () => {
    const put = (body: unknown, headers: Record<string, string> = {}) => call(env, stub, person, "PUT", "/work/repository", { body: JSON.stringify(body), headers });
    expect(await err(await put({ installationId: "i", owner: "acme", name: "k", extra: 1 }))).toMatchObject({ status: 400, field: "extra" });
    expect(await err(await put({ owner: "acme", name: "k" }))).toMatchObject({ status: 400, field: "installationId" });
    expect(await err(await put({ installationId: 1, owner: "a/b", name: "k" }))).toMatchObject({ status: 400, field: "owner" });
    expect(await err(await put({ installationId: 1, owner: "acme", name: ".." }))).toMatchObject({ status: 400, field: "name" });
    expect(await err(await put([1]))).toMatchObject({ status: 400, field: "" });
    expect(await err(await put({ installationId: 1, owner: "acme", name: "k" }, { "idempotency-key": "has space" }))).toMatchObject({ status: 400, field: "Idempotency-Key" });
    const ok = await put({ installationId: 12, owner: "acme", name: "k", branch: "trunk" }, { "idempotency-key": "k-1" });
    expect(await json(ok)).toEqual({ repository: { installationId: "12", owner: "acme", name: "k", branch: "trunk" } });
  });
});

describe("Work API composition", () => {
  it("joins the open items with the caller's sessions, people and emails", async () => {
    const { w, c } = await board();
    const res = await call(w.env, c.stub, person, "GET", "/work/items?stage=open");
    expect(res.status).toBe(200);
    const page = await json(res);
    expect(Object.keys(page)).toEqual(["repository", "head", "asOf", "building", "items"]);
    expect(page.repository).toEqual({ installationId: "12", owner: "acme", name: "knowledge", branch: "main", problem: null, problemMessage: null });
    expect(page.building).toBe(false);
    const [one, two, four] = page.items;

    // Mine: the owner is the git email the computer uses for me (people, through my Slack session's owner id).
    expect(one).toMatchObject({ number: 1, mine: true, owner: { email: "me.git@acme.test", name: "Me", id: ME } });
    expect(one.attention).toEqual({ state: "needs_you", name: "Me", since: "2026-11-19T08:00:00.000Z" });
    expect(one.sessions).toEqual([
      { id: SID.mine, title: "Session 1", ownerName: "Me", status: "waiting" },
      { id: SID.bos, title: "Session 2", ownerName: "Bo", status: "running" },
    ]);

    // Bo's private Slack session is left out entirely: no attention from its open ask, not listed.
    // My Slack session, named by its key, is shown by its id; it is running.
    expect(two).toMatchObject({ number: 2, mine: false, owner: { email: "bo@acme.test", name: "Bo", id: BO } });
    expect(two.sessions).toEqual([{ id: SID.slack, title: "Session 3", ownerName: "Me", status: "running" }]);
    expect(two.attention).toEqual({ state: "working", name: "Me", since: "2026-11-19T09:30:00.000Z" });

    // An idle session adds no attention; a member known only by their git email has a name, no id.
    expect(four).toMatchObject({ number: 4, owner: { email: "cy@acme.test", name: "Cy Git", id: null }, author: { email: "cy@acme.test", name: "Cy Git", id: null }, attention: null, unpublished: false });
    expect(typeof four.updatedAt).toBe("string");

    // One call to the Computer object per page, with every linked session and email.
    expect(c.ops).toHaveLength(1);
    expect(new Set(c.ops[0]!.sessionIds)).toEqual(new Set([SID.mine, SID.bos, "T1:C1:111", SID.private, SID.idle]));
  });

  it("answers 304 to an unchanged poll, and a new ETag when attention or the head moves", async () => {
    const { repo, w, c } = await board();
    const first = await call(w.env, c.stub, person, "GET", "/work/items?stage=open");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(new RegExp(`^"${repo.head}-[0-9a-f]{16}"$`));
    const again = await call(w.env, c.stub, person, "GET", "/work/items?stage=open", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");

    // Someone else's view of the same head differs (mine, needs_you), so its tag does too.
    const other = await call(w.env, c.stub, { ...person, userId: "user_bo", userEmail: "bo@acme.test" } as RequestIdentity, "GET", "/work/items?stage=open");
    expect(other.headers.get("etag")).not.toBe(etag);

    c.sql.exec("UPDATE sessions SET owner_email = NULL");
    const moved = await call(w.env, c.stub, person, "GET", "/work/items?stage=open", { headers: { "if-none-match": etag } });
    expect(moved.status).toBe(200);
  });

  it("answers an unchanged poll from the stamps alone: no list read, no composition; Work-As-Of on 200 and 304", async () => {
    const { w, c } = await board();
    const first = await call(w.env, c.stub, person, "GET", "/work/items?stage=open");
    const asOf = first.headers.get("work-as-of");
    expect(asOf).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(asOf).toBe((await json(first)).asOf);
    const items = vi.spyOn(w.index, "items");
    const ops = c.ops.length;
    const again = await call(w.env, c.stub, person, "GET", "/work/items?stage=open", { headers: { "if-none-match": first.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("work-as-of")).toBe(asOf);
    expect(items).not.toHaveBeenCalled();
    expect(c.ops.length).toBe(ops);
    // One item and its history carry it too.
    expect((await call(w.env, c.stub, person, "GET", "/work/items/1")).headers.get("work-as-of")).toBe(asOf);
  });

  it("moves the ETag on any write to sessions or people, also one that leaves updated_at alone", async () => {
    const { w, c } = await board();
    const etag = (await call(w.env, c.stub, person, "GET", "/work/items?stage=open")).headers.get("etag")!;
    c.sql.exec("UPDATE sessions SET owner_name = 'Mia' WHERE session_id = ?", SID.mine);
    const renamed = await call(w.env, c.stub, person, "GET", "/work/items?stage=open", { headers: { "if-none-match": etag } });
    expect(renamed.status).toBe(200);
    const next = renamed.headers.get("etag")!;
    expect(next).not.toBe(etag);
    c.sql.exec("UPDATE people SET git_name = 'Cy Two' WHERE slack_user_id = 'U_CY'");
    expect((await call(w.env, c.stub, person, "GET", "/work/items?stage=open", { headers: { "if-none-match": next } })).status).toBe(200);
  });

  it("finds a person by email through an index, not a scan", () => {
    const { sql } = computer([]);
    const plan = (q: string) => (sql.exec(`EXPLAIN QUERY PLAN ${q}`, "x@acme.test").toArray() as { detail: string }[]).map((r) => r.detail).join("; ");
    expect(plan("SELECT owner_user_id FROM sessions WHERE lower(owner_email) = ? AND owner_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1")).toMatch(/USING INDEX sessions_owner_email_lower/);
    expect(plan("SELECT slack_user_id FROM people p WHERE lower(p.git_email) = ? LIMIT 1")).toMatch(/USING INDEX people_git_email_lower/);
    expect(plan("SELECT owner_email FROM sessions WHERE owner_user_id = ?")).toMatch(/USING INDEX sessions_owner_user/);
  });

  it("gives a null updatedAt until the commit is known, never 1970", async () => {
    const repo = new FakeRepo({ "work/1-a.md": doc(1, "A") });
    const w = await workIndex(repo);
    const c = computer([]);
    expect((await call(w.env, c.stub, person, "PUT", "/work/repository", { body: JSON.stringify({ installationId: 12, owner: "acme", name: "knowledge" }) })).status).toBe(200);
    await w.settle();
    const page = await json(await call(w.env, c.stub, person, "GET", "/work/items?stage=open"));
    expect(page.items[0].updatedAt).toBeNull();
    expect(page.items[0].createdAt).toBeNull();
  });

  it("answers 503 with a retry hint when a closed item's body does not come from GitHub in time", async () => {
    const { repo, w, c } = await board();
    repo.hangNext = 1;
    const pending = call(w.env, c.stub, person, "GET", "/work/items/3");
    await new Promise((resolve) => setImmediate(resolve));
    w.clock.tick(READ_WAIT_MS);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await json(res)).error).toMatchObject({ code: "unavailable", retryAfterMs: expect.any(Number) });
    w.clock.tick(REQUEST_TIMEOUT_MS);
    await w.settle();
    expect((await call(w.env, c.stub, person, "GET", "/work/items/3")).status).toBe(200);
  });

  it("refuses a repository outside the installation's account", async () => {
    const w = await workIndex(new FakeRepo({}));
    const c = computer([]);
    const res = await call(w.env, c.stub, person, "PUT", "/work/repository", { body: JSON.stringify({ installationId: 12, owner: "elsewhere", name: "knowledge" }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid_request", field: "owner", reason: "owner_mismatch" });
  });

  it("pages closed items and answers one item with its body", async () => {
    const { w, c } = await board();
    const closed = await json(await call(w.env, c.stub, person, "GET", "/work/items?stage=closed&limit=10"));
    expect(Object.keys(closed)).toEqual(["items", "nextCursor"]);
    expect(closed.items.map((i: { number: number; stage: string }) => [i.number, i.stage])).toEqual([[3, "closed"]]);
    expect(closed.nextCursor).toBeNull();
    const one = await json(await call(w.env, c.stub, person, "GET", "/work/items/1"));
    expect(Object.keys(one)).toEqual(["item", "body"]);
    expect(one.item.attention.state).toBe("needs_you");
    expect(one.body).toContain("# 1. Mine");
  });

  it("shows a revision's session by its id, and only when the caller may see it", async () => {
    const { w, c } = await board();
    const res = await json(await call(w.env, c.stub, person, "GET", "/work/items/2/history"));
    expect(Object.keys(res)).toEqual(["revisions", "nextCursor"]);
    const update = res.revisions.find((r: { summary: string }) => r.summary === "Update 2");
    // The first trailer, my Slack session's key, becomes its id.
    expect(update.sessionId).toBe(SID.slack);
    const bo = await json(await call(w.env, c.stub, { ...person, userId: "user_bo" } as RequestIdentity, "GET", "/work/items/2/history"));
    expect(bo.revisions.find((r: { summary: string }) => r.summary === "Update 2").sessionId).toBeNull();
  });
});

describe("Work API repositories", () => {
  const installations = [
    { id: "12", githubInstallationId: 9012, accountLogin: "acme", accountType: "Organization", state: "active" },
    { id: "13", githubInstallationId: 9013, accountLogin: "ana", accountType: "User", state: "active" },
    { id: "14", githubInstallationId: 9014, accountLogin: "old", accountType: "Organization", state: "suspended" },
  ];

  it("lists each active installation's repositories, most recently pushed first, with its settings page", async () => {
    const repo = new FakeRepo({ "work/1-a.md": doc(1, "A") });
    repo.granted = [
      { id: 1, name: "app", pushedAt: "2026-11-18T00:00:00Z" },
      { id: 2, name: "empty", pushedAt: null },
      { id: 3, name: "site", private: true, pushedAt: "2026-10-01T00:00:00Z" },
    ];
    const w = await workIndex(repo, { listGitHubInstallations: () => installations });
    const res = await call(w.env, computer([]).stub, person, "GET", "/work/repositories");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.installations.map((i: { id: string }) => i.id)).toEqual(["12", "13"]);
    const [acme, ana] = body.installations;
    expect(acme).toMatchObject({ accountLogin: "acme", accountType: "Organization", settingsUrl: "https://github.com/organizations/acme/settings/installations/9012", truncated: false, problem: null });
    expect(ana.settingsUrl).toBe("https://github.com/settings/installations/9013");
    expect(acme.repositories.map((r: { name: string }) => r.name)).toEqual(["app", "knowledge", "site", "empty"]);
    expect(acme.repositories[2]).toEqual({ id: 3, owner: "acme", name: "site", private: true, defaultBranch: "main", pushedAt: "2026-10-01T00:00:00Z" });
    expect(repo.log).toContain("GET /installation/repositories?per_page=100&page=1");
  });

  it("stops at 500 repositories and says so", async () => {
    const repo = new FakeRepo({});
    repo.granted = Array.from({ length: 520 }, (_, i) => ({ id: i + 1, name: `r${i}`, pushedAt: "2026-11-01T00:00:00Z" }));
    const w = await workIndex(repo);
    const body = await json(await call(w.env, computer([]).stub, person, "GET", "/work/repositories"));
    expect(body.installations[0].repositories).toHaveLength(500);
    expect(body.installations[0].truncated).toBe(true);
    expect(repo.log.filter((l) => l.startsWith("GET /installation/repositories"))).toHaveLength(5);
  });

  it("names the problem of an installation GitHub will not list, and answers 503 when GitHub is down", async () => {
    const w = await workIndex(new FakeRepo({}), { mintGitHubInstallationToken: async () => ({ outcome: "failed", code: "installation_suspended", message: "The installation is suspended." }) as never });
    const body = await json(await call(w.env, computer([]).stub, person, "GET", "/work/repositories"));
    expect(body.installations[0]).toMatchObject({ repositories: [], problem: "installation_suspended", problemMessage: "The installation is suspended." });

    const down = new FakeRepo({});
    down.failNext = [{ status: 502, match: /^\/installation\// }];
    const w2 = await workIndex(down);
    const res = await call(w2.env, computer([]).stub, person, "GET", "/work/repositories");
    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({ code: "unavailable", retryAfterMs: 5_000 });
  });

  it("answers no installations when GitHub is not connected", async () => {
    const w = await workIndex(new FakeRepo({}), { listGitHubInstallations: () => [] });
    expect(await json(await call(w.env, computer([]).stub, person, "GET", "/work/repositories"))).toEqual({ installations: [] });
  });
});

describe("branchName", () => {
  it("follows git check-ref-format for a branch", () => {
    for (const ok of ["main", "trunk", "feat/work-index", "release-1.2", "a_b", "x@y", "ü"]) expect(branchName(ok), ok).toBe(true);
    for (const bad of ["", "-x", "a..b", "a/", "/a", "a//b", "a.lock", "a/b.lock", ".a", "a/.b", "a.", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "@", "a@{b", "a\u0001b", "a\u007fb", "x".repeat(256)]) {
      expect(branchName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("itemAttention", () => {
  const brief = (over: Partial<SessionBrief>): SessionBrief => ({ id: "cs_x", title: null, ownerId: BO, ownerName: "Bo", status: "idle", openAskAt: null, lastActiveAt: "2026-11-19T00:00:00Z", ...over });

  it("is needs_you, then waiting_on, then working, then nothing", () => {
    const mine = brief({ ownerId: ME, ownerName: "Me", openAskAt: "2026-11-19T05:00:00Z" });
    const bos = brief({ openAskAt: "2026-11-19T01:00:00Z" });
    const running = brief({ status: "running", lastActiveAt: "2026-11-19T06:00:00Z" });
    expect(itemAttention([bos, running, mine], ME)).toEqual({ state: "needs_you", name: "Me", since: "2026-11-19T05:00:00Z" });
    expect(itemAttention([running, bos], ME)).toEqual({ state: "waiting_on", name: "Bo", since: "2026-11-19T01:00:00Z" });
    expect(itemAttention([running, brief({ status: "starting", lastActiveAt: "2026-11-19T07:00:00Z" })], ME)).toEqual({ state: "working", name: "Bo", since: "2026-11-19T07:00:00Z" });
    expect(itemAttention([brief({ status: "waiting" }), brief({ status: "suspended" })], ME)).toBeNull();
    expect(itemAttention([], ME)).toBeNull();
  });
});
