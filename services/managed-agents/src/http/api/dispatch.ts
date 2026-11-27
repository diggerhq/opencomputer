// The Computer session API over HTTP (work 084, opc/docs/api/http): the routes the opencomputer
// edge forwards with `x-opencomputer-surface: api` under `/v1/computer/…` (computer_api.ts in
// opencomputer). Tracks and threads (spec 37): the actors' routes are session-routes.ts and
// work-routes.ts, all as the caller's principal (spec 34.3). The Computer DO keeps its own routes
// (secrets, tickets), served here.
//
// Every response carries a `req_` request id (the caller's when it sent a valid one), as
// `x-request-id` and in error bodies, and a `Server-Timing` of the time spent here.
//
// Telemetry: one `httpapi.request` per request (request-facts.ts), after the response is made, sent
// through the caller's `waitUntil` (never awaited here).

import type { RequestIdentity } from "../../edge/auth.js";
import { crockfordId } from "../../ids/crockford.js";
import { orgOf } from "../../actors/addresses.js";
import { capabilities } from "../../api-objects/capabilities.js";
import type { ComputerEdgeEnv } from "../../actors/computer/config.js";
import { isSessionId } from "../../ids/session-ids.js";
import { TICKET_MAX_SESSIONS } from "../../wire/ticket.js";
import type { ApiOp, ApiReply, ApiRequest } from "../../actors/computer/contract.js";
import type { SecretsApiOp } from "../../actors/computer/held-for-org/secrets/secrets-store.js";
import { Reply } from "./reply.js";
import { bodyOf } from "./request-body.js";
import { requestFact, timedDo, timedStub } from "./request-facts.js";
import { ACTOR_OPS, matchApiRoute, scopeOf } from "./route-table.js";
import { actorRoute } from "./session-routes.js";

/** What api-http needs of the Computer DO stub. */
export interface ComputerApiStub {
  computerApi(accountId: string, caller: ApiRequest, op: ApiOp | SecretsApiOp): Promise<ApiReply>;
}

const REQUEST_ID = /^req_[0-9A-Za-z_-]{4,60}$/;

/** An API error for a refusal made before routing (routes.ts): the same shape, request id and header as the rest. */
export function apiRefusal(request: Request, status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  const incoming = request.headers.get("x-request-id");
  return new Reply(incoming && REQUEST_ID.test(incoming) ? incoming : crockfordId("req", 12)).error(status, code, message, extra);
}

/**
 * An API route; `suffix` is the path after `/v1/computer`. `waitUntil` keeps the request's
 * `httpapi.request` send alive past the response (without it, the event is built and dropped).
 */
export async function routeComputerApi(
  request: Request,
  env: ComputerEdgeEnv,
  identity: RequestIdentity,
  accountId: string,
  computer: ComputerApiStub,
  suffix: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const incoming = request.headers.get("x-request-id");
  const out = new Reply(incoming && REQUEST_ID.test(incoming) ? incoming : crockfordId("req", 12));
  let response: Response | undefined;
  try {
    response = await routeApi(request, env, identity, accountId, computer, suffix, out, waitUntil);
    return response;
  } finally {
    requestFact(env, identity, request.method, out, response?.status ?? 500, waitUntil);
  }
}

async function routeApi(
  request: Request,
  env: ComputerEdgeEnv,
  identity: RequestIdentity,
  accountId: string,
  stub: ComputerApiStub,
  suffix: string,
  out: Reply,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const computer = timedStub(stub, out.facts);
  const route = matchApiRoute(request.method, suffix);
  if (!route) return out.error(404, "not_found", "No such route.");
  out.facts.op = route.op;
  if (route.sessionId) out.facts.sessionId = route.sessionId;
  const p = identity.ocPrincipal;
  if (!p) return out.error(401, "unauthenticated", "The request names no principal.");
  out.facts.via = p.via;
  if (p.subject.startsWith("usr_")) out.facts.member = p.subject;
  const claimed = request.headers.get("x-oc-principal");
  if (claimed !== null && claimed !== `${p.org}/${p.subject}`) {
    return out.error(403, "principal_mismatch", "x-oc-principal is not this credential's principal.");
  }
  // Only people set secrets (work 095): a session's own key, whatever it names, is refused.
  if ((route.op === "secrets" || route.op.startsWith("secrets.")) && p.kind === "agent") {
    return out.error(403, "forbidden", "Sessions cannot read or set secrets over this API.", { reason: "computer_principal" });
  }
  const scope = scopeOf(route.op);
  if (scope && !p.scopes.includes(scope)) {
    return out.error(403, "forbidden", `This key does not have the ${scope} scope.`, { reason: "missing_scope", scope });
  }
  const idem = request.headers.get("idempotency-key") ?? undefined;
  if (idem !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idem)) return out.error(400, "invalid_request", "Idempotency-Key is 1 to 255 printable characters.", { field: "Idempotency-Key" });
  if (ACTOR_OPS.has(route.op)) {
    // `Session.owner`'s name and email: the credential's, for a person or their key.
    const person = p.kind === "member" || p.kind === "key" ? { name: identity.userName ?? null, email: identity.userEmail ?? null } : undefined;
    return actorRoute(request, env, p, person, route, idem, out, waitUntil);
  }
  // The Computer's own routes (secrets, tickets), as the same principal.
  const ua = request.headers.get("user-agent");
  const caller: ApiRequest = {
    principal: p,
    name: identity.userName ?? null,
    email: identity.userEmail ?? null,
    client: ua ? ua.replace(/[^\x20-\x7e]|\|/g, "").slice(0, 64) || null : null,
    ...(identity.apiKey ? { apiKey: identity.apiKey } : {}),
    requestId: out.requestId,
    userAgent: ua,
  };
  const call = (op: ApiOp | SecretsApiOp) => computer.computerApi(accountId, caller, op).then((reply) => out.of(reply));

  if (route.op === "secrets") return out.error(409, "feature_unavailable", "Only organization secrets can be set over this API for now.", { feature: "secrets" });
  if (route.op === "secrets.list") return call({ op: "secrets.list" });
  if (route.op.startsWith("secrets.session.")) {
    // A session's own layer: Org judges who may see the session (else 404); the Computer holds its runner.
    const sessionId = route.sessionId!;
    if (!isSessionId(sessionId) || !(await timedDo(out.facts, orgOf(env, p.org).getSession(p, sessionId))).ok) return out.error(404, "session_not_found", "No such session.");
    if (route.op === "secrets.session.list") return call({ op: "secrets.session.list", sessionId });
  }
  if (route.op.startsWith("secrets.")) {
    const name = route.sub!;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      if (route.op === "secrets.put" || route.op === "secrets.session.put") return out.error(400, "invalid_name", "A name is letters, digits and _, not starting with a digit (at most 64).", { field: "name" });
      return out.error(404, "secret_not_found", route.sessionId ? "No such secret on this session." : "No such organization secret.");
    }
    if (route.op === "secrets.events") return call({ op: "secrets.events", name });
    if (route.op === "secrets.delete") return call({ op: "secrets.delete", name });
    if (route.op === "secrets.session.delete") return call({ op: "secrets.session.delete", sessionId: route.sessionId!, name });
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    return call(route.op === "secrets.session.put"
      ? { op: "secrets.session.put", sessionId: route.sessionId!, name, body: parsed.value }
      : { op: "secrets.put", name, body: parsed.value });
  }
  if (route.op === "me") return call({ op: "me" });
  if (route.op === "capabilities" && !route.sessionId) return out.send(200, { capabilities: capabilities() });

  const needsBody = request.method === "POST" || request.method === "PATCH" || request.method === "PUT";
  let body: unknown;
  if (needsBody) {
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    body = parsed.value;
  }
  if (route.op === "ticket") {
    // Owner first (spec 36.1): a ticket names only sessions the caller may use; the relay checks again on attach.
    // A body the Computer refuses anyway (no key, a project key, an agent's, a bad list) goes there for its answer.
    const named = body && typeof body === "object" && !Array.isArray(body) ? (body as { sessionIds?: unknown }).sessionIds : undefined;
    const mints = identity.apiKey && identity.apiKey.kind !== "project" && p.kind !== "agent";
    if (mints && Array.isArray(named) && named.length <= TICKET_MAX_SESSIONS && named.every((id) => typeof id === "string" && isSessionId(id))) {
      const org = orgOf(env, p.org);
      const seen = await timedDo(out.facts, Promise.all([...new Set(named as string[])].map((id) => org.getSession(p, id))));
      if (seen.some((r) => !r.ok)) return out.error(404, "session_not_found", "No such session.");
    }
    return call({ op: "ticket", body });
  }

  // Per-session capabilities: the same for every session, once Org says the principal may see it.
  const sessionId = route.sessionId!;
  if (!isSessionId(sessionId) || !(await timedDo(out.facts, orgOf(env, p.org).getSession(p, sessionId))).ok) return out.error(404, "session_not_found", "No such session.");
  return out.send(200, { capabilities: capabilities() });
}
