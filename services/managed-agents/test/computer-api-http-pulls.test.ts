// Spec 40.9: the GitHub App's pull request webhooks reach Org.acceptPull of the organizations
// that chose a Work repository through the installation; Org records that (test/org.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest";

import { receiveGitHubWebhook } from "../src/edge/git-deploy-service.js";

const SECRET = "s".repeat(32);
const ORG = "org_1";

/** A D1 fake: the index rows for installation 42, no deploy sources; records writes. */
function db(rows: { account_id: string; installation_id: string }[]) {
  const writes: unknown[][] = [];
  return {
    writes,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: sql.includes("github_installation_orgs") && args[0] === 42 ? rows : [] }),
        run: async () => (writes.push([sql, ...args]), {}),
      }),
    }),
  };
}

async function deliver(env: Record<string, unknown>, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
  return receiveGitHubWebhook(
    new Request("https://blue.test/v1/github/webhook", { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${sig}` }, body }),
    { OC_GITHUB_APP_WEBHOOK_SECRET: SECRET, ...env } as never,
  );
}

const repository = { id: 7, full_name: "o/r" };
const pr = { number: 3, title: "Fix", state: "closed", merged: true, merge_commit_sha: "b".repeat(40), html_url: "https://github.com/o/r/pull/3", base: { ref: "main" }, head: { sha: "a".repeat(40), repo: { id: 7 } } };

afterEach(() => vi.unstubAllGlobals());

describe("pull request webhooks (spec 40.9)", () => {
  it("a pull_request event goes to every indexed organization's Org", async () => {
    const org = { acceptPull: vi.fn(async () => undefined) };
    const env = { SERVERLESS_AGENTS_DB: db([{ account_id: ORG, installation_id: "i1" }, { account_id: "org_2", installation_id: "i2" }]), ORGS: { getByName: vi.fn(() => org) } };
    await deliver(env, "pull_request", { action: "closed", installation: { id: 42 }, repository, pull_request: pr });
    expect(org.acceptPull).toHaveBeenCalledTimes(2);
    expect(org.acceptPull).toHaveBeenCalledWith({ url: pr.html_url, state: "merged", checks: null, title: "Fix", head: "a".repeat(40), draft: null, base: "main", sha: "b".repeat(40), at: expect.any(Number) });
    expect(env.ORGS.getByName.mock.calls.map((c) => (c as unknown[])[0])).toEqual([ORG, "org_2"]);
    await deliver(env, "pull_request", { action: "labeled", installation: { id: 42 }, repository, pull_request: pr });
    await deliver(env, "pull_request", { action: "opened", installation: { id: 43 }, repository, pull_request: pr });
    expect(org.acceptPull).toHaveBeenCalledTimes(2);
  });

  it("a completed check suite reads each pull request and carries the conclusion, for the head it is of", async () => {
    const org = { acceptPull: vi.fn(async () => undefined) };
    const accounts = { mintGitHubInstallationToken: vi.fn(async () => ({ outcome: "minted", token: "t" })) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...pr, state: "open", merged: false })));
    const env = { SERVERLESS_AGENTS_DB: db([{ account_id: ORG, installation_id: "i1" }]), ORGS: { getByName: () => org }, ACCOUNTS: { getByName: () => accounts } };
    await deliver(env, "check_suite", { action: "completed", installation: { id: 42 }, repository, check_suite: { conclusion: "failure", head_sha: "a".repeat(40), pull_requests: [{ number: 3 }] } });
    expect(accounts.mintGitHubInstallationToken).toHaveBeenCalledWith({ installationId: "i1", permissions: { pull_requests: "read" } });
    expect(org.acceptPull).toHaveBeenLastCalledWith(expect.objectContaining({ url: pr.html_url, state: "open", checks: "failure" }));
    // A suite of a commit the pull request has moved on from says nothing of its head.
    await deliver(env, "check_suite", { action: "completed", installation: { id: 42 }, repository, check_suite: { conclusion: "success", head_sha: "0".repeat(40), pull_requests: [{ number: 3 }] } });
    expect(org.acceptPull).toHaveBeenLastCalledWith(expect.objectContaining({ head: "a".repeat(40), checks: null }));
  });
});
