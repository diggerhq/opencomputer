// The HTTP API of tracks and threads (spec 37), slice 2: the feed, the occurrence stream, the
// mutation routes and the work reads, all Org's, as the principal. Org is a fake.

import { describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import type { RequestIdentity } from "../src/edge/auth.js";

const ORG = "org_1";
const USER = "user_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SID = "cs_0123456789abcdef";
const TID = "trk_0123456789abcdef";
const CLIENT = "cl_0123456789abcdef";

const member = { kind: "user", userId: USER, accountId: ORG, organizationId: ORG, role: "member" } as RequestIdentity;
const key = (scopes: string[]) =>
  ({ ...member, apiKey: { id: "key_1", hash: "a".repeat(64), name: "k", kind: "user", scopes, expiresAt: null, createdAt: null } }) as RequestIdentity;
const agent = { ...member, principal: "computer", sessionKey: SID, apiKey: { id: "key_2", hash: "b".repeat(64), name: "s", kind: "user", scopes: ["sessions:read"], expiresAt: null, createdAt: null } } as RequestIdentity;

function setup(org: Record<string, unknown>) {
  const env = { ORGS: { getByName: vi.fn(() => org) } };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  return async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; identity?: RequestIdentity } = {}) => {
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
}

const frame = { protocol: 1, cursor: "f1.4", rows: [], gone: [] };

describe("the feed (spec 37.1)", () => {
  it("passes the query to Org and answers its frame", async () => {
    const org = { feed: vi.fn(async () => frame) };
    const call = setup(org);
    const r = await call("GET", `/feed?after=f1.2&kinds=session,thread&client=${CLIENT}&ack=3&sum=1`);
    expect(r).toEqual({ status: 200, body: frame });
    expect(org.feed).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.any(String), kind: "member" }), { after: "f1.2", kinds: ["session", "thread"], clientId: CLIENT, ack: 3, sum: true });
  });

  it("a reset, a foreign cursor or an old protocol is 409 reset with cursor null", async () => {
    const call = setup({ feed: vi.fn(async () => ({ reset: true, cursor: null })) });
    for (const path of ["/feed?after=f1.1", "/feed?after=e1.1.2", "/feed?protocol=0"]) {
      const r = await call("GET", path);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: "reset", cursor: null });
    }
  });

  it("without work:read: core kinds only", async () => {
    const org = { feed: vi.fn(async () => frame) };
    const call = setup(org);
    expect((await call("GET", "/feed", { identity: key(["sessions:read"]) })).status).toBe(200);
    expect(org.feed).toHaveBeenLastCalledWith(expect.anything(), { kinds: ["session", "machine"] });
    expect((await call("GET", "/feed?kinds=thread", { identity: key(["sessions:read"]) })).status).toBe(403);
    expect((await call("GET", "/feed", { identity: key(["work:read"]) })).status).toBe(403);
  });

  it("a mismatch report is 204; the occurrence stream has protocol and resets", async () => {
    const org = {
      mismatch: vi.fn(async () => undefined),
      occurrences: vi.fn(async (_p: unknown, q: { after?: string }) => (q.after === "o1.9" ? { reset: true, cursor: null } : { entries: [{ n: 1 }], to: "o1.1" })),
    };
    const call = setup(org);
    const body = { clientId: CLIENT, cursor: "f1.1", server: "a", client: "b" };
    expect((await call("POST", "/feed/mismatch", { body })).status).toBe(204);
    expect(org.mismatch).toHaveBeenCalledWith(expect.anything(), body);
    expect((await call("POST", "/feed/mismatch", { body: { ...body, clientId: "x" } })).status).toBe(400);
    expect(await call("GET", "/occurrences?limit=5")).toEqual({ status: 200, body: { protocol: 1, entries: [{ n: 1 }], to: "o1.1" } });
    expect((await call("GET", "/occurrences?after=o1.9")).status).toBe(409);
  });
});

describe("the mutation routes (spec 37.3)", () => {
  it("sends the mutation with the body and the path's ids, numbered by the client", async () => {
    const org = { mutate: vi.fn(async () => ({ protocol: 1, version: 7, op: null })) };
    const call = setup(org);
    const r = await call("PUT", `/work/threads/${SID}/title`, { body: { title: "x", sid: "cs_other" }, headers: { "x-oc-client": CLIENT, "x-oc-n": "4", "x-oc-trace": "t1" } });
    expect(r.status).toBe(200);
    expect(org.mutate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "thread.rename", args: { title: "x", sid: SID }, client: { id: CLIENT, n: 4 } }));
  });

  it("names every route's mutation and uses an Idempotency-Key without a client", async () => {
    const org = { mutate: vi.fn(async () => ({ protocol: 1, version: 1, op: null })) };
    const call = setup(org);
    const cases: [string, string, string, Record<string, string>][] = [
      ["DELETE", `/work/threads/${SID}/done`, "thread.reopen", { sid: SID }],
      ["DELETE", `/work/threads/${SID}`, "thread.delete", { sid: SID }],
      ["POST", "/work/tracks", "track.create", {}],
      ["PUT", `/work/tracks/${TID}/doc`, "doc.save", { tid: TID }],
      ["POST", `/work/tracks/${TID}/dissolve`, "track.dissolve", { tid: TID }],
      ["PUT", `/work/reads/${SID}`, "read.set", { sid: SID }],
      ["PUT", "/work/prefs/sidebar.width", "pref.set", { key: "sidebar.width" }],
      ["PUT", "/work/results/res_0123456789abcdef/review", "review.save", { resultId: "res_0123456789abcdef" }],
      ["POST", "/work/proposals/prp_0123456789abcdef/accept", "proposal.accept", { proposalId: "prp_0123456789abcdef" }],
      ["POST", "/work/ops/op_0123456789abcdef/undo", "undo", { opId: "op_0123456789abcdef" }],
    ];
    for (const [method, path, name, args] of cases) {
      expect((await call(method, path, { body: {}, headers: { "idempotency-key": "k1" } })).status).toBe(200);
      expect(org.mutate).toHaveBeenLastCalledWith(expect.anything(), { name, args, idem: "k1", person: { name: null, email: null } });
    }
  });

  it("carries the credential's name and email, for a session the mutation makes; never an agent's or a body's", async () => {
    const org = { mutate: vi.fn(async () => ({ protocol: 1 })) };
    const call = setup(org);
    const named = { ...member, userName: "Ada Lovelace", userEmail: "ada@example.com" } as RequestIdentity;
    await call("POST", "/work/tracks", { body: { tid: TID, person: { name: "Mallory" } }, headers: { "idempotency-key": "k2" }, identity: named });
    expect(org.mutate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ person: { name: "Ada Lovelace", email: "ada@example.com" } }));
    await call("POST", "/work/tracks", { body: { tid: TID }, headers: { "idempotency-key": "k3" }, identity: agent });
    expect(org.mutate).toHaveBeenLastCalledWith(expect.anything(), expect.not.objectContaining({ person: expect.anything() }));
  });

  it("maps refusals, refuses bad ids and needs work:write", async () => {
    const org = { mutate: vi.fn(async () => ({ error: { code: "out_of_order", message: "gap", lastMutation: 3 } })) };
    const call = setup(org);
    const r = await call("PUT", `/work/threads/${SID}/done`, { body: {}, headers: { "x-oc-client": CLIENT, "x-oc-n": "9" } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "out_of_order", lastMutation: 3 });
    expect((await call("PUT", "/work/threads/nope/done", { body: {} })).status).toBe(404);
    expect((await call("PUT", `/work/threads/${SID}/done`, { body: {}, headers: { "x-oc-n": "1" } })).status).toBe(400);
    expect((await call("PUT", `/work/threads/${SID}/done`, { body: {}, identity: key(["work:read"]) })).status).toBe(403);
    expect(org.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("the work reads (spec 37.1)", () => {
  it("threads, overview, revisions, review and search", async () => {
    const org = {
      threads: vi.fn(async () => ({ rows: [{ id: SID }], next: null })),
      overview: vi.fn(async () => ({ tracks: [], threads: [] })),
      docRevisions: vi.fn(async () => [{ rev: 2, body: "b" }]),
      doc: vi.fn(async (_p: unknown, tid: string) => (tid === TID ? { kind: "doc", id: TID, rev: 0, text: "", spans: [] } : null)),
      review: vi.fn(async (_p: unknown, id: string) => (id.endsWith("f") ? { resultId: id } : null)),
      search: vi.fn(async () => ({ rows: [] })),
    };
    const call = setup(org);
    expect(await call("GET", `/work/threads?earlier=true&track=${TID}&limit=10`)).toEqual({ status: 200, body: { protocol: 1, rows: [{ id: SID }], next: null } });
    expect(org.threads).toHaveBeenCalledWith(expect.anything(), { earlier: true, trackId: TID, limit: 10 });
    expect((await call("GET", "/work/overview")).body).toEqual({ protocol: 1, tracks: [], threads: [] });
    expect(await call("GET", `/work/tracks/${TID}/doc`, { identity: agent })).toEqual({ status: 200, body: { protocol: 1, doc: { kind: "doc", id: TID, rev: 0, text: "", spans: [] } } });
    expect((await call("GET", "/work/tracks/trk_0123456789abcdee/doc")).status).toBe(404);
    expect((await call("GET", `/work/tracks/${TID}/doc/revisions`)).body).toEqual({ protocol: 1, revisions: [{ rev: 2, body: "b" }] });
    expect((await call("GET", `/work/tracks/${TID}/doc/revisions/2`)).body).toEqual({ protocol: 1, revision: { rev: 2, body: "b" } });
    expect((await call("GET", `/work/tracks/${TID}/doc/revisions/3`)).status).toBe(404);
    expect((await call("GET", "/work/results/res_0123456789abcdef/review")).status).toBe(200);
    expect((await call("GET", "/work/results/res_0123456789abcdee/review")).status).toBe(404);
    expect((await call("GET", "/work/search?q=x&limit=50")).status).toBe(200);
    expect((await call("GET", "/work/search?q=x&limit=51")).status).toBe(400);
    expect((await call("GET", "/work/overview", { identity: key(["sessions:read"]) })).status).toBe(403);
  });

  it("the repository setting is Org's; a session may read it but not change it", async () => {
    const repo = { owner: "o", name: "r" };
    const org = { repository: vi.fn(async () => repo), setRepository: vi.fn(async () => ({ ok: true, repository: repo })) };
    const call = setup(org);
    expect(await call("GET", "/work/repository", { identity: agent })).toEqual({ status: 200, body: { repository: repo } });
    expect((await call("PUT", "/work/repository", { identity: agent, body: { repository: "o/r" } })).status).toBe(403);
    expect(await call("PUT", "/work/repository", { body: { installationId: 5, owner: "o", name: "r" } })).toEqual({ status: 200, body: { repository: repo } });
    expect(org.setRepository).toHaveBeenCalledWith(expect.anything(), { installationId: "5", owner: "o", name: "r" });
    expect((await call("PUT", "/work/repository", { body: { owner: "o" } })).status).toBe(400);
  });
});
