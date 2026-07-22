// Durable, owner/admin-visible alerts for exposed Agent Hook credentials.
//
// The internal receiver authenticates the exact raw body before parsing and
// stores only the frozen server-authored fields from design 017 §12.4. It never
// receives or persists GitHub Match Data or the exposed credential.

export interface AgentSecurityNotificationsEnv {
  OPENCOMPUTER_DB: D1Database;
  OC_SECURITY_NOTIFICATION_SECRET?: string;
}

export interface AgentSecurityCaller {
  orgID: string;
  userID: string;
}

export const AGENT_SECURITY_NOTIFICATION_PATH = "/internal/agent-security-notifications";

const MAX_BODY_BYTES = 4 * 1024;
const SIGNATURE_WINDOW_SECONDS = 5 * 60;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EVENT_ID_RE = /^hse_[0-9a-f]{24}$/;
const AGENT_ID_RE = /^agt_[0-9a-f]{24}$/;
const HOOK_ID_RE = /^hk_[0-9a-f]{24}$/;
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SecurityEventInput {
  id: string;
  org_id: string;
  agent_id: string;
  hook_id: string;
  kind: "secret_exposure";
  occurred_at: string;
}

interface StoredSecurityEvent {
  id: string;
  org_id: string;
  agent_id: string;
  hook_id: string;
  kind: "secret_exposure";
  occurred_at: number;
  received_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
}

interface CursorV1 {
  v: 1;
  include_acknowledged: boolean;
  occurred_at: number;
  id: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function fixedError(type: string, message: string, status: number): Response {
  return json({ error: { type, message } }, status);
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

async function validSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  if (!signature.startsWith("v1=")) return false;
  const bytes = hexBytes(signature.slice(3));
  if (!bytes) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
}

function parseCanonicalTimestamp(value: unknown): number | null {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const canonical = new Date(millis).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) return null;
  return Math.floor(millis / 1_000);
}

function parseEvent(rawBody: string): { event: SecurityEventInput; occurredAt: number } | null {
  let value: unknown;
  try { value = JSON.parse(rawBody); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "agent_id,hook_id,id,kind,occurred_at,org_id") return null;
  const occurredAt = parseCanonicalTimestamp(record.occurred_at);
  if (
    typeof record.id !== "string"
    || typeof record.org_id !== "string"
    || typeof record.agent_id !== "string"
    || typeof record.hook_id !== "string"
    || !EVENT_ID_RE.test(record.id)
    || !ORG_ID_RE.test(record.org_id)
    || !AGENT_ID_RE.test(record.agent_id)
    || !HOOK_ID_RE.test(record.hook_id)
    || record.kind !== "secret_exposure"
    || occurredAt === null
  ) return null;
  return { event: record as unknown as SecurityEventInput, occurredAt };
}

function sameEvent(
  row: StoredSecurityEvent,
  event: SecurityEventInput,
  occurredAt: number,
): boolean {
  return row.id === event.id
    && row.org_id === event.org_id
    && row.agent_id === event.agent_id
    && row.hook_id === event.hook_id
    && row.kind === event.kind
    && row.occurred_at === occurredAt;
}

export async function receiveAgentSecurityNotification(
  req: Request,
  env: AgentSecurityNotificationsEnv,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  if (req.method !== "POST") return fixedError("method_not_allowed", "Method not allowed", 405);
  if (!env.OC_SECURITY_NOTIFICATION_SECRET) {
    return fixedError("unavailable", "Security notification receiver is unavailable", 503);
  }
  if ((req.headers.get("content-type") ?? "").trim().toLowerCase() !== "application/json") {
    return fixedError("unsupported_media", "Content type must be application/json", 415);
  }
  const contentLength = req.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
    return fixedError("invalid", "Invalid content length", 400);
  }
  if (declared !== null && declared > MAX_BODY_BYTES) {
    return fixedError("payload_too_large", "Payload too large", 413);
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return fixedError("payload_too_large", "Payload too large", 413);
  }
  const timestamp = req.headers.get("x-oc-security-timestamp") ?? "";
  const signature = req.headers.get("x-oc-security-signature") ?? "";
  const timestampNumber = Number(timestamp);
  if (
    !/^[1-9]\d{9}$/.test(timestamp)
    || !Number.isSafeInteger(timestampNumber)
    || Math.abs(nowSeconds - timestampNumber) > SIGNATURE_WINDOW_SECONDS
  ) {
    return fixedError("unauthorized", "Invalid security notification signature", 401);
  }
  if (!(await validSignature(env.OC_SECURITY_NOTIFICATION_SECRET, timestamp, rawBody, signature))) {
    return fixedError("unauthorized", "Invalid security notification signature", 401);
  }

  const parsed = parseEvent(rawBody);
  if (!parsed) return fixedError("invalid", "Invalid security notification", 400);
  const inserted = await env.OPENCOMPUTER_DB.prepare(
    `INSERT OR IGNORE INTO agent_security_notifications
       (id,org_id,agent_id,hook_id,kind,occurred_at,received_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(
    parsed.event.id,
    parsed.event.org_id,
    parsed.event.agent_id,
    parsed.event.hook_id,
    parsed.event.kind,
    parsed.occurredAt,
    nowSeconds,
  ).run();
  if ((inserted.meta?.changes ?? 0) > 0) return new Response(null, { status: 204 });

  const existing = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id,org_id,agent_id,hook_id,kind,occurred_at,received_at,
            acknowledged_at,acknowledged_by
       FROM agent_security_notifications WHERE id=?1`,
  ).bind(parsed.event.id).first<StoredSecurityEvent>();
  if (!existing) return fixedError("unavailable", "Security notification storage is unavailable", 503);
  if (!sameEvent(existing, parsed.event, parsed.occurredAt)) {
    return fixedError("conflict", "Security notification id conflicts with an existing event", 409);
  }
  return new Response(null, { status: 204 });
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

function encodeCursor(cursor: CursorV1): string {
  return toBase64Url(JSON.stringify(cursor));
}

function decodeCursor(
  value: string | null,
  includeAcknowledged: boolean,
): CursorV1 | null | "invalid" {
  if (!value) return null;
  const decoded = fromBase64Url(value);
  if (!decoded) return "invalid";
  try {
    const parsed = JSON.parse(decoded) as Partial<CursorV1>;
    if (
      parsed.v !== 1
      || parsed.include_acknowledged !== includeAcknowledged
      || !Number.isSafeInteger(parsed.occurred_at)
      || Number(parsed.occurred_at) < 0
      || !EVENT_ID_RE.test(String(parsed.id ?? ""))
    ) return "invalid";
    return parsed as CursorV1;
  } catch {
    return "invalid";
  }
}

async function canManageSecurityAlerts(
  env: AgentSecurityNotificationsEnv,
  caller: AgentSecurityCaller,
): Promise<boolean> {
  const membership = await env.OPENCOMPUTER_DB.prepare(
    `SELECT role FROM org_memberships WHERE org_id=?1 AND user_id=?2`,
  ).bind(caller.orgID, caller.userID).first<{ role: string }>();
  return membership?.role === "owner" || membership?.role === "admin";
}

function serializeEvent(row: StoredSecurityEvent) {
  return {
    id: row.id,
    agentId: row.agent_id,
    hookId: row.hook_id,
    kind: row.kind,
    occurredAt: new Date(row.occurred_at * 1_000).toISOString(),
    acknowledgedAt: row.acknowledged_at === null
      ? null
      : new Date(row.acknowledged_at * 1_000).toISOString(),
    acknowledgedBy: row.acknowledged_by,
  };
}

export async function listAgentSecurityNotifications(
  req: Request,
  env: AgentSecurityNotificationsEnv,
  caller: AgentSecurityCaller,
): Promise<Response> {
  if (!(await canManageSecurityAlerts(env, caller))) {
    return fixedError("forbidden", "Organization owner or admin access is required", 403);
  }
  const url = new URL(req.url);
  const includeRaw = url.searchParams.get("include_acknowledged");
  if (includeRaw !== null && includeRaw !== "true" && includeRaw !== "false") {
    return fixedError("invalid", "include_acknowledged must be true or false", 400);
  }
  const includeAcknowledged = includeRaw === "true";
  const limitRaw = url.searchParams.get("limit");
  const requestedLimit = limitRaw === null ? DEFAULT_PAGE_SIZE : Number(limitRaw);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return fixedError("invalid", "limit must be a positive integer", 400);
  }
  const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
  const cursor = decodeCursor(url.searchParams.get("cursor"), includeAcknowledged);
  if (cursor === "invalid") return fixedError("invalid", "Invalid cursor", 400);

  const clauses = ["org_id=?1"];
  const bindings: unknown[] = [caller.orgID];
  if (!includeAcknowledged) clauses.push("acknowledged_at IS NULL");
  if (cursor) {
    bindings.push(cursor.occurred_at, cursor.id);
    const occurredIndex = bindings.length - 1;
    const idIndex = bindings.length;
    clauses.push(
      `(occurred_at < ?${occurredIndex} OR (occurred_at = ?${occurredIndex} AND id < ?${idIndex}))`,
    );
  }
  bindings.push(limit + 1);
  const limitIndex = bindings.length;
  const result = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id,org_id,agent_id,hook_id,kind,occurred_at,received_at,
            acknowledged_at,acknowledged_by
       FROM agent_security_notifications
      WHERE ${clauses.join(" AND ")}
      ORDER BY occurred_at DESC,id DESC
      LIMIT ?${limitIndex}`,
  ).bind(...bindings).all<StoredSecurityEvent>();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last
    ? encodeCursor({
      v: 1,
      include_acknowledged: includeAcknowledged,
      occurred_at: last.occurred_at,
      id: last.id,
    })
    : null;
  return json({ data: page.map(serializeEvent), next_cursor: nextCursor });
}

export async function acknowledgeAgentSecurityNotification(
  env: AgentSecurityNotificationsEnv,
  caller: AgentSecurityCaller,
  eventId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  if (!(await canManageSecurityAlerts(env, caller))) {
    return fixedError("forbidden", "Organization owner or admin access is required", 403);
  }
  if (!EVENT_ID_RE.test(eventId)) {
    return fixedError("not_found", "Security notification not found", 404);
  }
  const updated = await env.OPENCOMPUTER_DB.prepare(
    `UPDATE agent_security_notifications
        SET acknowledged_at=?1,acknowledged_by=?2
      WHERE id=?3 AND org_id=?4 AND acknowledged_at IS NULL`,
  ).bind(nowSeconds, caller.userID, eventId, caller.orgID).run();
  if ((updated.meta?.changes ?? 0) > 0) return new Response(null, { status: 204 });
  const existing = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id FROM agent_security_notifications WHERE id=?1 AND org_id=?2`,
  ).bind(eventId, caller.orgID).first<{ id: string }>();
  return existing
    ? new Response(null, { status: 204 })
    : fixedError("not_found", "Security notification not found", 404);
}
