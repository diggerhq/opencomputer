// A result's pull request on GitHub, with an installation token as the Computer gets one: what
// `GET /work/results/{id}/diff` reads with and `POST /work/results/{id}/merge` writes with.

import type { ActorEnv } from "../../actors/addresses.js";
import { type ComputerInstallation, selectTokenTarget } from "../../actors/computer/held-for-org/github.js";
import type { ResultRow } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import type { GitHubTokenMint } from "../../protocol.js";
import type { Reply } from "./reply.js";
import { timedDo } from "./request-facts.js";

/** The actors, and the legacy account object that mints installation tokens. */
export type PullEnv = ActorEnv & { ACCOUNTS: DurableObjectNamespace };

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})\/?$/;

export type PullAccess = {
  owner: string;
  repo: string;
  number: string;
  /** A call to GitHub's API with the token. `path`: under the repository (`/pulls/1`), or absolute (`https://…`). */
  github(path: string, init?: { method?: string; accept?: string; body?: unknown }): Promise<Response>;
  unavailable(): Response;
};

/** The pull request a result names and a token for it, or the response that says why not. */
export async function pullAccess(env: PullEnv, p: Principal, row: ResultRow | null, permissions: Record<string, "read" | "write">, out: Reply): Promise<PullAccess | Response> {
  const pull = row ? PULL_URL.exec(row.ref) : null;
  if (!pull) return out.error(404, "not_found", "This result is not a GitHub pull request.");
  const [, owner, repo, number] = pull as unknown as [string, string, string, string];
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
  const minted = await timedDo(out.facts, account.mintGitHubInstallationToken({ installationId: target.installationId, repositories: [repo], permissions }));
  if (minted.outcome !== "minted") return unavailable();
  const github: PullAccess["github"] = (path, init = {}) =>
    timedDo(out.facts, fetch(path.startsWith("https://") ? path : `https://api.github.com/repos/${owner}/${repo}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${minted.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "user-agent": "opencomputer-managed-agents",
        "x-github-api-version": "2022-11-28",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }));
  return { owner, repo, number, github, unavailable };
}
