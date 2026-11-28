// `POST /work/results/{id}/merge` and `/revert` (work 118): a person merges a thread's pull request
// from the surface, and undoes it. They are mutations by name and reply (`result.merge`,
// `result.revert`, spec 37.3), but GitHub's part is done here first (edge/github-pull.ts), with an
// installation token as the Computer gets one; Org then records what GitHub did, under the request's
// `Idempotency-Key`. Org is told before GitHub is asked (`mergeIntent`), so a merge whose record is
// lost here is still this person's when GitHub's webhook reports it.

import type { CreateSession, MergeFacts, OrgRpc, RevertFacts } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import { checksOf, deleteMergedBranch, findRevert, mergePull, openRevert, pullPub, readPull, type Failed, type RevertPull } from "../../edge/github-pull.js";
import { pullAccess, type PullEnv } from "./pull-access.js";
import { refusalOf, Reply } from "./reply.js";
import { asObject, bodyOf } from "./request-body.js";
import { timedDo } from "./request-facts.js";
import { PATH_ID } from "./route-table.js";
import { mutateReplyOf } from "./work-routes.js";

type Person = CreateSession["person"];

const WRITE = { contents: "write", pull_requests: "write", checks: "read" } as const;
const SHA = /^[0-9a-f]{40}$/;
/** A click older than this is not merged: one queued while offline should not land as a surprise. */
const STALE_MS = 5 * 60_000;

const refused = (out: Reply, reason: string, message: string, more: Record<string, unknown> = {}) => out.error(409, "refused", message, { reason, ...more });
/** The button is a person's: Org refuses an agent too (`mayMerge`); this is before any call out. */
const agentsDoNot = (out: Reply) => out.error(403, "forbidden", "A person merges here; an agent does not.", { reason: "people_only" });

/** The commit's body: who did it here, and as its co-author when their email is known, so GitHub shows them beside the app. */
function commitMessage(verb: "Merged" | "Reverted", person: Person): string {
  // One line each: a name is the person's own text, and a line break in it would start a trailer.
  const line = (v: string | null | undefined) => v?.replace(/[\r\n<>]+/g, " ").trim() || null;
  const email = line(person?.email);
  const name = line(person?.name) ?? email;
  const coauthor = email ? `\n\nCo-authored-by: ${name ?? email} <${email}>` : "";
  return `${verb}${name ? ` by ${name}` : ""} via OpenComputer.${coauthor}`;
}

type Call = {
  request: Request;
  env: PullEnv;
  p: Principal;
  person: Person;
  resultId: string;
  idem: string | undefined;
  trace: string | undefined;
  org: () => OrgRpc;
  out: Reply;
  /** Keeps Org's record alive when the person's connection drops after GitHub has merged. */
  waitUntil: ((promise: Promise<unknown>) => void) | undefined;
};

/** Org's record of what GitHub did: the mutation's reply. */
function record(c: Call, name: "result.merge" | "result.revert", args: Record<string, unknown>, facts: { merge: MergeFacts } | { revert: RevertFacts }): Promise<Response> {
  const done = timedDo(c.out.facts, c.org().mutate(c.p, { name, args, ...facts, ...(c.idem ? { idem: c.idem } : {}), ...(c.trace ? { trace: c.trace } : {}) }));
  c.waitUntil?.(done.catch(() => undefined));
  return done.then((r) => mutateReplyOf(c.out, r));
}

/** GitHub's refusal of a read or a write, as the reply. */
const failedOf = (c: Call, unavailable: () => Response, f: Failed): Response =>
  f.status >= 500 ? unavailable() : f.status === 404 ? c.out.error(404, "not_found", "No such pull request.") : refused(c.out, "blocked", f.message);

/** `POST /work/results/{id}/merge { head?, at? }`. `head`: the commit the person saw; `at`: when they clicked (ms). */
export async function resultMerge(c: Call): Promise<Response> {
  const { out } = c;
  if (!PATH_ID.resultId!(c.resultId)) return out.error(404, "not_found", "No such result.");
  if (c.p.kind === "agent") return agentsDoNot(out);
  const parsed = await bodyOf(c.request);
  if ("error" in parsed) return out.error(...parsed.error);
  const { head, at } = asObject(parsed.value) ?? {};
  if (head !== undefined && head !== null && !(typeof head === "string" && SHA.test(head))) return out.error(400, "invalid_request", "head is a commit.", { field: "head" });
  if (at !== undefined && at !== null && !(typeof at === "number" && Number.isFinite(at))) return out.error(400, "invalid_request", "at is a time in milliseconds.", { field: "at" });
  const args = { resultId: c.resultId, ...(typeof head === "string" ? { head } : {}), ...(typeof at === "number" ? { at } : {}) };

  const started = await timedDo(out.facts, c.org().mergeStart(c.p, c.resultId, { name: "result.merge", args, ...(c.idem ? { idem: c.idem } : {}) }));
  if (!started.ok) return refusalOf(out, started);
  // A retry of a request already answered: its reply, and GitHub is not asked again.
  if (started.replay) return mutateReplyOf(out, started.replay);
  if (typeof at === "number" && Date.now() - at > STALE_MS) return refused(out, "stale", "That click was a while ago. Merge again if you still mean it.");
  const pull = await pullAccess(c.env, c.p, started.result, WRITE, out);
  if (pull instanceof Response) return pull;
  const { github } = pull;
  const read = await readPull(github, pull.number);
  if (!read.ok) return failedOf(c, pull.unavailable, read);
  const { pr } = read;
  const base = pr.base?.ref;
  const sha = pr.head?.sha;
  if (typeof base !== "string" || typeof sha !== "string") return pull.unavailable();
  const number = Number(pull.number);

  // Merged before (on GitHub, or by a try of this click whose record was lost): Org takes the state, and says whose it was.
  if (pr.merged) return record(c, "result.merge", args, { merge: { number, base, head: sha, method: null, sha: pr.merge_commit_sha ?? null, branchDeleted: false } });
  if (pr.state !== "open") return refused(out, "closed", "The pull request is closed.");
  if (pr.draft) return refused(out, "draft", "The pull request is a draft.");
  if (typeof head === "string" && head !== sha) return refused(out, "changed", "The pull request changed since you looked.", { head: sha });
  if (pr.mergeable === false) return refused(out, "conflicts", `The pull request conflicts with ${base}.`);
  const checks = await checksOf(github, sha);
  if (checks.state === "failing") return refused(out, "checks_failing", `A check did not pass: ${checks.name}.`, { check: checks.name });
  if (checks.state === "running") return refused(out, "checks_running", `Checks are still running: ${checks.name}.`, { check: checks.name });

  const intent = await timedDo(out.facts, c.org().mergeIntent(c.p, c.resultId, { head: sha }));
  if (!intent.ok) return refusalOf(out, intent);
  const merged = await mergePull(github, number, commitMessage("Merged", c.person), sha);
  if (!merged.ok) {
    // No answer is not a refusal: GitHub may have merged, and then the webhook's merge is this person's.
    if (merged.status >= 500) return pull.unavailable();
    await timedDo(out.facts, c.org().mergeIntent(c.p, c.resultId, null)).catch(() => undefined);
    if (merged.status === 409) return refused(out, "changed", "The pull request changed since you looked.");
    return refused(out, "blocked", merged.message);
  }
  // One promise past the response: a connection dropped now loses neither the branch's tidying nor the record.
  const done = (async () => {
    const branchDeleted = await deleteMergedBranch(github, pr).catch(() => false);
    return record(c, "result.merge", args, { merge: { number, base, head: sha, method: merged.method, sha: merged.sha, branchDeleted } });
  })();
  c.waitUntil?.(done.catch(() => undefined));
  return done;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `POST /work/results/{id}/revert`: open the merged pull request's revert, and merge it. A revert GitHub will not merge stays open, and the reply says so. */
export async function resultRevert(c: Call): Promise<Response> {
  const { out } = c;
  if (!PATH_ID.resultId!(c.resultId)) return out.error(404, "not_found", "No such result.");
  if (c.p.kind === "agent") return agentsDoNot(out);
  const args = { resultId: c.resultId };
  const started = await timedDo(out.facts, c.org().mergeStart(c.p, c.resultId, { name: "result.revert", args, ...(c.idem ? { idem: c.idem } : {}) }));
  if (!started.ok) return refusalOf(out, started);
  if (started.replay) return mutateReplyOf(out, started.replay);
  if (started.result.state !== "merged") return refused(out, "not_merged", "The pull request is not merged.");
  const pull = await pullAccess(c.env, c.p, started.result, WRITE, out);
  if (pull instanceof Response) return pull;
  const { github } = pull;

  const intent = await timedDo(out.facts, c.org().mergeIntent(c.p, c.resultId, "revert"));
  if (!intent.ok) return refusalOf(out, intent);
  const giveUp = async (response: Response): Promise<Response> => {
    await timedDo(out.facts, c.org().mergeIntent(c.p, c.resultId, null)).catch(() => undefined);
    return response;
  };

  // The revert this result already has (a retry, or one left open), or GitHub has of it (one whose record was lost): not a second one.
  const had = started.result.pull?.revert;
  let found: RevertPull | null = had ? { number: had.number, url: had.url, title: `Revert #${pull.number}` } : null;
  if (!found) {
    const read = await readPull(github, pull.number);
    if (!read.ok) return giveUp(failedOf(c, pull.unavailable, read));
    if (!read.pr.merged) return giveUp(refused(out, "not_merged", "The pull request is not merged."));
    found = await findRevert(github, pull.owner, read.pr);
    if (!found) {
      const opened = await openRevert(github, read.pr);
      if (!opened.ok) return giveUp(opened.status >= 500 ? pull.unavailable() : refused(out, "blocked", opened.message));
      found = opened.revert;
    }
  }
  let revert: RevertPull = found;
  const left = (why: string) => record(c, "result.revert", args, { revert: { ...revert, merged: false, why } });

  // GitHub works out whether a new pull request merges a moment after it opens.
  let read = await readPull(github, revert.number);
  for (let i = 0; i < 4 && read.ok && !read.pr.merged && read.pr.mergeable === null; i++) {
    await wait(1_000);
    read = await readPull(github, revert.number);
  }
  if (!read.ok) return left(read.message);
  const { pr } = read;
  if (typeof pr.title === "string") revert = { ...revert, title: pr.title };
  if (!pr.merged) {
    if (pr.state !== "open") return left("The revert was closed.");
    if (pr.mergeable === false) return left(`The revert conflicts with ${pr.base?.ref ?? "its base"}.`);
    const merged = await mergePull(github, revert.number, commitMessage("Reverted", c.person), pr.head?.sha);
    if (!merged.ok) return left(merged.message);
  }
  const done = record(c, "result.revert", args, { revert: { ...revert, merged: true, why: null } });
  c.waitUntil?.(deleteMergedBranch(github, pr).catch(() => false));
  return done;
}

/**
 * After a `pr` result is added: read its pull request once, so its head, draft and state are known
 * before GitHub's first webhook about it (which may be never, for one opened long ago). Best effort.
 */
export async function seedPull(env: PullEnv, p: Principal, resultId: string, org: () => OrgRpc, requestId: string): Promise<void> {
  const row = await org().result(p, resultId);
  if (!row || row.type !== "pr" || row.pull?.head) return;
  const pull = await pullAccess(env, p, row, { pull_requests: "read" }, new Reply(requestId));
  if (pull instanceof Response) return;
  const read = await readPull(pull.github, pull.number);
  const pub = read.ok ? pullPub(`${pull.owner}/${pull.repo}`, read.pr, null, Date.now()) : null;
  // The result's own `ref` is what Org matches on.
  if (pub) await org().acceptPull({ ...pub, url: row.ref });
}
