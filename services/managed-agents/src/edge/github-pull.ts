// A pull request on GitHub, as the platform reads and changes it (work 118): its state, its checks,
// its merge, its branch and its revert. Every call goes through a `RepoCall`, which holds the token.

import type { MergeMethod, PullPub } from "../actors/org/contract.js";
import { GITHUB_API, gitHubHeaders } from "./github.js";

/** A call to GitHub's API. `path`: under the repository (`/pulls/1`), "" for the repository itself, or absolute (`https://…`). */
export type RepoCall = (path: string, init?: { method?: string; accept?: string; body?: unknown }) => Promise<Response>;

/** How long one call to GitHub may take: a merge request holds a person's click. */
const CALL_MS = 10_000;

export function repoCall(token: string, owner: string, repo: string): RepoCall {
  return (path, init = {}) =>
    fetch(path.startsWith("https://") ? path : `${GITHUB_API}/repos/${owner}/${repo}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...gitHubHeaders(`Bearer ${token}`),
        ...(init.accept ? { accept: init.accept } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(CALL_MS),
    });
}

export type Pull = {
  node_id?: string;
  number?: number;
  html_url?: string;
  title?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  mergeable?: boolean | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } };
};

/** GitHub did not answer (or answered 5xx), or refused in its own words. */
export type Failed = { ok: false; status: number; message: string };
const NO_ANSWER: Failed = { ok: false, status: 503, message: "GitHub did not answer." };

const messageOf = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : `GitHub answered ${String(response.status)}.`;
};
const failed = async (response: Response | null): Promise<Failed> => (!response || response.status >= 500 ? NO_ANSWER : { ok: false, status: response.status, message: await messageOf(response) });
const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

export async function readPull(github: RepoCall, number: string | number): Promise<{ ok: true; pr: Pull } | Failed> {
  const response = await github(`/pulls/${String(number)}`).catch(() => null);
  if (!response?.ok) return failed(response);
  return { ok: true, pr: (await response.json()) as Pull };
}

/** A pull request as Org takes it (`acceptPull`); null when GitHub's object lacks a field. `checks`: a completed suite's conclusion, for this head. */
export function pullPub(fullName: string, pr: Pull, checks: string | null, at: number): PullPub | null {
  if (typeof pr.number !== "number" || typeof pr.title !== "string") return null;
  const merged = pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at !== "");
  const state = merged ? "merged" : pr.state === "open" ? "open" : pr.state === "closed" ? "closed" : null;
  if (!state) return null;
  const url = typeof pr.html_url === "string" ? pr.html_url : `https://github.com/${fullName}/pull/${String(pr.number)}`;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const head = pr.head !== null && typeof pr.head === "object" ? str(pr.head.sha) : null;
  const base = pr.base !== null && typeof pr.base === "object" ? str(pr.base.ref) : null;
  return { url, state, checks, title: pr.title, at, head, draft: typeof pr.draft === "boolean" ? pr.draft : null, base, sha: merged ? str(pr.merge_commit_sha) : null };
}

/** A check run's conclusions that do not hold a merge back. */
const CLEAN = new Set(["success", "neutral", "skipped"]);

/**
 * The check runs of a commit, as a merge takes them: `failing` names the first that did not pass,
 * `running` the first not finished. Read at the click, since what the surface last heard may be of
 * an older commit. `unknown`: GitHub would not say, and its own rules decide.
 */
export async function checksOf(github: RepoCall, sha: string): Promise<{ state: "clean" | "unknown" } | { state: "failing" | "running"; name: string }> {
  const response = await github(`/commits/${sha}/check-runs?per_page=100&filter=latest`).catch(() => null);
  if (!response?.ok) return { state: "unknown" };
  const runs = ((await response.json().catch(() => null)) as { check_runs?: { name?: string; status?: string; conclusion?: string | null }[] } | null)?.check_runs ?? [];
  const failing = runs.find((r) => r.status === "completed" && !CLEAN.has(r.conclusion ?? ""));
  if (failing) return { state: "failing", name: failing.name ?? "a check" };
  const running = runs.find((r) => r.status !== "completed");
  if (running) return { state: "running", name: running.name ?? "a check" };
  return { state: "clean" };
}

/** The methods in the order tried: the first the repository allows. */
const METHODS: MergeMethod[] = ["squash", "merge", "rebase"];

/** Merge a pull request by the first method its repository allows. `sha`: only if that is still its head. */
export async function mergePull(github: RepoCall, number: string | number, message: string, sha?: string): Promise<{ ok: true; method: MergeMethod; sha: string | null } | Failed> {
  let last: Failed = { ok: false, status: 405, message: "This repository allows no merge method." };
  for (const method of METHODS) {
    const response = await github(`/pulls/${String(number)}/merge`, { method: "PUT", body: { merge_method: method, ...(method === "rebase" ? {} : { commit_message: message }), ...(sha ? { sha } : {}) } }).catch(() => null);
    if (response?.ok) return { ok: true, method, sha: ((await response.json().catch(() => null)) as { sha?: string } | null)?.sha ?? null };
    last = await failed(response);
    if (!(last.status === 405 && /not allowed on this repository/i.test(last.message))) break;
  }
  return last;
}

/**
 * Delete a merged pull request's branch, as GitHub's own button does: not a fork's, and not one
 * another open pull request is based on (GitHub would close that one). True when the branch is gone,
 * or the repository deletes merged branches itself.
 */
export async function deleteMergedBranch(github: RepoCall, pr: Pull): Promise<boolean> {
  const ref = pr.head?.ref;
  if (typeof ref !== "string" || pr.head?.repo?.full_name === undefined || pr.head.repo.full_name !== pr.base?.repo?.full_name) return false;
  const repository = await github("").catch(() => null);
  if (repository?.ok && ((await repository.json().catch(() => null)) as { delete_branch_on_merge?: boolean } | null)?.delete_branch_on_merge === true) return true;
  const based = await github(`/pulls?state=open&base=${encodeURIComponent(ref)}&per_page=1`).catch(() => null);
  if (!based?.ok || ((await based.json().catch(() => [])) as unknown[]).length > 0) return false;
  const response = await github(`/git/refs/heads/${refPath(ref)}`, { method: "DELETE" }).catch(() => null);
  if (response?.status === 204) return true;
  // 422 is also "protected": only "does not exist" says it is gone.
  return response?.status === 422 && /does not exist/i.test(await messageOf(response));
}

const REVERT = "mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { number url title } } }";

export type RevertPull = { number: number; url: string; title: string };

/** The revert GitHub already has of a merged pull request (its branch is `revert-<number>-<head>`), open or merged; null when it has none. */
export async function findRevert(github: RepoCall, owner: string, pr: Pull): Promise<RevertPull | null> {
  if (typeof pr.number !== "number" || typeof pr.head?.ref !== "string") return null;
  const response = await github(`/pulls?state=all&head=${encodeURIComponent(`${owner}:revert-${String(pr.number)}-${pr.head.ref}`)}&per_page=10`).catch(() => null);
  if (!response?.ok) return null;
  const found = ((await response.json().catch(() => [])) as Pull[]).find((v) => v.state === "open" || v.merged_at);
  return found && typeof found.number === "number" && typeof found.html_url === "string" ? { number: found.number, url: found.html_url, title: found.title ?? `Revert #${String(pr.number)}` } : null;
}

/** Open the revert of a merged pull request. */
export async function openRevert(github: RepoCall, pr: Pull): Promise<{ ok: true; revert: RevertPull } | Failed> {
  if (typeof pr.node_id !== "string") return { ok: false, status: 422, message: "GitHub did not say which pull request this is." };
  const response = await github(`${GITHUB_API}/graphql`, { method: "POST", body: { query: REVERT, variables: { id: pr.node_id } } }).catch(() => null);
  if (!response || response.status >= 500) return NO_ANSWER;
  const made = (await response.json().catch(() => null)) as { data?: { revertPullRequest?: { revertPullRequest?: Partial<RevertPull> | null } | null }; errors?: { message?: string }[] } | null;
  const opened = made?.data?.revertPullRequest?.revertPullRequest;
  if (typeof opened?.number !== "number" || typeof opened.url !== "string") return { ok: false, status: 422, message: made?.errors?.[0]?.message ?? "GitHub did not open the revert." };
  return { ok: true, revert: { number: opened.number, url: opened.url, title: opened.title ?? `Revert #${String(pr.number ?? "")}` } };
}
