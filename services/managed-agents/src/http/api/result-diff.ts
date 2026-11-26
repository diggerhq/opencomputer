// `GET /work/results/{id}/diff` (spec 37.1).

import type { ActorEnv } from "../../actors/addresses.js";
import { type ComputerInstallation, selectTokenTarget } from "../../actors/computer/held-for-org/github.js";
import { LIVE_PROTOCOL } from "../../actors/live/contract.js";
import type { OrgRpc } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import type { GitHubTokenMint } from "../../protocol.js";
import type { Reply } from "./reply.js";
import { timedDo } from "./request-facts.js";
import { PATH_ID } from "./route-table.js";

/** What the diff reads: the actors, and the legacy account object that mints installation tokens. */
export type ResultDiffEnv = ActorEnv & { ACCOUNTS: DurableObjectNamespace };

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})\/?$/;

/**
 * `GET /work/results/{id}/diff` (spec 37.1): the result's pull request diff, fetched with an
 * installation token as the Computer gets one. `ETag` is the head commit.
 */
export async function resultDiff(request: Request, env: ResultDiffEnv, p: Principal, resultId: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  if (!PATH_ID.resultId!(resultId)) return out.error(404, "not_found", "No such result.");
  const row = await timedDo(out.facts, org().result(p, resultId));
  const pull = row ? PULL_URL.exec(row.ref) : null;
  if (!pull) return out.error(404, "not_found", "This result is not a GitHub pull request.");
  const [, owner, repo, number] = pull;
  const account = env.ACCOUNTS.getByName(p.org) as unknown as {
    listGitHubInstallations(): Promise<{ id: string | number; accountLogin: string; state: string }[]>;
    mintGitHubInstallationToken(input: { installationId: string; repositories?: string[]; permissions?: Record<string, "read" | "write"> }): Promise<GitHubTokenMint>;
  };
  const unavailable = () => out.error(503, "unavailable", "GitHub did not answer. Try again shortly.", { retryAfterMs: 5_000 });
  const installations: ComputerInstallation[] = (await timedDo(out.facts, account.listGitHubInstallations()))
    .filter((i) => i.state === "active")
    .map((i) => ({ id: String(i.id), accountLogin: i.accountLogin }));
  const target = selectTokenTarget([`${owner}/${repo}`], installations, []);
  if (!target.ok) return out.error(409, "github_not_connected", target.error);
  const minted = await timedDo(out.facts, account.mintGitHubInstallationToken({ installationId: target.installationId, repositories: [repo!], permissions: { contents: "read", pull_requests: "read" } }));
  if (minted.outcome !== "minted") return unavailable();
  const github = (accept: string) =>
    timedDo(out.facts, fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { authorization: `Bearer ${minted.token}`, accept, "user-agent": "opencomputer-managed-agents", "x-github-api-version": "2022-11-28" },
    }));
  const meta = await github("application/vnd.github+json").catch(() => null);
  if (meta?.status === 404) return out.error(404, "not_found", "No such pull request.");
  if (!meta?.ok) return unavailable();
  const head = ((await meta.json()) as { head?: { sha?: unknown } }).head?.sha;
  if (typeof head !== "string") return unavailable();
  const etag = `"${head}"`;
  if (request.headers.get("if-none-match") === etag) {
    const response = out.send(304, null);
    response.headers.set("etag", etag);
    return response;
  }
  const diff = await github("application/vnd.github.diff").catch(() => null);
  if (!diff?.ok) return unavailable();
  const response = out.send(200, { protocol: LIVE_PROTOCOL, head, diff: await diff.text() });
  response.headers.set("etag", etag);
  return response;
}
