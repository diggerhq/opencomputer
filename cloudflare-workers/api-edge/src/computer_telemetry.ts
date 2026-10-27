// The computer API's edge telemetry (serverless-agents-ws work 084, instrumentation;
// the contract is the calvin catalog's "blue and edge" section). One `edge.request`
// per /api/managed-agents/computer/* request: route family, method, status,
// where it went (blue, the wire Worker, or answered here), blue's own time from
// its `Server-Timing: blue;dur=`, why the edge refused it, and whether the
// per-key rate limit did.
//
// Dumb dump: one event per request, no sums or windows here; Tinybird aggregates.
// The line goes to Tinybird's Events API (`calvin_events`, the envelope blue's
// gateway emitter writes) through `ctx.waitUntil`, never awaited on the request.
// Off (nothing built, nothing sent) unless TINYBIRD_API_URL and
// TINYBIRD_APPEND_TOKEN are both set.
//
// Data policy (work 054): ids only. No paths, bodies, key secrets or hashes,
// tickets, IPs or user agents; the route is a family name, never the URL.

export interface EdgeTelemetryEnv {
  TINYBIRD_API_URL?: string;
  TINYBIRD_APPEND_TOKEN?: string;
  CF_VERSION_METADATA?: { id?: string };
}

/** Why the edge refused the caller, or `ok`. */
export type EdgeAuth =
  | "ok"
  | "missing"
  | "invalid"
  | "conflicting"
  | "project_key"
  | "not_member"
  | "origin"
  | "key_required"
  | "disabled"
  | "none";

/** What the edge learns about one request while it handles it. */
export interface EdgeRequestFacts {
  started: number;
  auth: EdgeAuth;
  via: "key" | "dashboard" | "none";
  upstream: "blue" | "wire" | "edge";
  rateLimited: boolean;
  orgId?: string;
  keyId?: string;
}

export function newEdgeRequestFacts(now = Date.now()): EdgeRequestFacts {
  return { started: now, auth: "none", via: "none", upstream: "edge", rateLimited: false };
}

const POST_TIMEOUT_MS = 5_000;
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^\/computer\/sessions\/(cs_[0-9a-hjkmnp-tv-z]{16})(?:\/|$)/;

export function edgeTelemetryEnabled(env: EdgeTelemetryEnv): boolean {
  return Boolean(env.TINYBIRD_API_URL?.trim() && env.TINYBIRD_APPEND_TOKEN?.trim());
}

/** The route family of a computer API suffix (`/computer/...`), as blue's `httpapi.request` names them. */
export function computerApiRouteFamily(suffix: string): string {
  const parts = suffix.split("/").filter(Boolean); // ["computer", ...]
  const [, first, , third] = parts;
  if (first === "me") return parts.length === 2 ? "me" : "secrets";
  if (first === "tickets") return "tickets";
  if (first === "secrets" || first === "organization") return "secrets";
  if (first !== "sessions") return "other";
  if (parts.length <= 3) return "sessions";
  switch (third) {
    case "capabilities":
      return "sessions";
    case "interrupt":
    case "compact":
    case "suspend":
    case "resume":
      return "control";
    case "turns":
      return "turns";
    case "events":
      return "events";
    case "asks":
      return "asks";
    case "subagents":
      return "subagents";
    case "secrets":
      return "secrets";
    case "workspace":
      return "workspace";
    default:
      return "other";
  }
}

/** Blue's `Server-Timing: blue;dur=12.3`, in whole ms; undefined when absent. */
export function blueMs(response: Response): number | undefined {
  const header = response.headers.get("server-timing");
  const match = header ? /(?:^|,)\s*blue;dur=([0-9.]+)/.exec(header) : null;
  if (!match) return undefined;
  const ms = Math.round(Number(match[1]));
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** A Tinybird `DateTime64` string. */
export function tbTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** UUIDv7: a 48-bit ms timestamp, then random bits. */
export function uuidv7(now: number): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The `edge.request` line for `calvin_events` (`data` as a JSON string, as blue writes it). */
export function edgeRequestEvent(
  env: EdgeTelemetryEnv,
  req: Request,
  suffix: string,
  status: number,
  facts: EdgeRequestFacts,
  response: Response | null,
  now = Date.now(),
): Record<string, unknown> {
  const method = req.method.toUpperCase();
  const ua = req.headers.get("user-agent") ?? "";
  const session = SESSION.exec(suffix)?.[1];
  const colo = (req as { cf?: { colo?: unknown } }).cf?.colo;
  const blue = facts.upstream === "blue" && response ? blueMs(response) : undefined;
  const data: Record<string, unknown> = {
    route: computerApiRouteFamily(suffix),
    method: METHODS.has(method) ? method : "other",
    status,
    upstream: facts.upstream,
    auth: facts.auth,
    via: facts.via,
    rate_limited: facts.rateLimited,
    ...(blue !== undefined ? { blue_ms: blue } : {}),
    ...(facts.keyId && ID.test(facts.keyId) ? { key_id: facts.keyId } : {}),
  };
  return {
    schema_version: 1,
    event_id: uuidv7(now),
    event_name: "edge.request",
    occurred_at: tbTime(now),
    service_name: "edge",
    service_version: env.CF_VERSION_METADATA?.id || "dev",
    region: typeof colo === "string" && /^[A-Z]{3}$/.test(colo) ? colo : "unknown",
    synthetic: false,
    surface: ua.startsWith("opc/") ? "cli" : "api",
    ...(session ? { session_key: session } : {}),
    ...(facts.orgId && ID.test(facts.orgId) ? { org_id: facts.orgId } : {}),
    duration_ms: Math.max(0, Math.round(now - facts.started)),
    outcome: status < 400 ? "completed" : "failed",
    ...(status >= 400 ? { error_type: "unknown", error_code: String(status) } : {}),
    data: JSON.stringify(data),
  };
}

/**
 * Sends one request's `edge.request` off the response path. Never throws;
 * a failed POST is retried once on 5xx, 429 or a timeout, then dropped.
 */
export function reportEdgeRequest(
  env: EdgeTelemetryEnv,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  req: Request,
  suffix: string,
  facts: EdgeRequestFacts,
  response: Response | null,
): void {
  try {
    if (!ctx || !edgeTelemetryEnabled(env)) return;
    const line = JSON.stringify(
      edgeRequestEvent(env, req, suffix, response?.status ?? 500, facts, response),
    );
    ctx.waitUntil(post(env, line).catch(() => {}));
  } catch {
    // Telemetry never fails the request.
  }
}

async function post(env: EdgeTelemetryEnv, line: string): Promise<void> {
  const url = `${env.TINYBIRD_API_URL!.trim().replace(/\/+$/, "")}/v0/events?name=calvin_events&wait=false`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TINYBIRD_APPEND_TOKEN!.trim()}`,
          "content-type": "application/x-ndjson",
        },
        body: line,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok || (res.status < 500 && res.status !== 429)) return;
    } catch {
      // Retried once.
    }
  }
}
