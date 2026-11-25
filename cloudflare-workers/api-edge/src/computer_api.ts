// The computer's session API (serverless-agents-ws work 084): the public
// `/api/managed-agents/computer/*` routes, for API keys and dashboard
// sessions. Blue serves them at `/v1/computer/*` and already speaks the
// public contract (objects, errors, `Server-Timing`), so the edge only
// allows the documented routes, asserts who is calling and streams both
// ways: no body is rebuilt or buffered (long-polls hold for up to 60 s).
//
// Workspace files are the exception: `…/workspace/{archive,file,files}` go
// to the wire Worker, which checks the key itself, rather than through blue.
//
// This sits beside the dashboard surface in ./computer.ts, which keeps its
// own mount (`/api/dashboard/managed-agents/computer…`) and shaping.

import { computerEnabledFor } from "./computer";
import type { ManagedAgentsEnv } from "./managed_agents";
import type { ApiScope } from "./principal";
import type { RouteFamily } from "./route_family";

export const COMPUTER_API_PREFIX = "/api/managed-agents/computer";
const DEFAULT_WIRE_HTTP_URL = "https://wire.opencomputer.dev";

const COMPUTER_ROUTE = /^\/computer(?:\/|$)/;

// One path segment: an id (`cs_…`, `tn_…`, `ak_…`, a client-chosen session
// id, a foreign `toolu_…`) or a secret name. No dots first, no slashes, no
// percent-escapes, so nothing reaches blue that it would read as another path.
const SEG = "[A-Za-z0-9_][A-Za-z0-9._~:-]{0,199}";

const route = (pattern: string) => new RegExp(`^/computer${pattern}$`);

/**
 * The documented routes (opc docs/api/http/*.mdx), method by method. A route
 * of tracks and threads (spec 37) names the scope it needs, which the edge
 * checks against the principal; the others leave scopes to blue.
 */
const COMPUTER_API_ROUTES: ReadonlyArray<{
  methods: ReadonlySet<string>;
  pattern: RegExp;
  scope?: ApiScope;
}> = [
  { methods: new Set(["GET"]), pattern: route("/me") },
  { methods: new Set(["GET"]), pattern: route("/capabilities") },
  { methods: new Set(["POST"]), pattern: route("/tickets") },
  { methods: new Set(["GET", "POST"]), pattern: route("/sessions") },
  { methods: new Set(["GET", "PATCH"]), pattern: route(`/sessions/${SEG}`) },
  {
    methods: new Set(["GET"]),
    pattern: route(`/sessions/${SEG}/capabilities`),
  },
  // Set aside (docs/api/sessions.mdx).
  { methods: new Set(["PUT", "DELETE"]), pattern: route(`/sessions/${SEG}/aside`) },
  {
    methods: new Set(["POST"]),
    pattern: route(`/sessions/${SEG}/(?:interrupt|compact|suspend|resume)`),
  },
  { methods: new Set(["GET", "POST"]), pattern: route(`/sessions/${SEG}/turns`) },
  { methods: new Set(["GET"]), pattern: route(`/sessions/${SEG}/turns/${SEG}`) },
  {
    methods: new Set(["POST"]),
    pattern: route(`/sessions/${SEG}/turns/${SEG}/cancel`),
  },
  { methods: new Set(["GET"]), pattern: route(`/sessions/${SEG}/events`) },
  { methods: new Set(["GET"]), pattern: route(`/sessions/${SEG}/asks`) },
  { methods: new Set(["GET"]), pattern: route(`/sessions/${SEG}/asks/${SEG}`) },
  {
    methods: new Set(["POST"]),
    pattern: route(`/sessions/${SEG}/asks/${SEG}/(?:answer|dismiss)`),
  },
  // Subagents (docs/api/http/subagents.mdx).
  { methods: new Set(["GET"]), pattern: route(`/sessions/${SEG}/subagents`) },
  { methods: new Set(["GET"]), pattern: route(`/sessions/${SEG}/subagents/${SEG}`) },
  {
    methods: new Set(["POST"]),
    pattern: route(`/sessions/${SEG}/subagents/${SEG}/stop`),
  },
  // Secrets (docs/api/http/secrets.mdx).
  { methods: new Set(["GET"]), pattern: route("/secrets") },
  { methods: new Set(["GET"]), pattern: route(`/secrets/${SEG}/events`) },
  {
    methods: new Set(["PUT", "DELETE"]),
    pattern: route(`/(?:sessions/${SEG}|me|organization)/secrets/${SEG}`),
  },
  // The Work API (work tracking tech design 3.10).
  { methods: new Set(["GET", "PUT"]), pattern: route("/work/repository") },
  { methods: new Set(["GET"]), pattern: route("/work/repositories") },
  { methods: new Set(["GET"]), pattern: route("/work/items") },
  { methods: new Set(["GET"]), pattern: route(`/work/items/${SEG}`) },
  { methods: new Set(["GET"]), pattern: route(`/work/items/${SEG}/history`) },
  { methods: new Set(["GET"]), pattern: route(`/work/sessions/${SEG}/items`) },

  // Tracks and threads (spec 37.1): reads. `GET /live` is the socket.
  { methods: new Set(["GET"]), pattern: route("/feed"), scope: "sessions:read" },
  { methods: new Set(["POST"]), pattern: route("/feed/mismatch"), scope: "sessions:read" },
  { methods: new Set(["GET"]), pattern: route("/occurrences"), scope: "sessions:read" },
  { methods: new Set(["GET"]), pattern: route("/live"), scope: "sessions:read" },
  { methods: new Set(["GET"]), pattern: route("/work/threads"), scope: "work:read" },
  { methods: new Set(["GET"]), pattern: route("/work/overview"), scope: "work:read" },
  {
    methods: new Set(["GET"]),
    pattern: route(`/work/tracks/${SEG}/doc/revisions(?:/${SEG})?`),
    scope: "work:read",
  },
  { methods: new Set(["GET"]), pattern: route(`/work/results/${SEG}/review`), scope: "work:read" },
  { methods: new Set(["GET"]), pattern: route(`/work/results/${SEG}/diff`), scope: "work:read" },
  { methods: new Set(["GET"]), pattern: route("/work/search"), scope: "work:read" },
  { methods: new Set(["GET"]), pattern: route("/webhooks"), scope: "work:write" },
  { methods: new Set(["PUT", "DELETE"]), pattern: route(`/webhooks/${SEG}`), scope: "work:write" },
  // 37.2: the new turns and sessions routes.
  { methods: new Set(["POST"]), pattern: route("/work/tell-track"), scope: "work:write" },
  {
    methods: new Set(["POST"]),
    pattern: route(`/slack/threads/${SEG}/messages`),
    scope: "sessions:write",
  },
  // 37.3: the mutations, each its own request, all `work:write`.
  {
    methods: new Set(["PUT"]),
    pattern: route(`/work/threads/${SEG}/(?:title|track|keep|ready|attention|writers)`),
    scope: "work:write",
  },
  { methods: new Set(["PUT", "DELETE"]), pattern: route(`/work/threads/${SEG}/done`), scope: "work:write" },
  { methods: new Set(["DELETE"]), pattern: route(`/work/threads/${SEG}`), scope: "work:write" },
  { methods: new Set(["POST"]), pattern: route("/work/tracks"), scope: "work:write" },
  {
    methods: new Set(["PUT"]),
    pattern: route(`/work/tracks/${SEG}/(?:name|stand|keep|doc)`),
    scope: "work:write",
  },
  { methods: new Set(["PUT", "DELETE"]), pattern: route(`/work/tracks/${SEG}/done`), scope: "work:write" },
  { methods: new Set(["POST"]), pattern: route(`/work/tracks/${SEG}/dissolve`), scope: "work:write" },
  { methods: new Set(["DELETE"]), pattern: route(`/work/tracks/${SEG}`), scope: "work:write" },
  { methods: new Set(["PUT"]), pattern: route(`/work/reads/${SEG}`), scope: "work:write" },
  { methods: new Set(["PUT"]), pattern: route(`/work/prefs/${SEG}`), scope: "work:write" },
  { methods: new Set(["PUT"]), pattern: route(`/work/results/${SEG}`), scope: "work:write" },
  { methods: new Set(["PUT"]), pattern: route(`/work/results/${SEG}/review`), scope: "work:write" },
  { methods: new Set(["POST"]), pattern: route("/work/proposals"), scope: "work:write" },
  {
    methods: new Set(["POST"]),
    pattern: route(`/work/proposals/${SEG}/(?:accept|dismiss)`),
    scope: "work:write",
  },
  { methods: new Set(["POST"]), pattern: route(`/work/ops/${SEG}/undo`), scope: "work:write" },
];

/** The socket of tracks and threads (spec 38), relative to the mount. */
export const COMPUTER_LIVE_SUFFIX = "/computer/live";
export const LIVE_SUBPROTOCOL = "oc.live.v1";
const BEARER_SUBPROTOCOL = "oc.bearer.";

/**
 * What a `/live` upgrade offers (spec 18.7, 38): whether it asks for
 * `oc.live.v1`, and the token of an `oc.bearer.<token>` subprotocol, the only
 * place a browser can put one.
 */
export function liveOffer(request: Request): { live: boolean; token: string | null } {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const bearer = offered.find((value) => value.startsWith(BEARER_SUBPROTOCOL));
  return {
    live: offered.includes(LIVE_SUBPROTOCOL),
    token: bearer ? bearer.slice(BEARER_SUBPROTOCOL.length) || null : null,
  };
}

const WORKSPACE_ROUTE = new RegExp(
  `^/computer/sessions/(${SEG})/workspace/(archive|file|files)$`,
);

/** The workspace routes the wire Worker serves, with their methods. */
export function computerWorkspaceRoute(
  method: string,
  suffix: string,
): { sessionID: string; op: string } | null {
  const match = WORKSPACE_ROUTE.exec(suffix);
  if (!match) return null;
  const [, sessionID, op] = match;
  if (method === "GET" || (method === "PUT" && op === "archive")) {
    return { sessionID, op };
  }
  return null;
}

export function isComputerApiRoute(method: string, suffix: string): boolean {
  if (computerWorkspaceRoute(method, suffix)) return true;
  return COMPUTER_API_ROUTES.some(
    (entry) => entry.methods.has(method) && entry.pattern.test(suffix),
  );
}

/** The scope a listed route needs at the edge; null when blue alone decides. */
export function computerApiRouteScope(method: string, suffix: string): ApiScope | null {
  const entry = COMPUTER_API_ROUTES.find(
    (candidate) => candidate.methods.has(method) && candidate.pattern.test(suffix),
  );
  return entry?.scope ?? null;
}

// ── errors and request ids ───────────────────────────────────────────────

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** `req_` + 16 lowercase Crockford base32 characters, as blue mints them. */
export function newRequestID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = "req_";
  for (const byte of bytes) id += CROCKFORD[byte & 31];
  return id;
}

// A caller's own request id, echoed when it is a plain token.
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function clientRequestID(request: Request): string | null {
  const value = request.headers.get("x-request-id");
  return value && CLIENT_REQUEST_ID.test(value) ? value : null;
}

/** An edge-made error in the documented shape (docs/api/reference/errors.mdx). */
export function computerApiError(
  request: Request,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  const requestId = clientRequestID(request) ?? newRequestID();
  return Response.json(
    {
      error: {
        code,
        message,
        requestId,
        retryable: status === 429 || status >= 500,
        ...extra,
      },
    },
    {
      status,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    },
  );
}

// ── streaming pass-through ───────────────────────────────────────────────

/** Request headers the computer API reads, beyond the proxy's own. */
const API_REQUEST_HEADERS = [
  "user-agent",
  "if-none-match",
  // Tracks and threads (spec 34.2): the trace, the principal the client is
  // built for, and a member client's mutation order.
  "x-oc-trace",
  "x-oc-principal",
  "x-oc-client",
  "x-oc-n",
];

/** Response headers passed back from blue. */
const API_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "server-timing",
  "x-request-id",
  "x-opc-latest",
  "retry-after",
  "etag",
  // When the Work index last saw the branch head (work tracking 3.10), on 200 and 304.
  "work-as-of",
];

/** Request headers passed to the wire Worker, beside the caller's key. */
const WIRE_REQUEST_HEADERS = [
  "content-type",
  "content-encoding",
  "content-length",
  "idempotency-key",
  "if-none-match",
  "x-request-id",
  "user-agent",
  "accept",
  // The archive is compressed only when the caller asks for it.
  "accept-encoding",
];

/** Response headers passed back from the wire Worker. */
const WIRE_RESPONSE_HEADERS = [
  ...API_RESPONSE_HEADERS,
  "content-disposition",
];

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function streamBack(upstream: Response, names: readonly string[]): Response {
  const headers = new Headers();
  for (const name of names) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The runtime re-encodes a body it decoded when content-encoding is set,
  // so a length taken before that would be wrong.
  if (headers.has("content-encoding")) headers.delete("content-length");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(
    NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body,
    { status: upstream.status, statusText: upstream.statusText, headers },
  );
}

function upstreamUnavailable(request: Request, event: string, error: unknown) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  return computerApiError(
    request,
    502,
    "unavailable",
    "The computer API is temporarily unavailable. Try again shortly.",
  );
}

function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export const computerApiFamily: RouteFamily = {
  owns: (suffix) => COMPUTER_ROUTE.test(suffix),
  // The workspace routes are allowed on the mount but never reach blue: the
  // index routes them to the wire Worker first (proxyComputerWorkspace).
  allows: (method, suffix) =>
    !computerWorkspaceRoute(method, suffix) &&
    isComputerApiRoute(method, suffix),
  dashboardOnly: false,
  apiOnly: true,
  enabledFor: computerEnabledFor,
  // Unused: forward streams blue's contract body and errors back as they are.
  async shapeSuccess(_method, _suffix, upstream) {
    return upstream;
  },
  errorMessage: (_code, _status, _suffix, backendMessage) => backendMessage,
  async forward({ request, method, target, headers }) {
    for (const name of API_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // The caller's request id when it sent one; else blue mints a `req_` id
    // and returns it, rather than the edge's internal UUID.
    // Which contract the caller expects: `GET /computer/sessions` is the
    // dashboard's Slack-shaped list on the other mount, and a dashboard
    // session here carries no key claims to tell them apart. The proxy copies
    // only listed headers, so a client-sent value never reaches blue.
    headers.set("x-opencomputer-surface", "api");
    const requestID = clientRequestID(request);
    if (requestID) headers.set("x-request-id", requestID);
    else headers.delete("x-request-id");
    // The Live upgrade: only `oc.live.v1` goes on, never the bearer token.
    // Live answers 101 echoing it, and the socket is returned as it is.
    const upgrade = target.pathname.endsWith(COMPUTER_LIVE_SUFFIX);
    if (upgrade) {
      headers.set("upgrade", "websocket");
      headers.set("sec-websocket-protocol", LIVE_SUBPROTOCOL);
    }
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (hasBody(method)) init.body = request.body;
    try {
      const upstream = await fetch(target, init);
      if (upgrade && upstream.status === 101) return upstream;
      return streamBack(upstream, API_RESPONSE_HEADERS);
    } catch (error) {
      return upstreamUnavailable(request, "computer_api.upstream_failed", error);
    }
  },
};

/**
 * `…/sessions/{id}/workspace/{archive,file,files}` → the wire Worker's
 * `/v1/sessions/{id}/workspace/{op}`, with the caller's own key: the wire
 * Worker checks it against its KV as it does on an upgrade, so no assertion
 * is minted. Bodies stream both ways (archives are tar streams).
 */
export async function proxyComputerWorkspace(
  request: Request,
  env: Pick<ManagedAgentsEnv, "WIRE_HTTP_URL">,
  workspace: { sessionID: string; op: string },
): Promise<Response> {
  const base = (env.WIRE_HTTP_URL || DEFAULT_WIRE_HTTP_URL).replace(/\/+$/, "");
  const target = new URL(
    `${base}/v1/sessions/${encodeURIComponent(workspace.sessionID)}/workspace/${workspace.op}`,
  );
  target.search = new URL(request.url).search;
  if (target.protocol !== "https:" && target.hostname !== "localhost") {
    return computerApiError(
      request,
      503,
      "unavailable",
      "The computer API is temporarily unavailable. Try again shortly.",
    );
  }
  const headers = new Headers();
  for (const name of ["authorization", "x-api-key", ...WIRE_REQUEST_HEADERS]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (hasBody(method)) init.body = request.body;
  try {
    return streamBack(await fetch(target, init), WIRE_RESPONSE_HEADERS);
  } catch (error) {
    return upstreamUnavailable(request, "computer_api.wire_failed", error);
  }
}

// ── CORS ─────────────────────────────────────────────────────────────────

const CORS_ALLOW_HEADERS =
  "authorization, content-type, idempotency-key, x-request-id, if-none-match, x-oc-trace, x-oc-principal, x-oc-client, x-oc-n";
const CORS_ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE";
const CORS_EXPOSE_HEADERS =
  "server-timing, x-request-id, x-opc-latest, retry-after, etag, work-as-of";

/**
 * Whether a browser origin may call the computer API: the edge's own origin
 * (the dashboard is served by this Worker) and any listed in
 * COMPUTER_API_CORS_ORIGINS.
 */
export function computerApiOriginAllowed(
  request: Request,
  env: Pick<ManagedAgentsEnv, "COMPUTER_API_CORS_ORIGINS">,
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  return (env.COMPUTER_API_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .includes(origin);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

/** The answer to a preflight on the computer API. */
export function computerApiPreflight(
  request: Request,
  env: Pick<ManagedAgentsEnv, "COMPUTER_API_CORS_ORIGINS">,
): Response {
  const origin = request.headers.get("origin");
  if (!origin || !computerApiOriginAllowed(request, env)) {
    return new Response(null, { status: 204, headers: { vary: "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-allow-methods": CORS_ALLOW_METHODS,
      "access-control-max-age": "600",
    },
  });
}

/** Adds the CORS answer for an allowed origin to a computer API response. */
export function withComputerApiCors(
  request: Request,
  env: Pick<ManagedAgentsEnv, "COMPUTER_API_CORS_ORIGINS">,
  response: Response,
): Response {
  const origin = request.headers.get("origin");
  if (!origin || !computerApiOriginAllowed(request, env)) return response;
  // A WebSocket or otherwise immutable response is returned as it is.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) {
    headers.set(name, value);
  }
  headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── credentials ──────────────────────────────────────────────────────────

/**
 * The API key a computer API request carries: `x-api-key` or
 * `Authorization: Bearer` (docs/api/authentication.mdx). Both present and
 * different is a 401, as documented.
 */
export function computerApiKey(
  request: Request,
): { key: string | null } | { conflict: true } {
  const header = request.headers.get("x-api-key");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;
  if (header && bearer && header !== bearer) return { conflict: true };
  return { key: header || bearer };
}
