// The feed, the occurrence stream, the mutations and the work reads (spec 37.1, 37.3): Org's, as the principal.

import type { CreateSession, MutateReply, OrgRpc } from "../../actors/org/contract.js";
import { CORE_KINDS, LIVE_PROTOCOL } from "../../actors/live/contract.js";
import type { Principal } from "../../auth/principal.js";
import { cursor } from "../../durable/cursor.js";
import { refusalOf, statusOf, type Reply } from "./reply.js";
import { asObject, bodyOf, intParam } from "./request-body.js";
import { timedDo } from "./request-facts.js";
import { repositoriesQuery, repositoryChoice } from "./repository-request.js";
import { PATH_ID, type Route } from "./route-table.js";

const reset = (out: Reply, message: string) => out.error(409, "reset", message, { cursor: null });

/** A mutation's reply (spec 37.3): 200 with `protocol`, or its error with the status of spec 34.2. */
export function mutateReplyOf(out: Reply, r: MutateReply): Response {
  if ("error" in r) {
    const { code, message, ...extra } = r.error;
    return out.error(statusOf(code), code, message ?? `Refused: ${code}.`, extra);
  }
  return out.send(200, r);
}

/** The feed, the occurrence stream, the mutations and the work reads: Org's, as the principal. */
export async function orgRoute(
  request: Request,
  p: Principal,
  person: CreateSession["person"],
  route: Route,
  query: URLSearchParams,
  idem: string | undefined,
  trace: string | undefined,
  org: () => OrgRpc,
  out: Reply,
): Promise<Response> {
  const timed = <T>(call: Promise<T>) => timedDo(out.facts, call);
  const protocol = query.get("protocol");
  if (protocol !== null && !(Number(protocol) >= LIVE_PROTOCOL)) return reset(out, `This server speaks protocol ${LIVE_PROTOCOL}.`);
  // Path ids of the wrong shape name nothing.
  for (const [name, value] of Object.entries(route.args ?? {})) {
    if (PATH_ID[name] && !PATH_ID[name]!(value)) {
      return name === "sid" ? out.error(404, "session_not_found", "No such session.") : out.error(404, "not_found", `No such ${name}.`);
    }
  }
  if (route.sub !== undefined && route.op !== "work.review" && !PATH_ID.tid!(route.sub)) return out.error(404, "not_found", "No such track.");
  if (route.op === "work.review" && !PATH_ID.resultId!(route.sub!)) return out.error(404, "not_found", "No such result.");

  switch (route.op) {
    case "feed": {
      const after = query.get("after") ?? undefined;
      if (after !== undefined && !cursor.read("f", after)) return reset(out, "after is not a cursor of the feed.");
      let kinds = query.get("kinds")?.split(",").filter(Boolean);
      if (!p.scopes.includes("work:read")) {
        if (kinds?.some((k) => !CORE_KINDS.includes(k))) return out.error(403, "forbidden", "Work kinds need the work:read scope.", { reason: "missing_scope", scope: "work:read" });
        kinds ??= CORE_KINDS;
      }
      const frame = await timed(org().feed(p, {
        ...(after !== undefined ? { after } : {}),
        ...(kinds?.length ? { kinds } : {}),
      }));
      if ("reset" in frame) return reset(out, "The feed has moved past this cursor; read a snapshot.");
      return out.send(200, frame);
    }
    case "occurrences": {
      const after = query.get("after") ?? undefined;
      if (after !== undefined && !cursor.read("o", after)) return reset(out, "after is not a cursor of the occurrence stream.");
      const limit = intParam(query, "limit", 1, 1_000);
      if (limit === null) return out.error(400, "invalid_request", "limit is 1 to 1000.", { field: "limit" });
      const r = await timed(org().occurrences(p, { ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) }));
      if ("reset" in r) return reset(out, "The occurrence stream has moved past this cursor.");
      return out.send(200, { protocol: LIVE_PROTOCOL, entries: r.entries, to: r.to });
    }
    case "mutate": {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const body = asObject(parsed.value);
      if (!body) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
      const r = await timed(org().mutate(p, {
        name: route.name!,
        args: { ...body, ...route.args },
        ...(idem ? { idem } : {}),
        ...(trace ? { trace } : {}),
        ...(person ? { person } : {}),
      }));
      return mutateReplyOf(out, r);
    }
    case "work.threads": {
      const limit = intParam(query, "limit", 1, 200);
      if (limit === null) return out.error(400, "invalid_request", "limit is 1 to 200.", { field: "limit" });
      const earlier = query.get("earlier");
      if (earlier !== null && earlier !== "1" && earlier !== "true" && earlier !== "0" && earlier !== "false") return out.error(400, "invalid_request", "earlier is true or false.", { field: "earlier" });
      const track = query.get("track") ?? undefined;
      if (track !== undefined && !PATH_ID.tid!(track)) return out.error(400, "invalid_request", "track is a track id.", { field: "track" });
      const before = query.get("before") ?? undefined;
      if (before !== undefined && !cursor.read("p", before)) return reset(out, "before is not a page cursor.");
      const r = await timed(org().threads(p, {
        ...(earlier === "1" || earlier === "true" ? { earlier: true } : {}),
        ...(track ? { trackId: track } : {}),
        ...(before ? { before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
      return out.send(200, { protocol: LIVE_PROTOCOL, rows: r.rows, next: r.next });
    }
    case "work.thread": {
      // One thread, by id, whatever its age (a deep link to one no page has loaded): the rows a page holds for it.
      const r = await timed(org().thread(p, route.args!.sid!));
      return r ? out.send(200, { protocol: LIVE_PROTOCOL, rows: r.rows }) : out.error(404, "session_not_found", "No such session.");
    }
    case "work.overview":
      return out.send(200, { protocol: LIVE_PROTOCOL, ...(await timed(org().overview(p))) });
    case "work.doc": {
      const doc = await timed(org().doc(p, route.sub!));
      return doc ? out.send(200, { protocol: LIVE_PROTOCOL, doc }) : out.error(404, "not_found", "No such track.");
    }
    case "work.doc.revisions": {
      const rev = route.args?.rev;
      const revisions = await timed(org().docRevisions(p, route.sub!, rev !== undefined ? Number(rev) : undefined));
      if (rev !== undefined) {
        const one = revisions.find((r) => r.rev === Number(rev));
        return one ? out.send(200, { protocol: LIVE_PROTOCOL, revision: one }) : out.error(404, "not_found", "No such revision.");
      }
      return out.send(200, { protocol: LIVE_PROTOCOL, revisions });
    }
    case "work.review": {
      const review = await timed(org().review(p, route.sub!));
      return review ? out.send(200, { protocol: LIVE_PROTOCOL, review }) : out.error(404, "not_found", "No such review.");
    }
    case "work.search": {
      const q = query.get("q") ?? "";
      if (!q.trim() || q.length > 200) return out.error(400, "invalid_request", "q is 1 to 200 characters.", { field: "q" });
      const limit = intParam(query, "limit", 1, 50);
      if (limit === null) return out.error(400, "invalid_request", "limit is 1 to 50.", { field: "limit" });
      const r = await timed(org().search(p, { q, ...(limit !== undefined ? { limit } : {}) }));
      return out.send(200, { protocol: LIVE_PROTOCOL, rows: r.rows });
    }
    case "work.repository.get":
      return out.send(200, { repository: await timed(org().repository(p)) });
    case "work.repositories": {
      const q = repositoriesQuery(query);
      if ("error" in q) return out.of(q.error);
      const r = await timed(org().repositories(p, q.value));
      return r.ok ? out.send(200, { installations: r.installations }) : refusalOf(out, r);
    }
    case "work.repository.put": {
      // Only people change the Work setting (3.9, 3.10): a session's own key is refused.
      if (p.kind === "agent") return out.error(403, "forbidden", "Sessions cannot change Work over this API.", { reason: "computer_principal" });
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const choice = repositoryChoice(parsed.value);
      if ("error" in choice) return out.of(choice.error);
      const r = await timed(org().setRepository(p, choice.value));
      if (!r.ok) return refusalOf(out, r);
      return out.send(200, { repository: r.repository });
    }
    default:
      return out.error(404, "not_found", "No such route.");
  }
}
