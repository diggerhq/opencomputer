// The HTTP API of tracks and threads (spec 37), slice 3: /live and its revoke, PATCH and aside
// through Org, the agents' routes and result diffs. The actors are fakes.

import { afterEach, describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/http/api/dispatch.js";
import { routeComputerDashboard } from "../src/http/dashboard/routes.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { agentIdentity, keyIdentity, memberIdentity } from "./fixtures/identity.js";
import { PRINCIPAL_HEADER, upgradePrincipal } from "../src/actors/live/contract.js";

const ORG = "org_1";
const USER = "user_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SID = "cs_0123456789abcdef";
const RID = "res_0123456789abcdef";

const member = memberIdentity(ORG, USER);
const agent = agentIdentity(ORG, SID, ["sessions:read", "sessions:write"]);

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
  it("passes the upgrade to the organization's Live with the principal it verified", async () => {
    const live = { fetch: vi.fn(async () => new Response(null, { status: 200 })) };
    const call = setup({ LIVE: ns(live) });
    const headers = { upgrade: "websocket", "x-opencomputer-agent-token": "t", [PRINCIPAL_HEADER]: JSON.stringify({ org: "forged" }) };
    expect((await call("GET", "/live", { headers })).status).toBe(200);
    const sent = (live.fetch.mock.calls[0] as unknown as [Request])[0];
    expect(upgradePrincipal(sent)).toMatchObject({ org: ORG, kind: "member" });
    expect(sent.headers.get("upgrade")).toBe("websocket");
    expect(sent.headers.get("x-opencomputer-agent-token")).toBeNull();
    expect((await call("GET", "/live")).status).toBe(426);
  });

  it("the edge's revoke reaches Live; only from the edge", async () => {
    const live = { revoke: vi.fn(async () => undefined) };
    const edge = { kind: "user", userId: "opencomputer-edge", accountId: ORG, organizationId: ORG } as RequestIdentity;
    const revoke = (env: unknown, identity: RequestIdentity, body: unknown) =>
      routeComputerDashboard(new Request("https://blue.test/v1/internal/live/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env as never, identity, () => {});
    expect((await revoke({ LIVE: ns(live) }, edge, { org: ORG, credentialId: "key_1" }))?.status).toBe(204);
    expect(live.revoke).toHaveBeenCalledWith("key_1");
    expect((await revoke({ LIVE: ns(live) }, edge, { org: "org_2", credentialId: "key_1" }))?.status).toBe(403);
    expect((await revoke({ LIVE: ns(live) }, member, { org: ORG, credentialId: "key_1" }))?.status).toBe(403);
    expect(live.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH and aside (spec 37.2)", () => {
  const session = { id: SID, title: "x" };
  it("every field is one Org.patchSession, so all apply or none; settings wait on the entry Org owes", async () => {
    const accepted: { id: string; kind: string; body: unknown }[] = [];
    const log = { accept: vi.fn(async (_p: unknown, entry: { id: string; kind: string; body: unknown }) => (accepted.push(entry), { ok: true, id: entry.id, duplicate: true, outcome: { state: "waiting" } })) };
    const org = { patchSession: vi.fn(async () => ({ ok: true, session })), mutate: vi.fn(), getSession: vi.fn() };
    const call = setup({ ORGS: ns(org), SESSION_LOG: ns(log) });
    const body = { title: "t", archived: true, metadata: { a: "b" }, model: "claude-opus-5-5", access: { mode: "org" } };
    const r = await call("PATCH", `/sessions/${SID}`, { body, headers: { "idempotency-key": "k" } });
    expect(org.patchSession).toHaveBeenCalledTimes(1);
    const [, sid, patch] = org.patchSession.mock.calls[0] as unknown as [unknown, string, Record<string, unknown> & { settings: { id: string } }];
    expect(sid).toBe(SID);
    expect(patch).toEqual({ title: "t", archived: true, metadata: { a: "b" }, access: { mode: "org" }, settings: { id: expect.stringMatching(/^ie_/), body: { model: "claude-opus-5-5" } } });
    expect(org.mutate).not.toHaveBeenCalled();
    expect(org.getSession).not.toHaveBeenCalled();
    // The same entry, accepted again to wait for it; still waiting: 202 with its id.
    expect(accepted).toEqual([{ id: patch.settings.id, kind: "settings", body: { model: "claude-opus-5-5" } }]);
    expect(r).toMatchObject({ status: 202, body: { accepted: true, id: patch.settings.id, session } });
    // A retry with the key is the same entry.
    await call("PATCH", `/sessions/${SID}`, { body, headers: { "idempotency-key": "k" } });
    expect((org.patchSession.mock.calls[1] as unknown as [unknown, string, { settings: { id: string } }])[2].settings.id).toBe(patch.settings.id);
    // Without settings nothing waits.
    expect(await call("PATCH", `/sessions/${SID}`, { body: { archived: false } })).toMatchObject({ status: 200, body: { session } });
    expect(org.patchSession).toHaveBeenLastCalledWith(expect.anything(), SID, { archived: false });
    expect(log.accept).toHaveBeenCalledTimes(2);
  });

  it("a refused patch is the reply, and nothing is sent to the log", async () => {
    const log = { accept: vi.fn() };
    const org = { patchSession: vi.fn(async () => ({ ok: false, code: "forbidden", status: 403, message: "no" })) };
    const r = await setup({ ORGS: ns(org), SESSION_LOG: ns(log) })("PATCH", `/sessions/${SID}`, { body: { title: "t", model: "claude-opus-5-5" } });
    expect(r.status).toBe(403);
    expect(log.accept).not.toHaveBeenCalled();
  });

  it("one who is not the owner gets Org's owner_only, never an access view (owner first)", async () => {
    const org = { patchSession: vi.fn(async () => ({ ok: false, code: "forbidden", status: 403, reason: "owner_only" })) };
    const r = await setup({ ORGS: ns(org) })("PATCH", `/sessions/${SID}`, { body: { access: { mode: "org" } } });
    expect(r).toMatchObject({ status: 403, body: { error: { code: "forbidden", reason: "owner_only" } } });
  });

  it("aside sets and clears Org's column", async () => {
    const org = { patchSession: vi.fn(async () => ({ ok: true, session })) };
    const call = setup({ ORGS: ns(org) });
    expect(await call("PUT", `/sessions/${SID}/aside`, { body: { ref: "trk_1" } })).toMatchObject({ status: 200, body: { session } });
    expect(org.patchSession).toHaveBeenLastCalledWith(expect.anything(), SID, { aside: "trk_1" });
    expect((await call("DELETE", `/sessions/${SID}/aside`)).status).toBe(200);
    expect(org.patchSession).toHaveBeenLastCalledWith(expect.anything(), SID, { aside: null });
    expect((await call("PUT", `/sessions/${SID}/aside`, { body: { ref: "a b" } })).status).toBe(400);
    const reader = keyIdentity(ORG, USER, ["sessions:read"]);
    expect((await call("PUT", `/sessions/${SID}/aside`, { body: { ref: "x" }, identity: reader })).status).toBe(403);
    expect(org.patchSession).toHaveBeenCalledTimes(2);
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
