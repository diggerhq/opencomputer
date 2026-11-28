// `GET /work/results/{id}/diff` (spec 37.1).

import { LIVE_PROTOCOL } from "../../actors/live/contract.js";
import type { OrgRpc } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import { pullAccess, type PullEnv } from "./pull-access.js";
import type { Reply } from "./reply.js";
import { timedDo } from "./request-facts.js";
import { PATH_ID } from "./route-table.js";

/** What the diff reads: the actors, and the legacy account object that mints installation tokens. */
export type ResultDiffEnv = PullEnv;

/**
 * `GET /work/results/{id}/diff` (spec 37.1): the result's pull request diff, fetched with an
 * installation token as the Computer gets one. `ETag` is the head commit.
 */
export async function resultDiff(request: Request, env: ResultDiffEnv, p: Principal, resultId: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  if (!PATH_ID.resultId!(resultId)) return out.error(404, "not_found", "No such result.");
  const row = await timedDo(out.facts, org().result(p, resultId));
  const pull = await pullAccess(env, p, row, { contents: "read", pull_requests: "read" }, out);
  if (pull instanceof Response) return pull;
  const { unavailable } = pull;
  const github = (accept: string) => pull.github(`/pulls/${pull.number}`, { accept });
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
