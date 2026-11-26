// The Computer session API over HTTP (work 084, opc/docs/api/http): the routes the opencomputer
// edge forwards with `x-opencomputer-surface: api` under `/v1/computer/…` (computer_api.ts in
// opencomputer). Tracks and threads (spec 37): the session directory is Org's, the writes go
// through the session's inbox (SessionLog `accept`, then the machine's Computer `drain`), and the
// log's reads go straight to its SessionLog, all as the caller's principal (spec 34.3). The
// Computer DO keeps its own routes (secrets, tickets, session controls).
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
import { base64url, computerOf, cursor, hashOf, liveOf, logOf, orgOf, slackOf } from "../actor/index.js";
import type { CreateSession, DrainResult, InboxKind, ListQuery, MutateReply, OrgRpc, OrgSettings, Principal, Refusal, SessionPatch, SessionRow } from "../actor/index.js";
import { eventsStream, type LiveUpgrade, liveRequest } from "../live/contract.js";
import type { ApiScope, LogSummary } from "./api-types.js";
import { capabilities, checkSettings, PLAN_EXIT_MODES } from "./capabilities.js";
import type { ComputerEdgeEnv } from "./config.js";
import { CROCKFORD, isId, isSessionId } from "./session-ids.js";
import { type ApiOp, type ApiRequest, type ApiReply, validatePatch } from "./sessions-api.js";
import { type ComputerInstallation, selectTokenTarget } from "./github.js";
import type { GitHubTokenMint } from "../protocol.js";
import type { SecretsApiOp } from "./secrets-store.js";
import { repositoriesQuery, repositoryChoice } from "../org/repository.js";
import { gatewayTelemetry } from "./telemetry/gateway.js";

/** What api-http needs of the Computer DO stub. */
export interface ComputerApiStub {
  computerApi(accountId: string, caller: ApiRequest, op: ApiOp | SecretsApiOp): Promise<ApiReply>;
}

const BODY_MAX_BYTES = 512 * 1024;
const REQUEST_ID = /^req_[0-9A-Za-z_-]{4,60}$/;
const ID = /^[a-z]{2,4}_[0-9a-z]{4,40}$/;
const ASK_STATUSES = new Set(["open", "answered", "dismissed", "declined", "interrupted", "all"]);

interface Route {
  op: string;
  sessionId?: string;
  sub?: string;
  /** `mutate`: the mutation (spec 39) and its arguments from the path. */
  name?: string;
  args?: Record<string, string>;
}

const THREAD_MARKS: Record<string, string> = { title: "thread.rename", track: "thread.place", done: "thread.done", keep: "thread.keep", ready: "thread.ready", attention: "thread.attention", writers: "thread.writers" };
const TRACK_MARKS: Record<string, string> = { name: "track.rename", stand: "track.set_stand", done: "track.done", keep: "track.keep", doc: "doc.save" };

/** The work routes of tracks and threads (spec 37.1, 37.3): the reads and one route per mutation. */
function workRoute(method: string, s: string[]): Route | null {
  const m = (name: string, args: Record<string, string> = {}): Route => ({ op: "mutate", name, args });
  const [a, b, c, d] = s;
  const n = s.length;
  const is = (verb: string, length: number) => method === verb && n === length;
  switch (a) {
    case "threads":
      if (is("GET", 1)) return { op: "work.threads" };
      if (is("DELETE", 2)) return m("thread.delete", { sid: b! });
      if (is("PUT", 3) && THREAD_MARKS[c!]) return m(THREAD_MARKS[c!]!, { sid: b! });
      if (is("DELETE", 3) && c === "done") return m("thread.reopen", { sid: b! });
      return null;
    case "tracks":
      if (is("POST", 1)) return m("track.create");
      if (is("DELETE", 2)) return m("track.delete", { tid: b! });
      if (is("PUT", 3) && TRACK_MARKS[c!]) return m(TRACK_MARKS[c!]!, { tid: b! });
      if (is("DELETE", 3) && c === "done") return m("track.reopen", { tid: b! });
      if (is("POST", 3) && c === "dissolve") return m("track.dissolve", { tid: b! });
      if (is("GET", 3) && c === "doc") return { op: "work.doc", sub: b! };
      if (method === "GET" && c === "doc" && d === "revisions" && (n === 4 || n === 5)) return { op: "work.doc.revisions", sub: b!, ...(n === 5 ? { args: { rev: s[4]! } } : {}) };
      return null;
    case "tell-track":
      return is("POST", 1) ? { op: "work.tell" } : null;
    case "reads":
      return is("PUT", 2) ? m("read.set", { sid: b! }) : null;
    case "prefs":
      return is("PUT", 2) ? m("pref.set", { key: b! }) : null;
    case "results":
      if (is("PUT", 2)) return m("result.add", { resultId: b! });
      if (is("GET", 3) && c === "diff") return { op: "work.diff", sub: b! };
      if (n === 3 && c === "review") return method === "PUT" ? m("review.save", { resultId: b! }) : method === "GET" ? { op: "work.review", sub: b! } : null;
      return null;
    case "proposals":
      if (is("POST", 1)) return m("proposal.create");
      if (is("POST", 3) && (c === "accept" || c === "dismiss")) return m(`proposal.${c}`, { proposalId: b! });
      return null;
    case "ops":
      return is("POST", 3) && c === "undo" ? m("undo", { opId: b! }) : null;
    case "overview":
      return is("GET", 1) ? { op: "work.overview" } : null;
    case "search":
      return is("GET", 1) ? { op: "work.search" } : null;
    default:
      return null;
  }
}

/** A path id's shape, by its argument's name: a malformed one is `not_found`. */
const PATH_ID: Record<string, RegExp> = {
  sid: /^cs_[0-9a-hjkmnp-tv-z]{16}$/,
  tid: /^trk_[0-9a-hjkmnp-tv-z]{16}$/,
  resultId: /^res_[0-9a-hjkmnp-tv-z]{16}$/,
  proposalId: /^prp_[0-9a-hjkmnp-tv-z]{16}$/,
  opId: /^op_[0-9a-hjkmnp-tv-z]{16}$/,
  key: /^[A-Za-z0-9_.:-]{1,64}$/,
  rev: /^(0|[1-9]\d{0,8})$/,
};

/** `METHOD /suffix` → the route; null when it is not one of the API's. */
export function matchApiRoute(method: string, suffix: string): Route | null {
  const p = suffix.split("/").filter(Boolean);
  const is = (m: string, n: number) => method === m && p.length === n;
  if (is("GET", 1) && p[0] === "me") return { op: "me" };
  // The organization's settings for sessions (sessions.mdx#organization-default): Org's.
  if (p[0] === "settings" && p.length === 1 && (method === "GET" || method === "PATCH")) return { op: method === "GET" ? "settings.get" : "settings.patch" };
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
  if (is("GET", 1) && p[0] === "feed") return { op: "feed" };
  if (is("POST", 2) && p[0] === "feed" && p[1] === "mismatch") return { op: "feed.mismatch" };
  if (is("GET", 1) && p[0] === "occurrences") return { op: "occurrences" };
  if (is("GET", 1) && p[0] === "live") return { op: "live" };
  if (is("POST", 4) && p[0] === "slack" && p[1] === "threads" && p[3] === "messages") return { op: "slack.post", sub: p[2] };
  // The Work API (spec 37): tracks and threads, and the knowledge repository setting, all Org's.
  if (p[0] === "work") {
    const tracked = workRoute(method, p.slice(1));
    if (tracked) return tracked;
    if (p[1] === "repository" && p.length === 2) return method === "GET" ? { op: "work.repository.get" } : method === "PUT" ? { op: "work.repository.put" } : null;
    if (p[1] === "repositories") return is("GET", 2) ? { op: "work.repositories" } : null;
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
  if (op === "me" || op === "ticket" || op === "settings.get") return null;
  if (op === "asks.answer" || op === "asks.dismiss") return "asks:answer";
  if (op === "secrets" || op === "secrets.put" || op === "secrets.delete" || op === "secrets.session.put") return "secrets:write";
  if (op === "secrets.events") return "sessions:read";
  if (op === "work.repository.put" || op === "mutate" || op === "work.tell") return "work:write";
  if (op === "live") return "sessions:read";
  if (op === "feed" || op === "feed.mismatch" || op === "occurrences") return "sessions:read";
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
  } catch (error) {
    // Org could not read a page of the sessions it adopts (spec 43.1): retryable, and Org retries by itself.
    if (!(error instanceof Error) || !/\badopting\b/.test(error.message)) throw error;
    response = out.error(503, "adopting", "The organization's sessions are being moved. Try again shortly.", { retryAfterMs: 5_000 });
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
  if (op.startsWith("work.") || op === "mutate") return "work";
  if (op === "feed" || op === "feed.mismatch" || op === "occurrences" || op === "live") return "feed";
  return "other";
}

const OPS = new Set([
  "me", "ticket", "settings.get", "settings.patch", "secrets", "secrets.list", "secrets.events", "secrets.put", "secrets.delete", "secrets.session.put", "list", "create", "get", "patch", "capabilities",
  "aside.set", "aside.clear",
  "sessions.interrupt", "sessions.compact", "sessions.suspend", "sessions.resume",
  "turns.send", "turns.list", "turns.get", "turns.cancel", "events.list",
  "asks.list", "asks.get", "asks.answer", "asks.dismiss", "subagents.list", "subagents.get", "subagents.stop",
  "work.repository.get", "work.repository.put", "work.repositories",
  "feed", "feed.mismatch", "occurrences", "mutate", "work.threads", "work.overview", "work.doc", "work.doc.revisions", "work.review", "work.search",
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
  const p = identity.ocPrincipal;
  if (!p) return out.error(401, "unauthenticated", "The request names no principal.");
  out.facts.via = p.via;
  if (p.subject.startsWith("usr_")) out.facts.member = p.subject;
  const claimed = request.headers.get("x-oc-principal");
  if (claimed !== null && claimed !== `${p.org}/${p.subject}`) {
    return out.error(403, "principal_mismatch", "x-oc-principal is not this credential's principal.");
  }
  if (ACTOR_OPS.has(route.op)) {
    // `Session.owner`'s name and email: the credential's, for a person or their key.
    const person = p.kind === "member" || p.kind === "key" ? { name: identity.userName ?? null, email: identity.userEmail ?? null } : undefined;
    return actorRoute(request, env, p, person, route, out);
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
  const call = (op: ApiOp | SecretsApiOp) => computer.computerApi(accountId, caller, op).then((reply) => out.of(reply));

  if (route.op === "secrets") return out.error(409, "feature_unavailable", "Only organization secrets can be set over this API for now.", { feature: "secrets" });
  if (route.op === "secrets.list") return call({ op: "secrets.list" });
  if (route.op.startsWith("secrets.")) {
    const name = route.sub!;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      return (route.op === "secrets.put" || route.op === "secrets.session.put") ? out.error(400, "invalid_name", "A name is letters, digits and _, not starting with a digit (at most 64).", { field: "name" }) : out.error(404, "secret_not_found", "No such organization secret.");
    }
    if (route.op === "secrets.events") return call({ op: "secrets.events", name });
    if (route.op === "secrets.delete") return call({ op: "secrets.delete", name });
    if (route.op === "secrets.session.put") {
      // Org judges who may see the session; the Computer holds its runner.
      const sessionId = route.sessionId!;
      if (!isSessionId(sessionId) || !(await timedDo(out.facts, orgOf(env, p.org).getSession(p, sessionId))).ok) return out.error(404, "session_not_found", "No such session.");
    }
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

  // Per-session capabilities: the same for every session, once Org says the principal may see it.
  const sessionId = route.sessionId!;
  if (!isSessionId(sessionId) || !(await timedDo(out.facts, orgOf(env, p.org).getSession(p, sessionId))).ok) return out.error(404, "session_not_found", "No such session.");
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
      // `turnId` is `id` under the name `POST /sessions` gives it; either way it becomes the turn's id.
      for (const field of ["id", "turnId"] as const) {
        if (body[field] !== undefined && !isId("tn", body[field])) return { error: `${field} must be tn_ and 12 lowercase Crockford base32 characters.`, field };
      }
      if (body.id !== undefined && body.turnId !== undefined && body.id !== body.turnId) return { error: "id and turnId name the same turn: send one.", field: "turnId" };
      const { turnId, ...rest } = body;
      const named = allow("id", "input", "ifBusy", "turnId");
      return "error" in named || turnId === undefined ? named : { value: { ...rest, id: turnId } };
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
  "list", "create", "get", "patch", "aside.set", "aside.clear",
  "turns.send", "asks.answer", "asks.dismiss", "sessions.interrupt",
  "sessions.compact", "sessions.suspend", "sessions.resume", "turns.cancel", "subagents.stop",
  "events.list", "turns.list", "turns.get", "asks.list", "asks.get", "subagents.list", "subagents.get",
  "feed", "feed.mismatch", "occurrences", "mutate",
  "work.threads", "work.overview", "work.doc", "work.doc.revisions", "work.review", "work.search", "work.repository.get", "work.repository.put", "work.repositories",
  "live", "work.tell", "work.diff", "slack.post", "settings.get", "settings.patch",
]);

const TRACK_ID = /^trk_[0-9a-hjkmnp-tv-z]{16}$/;
const ENDED_TURNS = new Set(["completed", "failed", "cancelled"]);
/** How long `GET /sessions/{id}?minSeq` waits for the log without `waitMs`. */
const MIN_SEQ_WAIT_MS = 10_000;
const TRACE = /^[\x21-\x7e]{1,64}$/;
const ENTRY_KINDS = {
  "turns.send": "turn", "asks.answer": "answer", "asks.dismiss": "dismiss", "sessions.interrupt": "interrupt",
  "sessions.compact": "compact", "sessions.suspend": "suspend", "sessions.resume": "resume", "turns.cancel": "cancel", "subagents.stop": "stop",
} as const;

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
  // The host's refusals of a delivered entry (spec 40.2); the host's own `status` comes first (an entry refused before it was kept had none).
  ask_closed: 409,
  session_busy: 409,
  turn_not_cancellable: 409,
  subagent_ended: 409,
  feature_unavailable: 409,
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
  if (r.error === "invalid_cursor") return out.error(409, "reset", "The cursor cannot be read.", { cursor: null });
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
  const mine = drained.state === "delivered" ? drained.results.find((r) => r.id === entry.id) : undefined;
  if (mine) return mine.error ? { response: hostErrorOf(out, mine.error) } : { delivered: mine.result ?? null };
  // Not among this drain's results: the SessionLog's own owed drain (which `accept` starts) took the entry
  // first, and this call only waited behind it. The entry's outcome is in the inbox, whoever delivered it.
  const outcome = await timedLog(out.facts, logOf(env, sessionId).entry(entry.id));
  if (outcome?.state === "delivered") return { delivered: outcome.result ?? null };
  if (outcome?.state === "refused") return { response: hostErrorOf(out, { ...outcome.error, requestId: trace ?? "", retryable: false }) };
  return { waking: true };
}

/**
 * The wait rule (spec 37.1): the owner was read and had nothing new; wait on Live's stream from
 * `after` (empty: from wherever Live's head is), read the owner again, until `done` or the time is
 * up. Live takes the session's lease.
 */
async function waitFor<T>(env: ComputerEdgeEnv, p: Principal, stream: string, after: string, waitMs: number, first: T, read: () => Promise<T>, done: (r: T) => boolean): Promise<T> {
  const live = liveOf(env, p.org);
  const deadline = Date.now() + waitMs;
  let r = first;
  let head = after;
  while (!done(r)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const waited = await live.wait(p, stream, head, remaining).catch(() => null);
    if (!waited?.moved || waited.head === null) break;
    head = waited.head;
    r = await read();
  }
  return r;
}

type CreateInput = CreateSession & { turnId?: string };

/** `POST /sessions`'s body. `parent`, `writers`, `slackThread`, `origin` and `harness` are the actors' own, never a request's. */
function createInput(body: unknown): { value: CreateInput } | { error: [number, string, string, Record<string, unknown>] } {
  const input = asObject(body);
  const bad = (field: string, message: string) => ({ error: [400, "invalid_request", message, { field }] as [number, string, string, Record<string, unknown>] });
  if (!input) return bad("", "The body must be a JSON object.");
  const fields = new Set(["id", "input", "turnId", "title", "model", "effort", "mode", "speed", "metadata", "trackId", "role", "access"]);
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
  // Org checks it (org/sessions.ts `parseAccess`).
  if (input.access !== undefined) value.access = input.access as CreateInput["access"];
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
async function actorRoute(request: Request, env: ComputerEdgeEnv, p: Principal, person: CreateSession["person"], route: Route, out: Reply): Promise<Response> {
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
      ...(person ? { person } : {}),
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

  switch (route.op) {
    case "live":
      return liveUpgrade(request, env, p, out);
    case "work.tell":
      return tellTrack(request, env, p, idem, trace, org, out);
    case "work.diff":
      return resultDiff(request, env, p, route.sub!, org, out);
    case "slack.post":
      return slackPost(request, env, p, route.sub!, out);
    case "settings.get":
      return out.send(200, { settings: await timedDo(out.facts, org().settings(p)) });
    case "settings.patch": {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const r = await timedDo(out.facts, org().setSettings(p, parsed.value as Partial<OrgSettings>));
      return r.ok ? out.send(200, { settings: r.settings }) : refusalOf(out, r);
    }
  }
  if (!route.sessionId) return orgRoute(request, env, p, person, route, query, idem, trace, org, out);

  const sessionId = route.sessionId;
  if (!isSessionId(sessionId)) return out.error(404, "not_found", "No such session.");
  if (route.sub !== undefined && !ID.test(route.sub)) {
    const what = route.op.split(".")[0]!.replace(/s$/, "");
    return out.error(404, `${what}_not_found`, `No such ${what}.`);
  }
  const minSeq = intParam(query, "minSeq", 0, Number.MAX_SAFE_INTEGER);
  if (minSeq === null) return out.error(400, "invalid_request", "minSeq must be a non-negative integer.", { field: "minSeq" });

  if (route.op === "get") {
    const waitMs = intParam(query, "waitMs", 0, 60_000);
    if (waitMs === null) return out.error(400, "invalid_request", "waitMs is 0 to 60000.", { field: "waitMs" });
    const readSummary = () => timedLog(out.facts, readsOf(env, sessionId).summary(minSeq, p)).catch(() => null);
    let [got, summary] = await Promise.all([timedDo(out.facts, org().getSession(p, sessionId)), readSummary()]);
    if (!got.ok && p.admin) {
      // An admin outside the session reads its access and nothing else (sessions.mdx#access).
      const outside = await timedDo(out.facts, org().sessionAccess(p, sessionId));
      if (outside.ok) return out.send(200, strip(outside));
    }
    if (!got.ok) return refusalOf(out, got);
    // With minSeq, until the log has it (spec 37.1's wait rule).
    const behind = (r: typeof summary) => !!r && !r.ok && r.error === "unavailable";
    if (behind(summary)) {
      out.facts.waitMs = waitMs ?? MIN_SEQ_WAIT_MS;
      summary = await waitFor(env, p, eventsStream(sessionId), "", waitMs ?? MIN_SEQ_WAIT_MS, summary, readSummary, (r) => !behind(r));
      if (summary && !summary.ok && behind(summary)) return logRefusalOf(out, summary);
    }
    return out.send(200, { session: withSummary(got.session, summary?.ok ? summary.summary : null) });
  }

  if (route.op === "patch") return patchSession(request, env, p, sessionId, idem, trace, org, out);
  if (route.op === "aside.set" || route.op === "aside.clear") {
    let aside: string | null = null;
    if (route.op === "aside.set") {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const ref = asObject(parsed.value)?.ref;
      if (typeof ref !== "string" || !/^[\x21-\x7e]{1,255}$/.test(ref)) return out.error(400, "invalid_request", "ref is the id of what is set aside: 1 to 255 printable characters.", { field: "ref" });
      aside = ref;
    }
    const r = await timedDo(out.facts, org().patchSession(p, sessionId, { aside }));
    return r.ok ? out.send(200, { session: r.session }) : refusalOf(out, r);
  }

  // Every write, through the session's inbox (spec 37.2, 40.2).
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
        r = await waitFor(env, p, eventsStream(sessionId), head ?? "", waitMs, r, read, (n) => !n.ok || n.events.length > 0);
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
      const read = () => timedLog(out.facts, log.turn(route.sub!, { ...(minSeq !== undefined ? { minSeq } : {}) }, p));
      // Until the turn leaves `status`, or ends; the edge waits, not the log (spec 37.1).
      const done = (r: LogPage | LogRefused) => {
        const turnStatus = r.ok ? (r.turn as { status?: string } | undefined)?.status : undefined;
        return !r.ok || turnStatus === undefined || (status ? turnStatus !== status : ENDED_TURNS.has(turnStatus));
      };
      let r = await read();
      if (waitMs && !done(r)) {
        out.facts.waitMs = waitMs;
        r = await waitFor(env, p, eventsStream(sessionId), "", waitMs, r, read, done);
      }
      return answer(r, "turn");
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

/** The feed's kinds a principal without `work:read` may read (spec 37.1). */
const CORE_KINDS = ["session", "machine"];
const CLIENT_ID = /^cl_[0-9a-hjkmnp-tv-z]{16}$/;
const PROTOCOL = 1;

const reset = (out: Reply, message: string) => out.error(409, "reset", message, { cursor: null });

/** A mutation's reply (spec 37.3): 200 with `protocol`, or its error with the status of spec 34.2. */
function mutateReplyOf(out: Reply, r: MutateReply): Response {
  if ("error" in r) {
    const { code, message, ...extra } = r.error;
    return out.error(statusOf(code), code, message ?? `Refused: ${code}.`, extra);
  }
  return out.send(200, r);
}

/** The feed, the occurrence stream, the mutations and the work reads: Org's, as the principal. */
async function orgRoute(
  request: Request,
  env: ComputerEdgeEnv,
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
  if (protocol !== null && !(Number(protocol) >= PROTOCOL)) return reset(out, `This server speaks protocol ${PROTOCOL}.`);
  // Path ids of the wrong shape name nothing.
  for (const [name, value] of Object.entries(route.args ?? {})) {
    if (PATH_ID[name] && !PATH_ID[name]!.test(value)) return out.error(404, "not_found", `No such ${name}.`);
  }
  if (route.sub !== undefined && route.op !== "work.review" && !PATH_ID.tid!.test(route.sub)) return out.error(404, "not_found", "No such track.");
  if (route.op === "work.review" && !PATH_ID.resultId!.test(route.sub!)) return out.error(404, "not_found", "No such result.");

  switch (route.op) {
    case "feed": {
      const after = query.get("after") ?? undefined;
      if (after !== undefined && !cursor.read("f", after)) return reset(out, "after is not a cursor of the feed.");
      let kinds = query.get("kinds")?.split(",").filter(Boolean);
      if (!p.scopes.includes("work:read")) {
        if (kinds?.some((k) => !CORE_KINDS.includes(k))) return out.error(403, "forbidden", "Work kinds need the work:read scope.", { reason: "missing_scope", scope: "work:read" });
        kinds ??= CORE_KINDS;
      }
      const clientId = query.get("client") ?? undefined;
      if (clientId !== undefined && !CLIENT_ID.test(clientId)) return out.error(400, "invalid_request", "client is cl_ and 16 lowercase Crockford base32 characters.", { field: "client" });
      const ack = intParam(query, "ack", 0, Number.MAX_SAFE_INTEGER);
      if (ack === null) return out.error(400, "invalid_request", "ack is a non-negative integer.", { field: "ack" });
      const frame = await timed(org().feed(p, {
        ...(after !== undefined ? { after } : {}),
        ...(kinds?.length ? { kinds } : {}),
        ...(clientId ? { clientId } : {}),
        ...(ack !== undefined ? { ack } : {}),
        ...(query.get("sum") === "1" ? { sum: true } : {}),
      }));
      if ("reset" in frame) return reset(out, "The feed has moved past this cursor; read a snapshot.");
      return out.send(200, frame);
    }
    case "feed.mismatch": {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const b = asObject(parsed.value);
      if (!b || !CLIENT_ID.test(String(b.clientId)) || ["cursor", "server", "client"].some((f) => typeof b[f] !== "string" || (b[f] as string).length > 1_024)) {
        return out.error(400, "invalid_request", "The body is { clientId, cursor, server, client }.", { field: "" });
      }
      await timed(org().mismatch(p, { clientId: b.clientId as string, cursor: b.cursor as string, server: b.server as string, client: b.client as string }));
      return out.send(204, null);
    }
    case "occurrences": {
      const after = query.get("after") ?? undefined;
      if (after !== undefined && !cursor.read("o", after)) return reset(out, "after is not a cursor of the occurrence stream.");
      const limit = intParam(query, "limit", 1, 1_000);
      if (limit === null) return out.error(400, "invalid_request", "limit is 1 to 1000.", { field: "limit" });
      const r = await timed(org().occurrences(p, { ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) }));
      if ("reset" in r) return reset(out, "The occurrence stream has moved past this cursor.");
      return out.send(200, { protocol: PROTOCOL, entries: r.entries, to: r.to });
    }
    case "mutate": {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const body = asObject(parsed.value);
      if (!body) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
      // A member's client numbers its mutations; an agent or a key sends an Idempotency-Key instead.
      const clientId = request.headers.get("x-oc-client");
      const n = request.headers.get("x-oc-n");
      let client: { id: string; n: number } | undefined;
      if (clientId !== null || n !== null) {
        if (clientId === null || !CLIENT_ID.test(clientId)) return out.error(400, "invalid_request", "x-oc-client is cl_ and 16 lowercase Crockford base32 characters.", { field: "x-oc-client" });
        if (n === null || !/^[1-9]\d{0,15}$/.test(n) || !Number.isSafeInteger(Number(n))) return out.error(400, "invalid_request", "x-oc-n is a positive integer.", { field: "x-oc-n" });
        client = { id: clientId, n: Number(n) };
      }
      const r = await timed(org().mutate(p, {
        name: route.name!,
        args: { ...body, ...route.args },
        ...(client ? { client } : idem ? { idem } : {}),
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
      if (track !== undefined && !PATH_ID.tid!.test(track)) return out.error(400, "invalid_request", "track is a track id.", { field: "track" });
      const before = query.get("before") ?? undefined;
      if (before !== undefined && !cursor.read("p", before)) return reset(out, "before is not a page cursor.");
      const r = await timed(org().threads(p, {
        ...(earlier === "1" || earlier === "true" ? { earlier: true } : {}),
        ...(track ? { trackId: track } : {}),
        ...(before ? { before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
      return out.send(200, { protocol: PROTOCOL, rows: r.rows, next: r.next });
    }
    case "work.overview":
      return out.send(200, { protocol: PROTOCOL, ...(await timed(org().overview(p))) });
    case "work.doc": {
      const doc = await timed(org().doc(p, route.sub!));
      return doc ? out.send(200, { protocol: PROTOCOL, doc }) : out.error(404, "not_found", "No such track.");
    }
    case "work.doc.revisions": {
      const rev = route.args?.rev;
      const revisions = await timed(org().docRevisions(p, route.sub!, rev !== undefined ? Number(rev) : undefined));
      if (rev !== undefined) {
        const one = revisions.find((r) => r.rev === Number(rev));
        return one ? out.send(200, { protocol: PROTOCOL, revision: one }) : out.error(404, "not_found", "No such revision.");
      }
      return out.send(200, { protocol: PROTOCOL, revisions });
    }
    case "work.review": {
      const review = await timed(org().review(p, route.sub!));
      return review ? out.send(200, { protocol: PROTOCOL, review }) : out.error(404, "not_found", "No such review.");
    }
    case "work.search": {
      const q = query.get("q") ?? "";
      if (!q.trim() || q.length > 200) return out.error(400, "invalid_request", "q is 1 to 200 characters.", { field: "q" });
      const limit = intParam(query, "limit", 1, 50);
      if (limit === null) return out.error(400, "invalid_request", "limit is 1 to 50.", { field: "limit" });
      const r = await timed(org().search(p, { q, ...(limit !== undefined ? { limit } : {}) }));
      return out.send(200, { protocol: PROTOCOL, rows: r.rows });
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
      await indexInstallation(env, p.org, choice.value.installationId);
      return out.send(200, { repository: r.repository });
    }
    default:
      return out.error(404, "not_found", "No such route.");
  }
}

/**
 * Records that the organization uses this GitHub installation, so the App's pull request webhooks
 * reach its Org (spec 40.9, git-deploy-service.ts). The repository is already chosen; a failed
 * write is logged and the next choice writes it again.
 */
async function indexInstallation(env: ComputerEdgeEnv, org: string, installationId: string): Promise<void> {
  if (!env.SERVERLESS_AGENTS_DB) return;
  try {
    const account = env.ACCOUNTS.getByName(org) as unknown as { getGitHubInstallation(id: string): Promise<{ githubInstallationId: number } | null> };
    const installation = await account.getGitHubInstallation(installationId);
    if (!installation) return;
    await env.SERVERLESS_AGENTS_DB.prepare(
      "INSERT OR REPLACE INTO github_installation_orgs (github_installation_id, account_id, installation_id) VALUES (?, ?, ?)",
    ).bind(installation.githubInstallationId, org, installationId).run();
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "work.installation_index_failed", message: error instanceof Error ? error.message : String(error) }));
  }
}

// ------------------------------------------------------------------ slice 3: the socket, PATCH, agents' routes, diffs

/** `GET /live` (spec 38): the upgrade, passed to the organization's Live with the principal verified here. */
async function liveUpgrade(request: Request, env: ComputerEdgeEnv, p: Principal, out: Reply): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return out.error(426, "upgrade_required", "GET /live is a WebSocket.");
  const live = liveOf(env, p.org) as unknown as LiveUpgrade;
  return live.fetch(liveRequest(request, p));
}

/**
 * `PATCH /sessions/{id}` (spec 37.2): `title` is `thread.rename`, `archived` `thread.done` or
 * `thread.reopen`, `metadata` Org's column, the settings one `settings` inbox entry. Each part's
 * idempotency key is the request's with the part's name, so one key covers the whole request.
 */
async function patchSession(request: Request, env: ComputerEdgeEnv, p: Principal, sessionId: string, idem: string | undefined, trace: string | undefined, org: () => OrgRpc, out: Reply): Promise<Response> {
  const parsed = await bodyOf(request);
  if ("error" in parsed) return out.error(...parsed.error);
  const patch = validatePatch(parsed.value);
  if ("error" in patch) return out.of(patch.error);
  const { title, archived, metadata, model, effort, mode, speed, access } = patch.value;
  const settings = checkSettings({ ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(mode !== undefined ? { mode } : {}) });
  if (!settings.ok) return out.error(400, settings.code, settings.message, { field: settings.field });
  const mutate = async (name: string, args: Record<string, unknown>, part: string): Promise<Response | null> => {
    const r = await timedDo(out.facts, org().mutate(p, { name, args: { ...args, sid: sessionId }, ...(idem ? { idem: `${idem}:${part}` } : {}), ...(trace ? { trace } : {}) }));
    return "error" in r ? mutateReplyOf(out, r) : null;
  };
  if (title !== undefined) {
    const refused = await mutate("thread.rename", { title }, "title");
    if (refused) return refused;
  }
  if (archived !== undefined) {
    const refused = await mutate(archived ? "thread.done" : "thread.reopen", {}, "archived");
    if (refused) return refused;
  }
  if (metadata) {
    const r = await timedDo(out.facts, org().patchSession(p, sessionId, { metadata }));
    if (!r.ok) return refusalOf(out, r);
  }
  let waking: string | null = null;
  if (model !== undefined || effort !== undefined || mode !== undefined || speed !== undefined) {
    const body = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(mode !== undefined ? { mode } : {}), ...(speed !== undefined ? { speed } : {}) };
    const id = await entryId("ie", 16, idem ? ["settings", p.org, p.subject, sessionId, idem] : undefined);
    const sent = await sendEntry(env, p, sessionId, { id, kind: "settings", body }, trace, out);
    if ("response" in sent) return sent.response;
    if ("waking" in sent) waking = id;
  }
  // Access last: an admin outside the session changes it and nothing else, and learns nothing more (sessions.mdx#access).
  if (access !== undefined) {
    const r = await timedDo(out.facts, org().patchSession(p, sessionId, { access: access as SessionPatch["access"] }));
    if (!r.ok) return refusalOf(out, r);
    if (r.session === null) return out.send(200, strip(r));
  }
  const got = await timedDo(out.facts, org().getSession(p, sessionId));
  if (!got.ok) return refusalOf(out, got);
  return waking ? out.send(202, { accepted: true, id: waking, session: got.session }) : out.send(200, { session: got.session });
}

/** A body of exactly one string field of 1 to `max` characters. */
async function oneString(request: Request, field: string, max: number): Promise<{ value: string } | { error: [number, string, string, Record<string, unknown>] }> {
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed;
  const body = asObject(parsed.value);
  const extra = body && Object.keys(body).find((k) => k !== field);
  if (extra) return { error: [400, "invalid_request", `Unknown field ${extra}.`, { field: extra }] };
  const value = body?.[field];
  if (typeof value !== "string" || !value.trim() || value.length > max) return { error: [400, "invalid_request", `${field} is a string of 1 to ${max} characters.`, { field }] };
  return { value };
}

/** `POST /work/tell-track` (spec 37.2): an agent's message to its track's agent, as a turn there. */
async function tellTrack(request: Request, env: ComputerEdgeEnv, p: Principal, idem: string | undefined, trace: string | undefined, org: () => OrgRpc, out: Reply): Promise<Response> {
  if (p.kind !== "agent") return out.error(403, "forbidden", "Only a session's agent tells its track.", { reason: "agents_only" });
  const message = await oneString(request, "message", 100_000);
  if ("error" in message) return out.error(...message.error);
  const target = await timedDo(out.facts, org().trackAgent(p));
  if (!target) return out.error(404, "not_found", "This session's track has no agent.");
  const id = await entryId("tn", 12, idem ? ["tell", p.org, p.subject, idem] : undefined);
  const sent = await sendEntry(env, p, target, { id, kind: "turn", body: { input: message.value, ifBusy: "queue" } }, trace, out);
  if ("response" in sent) return sent.response;
  if ("waking" in sent) return out.send(202, { accepted: true, id });
  return out.send(200, sent.delivered);
}

const THREAD_KEY = /^[A-Za-z0-9:._-]{1,128}$/;

/** `POST /slack/threads/{key}/messages` (spec 37.2): an agent's `post_thread`, through the Slack actor. */
async function slackPost(request: Request, env: ComputerEdgeEnv, p: Principal, key: string, out: Reply): Promise<Response> {
  if (p.kind !== "agent") return out.error(403, "forbidden", "Only a session's agent posts to a Slack thread.", { reason: "agents_only" });
  const threadKey = decodeURIComponent(key);
  if (!THREAD_KEY.test(threadKey)) return out.error(404, "not_found", "No such Slack thread.");
  const text = await oneString(request, "text", 40_000);
  if ("error" in text) return out.error(...text.error);
  const r = await timedDo(out.facts, slackOf(env, p.org).post(p, threadKey, text.value));
  return r.ok ? out.send(200, { ts: r.ts }) : refusalOf(out, r);
}

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})\/?$/;

/**
 * `GET /work/results/{id}/diff` (spec 37.1): the result's pull request diff, fetched with an
 * installation token as the Computer gets one. `ETag` is the head commit.
 */
async function resultDiff(request: Request, env: ComputerEdgeEnv, p: Principal, resultId: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  if (!PATH_ID.resultId!.test(resultId)) return out.error(404, "not_found", "No such result.");
  const row = await timedDo(out.facts, org().result(p, resultId));
  const pull = row ? PULL_URL.exec(row.ref) : null;
  if (!pull) return out.error(404, "not_found", "This result is not a GitHub pull request.");
  const [, owner, repo, number] = pull;
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
  const minted = await timedDo(out.facts, account.mintGitHubInstallationToken({ installationId: target.installationId, repositories: [repo!], permissions: { contents: "read", pull_requests: "read" } }));
  if (minted.outcome !== "minted") return unavailable();
  const github = (accept: string) =>
    timedDo(out.facts, fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { authorization: `Bearer ${minted.token}`, accept, "user-agent": "opencomputer-managed-agents", "x-github-api-version": "2022-11-28" },
    }));
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
  const response = out.send(200, { protocol: PROTOCOL, head, diff: await diff.text() });
  response.headers.set("etag", etag);
  return response;
}
