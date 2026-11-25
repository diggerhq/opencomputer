// The HTTP API of tracks and threads (spec 37), slice 3: /live and its revoke, PATCH and aside
// through Org, the agents' routes, webhooks and result diffs. The actors are fakes.

import { afterEach, describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import { routeComputerDashboard } from "../src/computer/routes.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { PRINCIPAL_HEADER } from "../src/live/contract.js";

const ORG = "org_1";
const USER = "user_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SID = "cs_0123456789abcdef";
const RID = "res_0123456789abcdef";
const WH = "wh_0123456789abcdef";

const member = { kind: "user", userId: USER, accountId: ORG, organizationId: ORG, role: "member" } as RequestIdentity;
const agent = { ...member, principal: "computer", sessionKey: SID, apiKey: { id: "key_2", hash: "b".repeat(64), name: "s", kind: "user", scopes: ["sessions:read", "sessions:write"], expiresAt: null, createdAt: null } } as RequestIdentity;

function setup(env: Record<string, unknown>) {
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
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}
const ns = (actor: unknown) => ({ getByName: vi.fn(() => actor) });

afterEach(() => vi.unstubAllGlobals());

describe("/live (spec 38)", () => {
  it("passes the upgrade to the organization's Live with the principal signed", async () => {
    const live = { fetch: vi.fn(async () => new Response(null, { status: 200 })) };
    const call = setup({ LIVE: ns(live), LIVE_KEY: "k".repeat(32) });
    expect((await call("GET", "/live", { headers: { upgrade: "websocket" } })).status).toBe(200);
    const sent = (live.fetch.mock.calls[0] as unknown as [Request])[0];
    expect(sent.headers.get(PRINCIPAL_HEADER)).toMatch(/\./);
    expect(sent.headers.get("x-opencomputer-agent-token")).toBeNull();
    expect((await call("GET", "/live")).status).toBe(426);
  });

  it("is 503 without Live", async () => {
    expect((await setup({})("GET", "/live", { headers: { upgrade: "websocket" } })).status).toBe(503);
  });

  it("the edge's revoke reaches Live; 503 without it; only from the edge", async () => {
    const live = { revoke: vi.fn(async () => undefined) };
    const edge = { kind: "user", userId: "opencomputer-edge", accountId: ORG, organizationId: ORG } as RequestIdentity;
    const revoke = (env: unknown, identity: RequestIdentity, body: unknown) =>
      routeComputerDashboard(new Request("https://blue.test/v1/internal/live/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env as never, identity, () => {});
    expect((await revoke({ LIVE: ns(live) }, edge, { org: ORG, credentialId: "key_1" }))?.status).toBe(204);
    expect(live.revoke).toHaveBeenCalledWith("key_1");
    expect((await revoke({}, edge, { org: ORG, credentialId: "key_1" }))?.status).toBe(503);
    expect((await revoke({ LIVE: ns(live) }, edge, { org: "org_2", credentialId: "key_1" }))?.status).toBe(403);
    expect((await revoke({ LIVE: ns(live) }, member, { org: ORG, credentialId: "key_1" }))?.status).toBe(403);
    expect(live.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH and aside (spec 37.2)", () => {
  const session = { id: SID, title: "x" };
  it("title and archived are mutations, metadata Org's column", async () => {
    const org = {
      mutate: vi.fn(async () => ({ protocol: 1, version: 2, op: null })),
      patchSession: vi.fn(async () => ({ ok: true, session })),
      getSession: vi.fn(async () => ({ ok: true, session })),
    };
    const call = setup({ ORGS: ns(org) });
    const r = await call("PATCH", `/sessions/${SID}`, { body: { title: "t", archived: true, metadata: { a: "b" } }, headers: { "idempotency-key": "k" } });
    expect(r).toMatchObject({ status: 200, body: { session } });
    expect(org.mutate).toHaveBeenCalledWith(expect.anything(), { name: "thread.rename", args: { title: "t", sid: SID }, idem: "k:title" });
    expect(org.mutate).toHaveBeenCalledWith(expect.anything(), { name: "thread.done", args: { sid: SID }, idem: "k:archived" });
    expect(org.patchSession).toHaveBeenCalledWith(expect.anything(), SID, { metadata: { a: "b" } });
    await call("PATCH", `/sessions/${SID}`, { body: { archived: false } });
    expect(org.mutate).toHaveBeenLastCalledWith(expect.anything(), { name: "thread.reopen", args: { sid: SID } });
  });

  it("a refused mutation is the reply", async () => {
    const org = { mutate: vi.fn(async () => ({ error: { code: "forbidden", message: "no" } })), getSession: vi.fn() };
    const r = await setup({ ORGS: ns(org) })("PATCH", `/sessions/${SID}`, { body: { title: "t" } });
    expect(r.status).toBe(403);
    expect(org.getSession).not.toHaveBeenCalled();
  });

  it("aside sets and clears Org's column", async () => {
    const org = { patchSession: vi.fn(async () => ({ ok: true, session })) };
    const call = setup({ ORGS: ns(org) });
    expect(await call("PUT", `/sessions/${SID}/aside`, { body: { ref: "trk_1" } })).toMatchObject({ status: 200, body: { session } });
    expect(org.patchSession).toHaveBeenLastCalledWith(expect.anything(), SID, { aside: "trk_1" });
    expect((await call("DELETE", `/sessions/${SID}/aside`)).status).toBe(200);
    expect(org.patchSession).toHaveBeenLastCalledWith(expect.anything(), SID, { aside: null });
    expect((await call("PUT", `/sessions/${SID}/aside`, { body: { ref: "a b" } })).status).toBe(400);
  });
});

describe("the agents' routes (spec 37.2)", () => {
  it("tell-track and Slack post are an agent's only", async () => {
    const call = setup({ ORGS: ns({}), SLACK: ns({}) });
    expect((await call("POST", "/work/tell-track", { body: { message: "hi" } })).body.error.reason).toBe("agents_only");
    expect((await call("POST", "/slack/threads/T1:C1:1.2/messages", { body: { text: "hi" } })).body.error.reason).toBe("agents_only");
  });

  it("tell-track without a track agent is 404", async () => {
    const org = { trackAgent: vi.fn(async () => null) };
    const r = await setup({ ORGS: ns(org) })("POST", "/work/tell-track", { body: { message: "hi" }, identity: agent });
    expect(r.status).toBe(404);
    expect((await setup({ ORGS: ns(org) })("POST", "/work/tell-track", { body: { message: "hi", x: 1 }, identity: agent })).status).toBe(400);
  });

  it("Slack post goes through the Slack actor", async () => {
    const slack = { post: vi.fn(async () => ({ ok: true, ts: "1.3" })) };
    const call = setup({ SLACK: ns(slack) });
    expect(await call("POST", `/slack/threads/${encodeURIComponent("T1:C1:1.2")}/messages`, { body: { text: "hi" }, identity: agent })).toMatchObject({ status: 200, body: { ts: "1.3" } });
    expect(slack.post).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent", session: SID }), "T1:C1:1.2", "hi");
    expect((await call("POST", "/slack/threads/a%20b/messages", { body: { text: "hi" }, identity: agent })).status).toBe(404);
  });
});

describe("webhooks (spec 37.1)", () => {
  it("lists, sets and removes through Delivery; never an agent", async () => {
    const delivery = {
      listEndpoints: vi.fn(async () => [{ id: WH }]),
      setEndpoint: vi.fn(async () => ({ ok: true, endpoint: { id: WH } })),
      removeEndpoint: vi.fn(async () => ({ ok: true })),
    };
    const call = setup({ DELIVERY: ns(delivery) });
    expect(await call("GET", "/webhooks")).toMatchObject({ status: 200, body: { endpoints: [{ id: WH }] } });
    expect(await call("PUT", `/webhooks/${WH}`, { body: { url: "https://x.test/h" } })).toMatchObject({ status: 200, body: { endpoint: { id: WH } } });
    expect((await call("PUT", `/webhooks/${WH}`, { body: { url: "http://x.test/h" } })).status).toBe(400);
    expect((await call("PUT", "/webhooks/wh_bad", { body: { url: "https://x.test/h" } })).status).toBe(404);
    expect((await call("DELETE", `/webhooks/${WH}`)).status).toBe(204);
    expect((await call("GET", "/webhooks", { identity: agent })).status).toBe(403);
  });

  it("is 503 while Delivery has no endpoints", async () => {
    expect((await setup({ DELIVERY: ns({}) })("GET", "/webhooks")).status).toBe(503);
  });
});

describe("result diffs (spec 37.1)", () => {
  it("fetches the pull request's diff with an installation token; ETag is the head", async () => {
    const org = { result: vi.fn(async () => ({ id: RID, ref: "https://github.com/o/r/pull/7" })) };
    const accounts = {
      listGitHubInstallations: vi.fn(async () => [{ id: 5, accountLogin: "o", state: "active" }]),
      mintGitHubInstallationToken: vi.fn(async () => ({ outcome: "minted", token: "t" })),
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).accept === "application/vnd.github.diff" ? new Response("diff --git") : Response.json({ head: { sha: "abc" } }));
    vi.stubGlobal("fetch", fetchMock);
    const call = setup({ ORGS: ns(org), ACCOUNTS: ns(accounts) });
    const r = await call("GET", `/work/results/${RID}/diff`);
    expect(r).toMatchObject({ status: 200, body: { protocol: 1, head: "abc", diff: "diff --git" } });
    expect(r.headers.get("etag")).toBe('"abc"');
    expect(accounts.mintGitHubInstallationToken).toHaveBeenCalledWith({ installationId: "5", repositories: ["r"], permissions: { contents: "read", pull_requests: "read" } });
    expect((await call("GET", `/work/results/${RID}/diff`, { headers: { "if-none-match": '"abc"' } })).status).toBe(304);
  });

  it("a result that is no pull request is 404; another owner's is 409", async () => {
    const org = { result: vi.fn(async () => ({ id: RID, ref: "https://example.test/x" })) };
    expect((await setup({ ORGS: ns(org) })("GET", `/work/results/${RID}/diff`)).status).toBe(404);
    org.result.mockResolvedValue({ id: RID, ref: "https://github.com/other/r/pull/7" });
    const accounts = { listGitHubInstallations: vi.fn(async () => [{ id: 5, accountLogin: "o", state: "active" }]) };
    expect((await setup({ ORGS: ns(org), ACCOUNTS: ns(accounts) })("GET", `/work/results/${RID}/diff`)).body.error.code).toBe("github_not_connected");
  });
});
