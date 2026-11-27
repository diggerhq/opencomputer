// `POST /work/results/{id}/merge` and `/revert` (work 118): a person merges a thread's pull request
// from the surface, and undoes it. They are mutations by name and reply (`result.merge`,
// `result.revert`, spec 37.3), but GitHub's part is done here first, with an installation token as
// the Computer gets one; Org then records what GitHub did, under the request's `Idempotency-Key`.

import type { CreateSession, MergeFacts, OrgRpc, RevertFacts } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import { pullAccess, type PullAccess, type PullEnv } from "./pull-access.js";
import { refusalOf, type Reply } from "./reply.js";
import { asObject, bodyOf } from "./request-body.js";
import { timedDo } from "./request-facts.js";
import { PATH_ID } from "./route-table.js";
import { mutateReplyOf } from "./work-routes.js";

type Pull = {
  node_id?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  mergeable?: boolean | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } };
};
type Person = CreateSession["person"];
type Method = NonNullable<MergeFacts["method"]>;

/** The methods in the order tried: the first the repository allows. */
const METHODS: Method[] = ["squash", "merge", "rebase"];
const WRITE = { contents: "write", pull_requests: "write" } as const;
const SHA = /^[0-9a-f]{40}$/;

const refused = (out: Reply, reason: string, message: string, more: Record<string, unknown> = {}) => out.error(409, "refused", message, { reason, ...more });
/** The button is a person's: Org refuses an agent too (`mayMerge`); this is before any call out. */
const agentsDoNot = (out: Reply) => out.error(403, "forbidden", "A person merges here; an agent does not.", { reason: "people_only" });
const messageOf = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : `GitHub answered ${String(response.status)}.`;
};

/** The commit's body: who did it here, and as its co-author when their email is known, so GitHub shows them beside the app. */
function commitMessage(verb: "Merged" | "Reverted", person: Person): string {
  const name = person?.name?.trim() || person?.email || null;
  const coauthor = person?.email ? `\n\nCo-authored-by: ${name ?? person.email} <${person.email}>` : "";
  return `${verb}${name ? ` by ${name}` : ""} via OpenComputer.${coauthor}`;
}

/** Merge a pull request by the first method its repository allows. `sha`: only if that is still its head. */
async function mergePull(pull: PullAccess, number: string | number, message: string, sha?: string): Promise<{ ok: true; method: Method; sha: string | null } | { ok: false; status: number; message: string }> {
  let last = { ok: false as const, status: 405, message: "This repository allows no merge method." };
  for (const method of METHODS) {
    const response = await pull.github(`/pulls/${String(number)}/merge`, { method: "PUT", body: { merge_method: method, ...(method === "rebase" ? {} : { commit_message: message }), ...(sha ? { sha } : {}) } }).catch(() => null);
    if (!response) return { ok: false, status: 503, message: "GitHub did not answer." };
    if (response.ok) return { ok: true, method, sha: ((await response.json().catch(() => null)) as { sha?: string } | null)?.sha ?? null };
    last = { ok: false, status: response.status, message: await messageOf(response) };
    if (!(response.status === 405 && /not allowed on this repository/i.test(last.message))) break;
  }
  return last;
}

/** Delete a merged pull request's branch. True when it is gone. */
async function deleteBranch(pull: PullAccess, ref: string): Promise<boolean> {
  const response = await pull.github(`/git/refs/heads/${ref.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" }).catch(() => null);
  // 422: the repository deleted it on merge.
  return response?.status === 204 || response?.status === 422;
}

const readPull = async (pull: PullAccess, number: string | number): Promise<Pull | Response | null> => {
  const response = await pull.github(`/pulls/${String(number)}`).catch(() => null);
  if (!response || response.status >= 500) return null;
  if (!response.ok) return response;
  return (await response.json()) as Pull;
};

type Call = { request: Request; env: PullEnv; p: Principal; person: Person; resultId: string; idem: string | undefined; trace: string | undefined; org: () => OrgRpc; out: Reply };

/** Org's record of what GitHub did: the mutation's reply. */
async function record(c: Call, name: "result.merge" | "result.revert", args: Record<string, unknown>, github: MergeFacts | RevertFacts): Promise<Response> {
  const r = await timedDo(c.out.facts, c.org().mutate(c.p, { name, args, github, ...(c.idem ? { idem: c.idem } : {}), ...(c.trace ? { trace: c.trace } : {}) }));
  return mutateReplyOf(c.out, r);
}

/** `POST /work/results/{id}/merge { head? }`. */
export async function resultMerge(c: Call): Promise<Response> {
  const { out } = c;
  if (!PATH_ID.resultId!(c.resultId)) return out.error(404, "not_found", "No such result.");
  if (c.p.kind === "agent") return agentsDoNot(out);
  const parsed = await bodyOf(c.request);
  if ("error" in parsed) return out.error(...parsed.error);
  const head = asObject(parsed.value)?.head;
  if (head !== undefined && head !== null && !(typeof head === "string" && SHA.test(head))) return out.error(400, "invalid_request", "head is a commit.", { field: "head" });
  const args = { resultId: c.resultId, ...(typeof head === "string" ? { head } : {}) };

  const started = await timedDo(out.facts, c.org().mergeStart(c.p, c.resultId, "merge"));
  if (!started.ok) return refusalOf(out, started);
  const pull = await pullAccess(c.env, c.p, started.result, WRITE, out);
  if (pull instanceof Response) return pull;
  const pr = await readPull(pull, pull.number);
  if (pr === null) return pull.unavailable();
  if (pr instanceof Response) return pr.status === 404 ? out.error(404, "not_found", "No such pull request.") : refused(out, "blocked", await messageOf(pr));
  const base = pr.base?.ref;
  if (typeof base !== "string" || typeof pr.head?.sha !== "string") return pull.unavailable();
  const number = Number(pull.number);

  // Merged before (on GitHub, or by this request's first try): Org takes the state, and a retry gets its first reply.
  if (pr.merged) return record(c, "result.merge", args, { number, base, method: null, sha: pr.merge_commit_sha ?? null, branchDeleted: false });
  if (pr.state !== "open") return refused(out, "closed", "The pull request is closed.");
  if (pr.draft) return refused(out, "draft", "The pull request is a draft.");
  if (typeof head === "string" && head !== pr.head.sha) return refused(out, "changed", "The pull request changed since you looked.", { head: pr.head.sha });
  if (pr.mergeable === false) return refused(out, "conflicts", `The pull request conflicts with ${base}.`);

  const merged = await mergePull(pull, number, commitMessage("Merged", c.person), pr.head.sha);
  if (!merged.ok) {
    if (merged.status >= 500) return pull.unavailable();
    if (merged.status === 409) return refused(out, "changed", "The pull request changed since you looked.");
    return refused(out, "blocked", merged.message);
  }
  const own = pr.head.repo?.full_name !== undefined && pr.head.repo.full_name === pr.base?.repo?.full_name;
  const branchDeleted = own && typeof pr.head.ref === "string" ? await deleteBranch(pull, pr.head.ref) : false;
  return record(c, "result.merge", args, { number, base, method: merged.method, sha: merged.sha, branchDeleted });
}

const REVERT = "mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { number url headRefName } } }";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `POST /work/results/{id}/revert`: open the merged pull request's revert, and merge it. A revert GitHub will not merge stays open, and the reply says so. */
export async function resultRevert(c: Call): Promise<Response> {
  const { out } = c;
  if (!PATH_ID.resultId!(c.resultId)) return out.error(404, "not_found", "No such result.");
  if (c.p.kind === "agent") return agentsDoNot(out);
  const args = { resultId: c.resultId };
  const started = await timedDo(out.facts, c.org().mergeStart(c.p, c.resultId, "revert"));
  if (!started.ok) return refusalOf(out, started);
  if (started.result.state !== "merged") return refused(out, "not_merged", "The pull request is not merged.");
  const pull = await pullAccess(c.env, c.p, started.result, WRITE, out);
  if (pull instanceof Response) return pull;

  // The revert this result already has (a retry, or one left open): not a second one.
  const had = asObject((started.result.meta as Record<string, unknown> | null)?.revert) as Partial<RevertFacts> | null;
  let revert = had && typeof had.number === "number" && typeof had.url === "string" ? { number: had.number, url: had.url } : null;
  if (revert && had?.merged === true) return record(c, "result.revert", args, { ...revert, merged: true });
  if (!revert) {
    const pr = await readPull(pull, pull.number);
    if (pr === null) return pull.unavailable();
    if (pr instanceof Response) return pr.status === 404 ? out.error(404, "not_found", "No such pull request.") : refused(out, "blocked", await messageOf(pr));
    if (!pr.merged || typeof pr.node_id !== "string") return refused(out, "not_merged", "The pull request is not merged.");
    const response = await pull.github("https://api.github.com/graphql", { method: "POST", body: { query: REVERT, variables: { id: pr.node_id } } }).catch(() => null);
    if (!response || response.status >= 500) return pull.unavailable();
    const made = (await response.json().catch(() => null)) as { data?: { revertPullRequest?: { revertPullRequest?: { number?: number; url?: string } | null } | null }; errors?: { message?: string }[] } | null;
    const opened = made?.data?.revertPullRequest?.revertPullRequest;
    if (typeof opened?.number !== "number" || typeof opened.url !== "string") return refused(out, "blocked", made?.errors?.[0]?.message ?? "GitHub did not open the revert.");
    revert = { number: opened.number, url: opened.url };
  }

  // GitHub works out whether a new pull request merges a moment after it opens.
  let pr = await readPull(pull, revert.number);
  for (let i = 0; i < 4 && pr !== null && !(pr instanceof Response) && !pr.merged && pr.mergeable === null; i++) {
    await wait(1_000);
    pr = await readPull(pull, revert.number);
  }
  if (pr === null || pr instanceof Response) return record(c, "result.revert", args, { ...revert, merged: false });
  if (!pr.merged) {
    const merged = pr.mergeable === false ? null : await mergePull(pull, revert.number, commitMessage("Reverted", c.person));
    if (!merged?.ok) return record(c, "result.revert", args, { ...revert, merged: false });
  }
  if (typeof pr.head?.ref === "string") await deleteBranch(pull, pr.head.ref);
  return record(c, "result.revert", args, { ...revert, merged: true });
}
