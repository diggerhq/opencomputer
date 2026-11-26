import { describe, expect, it } from "vitest";

import { checkChoice, listGranted, type TokenMinter } from "../src/actors/org/repository.js";
import { branchName, repositoriesQuery, repositoryChoice } from "../src/http/api/repository-request.js";

/** The knowledge repository setting and the picker (spec 37, 43), against a fake GitHub. */

const account = (over: Partial<TokenMinter> = {}): TokenMinter => ({
  mintGitHubInstallationToken: async () => ({ outcome: "minted", token: "ghs_test", expiresAt: "2099-01-01T00:00:00Z" }),
  getGitHubInstallation: () => ({ accountLogin: "acme" }),
  listGitHubInstallations: () => [{ id: "12", githubInstallationId: 9012, accountLogin: "acme", accountType: "Organization", state: "active" }],
  ...over,
});

/** A fake api.github.com: path to [status, body]; everything else 404. */
function github(routes: Record<string, [number, unknown] | (() => [number, unknown])>) {
  const log: string[] = [];
  const fetch = async (url: string) => {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    log.push(path);
    const hit = routes[path];
    const [status, body] = typeof hit === "function" ? hit() : (hit ?? [404, { message: "Not Found" }]);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, log };
}

describe("checkChoice", () => {
  const repo: [number, unknown] = [200, { id: 7, name: "Knowledge", owner: { login: "acme" }, default_branch: "trunk" }];

  it("stores the names GitHub gives and the default branch", async () => {
    const gh = github({ "/repos/acme/knowledge": repo, "/repos/acme/knowledge/git/ref/heads/trunk": [200, { object: { sha: "abc" } }] });
    expect(await checkChoice(account(), gh.fetch, { installationId: "12", owner: "acme", name: "knowledge" })).toEqual({
      ok: true,
      repository: { installationId: "12", owner: "acme", name: "Knowledge", branch: "trunk", id: 7 },
    });
  });

  it("refuses another account's owner, a missing repository or branch, and answers 503 when GitHub is down", async () => {
    const gh = github({ "/repos/acme/knowledge": repo });
    expect(await checkChoice(account(), gh.fetch, { installationId: "12", owner: "other", name: "knowledge" })).toMatchObject({ ok: false, status: 400, field: "owner", reason: "owner_mismatch" });
    expect(await checkChoice(account(), gh.fetch, { installationId: "12", owner: "acme", name: "nope" })).toMatchObject({ ok: false, status: 400, field: "name", reason: "repository_not_found" });
    expect(await checkChoice(account(), gh.fetch, { installationId: "12", owner: "acme", name: "knowledge", branch: "gone" })).toMatchObject({ ok: false, field: "branch", reason: "branch_not_found" });
    expect(await checkChoice(account({ getGitHubInstallation: () => null }), gh.fetch, { installationId: "12", owner: "acme", name: "knowledge" })).toMatchObject({ ok: false, field: "installationId", reason: "installation_removed" });
    const down = github({ "/repos/acme/knowledge": [502, {}] });
    expect(await checkChoice(account(), down.fetch, { installationId: "12", owner: "acme", name: "knowledge" })).toMatchObject({ ok: false, status: 503, code: "unavailable" });
  });
});

describe("listGranted", () => {
  const installations = [
    { id: "12", githubInstallationId: 9012, accountLogin: "acme", accountType: "Organization", state: "active" },
    { id: "13", githubInstallationId: 9013, accountLogin: "ana", accountType: "User", state: "active" },
    { id: "14", githubInstallationId: 9014, accountLogin: "old", accountType: "Organization", state: "suspended" },
  ];
  const granted = (n: number, total: number) => [200, { total_count: total, repositories: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `r${i}`, owner: { login: "acme" }, pushed_at: "2026-11-01T00:00:00Z" })) }] as [number, unknown];

  it("lists each active installation, most recently pushed first, with its settings page", async () => {
    const gh = github({
      "/installation/repositories?per_page=100&page=1": [200, {
        total_count: 3,
        repositories: [
          { id: 2, name: "empty", owner: { login: "acme" }, pushed_at: null },
          { id: 3, name: "site", owner: { login: "acme" }, private: true, pushed_at: "2026-10-01T00:00:00Z" },
          { id: 1, name: "app", owner: { login: "acme" }, pushed_at: "2026-11-18T00:00:00Z" },
        ],
      }],
    });
    const r = await listGranted(account({ listGitHubInstallations: () => installations }), gh.fetch, {});
    if (!r.ok) throw new Error(r.code);
    expect(r.installations.map((i) => i.id)).toEqual(["12", "13"]);
    expect(r.installations[0]).toMatchObject({ accountType: "Organization", settingsUrl: "https://github.com/organizations/acme/settings/installations/9012", nextPage: null, truncated: false, problem: null });
    expect(r.installations[1]!.settingsUrl).toBe("https://github.com/settings/installations/9013");
    expect(r.installations[0]!.repositories.map((x) => x.name)).toEqual(["app", "site", "empty"]);
    expect(r.installations[0]!.repositories[1]).toEqual({ id: 3, owner: "acme", name: "site", private: true, defaultBranch: "main", pushedAt: "2026-10-01T00:00:00Z" });
  });

  it("pages, names an installation's problem, and answers 503 when GitHub is down", async () => {
    const gh = github({ "/installation/repositories?per_page=100&page=1": granted(100, 520), "/installation/repositories?per_page=100&page=6": granted(20, 520) });
    const first = await listGranted(account(), gh.fetch, {});
    expect(first.ok && first.installations[0]).toMatchObject({ nextPage: 2, truncated: false });
    const last = await listGranted(account(), gh.fetch, { installationId: "12", page: 6 });
    expect(last.ok && last.installations[0]).toMatchObject({ nextPage: null });
    expect(await listGranted(account(), gh.fetch, { installationId: "99" })).toEqual({ ok: true, installations: [] });

    const suspended = account({ mintGitHubInstallationToken: async () => ({ outcome: "failed", code: "installation_suspended", message: "Suspended.", retryable: false }) });
    expect(await listGranted(suspended, gh.fetch, {})).toMatchObject({ ok: true, installations: [{ repositories: [], problem: "installation_suspended", problemMessage: "Suspended." }] });
    const down = github({ "/installation/repositories?per_page=100&page=1": [502, {}] });
    expect(await listGranted(account(), down.fetch, {})).toMatchObject({ ok: false, code: "unavailable", status: 503 });
  });
});

describe("the requests", () => {
  it("checks a choice and a picker query", () => {
    expect(repositoryChoice({ installationId: 5, owner: "o", name: "r" })).toEqual({ value: { installationId: "5", owner: "o", name: "r" } });
    expect(repositoryChoice({ installationId: "5", owner: "o", name: "r", branch: "a..b" })).toMatchObject({ error: { status: 400, error: { field: "branch" } } });
    expect(repositoryChoice({ installationId: "5", owner: "o", name: "r", x: 1 })).toMatchObject({ error: { error: { field: "x" } } });
    expect(repositoriesQuery(new URLSearchParams("installation=12&page=6"))).toEqual({ value: { installationId: "12", page: 6 } });
    expect(repositoriesQuery(new URLSearchParams("page=2"))).toMatchObject({ error: { error: { field: "installation" } } });
    expect(repositoriesQuery(new URLSearchParams("installation=12&page=101"))).toMatchObject({ error: { error: { field: "page" } } });
  });

  it("follows git check-ref-format for a branch", () => {
    for (const ok of ["main", "trunk", "feat/work-index", "release-1.2", "a_b", "x@y", "ü"]) expect(branchName(ok), ok).toBe(true);
    for (const bad of ["", "-x", "a..b", "a/", "/a", "a//b", "a.lock", "a/b.lock", ".a", "a/.b", "a.", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "@", "a@{b", "a\u0001b", "a\u007fb", "x".repeat(256)]) {
      expect(branchName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
