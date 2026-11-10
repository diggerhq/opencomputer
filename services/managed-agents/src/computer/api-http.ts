// The Computer session API over HTTP (work 084, opc/docs/api/http): the routes the opencomputer
// edge forwards with `x-opencomputer-surface: api` under `/v1/computer/…` (computer_api.ts in
// opencomputer). Writes and the session rows go to the Computer DO (`computerApi`); reads of the
// log (events, turns, asks, subagents) go straight to the session's SessionLog after an access
// check, so a long-poll never holds the Computer DO.
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
import type { ApiScope, Session } from "./api-types.js";
import { API_SCOPES } from "./api-types.js";
import { capabilities, PLAN_EXIT_MODES } from "./capabilities.js";
import type { ComputerEdgeEnv } from "./config.js";
import { apiScopes } from "./keys.js";
import { COMPUTER_PRINCIPAL } from "../edge/computer-principal.js";
import type { LogReadRefusal, SessionLogRpc } from "./session-log-contract.js";
import { isSessionId, memberId } from "./session-ids.js";
import type { ApiCaller, ApiOp, ApiReply, WriteMethod } from "./sessions-api.js";
import type { SecretsApiOp } from "./secrets-store.js";
import { gatewayTelemetry } from "./telemetry/gateway.js";

/** What api-http needs of the Computer DO stub. */
export interface ComputerApiStub {
  computerApi(accountId: string, caller: ApiCaller, op: ApiOp | SecretsApiOp): Promise<ApiReply>;
}

const BODY_MAX_BYTES = 512 * 1024;
const REQUEST_ID = /^req_[0-9A-Za-z_-]{4,60}$/;
const ID = /^[a-z]{2,4}_[0-9a-z]{4,40}$/;
const ACCESS_TTL_MS = 30_000;
const ASK_STATUSES = new Set(["open", "answered", "dismissed", "declined", "interrupted", "all"]);

/** Positive access answers, per isolate: a long-poll loop does not ask the Computer DO every time. */
const accessCache = new Map<string, number>();

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
  // Secrets (secrets.mdx). Work 095 v1: the organization layer; personal and session secrets answer 409 feature_unavailable.
  if (is("GET", 1) && p[0] === "secrets") return { op: "secrets.list" };
  if (is("GET", 3) && p[0] === "secrets" && p[2] === "events") return { op: "secrets.events", sub: p[1] };
  if (p[0] === "organization" && p[1] === "secrets" && p.length === 3 && (method === "PUT" || method === "DELETE")) {
    return { op: method === "PUT" ? "secrets.put" : "secrets.delete", sub: p[2] };
  }
  if (p[0] === "me" && p[1] === "secrets" && p.length === 3 && (method === "PUT" || method === "DELETE")) return { op: "secrets" };
  if (p[0] !== "sessions") return null;
  if (p.length === 1) return method === "GET" ? { op: "list" } : method === "POST" ? { op: "create" } : null;
  const sessionId = p[1]!;
  if (is("GET", 2)) return { op: "get", sessionId };
  if (is("PATCH", 2)) return { op: "patch", sessionId };
  const r = p[2];
  if (is("GET", 3) && r === "capabilities") return { op: "capabilities", sessionId };
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
  if (r === "secrets" && p.length === 4 && (method === "PUT" || method === "DELETE")) return { op: "secrets", sessionId };
  return null;
}

/** The scope a route needs. */
function scopeOf(op: string): ApiScope | null {
  if (op === "me" || op === "ticket") return null;
  if (op === "asks.answer" || op === "asks.dismiss") return "asks:answer";
  if (op === "secrets" || op === "secrets.put" || op === "secrets.delete") return "secrets:write";
  if (op === "secrets.events") return "sessions:read";
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
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
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
  if (op === "list" || op === "create" || op === "get" || op === "patch" || op === "capabilities") return "sessions";
  if (op.startsWith("sessions.")) return "control";
  if (op === "events.list") return "events";
  if (op.startsWith("turns.")) return "turns";
  if (op.startsWith("asks.")) return "asks";
  if (op.startsWith("subagents.")) return "subagents";
  if (op === "ticket") return "tickets";
  if (op === "secrets" || op.startsWith("secrets.")) return "secrets";
  return "other";
}

const OPS = new Set([
  "me", "ticket", "secrets", "secrets.list", "secrets.events", "secrets.put", "secrets.delete", "list", "create", "get", "patch", "capabilities",
  "sessions.interrupt", "sessions.compact", "sessions.suspend", "sessions.resume",
  "turns.send", "turns.list", "turns.get", "turns.cancel", "events.list",
  "asks.list", "asks.get", "asks.answer", "asks.dismiss", "subagents.list", "subagents.get", "subagents.stop",
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
  const caller = await callerOf(request, identity, out.requestId);
  if (!caller) return out.error(403, "forbidden", "Project keys cannot use sessions.", { reason: "project_key" });
  out.facts.via = caller.via;
  out.facts.member = caller.member;
  // Only people set secrets (work 095): a session's own key, whatever it names, is refused.
  if ((route.op === "secrets" || route.op.startsWith("secrets.")) && identity.principal === COMPUTER_PRINCIPAL) {
    return out.error(403, "forbidden", "Sessions cannot read or set secrets over this API.", { reason: "computer_principal" });
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

  if (route.op === "secrets") return out.error(409, "feature_unavailable", "Only organization secrets can be set over this API for now.", { feature: "secrets" });
  if (route.op === "secrets.list") return call({ op: "secrets.list" });
  if (route.op.startsWith("secrets.")) {
    const name = route.sub!;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      return route.op === "secrets.put" ? out.error(400, "invalid_name", "A name is letters, digits and _, not starting with a digit (at most 64).", { field: "name" }) : out.error(404, "secret_not_found", "No such organization secret.");
    }
    if (route.op === "secrets.events") return call({ op: "secrets.events", name });
    if (route.op === "secrets.delete") return call({ op: "secrets.delete", name });
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    return call({ op: "secrets.put", name, body: parsed.value });
  }
  if (route.op === "me") return call({ op: "me" });
  if (route.op === "list") return call({ op: "list", query: [...query.entries()] });

  const needsBody = request.method === "POST" || request.method === "PATCH";
  let body: unknown;
  if (needsBody) {
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    body = parsed.value;
  }
  if (route.op === "ticket") return call({ op: "ticket", body });
  if (route.op === "create") return call({ op: "create", body, ...(idem ? { idempotencyKey: idem } : {}) });

  const sessionId = route.sessionId!;
  if (!isSessionId(sessionId)) return out.error(404, "session_not_found", "No such session.");
  if (route.sub !== undefined && !ID.test(route.sub)) {
    const what = route.op.split(".")[0]!.replace(/s$/, "");
    return out.error(404, `${what}_not_found`, `No such ${what}.`);
  }

  if (route.op === "get") {
    const minSeq = intParam(query, "minSeq", 0, Number.MAX_SAFE_INTEGER);
    if (minSeq === null) return out.error(400, "invalid_request", "minSeq must be a non-negative integer.", { field: "minSeq" });
    return call({ op: "get", sessionId, ...(minSeq !== undefined ? { minSeq } : {}) });
  }
  if (route.op === "patch") return call({ op: "patch", sessionId, body, ...(idem ? { idempotencyKey: idem } : {}) });

  // Writes to the session's writer.
  if (needsBody) {
    const input = asObject(body);
    if (!input) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
    const params = writeParams(route, input);
    if ("error" in params) return out.error(400, params.code ?? "invalid_request", params.error, { field: params.field });
    return call({ op: "call", sessionId, method: route.op as WriteMethod, params: params.value, ...(idem ? { idempotencyKey: idem } : {}) });
  }

  // Reads: an access check (cached), then the SessionLog.
  const cacheKey = `${accountId}\n${caller.member}\n${sessionId}`;
  const seen = accessCache.get(cacheKey);
  if (!seen || seen < Date.now()) {
    const access = await computer.computerApi(accountId, caller, { op: "access", sessionId });
    if (access.error) return out.of(access);
    if (accessCache.size > 10_000) accessCache.clear();
    accessCache.set(cacheKey, Date.now() + ACCESS_TTL_MS);
  }
  if (route.op === "capabilities") return out.send(200, { capabilities: capabilities() });
  if (!env.SESSION_LOG) return out.error(503, "unavailable", "Session history is unavailable.", { retryAfterMs: 5_000 });
  const log = env.SESSION_LOG.getByName(sessionId) as unknown as SessionLogRpc;
  const minSeq = intParam(query, "minSeq", 0, Number.MAX_SAFE_INTEGER);
  if (minSeq === null) return out.error(400, "invalid_request", "minSeq must be a non-negative integer.", { field: "minSeq" });
  const limit = (max: number) => intParam(query, "limit", 1, max);
  const cursor = query.get("cursor") ?? undefined;
  const refused = async (r: LogReadRefusal): Promise<Response> => {
    if (r.error === "cursor_ahead") {
      const got = await computer.computerApi(accountId, caller, { op: "get", sessionId });
      const session = (got.body as { session?: Session } | undefined)?.session;
      return out.error(409, "cursor_ahead", `after is past the session's lastSeq (${r.lastSeq}).`, { session: session ?? { id: sessionId, lastSeq: r.lastSeq, logEpoch: r.logEpoch } });
    }
    if (r.error === "unavailable") return out.error(503, "unavailable", "The session has not reached minSeq yet.", { retryAfterMs: r.retryAfterMs });
    if (r.error === "invalid_cursor") return out.error(400, "invalid_cursor", "The cursor is not valid for this list.");
    return out.error(404, r.error, `No such ${r.error.replace(/_not_found$/, "")}.`);
  };
  const strip = <T extends { ok: true }>(r: T) => {
    const { ok: _ok, ...rest } = r;
    return rest;
  };

  switch (route.op) {
    case "events.list": {
      const after = intParam(query, "after", 0, Number.MAX_SAFE_INTEGER);
      const lim = limit(500);
      const waitMs = intParam(query, "waitMs", 0, 60_000);
      const tailTurns = intParam(query, "tailTurns", 1, 50);
      for (const [name, v] of [["after", after], ["limit", lim], ["waitMs", waitMs], ["tailTurns", tailTurns]] as const) {
        if (v === null) return out.error(400, "invalid_request", `${name} is out of range.`, { field: name });
      }
      if (tailTurns !== undefined && after !== undefined) return out.error(400, "invalid_request", "tailTurns cannot be sent with after.", { field: "tailTurns" });
      const types = query.get("types")?.split(",").filter(Boolean);
      const turnId = query.get("turnId") ?? undefined;
      if (typeof waitMs === "number") out.facts.waitMs = waitMs;
      const r = await timedLog(out.facts, log.events({
        ...(typeof after === "number" ? { after } : {}),
        ...(typeof lim === "number" ? { limit: lim } : {}),
        ...(typeof waitMs === "number" ? { waitMs } : {}),
        ...(typeof tailTurns === "number" ? { tailTurns } : {}),
        ...(types?.length ? { types } : {}),
        ...(turnId ? { turnId } : {}),
        ...(minSeq !== undefined ? { minSeq } : {}),
      }));
      if (r.ok) delivered(out.facts, r.events);
      return r.ok ? out.send(200, strip(r)) : refused(r);
    }
    case "turns.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status")?.split(",").filter(Boolean) as never;
      const r = await timedLog(out.facts, log.turns({ ...(lim !== undefined ? { limit: lim } : {}), ...(cursor ? { cursor } : {}), ...(status ? { status } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }));
      return r.ok ? out.send(200, strip(r)) : refused(r);
    }
    case "turns.get": {
      const waitMs = intParam(query, "waitMs", 0, 60_000);
      if (waitMs === null) return out.error(400, "invalid_request", "waitMs is 0 to 60000.", { field: "waitMs" });
      const status = query.get("status") ?? undefined;
      if (waitMs !== undefined) out.facts.waitMs = waitMs;
      const r = await timedLog(out.facts, log.turn(route.sub!, { ...(waitMs !== undefined ? { waitMs } : {}), ...(status ? { status: status as never } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }));
      return r.ok ? out.send(200, { turn: r.turn }) : refused(r);
    }
    case "asks.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status") ?? "open";
      if (!ASK_STATUSES.has(status)) return out.error(400, "invalid_request", "status is open, answered, dismissed, declined, interrupted or all.", { field: "status" });
      const r = await timedLog(out.facts, log.asks({ status, ...(lim !== undefined ? { limit: lim } : {}), ...(cursor ? { cursor } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }));
      return r.ok ? out.send(200, strip(r)) : refused(r);
    }
    case "asks.get": {
      const r = await timedLog(out.facts, log.ask(route.sub!, minSeq));
      return r.ok ? out.send(200, { ask: r.ask }) : refused(r);
    }
    case "subagents.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status") ?? "running";
      if (status !== "running" && status !== "all") return out.error(400, "invalid_request", "status is running or all.", { field: "status" });
      const r = await timedLog(out.facts, log.subagents({ status, ...(lim !== undefined ? { limit: lim } : {}), ...(cursor ? { cursor } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }));
      return r.ok ? out.send(200, strip(r)) : refused(r);
    }
    case "subagents.get": {
      const r = await timedLog(out.facts, log.subagent(route.sub!, minSeq));
      return r.ok ? out.send(200, { subagent: r.subagent }) : refused(r);
    }
    default:
      return out.error(404, "not_found", "No such route.");
  }
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
      return allow("input", "ifBusy");
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
