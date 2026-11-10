// The wire Worker's request path (work 084, decision 7): `wire.opencomputer.dev`.
//
//   GET /v1 (WebSocket)  key (Authorization: Bearer / x-api-key) → sha256 → KV,
//                        or a ticket in the `opc.ticket.<t>` subprotocol → verify (never both: 4003 ticket_and_key;
//                        the ticket's org, member, computer and tunnelId must match the key's KV record)
//                        → fetch https://<tunnelId>.<WIRE_TUNNEL_DOMAIN>/connect, signed (X-Wire-*)
//                        → the 101 handed back as it came (Cloudflare pipes the socket)
//   /v1/sessions/<cs_…>/workspace/(archive|file|files)
//                        key only → /files/<cs_…>/<op> on the tunnel, both bodies streamed
//
// No DO, no D1: one KV read (two for a ticket), WebCrypto, one fetch. The key
// and the ticket never leave this Worker. A refused upgrade is still accepted
// and closed at once with the code, because a browser sees only 1006 for a
// failed one.

import { gatewayTelemetry } from "../computer/telemetry/gateway.js";
import { WIRE_CLIENT, WIRE_SIGNATURE_TTL_MS, type WireScope, computerKey, signWireAuth } from "./auth.js";
import { sha256Hex } from "./crypto.js";
import { type WireKeyRecord, type WireKeysKv, recordByHash, recordByKeyId } from "./keys.js";
import { SESSION_ID, verifyTicket } from "./ticket.js";

export const WIRE_PROTOCOL = "opc.v1";
export const TICKET_PROTOCOL_PREFIX = "opc.ticket.";
export const DEFAULT_TUNNEL_DOMAIN = "w.opencomputer.dev";
/** A ticket connection is closed by the relay this long after it opened. */
export const TICKET_CONNECTION_TTL_MS = 3600_000;
export const RETRY_AFTER_MS = 1_000;

export const CLOSE = {
  unauthenticated: 4001,
  forbidden: 4003,
  unavailable: 4503,
  version: 4400,
  internal: 1011,
} as const;

export interface WireEnv {
  /** `h:<sha256(key)>` → WireKeyRecord, `k:<keyId>` → hash; written by managed-agents. */
  WIRE_KEYS?: WireKeysKv;
  /** Verifies tickets (HKDF → HMAC); shared with managed-agents. A secret. */
  WIRE_TICKET_KEY?: string;
  /** Derives each computer's key; shared with managed-agents and previews. A secret. */
  PREVIEW_PLATFORM_KEY?: string;
  /** Where the tunnels' wire hostnames live; `w.opencomputer.dev` unless set. */
  WIRE_TUNNEL_DOMAIN?: string;
  /** Telemetry (work 084): both set turns on one `wireworker.request` per request; the gateway's append token. */
  TINYBIRD_API_URL?: string;
  TINYBIRD_APPEND_TOKEN?: string;
  CF_VERSION_METADATA?: { id?: string };
}

/**
 * What one request's `wireworker.request` reports (work 084 instrumentation, Q5), filled on the
 * way. Ids and closed values only: never a key, its hash, a ticket or a path.
 */
interface WireFacts {
  kind: "upgrade" | "files" | "other";
  via: "key" | "ticket" | "both" | "none";
  result: "accepted" | "refused" | "unavailable" | "failed" | "not_found";
  reason?: string;
  /** The close code an upgrade's socket got (or 101 passed through), or the HTTP status. */
  code?: number;
  op?: string;
  org?: string;
  member?: string;
  keyId?: string;
  sessionId?: string;
  /** KV lookups and their time; the tunnel round trip and its status. */
  kvGets: number;
  kvMs: number;
  tunnelMs?: number;
  tunnelStatus?: number;
}

export interface WireHandlerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests: the telemetry POST (defaults to `fetch`). */
  telemetryFetch?: typeof fetch;
}

/** The refusal reasons `wireworker.request` takes; anything else is `other`. */
const REASONS = new Set([
  "conflicting_keys", "ticket_and_key", "unauthenticated", "project_key", "missing_scope",
  "unsupported_version", "not_configured", "ticket", "not_found", "session_not_found", "tunnel_failed", "tunnel_refused", "internal",
]);

const FILES_ROUTE = /^\/v1\/sessions\/([^/]+)\/workspace\/(archive|file|files)$/;
const TUNNEL_LABEL = /^[A-Za-z0-9-]{1,63}$/;
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;
const OPC_CLIENT = /^opc\/\d+\.\d+\.\d+/;
/** Request headers a `/files` call carries to the relay; nothing else of the caller's goes. */
const FILES_REQUEST_HEADERS = ["content-type", "content-encoding", "content-length", "accept-encoding", "idempotency-key", "if-none-match"];

type Refusal = { status: 401 | 403; close: 4001 | 4003; code: "unauthenticated" | "forbidden"; reason?: string; scope?: string; message: string };

const unauthenticated: Refusal = { status: 401, close: CLOSE.unauthenticated, code: "unauthenticated", message: "The credential is missing, unknown, expired or revoked." };

/** Why `record` may not do what needs `scope` at `at`, or null. */
function refuseRecord(record: WireKeyRecord | null, at: number, scope: string): Refusal | null {
  if (!record || (record.expiresAt !== null && record.expiresAt !== undefined && record.expiresAt <= at)) return unauthenticated;
  if (record.kind === "project") {
    return { status: 403, close: CLOSE.forbidden, code: "forbidden", reason: "project_key", message: "A project-scoped key cannot use the computer." };
  }
  if (!record.scopes.includes(scope)) {
    return { status: 403, close: CLOSE.forbidden, code: "forbidden", reason: "missing_scope", scope, message: `The key lacks the ${scope} scope.` };
  }
  return null;
}

/** The API key from `Authorization: Bearer` or `x-api-key`, or null. */
function apiKey(headers: Headers): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
  if (bearer) return bearer[1]!;
  return headers.get("x-api-key")?.trim() || null;
}

/** Both headers present and naming different keys: refused like a bad key (authentication.mdx). */
function conflictingKeys(headers: Headers): boolean {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")?.[1];
  const header = headers.get("x-api-key")?.trim();
  return !!bearer && !!header && bearer !== header;
}

function subprotocols(headers: Headers): string[] {
  return (headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/** `opc/x.y.z…` from the User-Agent when it is a short printable one; "" otherwise. */
export function clientFromUserAgent(userAgent: string | null): string {
  if (!userAgent || !OPC_CLIENT.test(userAgent) || !WIRE_CLIENT.test(userAgent)) return "";
  return userAgent;
}

function mintRequestId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "req_";
  for (const byte of bytes) id += alphabet[byte & 31];
  return id;
}

/** The caller's x-request-id when it is a sane one, else a new `req_…`. */
function requestIdOf(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  return incoming && REQUEST_ID.test(incoming) ? incoming : mintRequestId();
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

/** An accepted upgrade closed at once with `code`: the client reads the code, not 1006. */
export function closedSocket(code: number, reason: Record<string, unknown>, selectProtocol = true): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  server.close(code, JSON.stringify(reason));
  // Offering no opc.v1 (4400), selecting it would fail the handshake in a browser.
  const headers: HeadersInit = selectProtocol ? { "sec-websocket-protocol": WIRE_PROTOCOL } : {};
  return new Response(null, { status: 101, webSocket: client, headers });
}

function errorResponse(status: number, requestId: string, error: Record<string, unknown>, headers: HeadersInit = {}): Response {
  return Response.json(
    { error: { ...error, requestId, retryable: status >= 500 || status === 429 } },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store", ...headers } },
  );
}

/** A request handler with its own isolate caches; `index.ts` makes one per isolate. */
export function createWireHandler(options: WireHandlerOptions = {}) {
  const upstream = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const computerKeys = new Map<string, Promise<string>>();

  function keyFor(env: WireEnv, tunnelId: string): Promise<string> {
    let key = computerKeys.get(tunnelId);
    if (!key) {
      key = computerKey(env.PREVIEW_PLATFORM_KEY!, tunnelId);
      computerKeys.set(tunnelId, key);
      if (computerKeys.size > 5_000) computerKeys.delete(computerKeys.keys().next().value as string);
      key.catch(() => computerKeys.delete(tunnelId));
    }
    return key;
  }

  async function signed(env: WireEnv, record: WireKeyRecord, client: string, scope: WireScope, at: number): Promise<{ origin: string; headers: Record<string, string> }> {
    if (!TUNNEL_LABEL.test(record.tunnelId)) throw new Error("bad tunnel id in key record");
    const headers = await signWireAuth(await keyFor(env, record.tunnelId), {
      member: record.member,
      keyId: record.keyId,
      client,
      scope,
      exp: at + WIRE_SIGNATURE_TTL_MS,
    });
    return { origin: `https://${record.tunnelId}.${env.WIRE_TUNNEL_DOMAIN || DEFAULT_TUNNEL_DOMAIN}`, headers };
  }

  /** A KV read, timed into the facts. */
  async function kv<T>(f: WireFacts, read: Promise<T>): Promise<T> {
    const began = performance.now();
    try {
      return await read;
    } finally {
      f.kvGets++;
      f.kvMs += performance.now() - began;
    }
  }

  function refused(f: WireFacts, reason: string, code: number): void {
    f.result = "refused";
    f.reason = reason;
    f.code = code;
  }

  async function upgrade(request: Request, env: WireEnv, url: URL, f: WireFacts): Promise<Response> {
    const protocols = subprotocols(request.headers);
    if (!protocols.includes(WIRE_PROTOCOL)) {
      refused(f, "unsupported_version", CLOSE.version);
      return closedSocket(CLOSE.version, { code: "unsupported_version", message: `Offer the ${WIRE_PROTOCOL} subprotocol.` }, false);
    }
    if (!env.WIRE_KEYS || !env.PREVIEW_PLATFORM_KEY) {
      console.error(JSON.stringify({ level: "error", event: "wire.not_configured" }));
      f.result = "failed";
      f.reason = "not_configured";
      f.code = CLOSE.internal;
      return closedSocket(CLOSE.internal, { code: "internal" });
    }
    const at = now();
    if (conflictingKeys(request.headers)) {
      log("wire.refused", { via: "key", close: CLOSE.unauthenticated, reason: "conflicting_keys" });
      f.via = "key";
      refused(f, "conflicting_keys", CLOSE.unauthenticated);
      return closedSocket(CLOSE.unauthenticated, { code: "unauthenticated" });
    }
    const key = apiKey(request.headers);
    const ticket = protocols.find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX))?.slice(TICKET_PROTOCOL_PREFIX.length);
    let record: WireKeyRecord | null = null;
    let client = "";
    let scope: WireScope = {};
    let via: "key" | "ticket" = "key";
    if (key && ticket !== undefined) {
      // A ticket narrows a key; both at once would make the narrowing silently optional.
      log("wire.refused", { via: "both", close: CLOSE.forbidden, reason: "ticket_and_key" });
      f.via = "both";
      refused(f, "ticket_and_key", CLOSE.forbidden);
      return closedSocket(CLOSE.forbidden, { code: "forbidden", reason: "ticket_and_key" });
    }
    if (key) {
      f.via = "key";
      record = await kv(f, recordByHash(env.WIRE_KEYS, await sha256Hex(key)));
      client = clientFromUserAgent(request.headers.get("user-agent"));
      if (record) scope = { scopes: record.scopes, ...(record.expiresAt != null ? { until: record.expiresAt } : {}) };
    } else if (ticket && env.WIRE_TICKET_KEY) {
      via = "ticket";
      f.via = "ticket";
      const claims = await verifyTicket(env.WIRE_TICKET_KEY, ticket, at);
      if (claims) {
        record = await kv(f, recordByKeyId(env.WIRE_KEYS, claims.keyId));
        // The ticket names its key; the key's current record must still be that member's, on the ticket's computer.
        if (
          record &&
          (record.org !== claims.org || record.member !== claims.member || record.computer !== claims.computer || record.tunnelId !== claims.tunnelId)
        ) {
          record = null;
        }
        client = WIRE_CLIENT.test(claims.client) ? claims.client : "";
        if (record) {
          scope = {
            scopes: record.scopes,
            ...(claims.scope.sessionIds ? { sessionIds: claims.scope.sessionIds } : {}),
            ...(claims.scope.readOnly !== undefined ? { readOnly: claims.scope.readOnly } : {}),
            until: Math.min(at + TICKET_CONNECTION_TTL_MS, record.expiresAt ?? Infinity),
          };
        }
      }
    }
    const refusal = refuseRecord(record, at, "sessions:read");
    if (refusal) {
      log("wire.refused", { via, close: refusal.close, reason: refusal.reason ?? refusal.code, keyId: record?.keyId });
      refused(f, refusal.reason ?? refusal.code, refusal.close);
      if (record) (f.org = record.org), (f.keyId = record.keyId);
      return closedSocket(refusal.close, { code: refusal.code, ...(refusal.reason ? { reason: refusal.reason } : {}), ...(refusal.scope ? { scope: refusal.scope } : {}) });
    }
    f.org = record!.org;
    f.member = record!.member;
    f.keyId = record!.keyId;
    const target = await signed(env, record!, client, scope, at);
    let response: Response;
    const tunnelAt = performance.now();
    try {
      response = await upstream(`${target.origin}/connect${url.search}`, {
        headers: { upgrade: "websocket", "sec-websocket-protocol": WIRE_PROTOCOL, ...target.headers },
      });
    } catch (error) {
      f.tunnelMs = performance.now() - tunnelAt;
      log("wire.tunnel_failed", { org: record!.org, error: String(error) });
      f.result = "unavailable";
      f.reason = "tunnel_failed";
      f.code = CLOSE.unavailable;
      return closedSocket(CLOSE.unavailable, { retryAfterMs: RETRY_AFTER_MS });
    }
    f.tunnelMs = performance.now() - tunnelAt;
    f.tunnelStatus = response.status;
    if (response.status === 101) {
      f.result = "accepted";
      f.code = 101;
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    log("wire.tunnel_refused", { org: record!.org, status: response.status });
    f.reason = "tunnel_refused";
    if (response.status === 530 || response.status === 502 || response.status === 503 || response.status === 504) {
      f.result = "unavailable";
      f.code = CLOSE.unavailable;
      return closedSocket(CLOSE.unavailable, { retryAfterMs: RETRY_AFTER_MS });
    }
    f.result = "failed";
    f.code = CLOSE.internal;
    return closedSocket(CLOSE.internal, { code: "internal" });
  }

  async function files(request: Request, env: WireEnv, url: URL, sessionId: string, op: string, f: WireFacts): Promise<Response> {
    const requestId = requestIdOf(request);
    const write = request.method === "PUT";
    f.op = write ? "put" : op;
    if (SESSION_ID.test(sessionId)) f.sessionId = sessionId;
    if (!(request.method === "GET" || (write && op === "archive"))) {
      f.result = "not_found";
      f.reason = "not_found";
      f.code = 404;
      return errorResponse(404, requestId, { code: "not_found", message: "No such route." });
    }
    if (!env.WIRE_KEYS || !env.PREVIEW_PLATFORM_KEY) {
      console.error(JSON.stringify({ level: "error", event: "wire.not_configured" }));
      f.result = "failed";
      f.reason = "not_configured";
      f.code = 500;
      return errorResponse(500, requestId, { code: "internal", message: "Something went wrong on our side." });
    }
    if (conflictingKeys(request.headers)) {
      f.via = "key";
      refused(f, "conflicting_keys", 401);
      return errorResponse(401, requestId, { code: "unauthenticated", message: "Authorization and x-api-key name different keys." });
    }
    const key = apiKey(request.headers);
    const ticketOffered = subprotocols(request.headers).some((p) => p.startsWith(TICKET_PROTOCOL_PREFIX));
    if (key?.startsWith("tk_") || (!key && ticketOffered)) {
      f.via = "ticket";
      refused(f, "ticket", 403);
      return errorResponse(403, requestId, { code: "forbidden", reason: "ticket", message: "Tickets open WebSocket connections only; use an API key for files." });
    }
    const at = now();
    if (key) f.via = "key";
    const record = key ? await kv(f, recordByHash(env.WIRE_KEYS, await sha256Hex(key))) : null;
    const scopeNeeded = write ? "sessions:write" : "sessions:read";
    const refusal = refuseRecord(record, at, scopeNeeded);
    if (refusal) {
      const { status, code, reason, scope, message } = refusal;
      refused(f, reason ?? code, status);
      if (record) (f.org = record.org), (f.keyId = record.keyId);
      return errorResponse(status, requestId, { code, ...(reason ? { reason } : {}), ...(scope ? { scope } : {}), message });
    }
    f.org = record!.org;
    f.member = record!.member;
    f.keyId = record!.keyId;
    if (!SESSION_ID.test(sessionId)) {
      f.result = "not_found";
      f.reason = "session_not_found";
      f.code = 404;
      return errorResponse(404, requestId, { code: "session_not_found", message: "No such session." });
    }

    const scope: WireScope = { scopes: record!.scopes, ...(record!.expiresAt != null ? { until: record!.expiresAt } : {}) };
    const target = await signed(env, record!, clientFromUserAgent(request.headers.get("user-agent")), scope, at);
    const headers = new Headers(target.headers);
    for (const name of FILES_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("x-request-id", requestId);

    let response: Response;
    const tunnelAt = performance.now();
    try {
      response = await upstream(`${target.origin}/files/${sessionId}/${op}${url.search}`, {
        method: request.method,
        headers,
        body: write ? request.body : null,
        redirect: "manual",
      });
    } catch (error) {
      f.tunnelMs = performance.now() - tunnelAt;
      log("wire.files_failed", { org: record!.org, error: String(error) });
      f.result = "unavailable";
      f.reason = "tunnel_failed";
      f.code = 503;
      return unavailable(requestId);
    }
    f.tunnelMs = performance.now() - tunnelAt;
    f.tunnelStatus = response.status;
    if (response.status === 530 || response.status === 502) {
      await response.body?.cancel().catch(() => undefined);
      f.result = "unavailable";
      f.reason = "tunnel_refused";
      f.code = 503;
      return unavailable(requestId);
    }
    f.result = response.status < 400 ? "accepted" : "failed";
    f.code = response.status;
    const out = new Headers(response.headers);
    out.set("x-request-id", requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  }

  function unavailable(requestId: string): Response {
    return errorResponse(
      503,
      requestId,
      { code: "computer_unavailable", retryAfterMs: RETRY_AFTER_MS, message: "Your computer is starting or being updated. Retry." },
      { "retry-after": String(Math.ceil(RETRY_AFTER_MS / 1000)) },
    );
  }

  /** The request's one `wireworker.request` (Q5); sent through `waitUntil`, never awaited, never throws. */
  function report(env: WireEnv, f: WireFacts, began: number, waitUntil: ((p: Promise<unknown>) => void) | undefined): void {
    try {
      const t = gatewayTelemetry(env, {
        ...(options.telemetryFetch ? { fetch: options.telemetryFetch } : {}),
        base: f.org ? { org_id: f.org } : {},
      });
      const failed = f.result !== "accepted";
      t.emit("wireworker.request", {
        surface: "cli",
        ...(f.sessionId ? { session_key: f.sessionId } : {}),
        ...(f.member ? { person_id: f.member } : {}),
        duration_ms: Math.round(performance.now() - began),
        outcome: failed ? "failed" : "completed",
        ...(failed ? { error_type: "unknown" as const, error_code: f.reason && REASONS.has(f.reason) ? f.reason : f.result } : {}),
        data: {
          kind: f.kind,
          via: f.via,
          result: f.result,
          ...(f.reason ? { reason: REASONS.has(f.reason) ? f.reason : "other" } : {}),
          ...(f.code !== undefined ? { code: f.code } : {}),
          ...(f.op ? { op: ["put", "archive", "file", "files"].includes(f.op) ? f.op : "other" } : {}),
          ...(f.keyId ? { key_id: f.keyId } : {}),
          kv_gets: f.kvGets,
          kv_ms: Math.round(f.kvMs),
          ...(f.tunnelMs !== undefined ? { tunnel_ms: Math.round(f.tunnelMs) } : {}),
          ...(f.tunnelStatus !== undefined ? { tunnel_status: f.tunnelStatus } : {}),
        },
      });
      const done = t.done();
      if (waitUntil) waitUntil(done);
    } catch {
      // Telemetry never fails the request.
    }
  }

  return async function handle(request: Request, env: WireEnv, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    const began = performance.now();
    const f: WireFacts = { kind: "other", via: "none", result: "not_found", kvGets: 0, kvMs: 0 };
    try {
      if (url.pathname === "/v1" && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        f.kind = "upgrade";
        return await upgrade(request, env, url, f);
      }
      const route = FILES_ROUTE.exec(url.pathname);
      if (route) {
        f.kind = "files";
        return await files(request, env, url, route[1]!, route[2]!, f);
      }
      f.reason = "not_found";
      f.code = 404;
      return errorResponse(404, requestIdOf(request), { code: "not_found", message: "No such route." });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "wire.handler_failed", error: String(error) }));
      f.result = "failed";
      f.reason = "internal";
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return (f.code = CLOSE.internal), closedSocket(CLOSE.internal, { code: "internal" });
      f.code = 500;
      return errorResponse(500, mintRequestId(), { code: "internal", message: "Something went wrong on our side." });
    } finally {
      report(env, f, began, ctx ? (p) => ctx.waitUntil(p) : undefined);
    }
  };
}
