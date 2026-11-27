// `GET /work/results/{id}/file`: the bytes of a file the agent sent from a session with no Slack
// thread (calvin's runner/work-tools.ts `fileResult`: a `file` or `document` result whose `ref`
// is the path in the session's workspace), for the dashboard to show it.

import { computerOf, type ActorEnv } from "../../actors/addresses.js";
import type { OrgRpc } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import type { Reply } from "./reply.js";
import { timedDo } from "./request-facts.js";
import { PATH_ID } from "./route-table.js";

/** A path the relay takes: relative, no `..`, no empty part. */
export const isWorkspacePath = (ref: string) => /^[^/]/.test(ref) && ref.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export async function resultFile(request: Request, env: ActorEnv, p: Principal, resultId: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  if (!PATH_ID.resultId!(resultId)) return out.error(404, "not_found", "No such result.");
  // `result` answers null unless `p` may see the result's session.
  const row = await timedDo(out.facts, org().result(p, resultId));
  if (!row || (row.type !== "file" && row.type !== "document") || !isWorkspacePath(row.ref)) {
    return out.error(404, "not_found", "This result is not a file in a workspace.");
  }
  const session = await timedDo(out.facts, org().getSession(p, row.sessionId));
  if (!session.ok) return out.error(404, "not_found", "No such result.");
  const r = await timedDo(
    out.facts,
    computerOf(env, session.session.machine).workspaceFile({ member: p.subject, sessionId: row.sessionId, path: row.ref, ifNoneMatch: request.headers.get("if-none-match") }),
  );
  if (r.ok || r.status === 304) return r;
  const body = (await r.json().catch(() => null)) as { code?: unknown; message?: unknown; retryAfterMs?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "unavailable";
  const message = typeof body?.message === "string" ? body.message : "The file could not be read.";
  // The relay's 404 is a file no longer there; its 403 a session `p` may see but not attach to.
  if (r.status === 404 || r.status === 403) return out.error(404, "path_not_found", "The file is no longer in the workspace.");
  return out.error(r.status >= 500 ? 503 : r.status, code, message, typeof body?.retryAfterMs === "number" ? { retryAfterMs: body.retryAfterMs } : {});
}
