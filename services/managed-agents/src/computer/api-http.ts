// The Computer session API over HTTP (work 084, opc/docs/api/http): the routes the opencomputer
// edge forwards with `x-opencomputer-surface: api` under `/v1/computer/…` (computer_api.ts in
// opencomputer). Tracks and threads (spec 37): the session directory is Org's, the writes go
// through the session's inbox (SessionLog `accept`, then the machine's Computer `drain`), and the
// log's reads go straight to its SessionLog, all as the caller's principal (spec 34.3). The
// Computer DO keeps its own routes (secrets, tickets, the Work setting, session controls).
//
// Every response carries a `req_` request id (the caller's when it sent a valid one), as
// `x-request-id` and in error bodies, and a `Server-Timing` of the time spent here.
//
// Telemetry (work 084 instrumentation, Q3/Q4): one `httpapi.request` per request, after the
// response is made, sent through the caller's `waitUntil` (never awaited here). Facts only: the
// route family and op, status, error code, time in the Computer DO and the SessionLog, a long-poll's
// wait and whether it came back empty, the events delivered and their age. Never a path, query,
// body or key.

import type { RequestIdentity } from "../edge/auth.js";
import { readBoundedText } from "../edge/http.js";
import { base64url, computerOf, cursor, hashOf, liveOf, logOf, orgOf } from "../actor/index.js";
import type { CreateSession, DrainResult, InboxKind, ListQuery, Principal, Refusal, SessionRow } from "../actor/index.js";
import { eventsStream } from "../live/contract.js";
import type { ApiScope, LogSummary } from "./api-types.js";
import { API_SCOPES } from "./api-types.js";
import { capabilities, checkSettings, PLAN_EXIT_MODES } from "./capabilities.js";
import type { ComputerEdgeEnv } from "./config.js";
import { apiScopes } from "./keys.js";
import { COMPUTER_PRINCIPAL, principalOf } from "../edge/computer-principal.js";
import { CROCKFORD, isId, isSessionId, memberId } from "./session-ids.js";
import type { ApiCaller, ApiOp, ApiReply, WriteMethod } from "./sessions-api.js";
import type { SecretsApiOp } from "./secrets-store.js";
import type { WorkContextOp, WorkRefsOp, WorkStampOp } from "./work/briefs.js";
import { type WorkRoute, workApi } from "./work/api.js";
import type { WorkIndexRpc } from "./work/index-contract.js";
import { gatewayTelemetry } from "./telemetry/gateway.js";

/** What api-http needs of the Computer DO stub. */
export interface ComputerApiStub {
  computerApi(accountId: string, caller: ApiCaller, op: ApiOp | SecretsApiOp | WorkContextOp | WorkStampOp | WorkRefsOp): Promise<ApiReply>;
}

const BODY_MAX_BYTES = 512 * 1024;
const REQUEST_ID = /^req_[0-9A-Za-z_-]{4,60}$/;
const ID = /^[a-z]{2,4}_[0-9a-z]{4,40}$/;
const ASK_STATUSES = new Set(["open", "answered", "dismissed", "declined", "interrupted", "all"]);

interface Route {
  op: string;
  sessionId?: string;
  sub?: string;
}

/** `METHOD /suffix` → the route; null when it is not one of the API's. */
export function matchApiRoute(method: string, suffix: string): Route | null {
  const p = suffix.split("/").filter(Boolean);
  const is = (m: string, n: number) => method === m && p.length === n;
  if (is("GET", 1) && p[0] === "me") return { op: "me" };
  if (is("POST", 1) && p[0] === "tickets") return { op: "ticket" };
  // Secret writes: organization and session layers; personal secrets remain unavailable over HTTP.
  if (is("GET", 1) && p[0] === "secrets") return { op: "secrets.list" };
  if (is("GET", 3) && p[0] === "secrets" && p[2] === "events") return { op: "secrets.events", sub: p[1] };
  if (p[0] === "organization" && p[1] === "secrets" && p.length === 3 && (method === "PUT" || method === "DELETE")) {
    return { op: method === "PUT" ? "secrets.put" : "secrets.delete", sub: p[2] };
  }
  if (p[0] === "me" && p[1] === "secrets" && p.length === 3 && (method === "PUT" || method === "DELETE")) return { op: "secrets" };
  // The same for every session, so the new-session screen can read it before there is one.
  if (is("GET", 1) && p[0] === "capabilities") return { op: "capabilities" };
  // The Work API (work tracking 3.10): the organization's items, read from its knowledge repository.
  if (p[0] === "work") {
    if (p[1] === "repository" && p.length === 2) return method === "GET" ? { op: "work.repository.get" } : method === "PUT" ? { op: "work.repository.put" } : null;
    if (p[1] === "repositories") return is("GET", 2) ? { op: "work.repositories" } : null;
    // The items a session worked on, for the session's screen.
    if (p[1] === "sessions") return is("GET", 4) && p[3] === "items" ? { op: "work.session.items", sub: p[2] } : null;
    if (p[1] !== "items") return null;
    if (is("GET", 2)) return { op: "work.items" };
    if (is("GET", 3)) return { op: "work.item", sub: p[2] };
    if (is("GET", 4) && p[3] === "history") return { op: "work.history", sub: p[2] };
    return null;
  }
  if (p[0] !== "sessions") return null;
  if (p.length === 1) return method === "GET" ? { op: "list" } : method === "POST" ? { op: "create" } : null;
  const sessionId = p[1]!;
  if (is("GET", 2)) return { op: "get", sessionId };
  if (is("PATCH", 2)) return { op: "patch", sessionId };
  const r = p[2];
  if (is("GET", 3) && r === "capabilities") return { op: "capabilities", sessionId };
  // Set aside (work-tracking 3.8): the Computer DO's own column, never the writer.
  if (is("PUT", 3) && r === "aside") return { op: "aside.set", sessionId };
  if (is("DELETE", 3) && r === "aside") return { op: "aside.clear", sessionId };
  if (is("POST", 3) && (r === "interrupt" || r === "compact" || r === "suspend" || r === "resume")) return { op: `sessions.${r}`, sessionId };
  if (r === "turns") {
    if (is("POST", 3)) return { op: "turns.send", sessionId };
    if (is("GET", 3)) return { op: "turns.list", sessionId };
    if (is("GET", 4)) return { op: "turns.get", sessionId, sub: p[3] };
    if (is("POST", 5) && p[4] === "cancel") return { op: "turns.cancel", sessionId, sub: p[3] };
  }
  if (is("GET", 3) && r === "events") return { op: "events.list", sessionId };
  if (r === "asks") {
    if (is("GET", 3)) return { op: "asks.list", sessionId };
    if (is("GET", 4)) return { op: "asks.get", sessionId, sub: p[3] };
    if (is("POST", 5) && (p[4] === "answer" || p[4] === "dismiss")) return { op: `asks.${p[4]}`, sessionId, sub: p[3] };
  }
  if (r === "subagents") {
    if (is("GET", 3)) return { op: "subagents.list", sessionId };
    if (is("GET", 4)) return { op: "subagents.get", sessionId, sub: p[3] };
    if (is("POST", 5) && p[4] === "stop") return { op: "subagents.stop", sessionId, sub: p[3] };
  }
  if (r === "secrets" && is("PUT", 4)) return { op: "secrets.session.put", sessionId, sub: p[3] };
  if (r === "secrets" && is("DELETE", 4)) return { op: "secrets", sessionId };
  return null;
}

/** The scope a route needs. */
function scopeOf(op: string): ApiScope | null {
  if (op === "me" || op === "ticket") return null;
  if (op === "asks.answer" || op === "asks.dismiss") return "asks:answer";
  if (op === "secrets" || op === "secrets.put" || op === "secrets.delete" || op === "secrets.session.put") return "secrets:write";
  if (op === "secrets.events") return "sessions:read";
  if (op === "work.repository.put") return "work:write";
  if (op.startsWith("work.")) return "work:read";
  if (op === "list" || op === "get" || op === "capabilities" || op.endsWith(".list") || op.endsWith(".get")) return "sessions:read";
  return "sessions:write";
}

/** What one request's `httpapi.request` reports, filled on the way. */
interface RequestFacts {
  op: string;
  via?: string;
  member?: string;
  sessionId?: string;
  /** Time awaiting the Computer DO / the SessionLog, ms. */
  doMs: number;
  logMs: number;
  /** A long-poll's requested wait, ms. */
  waitMs?: number;
  /** events.list: events returned, and now − createdAt of the first and last. */
  events?: number;
  oldestAgeMs?: number;
  newestAgeMs?: number;
  replayed?: boolean;
  errorCode?: string;
}

class Reply {
  readonly started = performance.now();
  readonly facts: RequestFacts = { op: "unknown", doMs: 0, logMs: 0 };
  constructor(readonly requestId: string) {}

  send(status: number, body: unknown): Response {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": this.requestId,
      "server-timing": `blue;dur=${(performance.now() - this.started).toFixed(1)}`,
    });
    return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), { status, headers });
  }

  error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
    this.facts.errorCode = code;
    const retryable = extra.retryable ?? (status === 429 || status === 500 || status === 503 || code === "queue_full");
    const response = this.send(status, { error: { ...extra, code, message, requestId: this.requestId, retryable } });
    if (typeof extra.retryAfterMs === "number") response.headers.set("retry-after", String(Math.max(1, Math.ceil(extra.retryAfterMs / 1000))));
    return response;
  }

  of(reply: ApiReply): Response {
    if ((reply.body as { duplicate?: unknown } | undefined)?.duplicate === true) this.facts.replayed = true;
    if (reply.error) {
      const { code, message, ...extra } = reply.error;
      return this.error(reply.status, code, message, extra);
    }
    return this.send(reply.status, reply.body);
  }
}

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `req_${[...bytes].map((b) => alphabet[b & 31]).join("")}`;
}

/** The caller as the DO needs it; refuses project keys. */
async function callerOf(request: Request, identity: RequestIdentity, requestId: string): Promise<ApiCaller | null> {
  const key = identity.apiKey;
  if (key?.kind === "project") return null;
  const ua = request.headers.get("user-agent");
  const via = ua?.startsWith("opc/") ? "opc" : key ? "api" : "dashboard";
  return {
    member: await memberId(identity.userId),
    userId: identity.userId,
    // The edge folds an organization's `owner` and `admin` roles into `admin`.
    admin: identity.role === "admin" || identity.role === "owner",
    name: identity.userName ?? null,
    email: identity.userEmail ?? null,
    via,
    client: ua ? ua.replace(/[^\x20-\x7e]|\|/g, "").slice(0, 64) || null : null,
    scopes: key ? apiScopes(key.scopes) : [...API_SCOPES],
    ...(key ? { apiKey: key } : {}),
    requestId,
    userAgent: ua,
  };
}

async function bodyOf(request: Request): Promise<{ value: unknown } | { error: [number, string, string, Record<string, unknown>] }> {
  const text = await readBoundedText(request, BODY_MAX_BYTES);
  if (text === null) return { error: [413, "payload_too_large", "The body is too large.", {}] };
  if (!text.trim()) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: [400, "invalid_request", "The body is not JSON.", { field: "" }] };
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value === undefined ? {} : value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A non-negative integer query parameter in [min, max]; undefined when absent; null when bad. */
function intParam(query: URLSearchParams, name: string, min: number, max: number): number | undefined | null {
  const raw = query.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** An API error for a refusal made before routing (routes.ts): the same shape, request id and header as the rest. */
export function apiRefusal(request: Request, status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  const incoming = request.headers.get("x-request-id");
  return new Reply(incoming && REQUEST_ID.test(incoming) ? incoming : newRequestId()).error(status, code, message, extra);
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
  const out = new Reply(incoming && REQUEST_ID.test(incoming) ? incoming : newRequestId());
  let response: Response | undefined;
  try {
    response = await routeApi(request, env, identity, accountId, computer, suffix, out);
    return response;
  } finally {
    requestFact(env, identity, request.method, out, response?.status ?? 500, waitUntil);
  }
}

/** The closed route families of `httpapi.request` and `edge.request` (the catalog's list). */
export function routeFamily(op: string): string {
  if (op === "list" || op === "create" || op === "get" || op === "patch" || op === "capabilities" || op.startsWith("aside.")) return "sessions";
  if (op.startsWith("sessions.")) return "control";
  if (op === "events.list") return "events";
  if (op.startsWith("turns.")) return "turns";
  if (op.startsWith("asks.")) return "asks";
  if (op.startsWith("subagents.")) return "subagents";
  if (op === "ticket") return "tickets";
  if (op === "secrets" || op.startsWith("secrets.")) return "secrets";
  if (op.startsWith("work.")) return "work";
  return "other";
}

const OPS = new Set([
  "me", "ticket", "secrets", "secrets.list", "secrets.events", "secrets.put", "secrets.delete", "secrets.session.put", "list", "create", "get", "patch", "capabilities",
  "aside.set", "aside.clear",
  "sessions.interrupt", "sessions.compact", "sessions.suspend", "sessions.resume",
  "turns.send", "turns.list", "turns.get", "turns.cancel", "events.list",
  "asks.list", "asks.get", "asks.answer", "asks.dismiss", "subagents.list", "subagents.get", "subagents.stop",
  "work.repository.get", "work.repository.put", "work.repositories", "work.items", "work.item", "work.history", "work.session.items",
]);

/** The request's one `httpapi.request`; never throws, never awaited. */
function requestFact(env: ComputerEdgeEnv, identity: RequestIdentity, method: string, out: Reply, status: number, waitUntil: ((p: Promise<unknown>) => void) | undefined): void {
  try {
    const f = out.facts;
    const ms = Math.round(performance.now() - out.started);
    const t = gatewayTelemetry(env, { base: { org_id: identity.accountId } });
    const op = OPS.has(f.op) ? f.op : "other";
    const code = f.errorCode && /^[a-z][a-z0-9_]{0,63}$/.test(f.errorCode) ? f.errorCode : f.errorCode ? "other" : undefined;
    t.emit("httpapi.request", {
      surface: f.via === "opc" ? "cli" : "api",
      ...(f.sessionId && isSessionId(f.sessionId) ? { session_key: f.sessionId } : {}),
      ...(f.member ? { person_id: f.member } : {}),
      duration_ms: ms,
      outcome: status < 400 ? "completed" : "failed",
      ...(code ? { error_type: "unknown" as const, error_code: code } : {}),
      data: {
        route: routeFamily(op),
        op,
        method: ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ? method : "other",
        status,
        do_ms: Math.round(f.doMs),
        log_ms: Math.round(f.logMs),
        ...(f.waitMs !== undefined ? { wait_ms: f.waitMs } : {}),
        ...(f.events !== undefined ? { events: f.events, empty: f.events === 0 } : {}),
        ...(f.oldestAgeMs !== undefined ? { oldest_age_ms: f.oldestAgeMs } : {}),
        ...(f.newestAgeMs !== undefined ? { newest_age_ms: f.newestAgeMs } : {}),
        ...(f.replayed ? { replayed: true } : {}),
      },
    });
    const done = t.done();
    if (waitUntil) waitUntil(done);
  } catch {
    // Telemetry never fails the request.
  }
}

/** The DO stub, timed into the request's facts. */
function timedStub(computer: ComputerApiStub, facts: RequestFacts): ComputerApiStub {
  return {
    async computerApi(accountId, caller, op) {
      const began = performance.now();
      try {
        return await computer.computerApi(accountId, caller, op);
      } finally {
        facts.doMs += performance.now() - began;
      }
    },
  };
}

/** A SessionLog read, timed into the request's facts. */
async function timedLog<T>(facts: RequestFacts, read: Promise<T>): Promise<T> {
  const began = performance.now();
  try {
    return await read;
  } finally {
    facts.logMs += performance.now() - began;
  }
}

/** events.list's delivered events and their age (now − createdAt), for `httpapi.request`. */
function delivered(facts: RequestFacts, events: ReadonlyArray<{ createdAt: string }>): void {
  facts.events = events.length;
  if (!events.length) return;
  const now = Date.now();
  const age = (at: string) => {
    const t = Date.parse(at);
    return Number.isFinite(t) ? Math.max(0, Math.round(now - t)) : undefined;
  };
  const oldest = age(events[0]!.createdAt);
  const newest = age(events[events.length - 1]!.createdAt);
  if (oldest !== undefined) facts.oldestAgeMs = oldest;
  if (newest !== undefined) facts.newestAgeMs = newest;
}

async function routeApi(
  request: Request,
  env: ComputerEdgeEnv,
  identity: RequestIdentity,
  accountId: string,
  stub: ComputerApiStub,
  suffix: string,
  out: Reply,
): Promise<Response> {
  const computer = timedStub(stub, out.facts);
  const route = matchApiRoute(request.method, suffix);
  if (!route) return out.error(404, "not_found", "No such route.");
  out.facts.op = route.op;
  if (route.sessionId) out.facts.sessionId = route.sessionId;
  const p = await principalOf(identity, request.headers.get("user-agent"));
  if (!p) return out.error(403, "forbidden", "Project keys cannot use sessions.", { reason: "project_key" });
  out.facts.via = p.via;
  if (p.subject.startsWith("usr_")) out.facts.member = p.subject;
  const claimed = request.headers.get("x-oc-principal");
  if (claimed !== null && claimed !== `${p.org}/${p.subject}`) {
    return out.error(403, "principal_mismatch", "x-oc-principal is not this credential's principal.");
  }
  if (ACTOR_OPS.has(route.op)) return actorRoute(request, env, p, route, out);
  // The Computer's own routes (secrets, tickets, Work settings, session controls) keep today's caller and scopes.
  const caller = await callerOf(request, identity, out.requestId);
  if (!caller) return out.error(403, "forbidden", "Project keys cannot use sessions.", { reason: "project_key" });
  // Only people set secrets (work 095): a session's own key, whatever it names, is refused.
  if ((route.op === "secrets" || route.op.startsWith("secrets.")) && identity.principal === COMPUTER_PRINCIPAL) {
    return out.error(403, "forbidden", "Sessions cannot read or set secrets over this API.", { reason: "computer_principal" });
  }
  // Only people change the Work setting (3.9, 3.10): a session's own key is refused on writes.
  if (route.op === "work.repository.put" && identity.principal === COMPUTER_PRINCIPAL) {
    return out.error(403, "forbidden", "Sessions cannot change Work over this API.", { reason: "computer_principal" });
  }
  const scope = scopeOf(route.op);
  if (scope && !caller.scopes.includes(scope)) {
    return out.error(403, "forbidden", `This key does not have the ${scope} scope.`, { reason: "missing_scope", scope });
  }
  const idem = request.headers.get("idempotency-key") ?? undefined;
  if (idem !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idem)) return out.error(400, "invalid_request", "Idempotency-Key is 1 to 255 printable characters.", { field: "Idempotency-Key" });
  const url = new URL(request.url);
  const query = url.searchParams;
  const call = (op: ApiOp | SecretsApiOp) => computer.computerApi(accountId, caller, op).then((reply) => out.of(reply));

  if (route.op.startsWith("work.")) {
    let body: unknown;
    if (request.method === "PUT") {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      body = parsed.value;
    }
    const index = env.WORK_INDEX ? (env.WORK_INDEX.getByName(accountId) as unknown as WorkIndexRpc) : null;
    const reply = await workApi(
      { accountId, caller, index, context: (op) => computer.computerApi(accountId, caller, op) },
      route as WorkRoute,
      query,
      body,
      request.headers.get("if-none-match"),
    );
    const response = out.of(reply);
    if (reply.etag) response.headers.set("etag", reply.etag);
    if (reply.asOf) response.headers.set("work-as-of", reply.asOf);
    return response;
  }
  if (route.op === "secrets") return out.error(409, "feature_unavailable", "Only organization secrets can be set over this API for now.", { feature: "secrets" });
  if (route.op === "secrets.list") return call({ op: "secrets.list" });
  if (route.op.startsWith("secrets.")) {
    const name = route.sub!;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      return (route.op === "secrets.put" || route.op === "secrets.session.put") ? out.error(400, "invalid_name", "A name is letters, digits and _, not starting with a digit (at most 64).", { field: "name" }) : out.error(404, "secret_not_found", "No such organization secret.");
    }
    if (route.op === "secrets.events") return call({ op: "secrets.events", name });
    if (route.op === "secrets.delete") return call({ op: "secrets.delete", name });
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
  if (route.op === "ticket") return call({ op: "ticket", body });

  const sessionId = route.sessionId!;
  if (!isSessionId(sessionId)) return out.error(404, "session_not_found", "No such session.");
  if (route.sub !== undefined && !ID.test(route.sub)) {
    const what = route.op.split(".")[0]!.replace(/s$/, "");
    return out.error(404, `${what}_not_found`, `No such ${what}.`);
  }

  if (route.op === "patch") return call({ op: "patch", sessionId, body, ...(idem ? { idempotencyKey: idem } : {}) });
  if (route.op === "aside.set") return call({ op: "aside.set", sessionId, body });
  if (route.op === "aside.clear") return call({ op: "aside.clear", sessionId });

  // Writes to the session's writer.
  if (needsBody) {
    const input = asObject(body);
    if (!input) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
    const params = writeParams(route, input);
    if ("error" in params) return out.error(400, params.code ?? "invalid_request", params.error, { field: params.field });
    return call({ op: "call", sessionId, method: route.op as WriteMethod, params: params.value, ...(idem ? { idempotencyKey: idem } : {}) });
  }

  // Per-session capabilities: the same for every session, after the Computer's access check.
  const access = await computer.computerApi(accountId, caller, { op: "access", sessionId });
  if (access.error) return out.of(access);
  return out.send(200, { capabilities: capabilities() });
}

type Params = { value: Record<string, unknown> } | { error: string; field: string; code?: string };

/** A write's body as the method's params; unknown fields are refused (the writer decodes strictly too). */
export function writeParams(route: Route, body: Record<string, unknown>): Params {
  const allow = (...fields: string[]): Params => {
    const bad = Object.keys(body).find((k) => !fields.includes(k));
    return bad ? { error: `Unknown field ${bad}.`, field: bad } : { value: { ...body } };
  };
  switch (route.op) {
    case "turns.send": {
      if (typeof body.input !== "string" || body.input.length < 1 || body.input.length > 100_000) {
        return { error: "input must be a string of 1 to 100,000 characters.", field: "input" };
      }
      if (body.ifBusy !== undefined && body.ifBusy !== "queue" && body.ifBusy !== "steer" && body.ifBusy !== "interrupt") {
        return { error: "ifBusy is queue, steer or interrupt.", field: "ifBusy" };
      }
      if (body.id !== undefined && !isId("tn", body.id)) return { error: "id must be tn_ and 12 lowercase Crockford base32 characters.", field: "id" };
      return allow("id", "input", "ifBusy");
    }
    case "turns.cancel":
      return Object.keys(body).length ? { error: `Unknown field ${Object.keys(body)[0]}.`, field: Object.keys(body)[0]! } : { value: { turnId: route.sub } };
    case "sessions.interrupt":
      return allow("turnId");
    case "sessions.compact":
      return allow("instructions");
    case "sessions.suspend":
      return allow("ifIdle");
    case "sessions.resume":
      return allow();
    case "asks.answer": {
      // calvin's rule (asks.ts PLAN_EXIT_MODES): `mode` only with allow, one of the plan-exit modes.
      if (body.mode !== undefined) {
        if (body.decision !== "allow" || typeof body.mode !== "string" || !PLAN_EXIT_MODES.includes(body.mode)) {
          return { error: `mode is one of ${PLAN_EXIT_MODES.join(", ")}, sent only with decision allow.`, field: "mode", code: "invalid_answer" };
        }
      }
      return { value: { askId: route.sub, answer: body } };
    }
    case "asks.dismiss": {
      const r = allow("message");
      if ("value" in r && r.value.message !== undefined && (typeof r.value.message !== "string" || r.value.message.length > 2000)) {
        return { error: "message is at most 2,000 characters.", field: "message" };
      }
      return "value" in r ? { value: { askId: route.sub, ...r.value } } : r;
    }
    case "subagents.stop":
      return Object.keys(body).length ? { error: `Unknown field ${Object.keys(body)[0]}.`, field: Object.keys(body)[0]! } : { value: { subagentId: route.sub } };
    default:
      return { error: "Not a write.", field: "" };
  }
}

// ------------------------------------------------------------------ the actors' routes (spec 37)

/** The routes served by the actors of tracks and threads, not the Computer object. */
const ACTOR_OPS = new Set([
  "list", "create", "get",
  "turns.send", "asks.answer", "asks.dismiss", "sessions.interrupt",
  "events.list", "turns.list", "turns.get", "asks.list", "asks.get", "subagents.list", "subagents.get",
]);

const TRACK_ID = /^trk_[0-9a-hjkmnp-tv-z]{16}$/;
const TRACE = /^[\x21-\x7e]{1,64}$/;
const ENTRY_KINDS = { "turns.send": "turn", "asks.answer": "answer", "asks.dismiss": "dismiss", "sessions.interrupt": "interrupt" } as const;

/** SessionLog's reads as they take the principal and a cursor (session-log lane, spec 37.1). */
type LogRefused = { ok: false; error: string; cursor?: string | null; seq?: number; retryAfterMs?: number; [field: string]: unknown };
type LogPage = { ok: true; [field: string]: unknown };
type EventsAnswer = (LogPage & { events: { createdAt: string }[]; cursor?: string }) | LogRefused;
interface LogReads {
  summary(minSeq: number | undefined, p: Principal): Promise<{ ok: true; summary: LogSummary } | LogRefused>;
  events(q: Record<string, unknown>, p: Principal): Promise<EventsAnswer>;
  turns(q: Record<string, unknown>, p: Principal): Promise<LogPage | LogRefused>;
  turn(turnId: string, q: Record<string, unknown>, p: Principal): Promise<LogPage | LogRefused>;
  asks(q: Record<string, unknown>, p: Principal): Promise<LogPage | LogRefused>;
  ask(askId: string, minSeq: number | undefined, p: Principal): Promise<LogPage | LogRefused>;
  subagents(q: Record<string, unknown>, p: Principal): Promise<LogPage | LogRefused>;
  subagent(subagentId: string, minSeq: number | undefined, p: Principal): Promise<LogPage | LogRefused>;
}
const readsOf = (env: ComputerEdgeEnv, sessionId: string) => logOf(env, sessionId) as unknown as LogReads;

const STATUS_OF: Record<string, number> = {
  invalid_request: 400,
  forbidden: 403,
  principal_mismatch: 403,
  not_found: 404,
  refused: 409,
  taken: 409,
  conflict: 409,
  out_of_order: 409,
  idempotency_conflict: 409,
  reset: 409,
  agent_turns: 409,
  inbox_full: 429,
  unavailable: 503,
  computer_unavailable: 503,
  // The host's refusals of a delivered entry (spec 40.2).
  ask_closed: 409,
  queue_full: 429,
  insufficient_credits: 402,
  model_refused: 403,
};
const statusOf = (code: string, status?: unknown): number =>
  typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600 ? status : (STATUS_OF[code] ?? (code.endsWith("_not_found") ? 404 : 400));

/** An actor's refusal as the HTTP error of spec 34.2. */
function refusalOf(out: Reply, r: Refusal): Response {
  const { ok: _ok, code, status, message, ...extra } = r;
  return out.error(statusOf(code, status), code, message ?? `Refused: ${code}.`, extra);
}

/** A host's error from a delivered entry (`ask_closed`, `queue_full`, …), with its own status when it has one. */
function hostErrorOf(out: Reply, error: NonNullable<Extract<DrainResult, { state: "delivered" }>["results"][number]["error"]>): Response {
  const { code, message, requestId: _requestId, retryable: _retryable, status, ...extra } = error;
  return out.error(typeof status === "number" || code in STATUS_OF ? statusOf(code, status) : 500, code, message, extra);
}

/** A SessionLog read's refusal: `reset` is 409 with its cursor; one the caller may not see is `not_found`. */
function logRefusalOf(out: Reply, r: LogRefused): Response {
  if (r.error === "reset") return out.error(409, "reset", "The cursor's position no longer exists.", { cursor: r.cursor ?? null, ...(r.seq !== undefined ? { seq: r.seq } : {}) });
  if (r.error === "invalid_cursor" || r.error === "cursor_ahead") return out.error(409, "reset", "The cursor cannot be read.", { cursor: null });
  if (r.error === "unavailable") return out.error(503, "unavailable", "The session has not reached minSeq yet.", { retryAfterMs: r.retryAfterMs ?? 1_000 });
  if (r.error === "forbidden" || r.error === "not_found") return out.error(404, "not_found", "No such session.");
  return out.error(404, r.error, `No such ${r.error.replace(/_not_found$/, "")}.`);
}

const strip = <T extends { ok: true }>(r: T): Omit<T, "ok"> => {
  const { ok: _ok, ...rest } = r;
  return rest;
};

/** `<prefix>_` and `length` Crockford characters: of the hash of `seed` when given (a retry lands on the same id), else random. */
async function entryId(prefix: string, length: number, seed?: unknown): Promise<string> {
  const bytes = seed === undefined ? crypto.getRandomValues(new Uint8Array(length)) : base64url.decode(await hashOf(seed))!;
  let id = `${prefix}_`;
  for (let i = 0; i < length; i++) id += CROCKFORD[bytes[i]! & 31];
  return id;
}

/** Time awaiting an actor other than the SessionLog, into the request's facts. */
async function timedDo<T>(facts: RequestFacts, call: Promise<T>): Promise<T> {
  const began = performance.now();
  try {
    return await call;
  } finally {
    facts.doMs += performance.now() - began;
  }
}

type Sent = { delivered: unknown } | { waking: true } | { response: Response };

/**
 * One inbox entry, as spec 40.2: `SessionLog.accept`, then `drain` on the machine it names. Delivered:
 * the host's result (or its error); not up: waking.
 */
async function sendEntry(env: ComputerEdgeEnv, p: Principal, sessionId: string, entry: { id: string; kind: InboxKind; body: unknown }, trace: string | undefined, out: Reply): Promise<Sent> {
  const accepted = await timedLog(out.facts, logOf(env, sessionId).accept(p, { ...entry, ...(trace ? { trace } : {}) }));
  if (!accepted.ok) {
    const code = accepted.code === "forbidden" ? "not_found" : accepted.code;
    return { response: refusalOf(out, { ok: false, code, message: code === "not_found" ? "No such session." : `Refused: ${code}.` }) };
  }
  if (accepted.duplicate) out.facts.replayed = true;
  if (accepted.duplicate && accepted.result !== undefined) return { delivered: accepted.result };
  const drained = await timedDo(out.facts, computerOf(env, accepted.machine).drain(sessionId, { wait: true }));
  if (drained.state === "waking") return { waking: true };
  // Not among the results: the session's own drain delivered it; its outcome shows in the session's row.
  const mine = drained.results.find((r) => r.id === entry.id);
  if (!mine) return { waking: true };
  if (mine.error) return { response: hostErrorOf(out, mine.error) };
  return { delivered: mine.result ?? null };
}

/**
 * The wait rule (spec 37.1): the owner was read and had nothing new; wait on Live's stream, then read
 * again. Without Live, poll the owner every second until the timeout.
 */
async function waitFor<T>(env: ComputerEdgeEnv, p: Principal, stream: string, after: string, waitMs: number, first: T, read: () => Promise<T>, fresh: (r: T) => boolean): Promise<T> {
  const live = liveOf(env, p.org);
  if (live) {
    const waited = await live.wait(p, stream, after, waitMs).catch(() => null);
    return waited?.moved ? read() : first;
  }
  const deadline = Date.now() + waitMs;
  let r = first;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
    r = await read();
    if (fresh(r)) return r;
  }
  return r;
}

type CreateInput = CreateSession & { turnId?: string };

/** `POST /sessions`'s body. `parent`, `writers`, `slackThread`, `origin` and `harness` are the actors' own, never a request's. */
function createInput(body: unknown): { value: CreateInput } | { error: [number, string, string, Record<string, unknown>] } {
  const input = asObject(body);
  const bad = (field: string, message: string) => ({ error: [400, "invalid_request", message, { field }] as [number, string, string, Record<string, unknown>] });
  if (!input) return bad("", "The body must be a JSON object.");
  const fields = new Set(["id", "input", "turnId", "title", "model", "effort", "mode", "speed", "metadata", "trackId", "role"]);
  for (const field of Object.keys(input)) if (!fields.has(field)) return bad(field, `Unknown field ${field}.`);
  const value: CreateInput = {};
  if (input.id !== undefined) {
    if (!isSessionId(input.id)) return bad("id", "id must be cs_ and 16 lowercase Crockford base32 characters.");
    value.id = input.id;
  }
  if (input.turnId !== undefined) {
    if (!isId("tn", input.turnId)) return bad("turnId", "turnId must be tn_ and 12 lowercase Crockford base32 characters.");
    if (input.input === undefined) return bad("turnId", "turnId is sent only with input.");
    value.turnId = input.turnId;
  }
  for (const [field, min, max] of [["input", 1, 100_000], ["title", 0, 200], ["model", 1, 200], ["effort", 1, 50], ["mode", 1, 50]] as const) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length < min || v.length > max) return bad(field, `${field} must be a string of ${min} to ${max} characters.`);
    value[field] = v;
  }
  if (input.speed !== undefined) {
    if (input.speed !== "fast" && input.speed !== "standard") return bad("speed", "speed must be fast or standard.");
    value.speed = input.speed;
  }
  if (input.metadata !== undefined) {
    const m = asObject(input.metadata);
    const entries = m ? Object.entries(m) : [];
    if (!m || entries.length > 20 || entries.some(([k, v]) => k.length < 1 || k.length > 40 || typeof v !== "string" || v.length > 500)) {
      return bad("metadata", "metadata is at most 20 keys of 1 to 40 characters, with string values of at most 500.");
    }
    value.metadata = m as Record<string, string>;
  }
  if (input.trackId !== undefined) {
    if (typeof input.trackId !== "string" || !TRACK_ID.test(input.trackId)) return bad("trackId", "trackId must be trk_ and 16 lowercase Crockford base32 characters.");
    value.trackId = input.trackId;
  }
  if (input.role !== undefined) {
    if (input.role !== "start") return bad("role", "role is start.");
    value.role = "start";
  }
  const settings = checkSettings({
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  });
  if (!settings.ok) return { error: [400, settings.code, settings.message, { field: settings.field }] };
  return { value };
}

/** `GET /sessions`'s query; Org checks the rest. */
function listQuery(query: URLSearchParams): ListQuery | { error: string; field: string } {
  const q: ListQuery = {};
  const csv = (name: string) => query.get(name)?.split(",").filter(Boolean);
  for (const name of ["owner", "q", "cursor", "slackThread"] as const) {
    const v = query.get(name);
    if (v !== null) q[name] = v;
  }
  const status = csv("status");
  if (status?.length) q.status = status;
  const origin = csv("origin");
  if (origin?.length) q.origin = origin;
  const archived = query.get("archived");
  if (archived !== null) {
    if (archived !== "true" && archived !== "false") return { error: "archived is true or false.", field: "archived" };
    q.archived = archived === "true";
  }
  const order = query.get("order");
  if (order !== null) {
    if (order !== "active" && order !== "created") return { error: "order is active or created.", field: "order" };
    q.order = order;
  }
  const limit = intParam(query, "limit", 1, 100);
  if (limit === null) return { error: "limit is 1 to 100.", field: "limit" };
  if (limit !== undefined) q.limit = limit;
  return q;
}

/** The session row with the log's newer summary laid over it (`GET /sessions/{id}`). */
function withSummary(session: SessionRow, summary: LogSummary | null): SessionRow {
  if (!summary || summary.lastSeq < session.lastSeq) return session;
  return {
    ...session,
    ...(summary.status && session.status !== "suspended" ? { status: summary.status } : {}),
    ...(summary.settings ? { settings: summary.settings } : {}),
    activeTurnId: summary.activeTurnId,
    queued: summary.queued,
    asks: summary.asks,
    subagents: summary.subagents,
    lastTurn: summary.lastTurn,
    lastText: summary.lastText,
    context: summary.context,
    lastSeq: summary.lastSeq,
    ...(summary.lastActiveAt ? { lastActiveAt: summary.lastActiveAt } : {}),
    syncedAt: summary.syncedAt,
  };
}

/** A route of spec 37 served by the actors, as the principal. */
async function actorRoute(request: Request, env: ComputerEdgeEnv, p: Principal, route: Route, out: Reply): Promise<Response> {
  const scope = scopeOf(route.op);
  if (scope && !p.scopes.includes(scope)) {
    return out.error(403, "forbidden", `This key does not have the ${scope} scope.`, { reason: "missing_scope", scope });
  }
  const idem = request.headers.get("idempotency-key") ?? undefined;
  if (idem !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idem)) return out.error(400, "invalid_request", "Idempotency-Key is 1 to 255 printable characters.", { field: "Idempotency-Key" });
  const rawTrace = request.headers.get("x-oc-trace");
  const trace = rawTrace && TRACE.test(rawTrace) ? rawTrace : undefined;
  const query = new URL(request.url).searchParams;
  const org = () => orgOf(env, p.org);

  if (route.op === "list") {
    const q = listQuery(query);
    if ("error" in q) return out.error(400, "invalid_request", q.error, { field: q.field });
    const r = await timedDo(out.facts, org().listSessions(p, q));
    return r.ok ? out.send(200, strip(r)) : refusalOf(out, r);
  }

  if (route.op === "create") {
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    const input = createInput(parsed.value);
    if ("error" in input) return out.error(...input.error);
    const { turnId: askedTurn, ...create } = input.value;
    if (create.role && p.kind !== "member") return out.error(403, "forbidden", "Only a member starts a session with a role.", { reason: "members_only" });
    // An Idempotency-Key without an id is hashed into the id, so a retry is the same create.
    const id = create.id ?? (idem ? await entryId("cs", 16, ["create", p.org, p.subject, idem]) : undefined);
    const made = await timedDo(out.facts, org().createSession(p, {
      ...create,
      ...(id ? { id } : {}),
      ...(p.kind === "agent" && p.session ? { parent: p.session } : {}),
    }));
    if (!made.ok) return refusalOf(out, made);
    const session = made.session;
    out.facts.sessionId = session.id;
    if (made.duplicate) out.facts.replayed = true;
    if (create.input === undefined) {
      return out.send(made.duplicate ? 200 : 201, { session, turn: null, delivery: null, duplicate: made.duplicate, seq: session.lastSeq });
    }
    // One turn per create, whatever retries: its id is the client's, else derived from the session's.
    const turnId = askedTurn ?? (await entryId("tn", 12, ["create", session.id]));
    const sent = await sendEntry(env, p, session.id, { id: turnId, kind: "turn", body: { input: create.input, ifBusy: "queue" } }, trace, out);
    if ("response" in sent) return sent.response;
    if ("waking" in sent) return out.send(202, { accepted: true, id: turnId, session });
    const result = (asObject(sent.delivered) ?? {}) as { turn?: unknown; delivery?: unknown; seq?: number; duplicate?: boolean };
    const duplicate = made.duplicate && result.duplicate !== false;
    return out.send(duplicate ? 200 : 201, { session, turn: result.turn ?? null, delivery: result.delivery ?? null, duplicate, seq: result.seq ?? session.lastSeq });
  }

  const sessionId = route.sessionId!;
  if (!isSessionId(sessionId)) return out.error(404, "not_found", "No such session.");
  if (route.sub !== undefined && !ID.test(route.sub)) {
    const what = route.op.split(".")[0]!.replace(/s$/, "");
    return out.error(404, `${what}_not_found`, `No such ${what}.`);
  }
  const minSeq = intParam(query, "minSeq", 0, Number.MAX_SAFE_INTEGER);
  if (minSeq === null) return out.error(400, "invalid_request", "minSeq must be a non-negative integer.", { field: "minSeq" });

  if (route.op === "get") {
    const [got, summary] = await Promise.all([
      timedDo(out.facts, org().getSession(p, sessionId)),
      timedLog(out.facts, readsOf(env, sessionId).summary(minSeq, p)).catch(() => null),
    ]);
    if (!got.ok) return refusalOf(out, got);
    return out.send(200, { session: withSummary(got.session, summary?.ok ? summary.summary : null) });
  }

  // The four writes, through the session's inbox (spec 37.2, 40.2).
  if (route.op in ENTRY_KINDS) {
    const op = route.op as keyof typeof ENTRY_KINDS;
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    const input = asObject(parsed.value);
    if (!input) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
    const params = writeParams(route, input);
    if ("error" in params) return out.error(400, params.code ?? "invalid_request", params.error, { field: params.field });
    const { id: askedId, ...body } = params.value;
    const kind = ENTRY_KINDS[op];
    const [prefix, length] = kind === "turn" ? ["tn", 12] as const : ["ie", 16] as const;
    const id = typeof askedId === "string" ? askedId : await entryId(prefix, length, idem ? [kind, p.org, p.subject, sessionId, idem] : undefined);
    const sent = await sendEntry(env, p, sessionId, { id, kind, body }, trace, out);
    if ("response" in sent) return sent.response;
    if ("waking" in sent) return out.send(202, { accepted: true, id });
    return out.send(200, sent.delivered);
  }

  // The session's reads: straight to its SessionLog as the principal, which checks access.
  const log = readsOf(env, sessionId);
  const limit = (max: number) => intParam(query, "limit", 1, max);
  const pageCursor = query.get("cursor") ?? undefined;
  const answer = (r: LogPage | LogRefused, pick?: string) => (r.ok ? out.send(200, pick ? { [pick]: r[pick] } : strip(r)) : logRefusalOf(out, r));
  switch (route.op) {
    case "events.list": {
      const after = query.get("after") ?? undefined;
      // A cursor the module cannot read (a bare seq of the old API included) is reset with no cursor.
      if (after !== undefined && !cursor.read("e", after)) return out.error(409, "reset", "after is not a cursor of this session's events.", { cursor: null });
      const lim = limit(500);
      const waitMs = intParam(query, "waitMs", 0, 60_000);
      const tailTurns = intParam(query, "tailTurns", 1, 50);
      for (const [name, v] of [["limit", lim], ["waitMs", waitMs], ["tailTurns", tailTurns]] as const) {
        if (v === null) return out.error(400, "invalid_request", `${name} is out of range.`, { field: name });
      }
      if (tailTurns !== undefined && after !== undefined) return out.error(400, "invalid_request", "tailTurns cannot be sent with after.", { field: "tailTurns" });
      const types = query.get("types")?.split(",").filter(Boolean);
      const turnId = query.get("turnId") ?? undefined;
      const q = {
        ...(after !== undefined ? { after } : {}),
        ...(typeof lim === "number" ? { limit: lim } : {}),
        ...(typeof tailTurns === "number" ? { tailTurns } : {}),
        ...(types?.length ? { types } : {}),
        ...(turnId ? { turnId } : {}),
        ...(minSeq !== undefined ? { minSeq } : {}),
      };
      const read = () => timedLog(out.facts, log.events(q, p));
      let r = await read();
      if (waitMs && r.ok && !r.events.length) {
        out.facts.waitMs = waitMs;
        const head = r.cursor ?? after;
        if (head) r = await waitFor(env, p, eventsStream(sessionId), head, waitMs, r, read, (n) => !n.ok || n.events.length > 0);
      }
      if (r.ok) delivered(out.facts, r.events);
      return answer(r);
    }
    case "turns.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status")?.split(",").filter(Boolean);
      return answer(await timedLog(out.facts, log.turns({ ...(lim !== undefined ? { limit: lim } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...(status ? { status } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)));
    }
    case "turns.get": {
      const waitMs = intParam(query, "waitMs", 0, 60_000);
      if (waitMs === null) return out.error(400, "invalid_request", "waitMs is 0 to 60000.", { field: "waitMs" });
      const status = query.get("status") ?? undefined;
      if (waitMs !== undefined) out.facts.waitMs = waitMs;
      return answer(await timedLog(out.facts, log.turn(route.sub!, { ...(waitMs !== undefined ? { waitMs } : {}), ...(status ? { status } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)), "turn");
    }
    case "asks.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status") ?? "open";
      if (!ASK_STATUSES.has(status)) return out.error(400, "invalid_request", "status is open, answered, dismissed, declined, interrupted or all.", { field: "status" });
      return answer(await timedLog(out.facts, log.asks({ status, ...(lim !== undefined ? { limit: lim } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)));
    }
    case "asks.get":
      return answer(await timedLog(out.facts, log.ask(route.sub!, minSeq, p)), "ask");
    case "subagents.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status") ?? "running";
      if (status !== "running" && status !== "all") return out.error(400, "invalid_request", "status is running or all.", { field: "status" });
      return answer(await timedLog(out.facts, log.subagents({ status, ...(lim !== undefined ? { limit: lim } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)));
    }
    case "subagents.get":
      return answer(await timedLog(out.facts, log.subagent(route.sub!, minSeq, p)), "subagent");
    default:
      return out.error(404, "not_found", "No such route.");
  }
}
