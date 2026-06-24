// Sandbox webhook management at the edge (all-Svix-at-edge). api-edge owns
// /api/webhooks CRUD + /test + /deliveries, backed by Svix Apps/Endpoints, with
// a small D1 index (webhook_destinations + orgs.has_webhooks). events-ingest does
// the delivery push. The CP never touches Svix; for inline-on-create it calls the
// HMAC-auth'd /internal/webhooks/register here.
// See .agents/work/sandbox-webhooks-rearchitecture.md §3-§4, §8.

import { SvixClient, SvixError, type EndpointParams } from "../../shared/svix";

export interface WebhookEnv {
  OPENCOMPUTER_DB: D1Database;
  SVIX_API_TOKEN: string;
  EVENT_SECRET: string;
}

export interface Caller {
  orgID: string;
  userID: string | null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function randomHex(nBytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(nBytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function svix(env: WebhookEnv): SvixClient | null {
  if (!env.SVIX_API_TOKEN) return null;
  return new SvixClient(env.SVIX_API_TOKEN);
}

// Map a SvixError to our public {error}+status; default 502 for upstream faults.
function svixErrorResponse(e: unknown): Response {
  if (e instanceof SvixError) {
    // 4xx from Svix (bad input) → surface as 400; upstream/transient → 502.
    const status = e.status >= 400 && e.status < 500 ? 400 : 502;
    return json({ error: `webhook provider error: ${e.message}` }, status);
  }
  return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
}

interface DestRow {
  id: string;
  org_id: string;
  svix_app_id: string;
  svix_endpoint_id: string;
  url: string;
  event_types: string;
  sandbox_id: string | null;
  name: string | null;
  disabled: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function toWire(r: DestRow): Record<string, unknown> {
  let eventTypes: string[] = [];
  try {
    eventTypes = JSON.parse(r.event_types || "[]");
  } catch {
    eventTypes = [];
  }
  return {
    id: r.id,
    url: r.url,
    eventTypes,
    sandboxId: r.sandbox_id,
    name: r.name,
    enabled: r.disabled === 0,
    createdAt: new Date(r.created_at * 1000).toISOString(),
  };
}

async function getDest(env: WebhookEnv, orgID: string, id: string): Promise<DestRow | null> {
  return env.OPENCOMPUTER_DB.prepare(
    "SELECT * FROM webhook_destinations WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL",
  )
    .bind(id, orgID)
    .first<DestRow>();
}

// Refresh orgs.has_webhooks from the live destination count (the events-ingest
// dormancy gate). Called after create/delete.
async function refreshHasWebhooks(env: WebhookEnv, orgID: string): Promise<void> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT COUNT(*) AS n FROM webhook_destinations WHERE org_id = ?1 AND deleted_at IS NULL",
  )
    .bind(orgID)
    .first<{ n: number }>();
  const has = (row?.n ?? 0) > 0 ? 1 : 0;
  await env.OPENCOMPUTER_DB.prepare("UPDATE orgs SET has_webhooks = ?1 WHERE id = ?2")
    .bind(has, orgID)
    .run();
}

function isHttpsURL(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

// Create a Svix endpoint for (org, optional sandbox) + persist the index row.
// Shared by POST /api/webhooks and the inline-create internal endpoint.
async function createDestination(
  env: WebhookEnv,
  sx: SvixClient,
  orgID: string,
  spec: { url: string; eventTypes?: string[]; sandboxId?: string | null; name?: string | null; secret?: string; metadata?: Record<string, string> },
): Promise<{ wire: Record<string, unknown>; secret: string }> {
  const app = await sx.ensureApplication(orgID, `org:${orgID}`);
  const epParams: EndpointParams = { url: spec.url };
  if (spec.name) epParams.description = spec.name;
  if (spec.eventTypes && spec.eventTypes.length) epParams.filterTypes = spec.eventTypes;
  if (spec.sandboxId) epParams.channels = [spec.sandboxId];
  if (spec.secret) epParams.secret = spec.secret;
  const ep = await sx.createEndpoint(app.id, epParams);
  if (spec.metadata && Object.keys(spec.metadata).length) {
    await sx.setEndpointHeaders(app.id, ep.id, spec.metadata);
  }
  const secret = spec.secret ?? (await sx.getEndpointSecret(app.id, ep.id));

  const id = "whk_" + randomHex(12);
  const ts = nowSec();
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO webhook_destinations
       (id, org_id, svix_app_id, svix_endpoint_id, url, event_types, sandbox_id, name, disabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)`,
  )
    .bind(
      id,
      orgID,
      app.id,
      ep.id,
      spec.url,
      JSON.stringify(spec.eventTypes ?? []),
      spec.sandboxId ?? null,
      spec.name ?? null,
      ts,
    )
    .run();
  await refreshHasWebhooks(env, orgID);

  return {
    wire: {
      id,
      url: spec.url,
      eventTypes: spec.eventTypes ?? [],
      sandboxId: spec.sandboxId ?? null,
      name: spec.name ?? null,
      enabled: true,
      createdAt: new Date(ts * 1000).toISOString(),
    },
    secret,
  };
}

// ── public API: /api/webhooks* ───────────────────────────────────────────────

// handleWebhooksAPI dispatches an authenticated /api/webhooks* request. Returns
// a Response (the caller has already authenticated and matched the path prefix).
export async function handleWebhooksAPI(
  req: Request,
  env: WebhookEnv,
  caller: Caller,
  url: URL,
): Promise<Response> {
  const sx = svix(env);
  if (!sx) return json({ error: "webhooks are not configured on this deployment" }, 503);

  // Path after "/api/webhooks": "", "/:id", "/:id/test", "/:id/deliveries",
  // "/:id/deliveries/:deliveryId", "/:id/deliveries/:deliveryId/redeliver".
  const rest = url.pathname.replace(/^\/api\/webhooks/, "").replace(/^\//, "");
  const seg = rest === "" ? [] : rest.split("/");
  const method = req.method;

  try {
    // /api/webhooks
    if (seg.length === 0) {
      if (method === "POST") return await createWebhook(req, env, sx, caller);
      if (method === "GET") return await listWebhooks(env, caller);
      return json({ error: "method not allowed" }, 405);
    }

    const id = seg[0];

    // /api/webhooks/:id
    if (seg.length === 1) {
      if (method === "GET") {
        const row = await getDest(env, caller.orgID, id);
        return row ? json(toWire(row)) : json({ error: "webhook not found" }, 404);
      }
      if (method === "PATCH") return await patchWebhook(req, env, sx, caller, id);
      if (method === "DELETE") return await deleteWebhook(env, sx, caller, id);
      return json({ error: "method not allowed" }, 405);
    }

    // /api/webhooks/:id/test
    if (seg.length === 2 && seg[1] === "test" && method === "POST") {
      return await testWebhook(env, sx, caller, id);
    }

    // /api/webhooks/:id/deliveries
    if (seg.length === 2 && seg[1] === "deliveries" && method === "GET") {
      return await listDeliveries(env, sx, caller, id);
    }

    // /api/webhooks/:id/deliveries/:deliveryId
    if (seg.length === 3 && seg[1] === "deliveries" && method === "GET") {
      return await getDelivery(env, sx, caller, id, seg[2]);
    }

    // /api/webhooks/:id/deliveries/:deliveryId/redeliver
    if (seg.length === 4 && seg[1] === "deliveries" && seg[3] === "redeliver" && method === "POST") {
      return await redeliver(env, sx, caller, id, seg[2]);
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return svixErrorResponse(e);
  }
}

async function createWebhook(req: Request, env: WebhookEnv, sx: SvixClient, caller: Caller): Promise<Response> {
  let body: { url?: string; eventTypes?: string[]; sandboxId?: string; name?: string; metadata?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!isHttpsURL(body.url)) return json({ error: "url must be a valid https URL" }, 400);

  const { wire, secret } = await createDestination(env, sx, caller.orgID, {
    url: body.url,
    eventTypes: body.eventTypes,
    sandboxId: body.sandboxId ?? null,
    name: body.name ?? null,
    metadata: body.metadata,
  });
  // Secret is returned once on create (Svix-generated; always re-fetchable via Svix).
  return json({ ...wire, secret }, 201);
}

async function listWebhooks(env: WebhookEnv, caller: Caller): Promise<Response> {
  const rows = await env.OPENCOMPUTER_DB.prepare(
    "SELECT * FROM webhook_destinations WHERE org_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC",
  )
    .bind(caller.orgID)
    .all<DestRow>();
  return json({ data: (rows.results ?? []).map(toWire) });
}

async function patchWebhook(req: Request, env: WebhookEnv, sx: SvixClient, caller: Caller, id: string): Promise<Response> {
  const row = await getDest(env, caller.orgID, id);
  if (!row) return json({ error: "webhook not found" }, 404);
  let body: { url?: string; eventTypes?: string[]; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const ep: EndpointParams = { url: body.url ?? row.url };
  if (body.eventTypes !== undefined) ep.filterTypes = body.eventTypes;
  else {
    try {
      ep.filterTypes = JSON.parse(row.event_types || "[]");
    } catch {
      ep.filterTypes = [];
    }
  }
  if (row.sandbox_id) ep.channels = [row.sandbox_id];
  if (body.enabled !== undefined) ep.disabled = !body.enabled;
  if (body.url !== undefined && !isHttpsURL(body.url)) return json({ error: "url must be a valid https URL" }, 400);

  await sx.updateEndpoint(row.svix_app_id, row.svix_endpoint_id, ep);

  const disabled = body.enabled === undefined ? row.disabled : body.enabled ? 0 : 1;
  await env.OPENCOMPUTER_DB.prepare(
    "UPDATE webhook_destinations SET url = ?1, event_types = ?2, disabled = ?3, updated_at = ?4 WHERE id = ?5",
  )
    .bind(ep.url, JSON.stringify(ep.filterTypes ?? []), disabled, nowSec(), id)
    .run();

  const updated = await getDest(env, caller.orgID, id);
  return updated ? json(toWire(updated)) : json({ error: "webhook not found" }, 404);
}

async function deleteWebhook(env: WebhookEnv, sx: SvixClient, caller: Caller, id: string): Promise<Response> {
  const row = await getDest(env, caller.orgID, id);
  if (!row) return json({ error: "webhook not found" }, 404);
  try {
    await sx.deleteEndpoint(row.svix_app_id, row.svix_endpoint_id);
  } catch (e) {
    // If the Svix endpoint is already gone, proceed to tombstone locally.
    if (!(e instanceof SvixError) || e.status !== 404) throw e;
  }
  await env.OPENCOMPUTER_DB.prepare("UPDATE webhook_destinations SET deleted_at = ?1 WHERE id = ?2")
    .bind(nowSec(), id)
    .run();
  await refreshHasWebhooks(env, caller.orgID);
  return new Response(null, { status: 204 });
}

async function testWebhook(env: WebhookEnv, sx: SvixClient, caller: Caller, id: string): Promise<Response> {
  const row = await getDest(env, caller.orgID, id);
  if (!row) return json({ error: "webhook not found" }, 404);
  let eventType = "sandbox.created";
  try {
    const types: string[] = JSON.parse(row.event_types || "[]");
    if (types.length) eventType = types[0];
  } catch {
    /* keep default */
  }
  const msg = await sx.createMessage(row.svix_app_id, {
    eventType,
    payload: { type: eventType, sandboxId: row.sandbox_id ?? "sb-test", test: true },
    eventId: `test.${id}.${randomHex(6)}`,
    channels: row.sandbox_id ? [row.sandbox_id] : undefined,
  });
  return json({ ok: true, eventType, messageId: msg.id });
}

async function listDeliveries(env: WebhookEnv, sx: SvixClient, caller: Caller, id: string): Promise<Response> {
  const row = await getDest(env, caller.orgID, id);
  if (!row) return json({ error: "webhook not found" }, 404);
  const attempts = await sx.listEndpointAttempts(row.svix_app_id, row.svix_endpoint_id, 50);
  const data = attempts.map((a) => ({
    id: a.msgId, // the redeliver/get key
    attemptId: a.id,
    status: a.status === 0 ? "success" : a.status === 1 ? "pending" : "failed",
    responseStatusCode: a.responseStatusCode,
    timestamp: a.timestamp,
  }));
  return json({ data });
}

async function getDelivery(env: WebhookEnv, sx: SvixClient, caller: Caller, id: string, deliveryID: string): Promise<Response> {
  const row = await getDest(env, caller.orgID, id);
  if (!row) return json({ error: "webhook not found" }, 404);
  const msg = await sx.getMessage(row.svix_app_id, deliveryID);
  return json({
    id: msg.id,
    eventType: msg.eventType,
    eventId: msg.eventId,
    payload: msg.payload,
    timestamp: msg.timestamp,
  });
}

async function redeliver(env: WebhookEnv, sx: SvixClient, caller: Caller, id: string, deliveryID: string): Promise<Response> {
  const row = await getDest(env, caller.orgID, id);
  if (!row) return json({ error: "webhook not found" }, 404);
  await sx.resendMessage(row.svix_app_id, deliveryID, row.svix_endpoint_id);
  return json({ ok: true });
}

// ── internal: inline-on-create registration (CP → edge, HMAC-auth'd) ─────────

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// registerInlineWebhooksInternal handles POST /internal/webhooks/register, called
// by the CP at sandbox-create time (before the sandbox emits `created`). HMAC over
// {ts}.{path}{query}.{body} with EVENT_SECRET, ±5min — same scheme as the other
// /internal POST endpoints. Body: {orgId, sandboxId, webhooks:[{url,eventTypes?,secret?}]}.
export async function registerInlineWebhooksInternal(req: Request, env: WebhookEnv, url: URL): Promise<Response> {
  const sx = svix(env);
  if (!sx) return json({ error: "webhooks are not configured" }, 503);

  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature" }, 400);
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec() - tsNum) > 5 * 60) {
    return json({ error: "timestamp out of window" }, 401);
  }
  const rawBody = await req.text();
  const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${url.pathname}${url.search}.${rawBody}`);
  if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  let body: { orgId?: string; sandboxId?: string; webhooks?: Array<{ url: string; eventTypes?: string[]; secret?: string }> };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.orgId || !body.sandboxId || !Array.isArray(body.webhooks)) {
    return json({ error: "orgId, sandboxId, webhooks required" }, 400);
  }

  const out: Array<{ id: string; url: string; secret?: string }> = [];
  for (const spec of body.webhooks) {
    if (!isHttpsURL(spec.url)) continue; // best-effort: skip invalid, like the shipped path
    try {
      const { wire, secret } = await createDestination(env, sx, body.orgId, {
        url: spec.url,
        eventTypes: spec.eventTypes,
        sandboxId: body.sandboxId,
        secret: spec.secret,
      });
      // Return the secret only when Svix generated it (caller didn't supply one).
      out.push({ id: wire.id as string, url: spec.url, ...(spec.secret ? {} : { secret }) });
    } catch (e) {
      console.error(`registerInlineWebhooks: ${body.sandboxId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return json({ webhooks: out });
}
