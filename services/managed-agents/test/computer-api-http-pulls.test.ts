// Spec 40.9: the GitHub App's pull request webhooks reach Org.acceptPull of the organizations
// that chose a Work repository through the installation; PUT /work/repository records that.

import { afterEach, describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import { memberIdentity } from "./fixtures/identity.js";
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
const pr = { number: 3, title: "Fix", state: "closed", merged: true, html_url: "https://github.com/o/r/pull/3", base: { ref: "main" }, head: { sha: "a".repeat(40), repo: { id: 7 } } };

afterEach(() => vi.unstubAllGlobals());

describe("pull request webhooks (spec 40.9)", () => {
  it("a pull_request event goes to every indexed organization's Org", async () => {
    const org = { acceptPull: vi.fn(async () => undefined) };
    const env = { SERVERLESS_AGENTS_DB: db([{ account_id: ORG, installation_id: "i1" }, { account_id: "org_2", installation_id: "i2" }]), ORGS: { getByName: vi.fn(() => org) } };
    await deliver(env, "pull_request", { action: "closed", installation: { id: 42 }, repository, pull_request: pr });
    expect(org.acceptPull).toHaveBeenCalledTimes(2);
    expect(org.acceptPull).toHaveBeenCalledWith({ url: pr.html_url, state: "merged", checks: null, title: "Fix", at: expect.any(Number) });
    expect(env.ORGS.getByName.mock.calls.map((c) => (c as unknown[])[0])).toEqual([ORG, "org_2"]);
    await deliver(env, "pull_request", { action: "labeled", installation: { id: 42 }, repository, pull_request: pr });
    await deliver(env, "pull_request", { action: "opened", installation: { id: 43 }, repository, pull_request: pr });
    expect(org.acceptPull).toHaveBeenCalledTimes(2);
  });

  it("a completed check suite reads each pull request and carries the conclusion", async () => {
    const org = { acceptPull: vi.fn(async () => undefined) };
    const accounts = { mintGitHubInstallationToken: vi.fn(async () => ({ outcome: "minted", token: "t" })) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...pr, state: "open", merged: false })));
    const env = { SERVERLESS_AGENTS_DB: db([{ account_id: ORG, installation_id: "i1" }]), ORGS: { getByName: () => org }, ACCOUNTS: { getByName: () => accounts } };
    await deliver(env, "check_suite", { action: "completed", installation: { id: 42 }, repository, check_suite: { conclusion: "failure", pull_requests: [{ number: 3 }] } });
    expect(accounts.mintGitHubInstallationToken).toHaveBeenCalledWith({ installationId: "i1", permissions: { pull_requests: "read" } });
    expect(org.acceptPull).toHaveBeenCalledWith(expect.objectContaining({ url: pr.html_url, state: "open", checks: "failure" }));
  });
});

describe("PUT /work/repository records the installation", () => {
  it("writes the organization under GitHub's installation id", async () => {
    const d1 = db([]);
    const repo = { owner: "o", name: "r" };
    const env = {
      SERVERLESS_AGENTS_DB: d1,
      ORGS: { getByName: () => ({ setRepository: vi.fn(async () => ({ ok: true, repository: repo })) }) },
      ACCOUNTS: { getByName: () => ({ getGitHubInstallation: vi.fn(async () => ({ githubInstallationId: 42 })) }) },
    };
    const member = memberIdentity(ORG, "user_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const stub: ComputerApiStub = { computerApi: vi.fn() };
    const res = await routeComputerApi(
      new Request("https://blue.test/v1/computer/work/repository", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId: "i1", owner: "o", name: "r" }) }),
      env as never, member, ORG, stub, "/work/repository",
    );
    expect(res.status).toBe(200);
    expect(d1.writes).toEqual([[expect.stringContaining("github_installation_orgs"), 42, ORG, "i1"]]);
  });
});
