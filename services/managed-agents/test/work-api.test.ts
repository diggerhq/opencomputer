import { describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import { branchName } from "../src/computer/work/api.js";
import type { TokenMinter } from "../src/computer/work/github.js";
import { WorkIndex } from "../src/computer/work/index.js";
import type { WorkIndexRpc } from "../src/computer/work/index-contract.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { FakeRepo } from "./fixtures/fake-github-repo.js";
import { FakeClock, indexStore } from "./fixtures/work-platform.js";

/** GET /work/repositories (work tracking 3.10): the repository picker, through the Work index. */

const ORG = "acct_1";
const person = { kind: "user", accountId: ORG, organizationId: ORG, userId: "user_me", role: "member", userName: "Me", userEmail: "Me@Acme.test" } as RequestIdentity;
const key = { id: "key_1", hash: "a".repeat(64), name: "laptop", kind: "user" as const, expiresAt: null, createdAt: null };
const withKey = (scopes: string[]) => ({ ...person, apiKey: { ...key, scopes } }) as RequestIdentity;
const stub: ComputerApiStub = { computerApi: vi.fn() };

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
    repositories: (a, q) => index.repositories(a, q),
    items: (a, q) => index.items(a, q),
    item: (a, n) => index.item(a, n),
    history: (a, n, c) => index.history(a, n, c),
    poke: (a) => index.poke(a),
    stamp: (a) => index.stamp(a),
    linked: (a, refs) => index.linked(a, refs),
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


describe("Work API scopes", () => {
  it("needs work:read; 503 unavailable when the index is not bound; only GET", async () => {
    const env = { WORK_INDEX: { getByName: () => ({ repositories: async () => ({ ok: true, installations: [] }) }) } };
    const res = await call(env, stub, withKey(["sessions:read"]), "GET", "/work/repositories");
    expect(res.status).toBe(403);
    expect((await json(res)).error).toMatchObject({ reason: "missing_scope", scope: "work:read" });
    expect((await call(env, stub, withKey(["work:read"]), "GET", "/work/repositories")).status).toBe(200);
    expect((await call(env, stub, person, "GET", "/work/repositories?x=1")).status).toBe(400);
    const unbound = await call({}, stub, person, "GET", "/work/repositories");
    expect(unbound.status).toBe(503);
    expect((await json(unbound)).error).toMatchObject({ code: "unavailable", retryable: true });
    expect((await call(env, stub, person, "POST", "/work/repositories")).status).toBe(404);
    expect((await call(env, stub, person, "GET", "/work/items?stage=open")).status).toBe(404);
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
    const res = await call(w.env, stub, person, "GET", "/work/repositories");
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

  it("mints a fresh token for every listing, so a grant changed on GitHub shows at once", async () => {
    let mints = 0;
    const w = await workIndex(new FakeRepo({}), {
      mintGitHubInstallationToken: async () => ({ outcome: "minted", token: `ghs_${++mints}`, expiresAt: "2099-01-01T00:00:00Z" }),
    });
    await call(w.env, stub, person, "GET", "/work/repositories");
    await call(w.env, stub, person, "GET", "/work/repositories");
    expect(mints).toBe(2);
  });

  it("lists a page at a time, and a later page of one installation", async () => {
    const repo = new FakeRepo({});
    repo.granted = Array.from({ length: 520 }, (_, i) => ({ id: i + 1, name: `r${i}`, pushedAt: "2026-11-01T00:00:00Z" }));
    const w = await workIndex(repo);
    const first = await json(await call(w.env, stub, person, "GET", "/work/repositories"));
    expect(first.installations[0]).toMatchObject({ nextPage: 2, truncated: false });
    expect(first.installations[0].repositories).toHaveLength(100);
    const last = await json(await call(w.env, stub, person, "GET", "/work/repositories?installation=12&page=6"));
    expect(last.installations[0]).toMatchObject({ nextPage: null, truncated: false });
    expect(last.installations[0].repositories).toHaveLength(21);
    const other = await json(await call(w.env, stub, person, "GET", "/work/repositories?installation=99&page=2"));
    expect(other.installations).toEqual([]);
    expect(repo.log.filter((l) => l.startsWith("GET /installation/repositories"))).toHaveLength(2);
  });

  it("refuses a later page of every installation, or past the last", async () => {
    const w = await workIndex(new FakeRepo({}));
    expect((await call(w.env, stub, person, "GET", "/work/repositories?page=2")).status).toBe(400);
    expect((await call(w.env, stub, person, "GET", "/work/repositories?installation=12&page=101")).status).toBe(400);
    expect((await call(w.env, stub, person, "GET", "/work/repositories?installation=12&page=0")).status).toBe(400);
  });

  it("names the problem of an installation GitHub will not list, and answers 503 when GitHub is down", async () => {
    const w = await workIndex(new FakeRepo({}), { mintGitHubInstallationToken: async () => ({ outcome: "failed", code: "installation_suspended", message: "The installation is suspended." }) as never });
    const body = await json(await call(w.env, stub, person, "GET", "/work/repositories"));
    expect(body.installations[0]).toMatchObject({ repositories: [], problem: "installation_suspended", problemMessage: "The installation is suspended." });

    const down = new FakeRepo({});
    down.failNext = [{ status: 502, match: /^\/installation\// }];
    const w2 = await workIndex(down);
    const res = await call(w2.env, stub, person, "GET", "/work/repositories");
    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({ code: "unavailable", retryAfterMs: 5_000 });
  });

  it("answers no installations when GitHub is not connected", async () => {
    const w = await workIndex(new FakeRepo({}), { listGitHubInstallations: () => [] });
    expect(await json(await call(w.env, stub, person, "GET", "/work/repositories"))).toEqual({ installations: [] });
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
