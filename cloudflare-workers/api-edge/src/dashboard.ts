// dashboard.ts — edge-native dashboard backend.
//
// The new architecture (see docs/dev-cutover-runbook.md + the dev-cutover diagram)
// makes the CF edge authoritative for identity, billing, sandbox routing index,
// and audit log. The dashboard accordingly lives here: D1 is the source of
// truth for org/user/api-key/checkpoint data, and only sandbox-RUNTIME ops
// (exec, PTY, logs) proxy to the cell where the sandbox actually runs.
//
// Auth: session JWT cookie `oc_session` minted by /auth/callback. Browser
// hits /api/dashboard/...; we validate the cookie and execute the handler.
//
// Proxy pattern for sandbox-runtime ops:
//   1. Look up the sandbox's cell_id in D1 sandboxes_index (or org.home_cell
//      for non-sandbox-scoped proxies like /agents).
//   2. Mint a short-lived capability JWT for that cell with claims.OrgID +
//      claims.Plan (the same cap-token shape /api/sandboxes POST uses).
//   3. Fetch the cell's /internal/dashboard/{path} with Authorization: Bearer.
//   4. Stream the response (or WebSocket pair) back to the browser.

import {
  autumnPurchase,
  autumnTopUpCharge,
  autumnAttach,
  autumnHasToppedUp,
  syncAutumnToD1,
  autumnSetAutoTopup,
} from "./autumn_webhook";
import { handleWebhooksAPI, type WebhookEnv } from "./webhooks";

export interface DashboardEnv {
  OPENCOMPUTER_DB: D1Database;
  SESSIONS_KV: KVNamespace;
  CREDIT_ACCOUNT: DurableObjectNamespace;
  SESSION_JWT_SECRET: string;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  STRIPE_API_KEY: string;
  WORKER_ENV: string;
  // Autumn billing — read customer state + create top-up/concurrency checkouts.
  // Empty on deployments not yet on Autumn.
  AUTUMN_SECRET_KEY: string;
  AUTUMN_BASE_URL?: string;
  // "true" → new signups are provisioned on Autumn (Stage 2 switch). Default
  // off keeps merge dormant; existing orgs are never auto-migrated by this.
  AUTUMN_NEW_ORGS?: string;
  // CF Custom Hostnames API token + zone (for /org/custom-domain). Optional —
  // if unset the custom-domain endpoints return 503 (feature disabled).
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  // Durable Agent Sessions (/v3) — the dashboard proxies /api/dashboard/v3/* to
  // this sessions-api host, asserting the logged-in OC org via a short-lived
  // signed OC org token (OC_ORG_TOKEN_SECRET, shared with sessions-api). No osb_
  // key in the browser, no key custody. Both optional — if OC_ORG_TOKEN_SECRET is
  // unset the proxy 503s.
  SESSIONS_API_URL?: string;
  OC_ORG_TOKEN_SECRET?: string;
}

const SESSION_COOKIE = "oc_session";
const SESSION_TTL_SEC = 60 * 60 * 8;

interface SessionClaims {
  iss?: string;
  sub: string;
  iat: number;
  exp: number;
  org_id: string;
  user_id: string;
  plan: string;
}

interface Caller {
  orgID: string;
  userID: string;
  plan: string;
  claims: SessionClaims;
}

// ── auth ─────────────────────────────────────────────────────────────────

export async function authDashboard(req: Request, env: DashboardEnv): Promise<Caller | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const claims = await verifySessionJWT(env.SESSION_JWT_SECRET, m[1]);
  if (!claims) return null;
  return { orgID: claims.org_id, userID: claims.user_id, plan: claims.plan, claims };
}

async function verifySessionJWT(secret: string, token: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(`${headerB64}.${payloadB64}`));
  if (b64url(expected) !== sigB64) return null;
  try {
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as SessionClaims;
    if (payload.iss !== "opensandbox-session") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function mintSessionJWT(secret: string, orgID: string, userID: string, plan: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "opensandbox-session", sub: userID, iat: now, exp: now + SESSION_TTL_SEC,
    org_id: orgID, user_id: userID, plan,
  };
  const enc = new TextEncoder();
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

function setSessionCookie(jwt: string): string {
  return `${SESSION_COOKIE}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

// Same shape as the cap-token /api/sandboxes mints for /internal/sandboxes/create.
// Cells' capTokenMiddleware validates this same format on /internal/dashboard/*.
async function mintCellCapToken(secret: string, orgID: string, cellID: string, plan: string, userID: string | null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: orgID, iss: "opensandbox-edge", iat: now, exp: now + 120,
    org_id: orgID, cell_id: cellID, plan,
  };
  if (userID) payload.user_id = userID;
  const enc = new TextEncoder();
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

// OC org token: a short-lived HS256 token carrying the OC org id, signed with
// OC_ORG_TOKEN_SECRET (shared with sessions-api). /v3 trusts it and sets owner =
// the asserted org — same "act for org X" shape as the cell cap-token, so no
// osb_ key reaches the browser and /v3 never custodies a customer key.
async function mintOrgToken(secret: string, orgID: string, userID: string | null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: orgID, iss: "opencomputer", aud: "sessions-api-v3", iat: now, exp: now + 120,
    org_id: orgID,
  };
  if (userID) payload.user_id = userID;
  const enc = new TextEncoder();
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// D1 stores timestamps as unix seconds (INTEGER). The cell's Go handlers
// marshal time.Time as RFC3339 strings, which is what the dashboard frontend
// expects (`new Date(value)` then `.toISOString()`). Mirror that.
function epochToISO(s: number | null | undefined): string | undefined {
  if (s == null || s === 0) return undefined;
  return new Date(s * 1000).toISOString();
}

// Required-date variant: returns a valid ISO string even if input is null
// (uses unix epoch). Used for fields like createdAt that the frontend
// treats as non-nullable.
function epochToISORequired(s: number | null | undefined): string {
  return new Date(((s ?? 0) || 0) * 1000).toISOString();
}

// Cell ID → region. Reverse of api-edge's pickCell convention:
// cells follow {cloud}-{region-with-hyphens}-{slot}, e.g.
// "azure-us-west-2-b" → region "us-west-2".
function cellToRegion(cellID: string): string {
  // Strip first segment (cloud) and last segment (slot).
  const parts = cellID.split("-");
  if (parts.length < 3) return "";
  return parts.slice(1, -1).join("-");
}

// shapeOrg maps a D1 orgs row to the frontend's Org interface (camelCase,
// timestamps as ISO strings, integer-flag booleans).
interface OrgRow {
  id: string; name: string; slug: string; plan: string;
  max_concurrent_sandboxes: number; max_sandbox_timeout_sec: number;
  created_at: number; updated_at: number;
  custom_domain: string | null; cf_hostname_id: string | null;
  domain_verification_status: string; domain_ssl_status: string;
  verification_txt_name: string | null; verification_txt_value: string | null;
  ssl_txt_name: string | null; ssl_txt_value: string | null;
  workos_org_id: string | null; is_personal: number;
  credit_balance_cents: number;
  free_credits_remaining_cents: number; is_halted: number;
  halted_at: number | null;
}

function shapeOrg(r: OrgRow): Record<string, unknown> {
  return {
    id: r.id, name: r.name, slug: r.slug, plan: r.plan,
    maxConcurrentSandboxes: r.max_concurrent_sandboxes,
    maxSandboxTimeoutSec: r.max_sandbox_timeout_sec,
    createdAt: epochToISORequired(r.created_at),
    updatedAt: epochToISORequired(r.updated_at),
    customDomain: r.custom_domain ?? undefined,
    cfHostnameId: r.cf_hostname_id ?? undefined,
    domainVerificationStatus: r.domain_verification_status,
    domainSslStatus: r.domain_ssl_status,
    verificationTxtName: r.verification_txt_name ?? undefined,
    verificationTxtValue: r.verification_txt_value ?? undefined,
    sslTxtName: r.ssl_txt_name ?? undefined,
    sslTxtValue: r.ssl_txt_value ?? undefined,
    workosOrgId: r.workos_org_id ?? undefined,
    isPersonal: !!r.is_personal,
    creditBalanceCents: r.credit_balance_cents,
    freeCreditsRemainingCents: r.free_credits_remaining_cents,
    isHalted: !!r.is_halted,
    haltedAt: epochToISO(r.halted_at),
  };
}

// ── cell lookup helpers ──────────────────────────────────────────────────

interface CellRow {
  cell_id: string;
  base_url: string;
}

async function homeCell(env: DashboardEnv, orgID: string): Promise<CellRow | null> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT c.cell_id, c.base_url FROM orgs o JOIN cells c ON c.cell_id = o.home_cell WHERE o.id = ?1`,
  ).bind(orgID).first<CellRow>();
  return row ?? null;
}

async function sandboxCell(env: DashboardEnv, sandboxID: string): Promise<{ cell_id: string; base_url: string; org_id: string } | null> {
  return env.OPENCOMPUTER_DB.prepare(
    `SELECT s.cell_id, s.org_id, c.base_url FROM sandboxes_index s JOIN cells c ON c.cell_id = s.cell_id WHERE s.id = ?1`,
  ).bind(sandboxID).first<{ cell_id: string; base_url: string; org_id: string }>();
}

// proxyToCell handles non-WebSocket dashboard requests. Looks up the
// destination URL (caller-supplied), mints a cap-token for that cell, and
// streams the response back. Pass-through for status, body, content-type.
async function proxyToCell(
  req: Request,
  env: DashboardEnv,
  caller: Caller,
  cell: CellRow,
  path: string,
): Promise<Response> {
  const url = new URL(req.url);
  const target = cell.base_url.replace(/\/$/, "") + path + url.search;
  const token = await mintCellCapToken(env.SESSION_JWT_SECRET, caller.orgID, cell.cell_id, caller.plan, caller.userID);

  // Forward only the headers the cell actually needs. CF Workers forbids
  // some headers (Host, Connection, Content-Length) and stripping cookies
  // avoids sending the browser's session JWT to the cell. The Authorization
  // header is the auth signal the cell needs; content-type matters for body
  // parsing on POST/PUT.
  const headers = new Headers();
  headers.set("authorization", "Bearer " + token);
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const ua = req.headers.get("user-agent");
  if (ua) headers.set("user-agent", ua);

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
  return fetch(target, init);
}

// ── WebSocket proxy (PTY) ────────────────────────────────────────────────

async function proxyWebSocket(
  req: Request,
  env: DashboardEnv,
  caller: Caller,
  cell: CellRow,
  cellPath: string,
): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected websocket upgrade" }, 400);
  }

  // Mint the cell-bound cap-token the cell-CP expects in Authorization,
  // then transparently forward the upgrade to the cell-CP. With the
  // OPENSANDBOX_WS_BROKER=1 cell-CP path active, the cell-CP's
  // wsgateway terminates the browser's WS and brokers it against the
  // worker — redial on upstream close, keepalive, exec-exit suppression,
  // multi-session per sandbox, etc. live in Go, not here.
  //
  // Previously this function did an edge-side WebSocketPair + manual
  // Blob-aware bridge. That made the cell-CP see the EDGE as the client,
  // which short-circuited the broker's redial/keepalive — a worker
  // restart killed the browser's terminal. Replacing the bridge with
  // a transparent forward puts the broker actually in the middle.
  let token: string;
  try {
    token = await mintCellCapToken(env.SESSION_JWT_SECRET, caller.orgID, cell.cell_id, caller.plan, caller.userID);
  } catch (e) {
    console.error("proxyWebSocket: mint failed:", e);
    return new Response("token mint failed", { status: 500 });
  }
  const upstreamURL = cell.base_url.replace(/\/$/, "") + cellPath;
  console.log(`proxyWebSocket: forwarding upgrade to ${upstreamURL}`);

  const fwd = new Request(upstreamURL, req);
  fwd.headers.set("authorization", "Bearer " + token);
  // Strip browser cookies — cell-CP authenticates the cap-token, not
  // dashboard session cookies, and the cookies would only bloat the
  // upstream request.
  fwd.headers.delete("cookie");
  return await fetch(fwd);
}

// ── identity (/me, /orgs, /org, /org/switch) ─────────────────────────────

async function handleMe(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  // Load user + org list. Org list joins via org_memberships; each row carries
  // the active flag so the UI can highlight the current org.
  const user = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, email, name, workos_user_id FROM users WHERE id = ?1`,
  ).bind(caller.userID).first<{ id: string; email: string; name: string | null; workos_user_id: string | null }>();
  if (!user) return json({ error: "user not found" }, 404);

  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT o.id, o.name, o.is_personal FROM orgs o
       JOIN org_memberships m ON m.org_id = o.id
      WHERE m.user_id = ?1`,
  ).bind(caller.userID).all<{ id: string; name: string; is_personal: number }>();
  const orgs = (results ?? []).map((r) => ({
    id: r.id, name: r.name, isPersonal: !!r.is_personal, isActive: r.id === caller.orgID,
  }));

  return json({
    id: user.id, email: user.email, name: user.name, orgId: caller.orgID, orgs,
  });
}

async function handleListOrgs(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT o.id, o.name, o.is_personal, o.plan, o.home_cell FROM orgs o
       JOIN org_memberships m ON m.org_id = o.id
      WHERE m.user_id = ?1
      ORDER BY o.is_personal DESC, o.name ASC`,
  ).bind(caller.userID).all<{ id: string; name: string; is_personal: number; plan: string; home_cell: string }>();
  // Shape to OrgInfo for /orgs route (the frontend uses { id, name, isPersonal, isActive }).
  return json((results ?? []).map((r) => ({
    id: r.id, name: r.name, isPersonal: !!r.is_personal, plan: r.plan,
    homeCell: r.home_cell, isActive: r.id === caller.orgID,
  })));
}

async function handleGetOrg(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM orgs WHERE id = ?1`).bind(caller.orgID).first<OrgRow>();
  if (!org) return json({ error: "org not found" }, 404);
  return json(shapeOrg(org));
}

async function handleUpdateOrg(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const body = await req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, 400);
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT owner_user_id, workos_org_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ owner_user_id: string | null; workos_org_id: string | null }>();
  if (!org) return json({ error: "org not found" }, 404);
  if (org.owner_user_id !== caller.userID) return json({ error: "only owner can rename" }, 403);

  await env.OPENCOMPUTER_DB.prepare(`UPDATE orgs SET name = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(name, Math.floor(Date.now() / 1000), caller.orgID).run();

  // Best-effort WorkOS sync. Errors logged, not surfaced.
  if (org.workos_org_id) {
    workosUpdateOrg(env, org.workos_org_id, name).catch((e) => console.error("workos org update failed", e));
  }
  const updated = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM orgs WHERE id = ?1`).bind(caller.orgID).first<OrgRow>();
  return json(updated ? shapeOrg(updated) : null);
}

async function handleOrgSwitch(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const body = await req.json<{ orgId?: string }>().catch(() => ({} as { orgId?: string }));
  if (!body.orgId) return json({ error: "orgId required" }, 400);
  // Verify membership before issuing a session for the new org.
  const m = await env.OPENCOMPUTER_DB.prepare(
    `SELECT 1 FROM org_memberships WHERE user_id = ?1 AND org_id = ?2`,
  ).bind(caller.userID, body.orgId).first();
  if (!m) return json({ error: "not a member of that org" }, 403);
  const orgRow = await env.OPENCOMPUTER_DB.prepare(`SELECT plan FROM orgs WHERE id = ?1`).bind(body.orgId).first<{ plan: string }>();
  const plan = orgRow?.plan ?? "free";
  const fresh = await mintSessionJWT(env.SESSION_JWT_SECRET, body.orgId, caller.userID, plan);
  return json({ ok: true, orgId: body.orgId, plan }, 200, { "set-cookie": setSessionCookie(fresh) });
}

// ── members ──────────────────────────────────────────────────────────────

async function handleListMembers(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT m.user_id, m.role, m.created_at, u.email, u.name, u.workos_user_id
       FROM org_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ?1 ORDER BY m.created_at ASC`,
  ).bind(caller.orgID).all<{
    user_id: string; role: string; created_at: number;
    email: string; name: string | null; workos_user_id: string | null;
  }>();
  // Frontend OrgMember interface — bare array, camelCase.
  return json((results ?? []).map((r) => ({
    id: r.user_id,
    membershipId: r.user_id, // we don't have a separate membership id; reuse
    workosUserId: r.workos_user_id ?? undefined,
    email: r.email,
    name: r.name ?? r.email,
    role: r.role,
    status: "active",
  })));
}

async function handleRemoveMember(_req: Request, env: DashboardEnv, caller: Caller, memberUserID: string): Promise<Response> {
  if (memberUserID === caller.userID) return json({ error: "cannot remove self" }, 400);
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT owner_user_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ owner_user_id: string | null }>();
  if (!org || org.owner_user_id !== caller.userID) return json({ error: "only owner can remove members" }, 403);
  await env.OPENCOMPUTER_DB.prepare(`DELETE FROM org_memberships WHERE org_id = ?1 AND user_id = ?2`).bind(caller.orgID, memberUserID).run();
  return new Response(null, { status: 204 });
}

// ── invitations ──────────────────────────────────────────────────────────

async function handleListInvitations(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, email, role, status, created_at, expires_at, accepted_at, revoked_at, invited_by
       FROM invitations WHERE org_id = ?1 ORDER BY created_at DESC`,
  ).bind(caller.orgID).all<{ id: string; email: string; role: string; status: string; created_at: number; expires_at: number | null; accepted_at: number | null; revoked_at: number | null; invited_by: string | null }>();
  // Bare array — frontend expects OrgInvitation[].
  return json((results ?? []).map((r) => ({
    id: r.id, email: r.email, role: r.role, state: r.status,
    createdAt: epochToISORequired(r.created_at),
    expiresAt: epochToISORequired(r.expires_at),
    acceptedAt: epochToISO(r.accepted_at),
    revokedAt: epochToISO(r.revoked_at),
    invitedBy: r.invited_by ?? undefined,
  })));
}

async function handleSendInvitation(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const body = await req.json<{ email?: string; role?: string }>().catch(() => ({} as { email?: string; role?: string }));
  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role || "member";
  if (!email) return json({ error: "email required" }, 400);
  if (!["owner", "admin", "member"].includes(role)) return json({ error: "invalid role" }, 400);

  // WorkOS invitation send. Returns the WorkOS invitation ID we mirror in D1.
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT workos_org_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ workos_org_id: string | null }>();
  let workosInviteID: string | null = null;
  if (org?.workos_org_id) {
    try {
      const r = await fetch("https://api.workos.com/user_management/invitations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.WORKOS_API_KEY}` },
        body: JSON.stringify({ email, organization_id: org.workos_org_id, expires_in_days: 7, role_slug: role }),
      });
      if (r.ok) {
        const data = await r.json<{ id: string }>();
        workosInviteID = data.id;
      } else {
        console.error(`workos invite ${email} returned ${r.status}: ${await r.text()}`);
      }
    } catch (e) {
      console.error(`workos invite ${email} threw`, e);
    }
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO invitations (id, org_id, email, role, invited_by, workos_invitation_id, status, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
  ).bind(id, caller.orgID, email, role, caller.userID, workosInviteID, now + 7 * 86400, now).run();
  return json({ id, email, role, status: "pending", workos_invitation_id: workosInviteID, expires_at: now + 7 * 86400 }, 201);
}

async function handleRevokeInvitation(_req: Request, env: DashboardEnv, caller: Caller, inviteID: string): Promise<Response> {
  const inv = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, workos_invitation_id, status FROM invitations WHERE id = ?1 AND org_id = ?2`,
  ).bind(inviteID, caller.orgID).first<{ id: string; workos_invitation_id: string | null; status: string }>();
  if (!inv) return json({ error: "invitation not found" }, 404);
  if (inv.status !== "pending") return json({ error: `cannot revoke ${inv.status} invitation` }, 400);

  if (inv.workos_invitation_id) {
    try {
      await fetch(`https://api.workos.com/user_management/invitations/${inv.workos_invitation_id}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.WORKOS_API_KEY}` },
      });
    } catch (e) { console.error("workos revoke failed", e); }
  }
  await env.OPENCOMPUTER_DB.prepare(`UPDATE invitations SET status = 'revoked', revoked_at = ?1 WHERE id = ?2`)
    .bind(Math.floor(Date.now() / 1000), inviteID).run();
  return new Response(null, { status: 204 });
}

// ── API keys ─────────────────────────────────────────────────────────────

async function handleListAPIKeys(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, name, key_prefix, scopes, last_used, expires_at, created_at, created_by
       FROM api_keys WHERE org_id = ?1 ORDER BY created_at DESC`,
  ).bind(caller.orgID).all<{
    id: string; name: string; key_prefix: string; scopes: string;
    last_used: number | null; expires_at: number | null; created_at: number; created_by: string | null;
  }>();
  const keys = (results ?? []).map((r) => ({
    id: r.id,
    orgId: caller.orgID,
    name: r.name,
    keyPrefix: r.key_prefix,
    scopes: r.scopes.split(",").map((s) => s.trim()).filter(Boolean),
    lastUsed: epochToISO(r.last_used),
    expiresAt: epochToISO(r.expires_at),
    createdAt: epochToISORequired(r.created_at),
  }));
  return json(keys);
}

async function handleCreateAPIKey(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const body = await req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const name = (body.name ?? "Untitled").trim() || "Untitled";
  // Same format as the cell: "osb_" + 64 hex chars (32 random bytes).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const plainKey = "osb_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await sha256Hex(plainKey);
  const prefix = plainKey.slice(0, 8);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sandbox:*', ?7)`,
  ).bind(id, caller.orgID, caller.userID, hash, prefix, name, now).run();
  return json({
    id, orgId: caller.orgID, name, key: plainKey, keyPrefix: prefix,
    scopes: ["sandbox:*"], createdAt: new Date(now * 1000).toISOString(),
  }, 201);
}

async function handleDeleteAPIKey(_req: Request, env: DashboardEnv, caller: Caller, keyID: string): Promise<Response> {
  await env.OPENCOMPUTER_DB.prepare(`DELETE FROM api_keys WHERE id = ?1 AND org_id = ?2`).bind(keyID, caller.orgID).run();
  return new Response(null, { status: 204 });
}

// ── sessions list (cross-cell) ───────────────────────────────────────────

async function handleListSessions(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "";
  let stmt;
  if (status) {
    stmt = env.OPENCOMPUTER_DB.prepare(
      `SELECT id, cell_id, worker_id, status, template_id, created_at, last_event_at, stopped_at
         FROM sandboxes_index WHERE org_id = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT 200`,
    ).bind(caller.orgID, status);
  } else {
    stmt = env.OPENCOMPUTER_DB.prepare(
      `SELECT id, cell_id, worker_id, status, template_id, created_at, last_event_at, stopped_at
         FROM sandboxes_index WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`,
    ).bind(caller.orgID);
  }
  const { results } = await stmt.all<{
    id: string; cell_id: string; worker_id: string | null; status: string;
    template_id: string | null; created_at: number; last_event_at: number | null; stopped_at: number | null;
  }>();
  // Reshape to match the frontend's Session interface (camelCase, ISO timestamps).
  const sessions = (results ?? []).map((r) => ({
    id: r.id,
    sandboxId: r.id,
    orgId: caller.orgID,
    template: r.template_id ?? "default",
    region: cellToRegion(r.cell_id),
    workerId: r.worker_id ?? "",
    status: r.status,
    startedAt: epochToISORequired(r.created_at),
    stoppedAt: epochToISO(r.stopped_at),
    cellId: r.cell_id, // bonus: surface the cell for cross-cell aware UI
  }));
  return json(sessions);
}

// ── checkpoints (cross-cell) ─────────────────────────────────────────────

async function handleListCheckpoints(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") ?? "20", 10) || 20));
    const offset = (page - 1) * perPage;

    const { results } = await env.OPENCOMPUTER_DB.prepare(
      `SELECT id, sandbox_id, owner_cell_id, s3_url, size_bytes, golden_hash, workspace_size, created_at, expires_at, name, status, error_msg, failed_at, kind
         FROM checkpoints_index WHERE org_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
    ).bind(caller.orgID, perPage, offset).all<{
      id: string; sandbox_id: string; owner_cell_id: string; s3_url: string | null;
      size_bytes: number | null; golden_hash: string | null; workspace_size: number | null;
      created_at: number; expires_at: number | null;
      name: string | null;
      status: string | null; error_msg: string | null; failed_at: number | null;
      kind: string | null;
    }>();
    const totalRow = await env.OPENCOMPUTER_DB.prepare(`SELECT COUNT(*) AS c FROM checkpoints_index WHERE org_id = ?1`).bind(caller.orgID).first<{ c: number }>();
    return json({
      checkpoints: (results ?? []).map((r) => ({
        id: r.id,
        sandboxId: r.sandbox_id ?? "",
        orgId: caller.orgID,
        // Prefer the user-set name. Pre-fix this derived from s3_url which
        // always ended in "rootfs.tar.zst" (every row showed the same name);
        // the column was added + backfilled from cell PG sandbox_checkpoints
        // so this now surfaces what customers actually called the checkpoint.
        name: r.name && r.name.length > 0 ? r.name : r.id.slice(0, 8),
        status: r.status ?? "ready",
        sizeBytes: r.size_bytes ?? 0,
        activeForks: 0,
        totalForks: 0,
        createdAt: epochToISORequired(r.created_at),
        errorMsg: r.error_msg ?? undefined,
        failedAt: r.failed_at ? epochToISORequired(r.failed_at) : undefined,
        kind: r.kind === "disk_only" ? "disk_only" : "full",
        cellId: r.owner_cell_id ?? "",
        goldenHash: r.golden_hash ?? "",
      })),
      total: totalRow?.c ?? 0,
      page, perPage,
    });
  } catch (err) {
    console.error("handleListCheckpoints failed:", err);
    return json({ error: `checkpoints failed: ${(err as Error).message}` }, 500);
  }
}

async function handleDeleteCheckpoint(_req: Request, env: DashboardEnv, caller: Caller, cpID: string): Promise<Response> {
  // Verify ownership before delete.
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT owner_cell_id FROM checkpoints_index WHERE id = ?1 AND org_id = ?2`,
  ).bind(cpID, caller.orgID).first<{ owner_cell_id: string }>();
  if (!row) return json({ error: "checkpoint not found" }, 404);
  // Delete D1 row first (source of truth). Owning-cell blob cleanup is async
  // via the cell's existing GC; we don't try to coordinate here.
  await env.OPENCOMPUTER_DB.prepare(`DELETE FROM checkpoints_index WHERE id = ?1 AND org_id = ?2`).bind(cpID, caller.orgID).run();
  return new Response(null, { status: 204 });
}

// ── custom domain (CF Custom Hostnames API) ──────────────────────────────

interface CFCustomHostname {
  id: string;
  status: string;
  ssl: { status: string; txt_name?: string; txt_value?: string; validation_records?: { name: string; value: string }[] };
  ownership_verification?: { name: string; value: string };
}

async function cfAPI(env: DashboardEnv, method: string, path: string, body?: any): Promise<Response> {
  return fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function handleSetCustomDomain(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return json({ error: "Cloudflare not configured" }, 503);
  const body = await req.json<{ domain?: string }>().catch(() => ({} as { domain?: string }));
  const domain = (body.domain ?? "").trim().toLowerCase();
  if (!domain) return json({ error: "domain required" }, 400);

  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT cf_hostname_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ cf_hostname_id: string | null }>();
  if (org?.cf_hostname_id) {
    await cfAPI(env, "DELETE", `/zones/${env.CF_ZONE_ID}/custom_hostnames/${org.cf_hostname_id}`).catch(() => {});
  }
  const r = await cfAPI(env, "POST", `/zones/${env.CF_ZONE_ID}/custom_hostnames`, {
    hostname: domain,
    ssl: { method: "txt", type: "dv" },
  });
  if (!r.ok) return json({ error: `Cloudflare API: ${r.status} ${await r.text()}` }, 502);
  const data = (await r.json<{ result: CFCustomHostname }>()).result;

  const verifyName = data.ownership_verification?.name ?? null;
  const verifyValue = data.ownership_verification?.value ?? null;
  let sslName: string | null = null;
  let sslValue: string | null = null;
  if (data.ssl.txt_name) { sslName = data.ssl.txt_name; sslValue = data.ssl.txt_value ?? null; }
  else if (data.ssl.validation_records?.[0]) { sslName = data.ssl.validation_records[0].name; sslValue = data.ssl.validation_records[0].value; }

  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE orgs SET custom_domain = ?1, cf_hostname_id = ?2, domain_verification_status = ?3, domain_ssl_status = ?4,
                     verification_txt_name = ?5, verification_txt_value = ?6, ssl_txt_name = ?7, ssl_txt_value = ?8,
                     updated_at = ?9
       WHERE id = ?10`,
  ).bind(domain, data.id, data.status, data.ssl.status, verifyName, verifyValue, sslName, sslValue, Math.floor(Date.now() / 1000), caller.orgID).run();
  const updated = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM orgs WHERE id = ?1`).bind(caller.orgID).first<OrgRow>();
  return json(updated ? shapeOrg(updated) : null);
}

async function handleDeleteCustomDomain(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return json({ error: "Cloudflare not configured" }, 503);
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT cf_hostname_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ cf_hostname_id: string | null }>();
  if (org?.cf_hostname_id) {
    await cfAPI(env, "DELETE", `/zones/${env.CF_ZONE_ID}/custom_hostnames/${org.cf_hostname_id}`).catch(() => {});
  }
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE orgs SET custom_domain = NULL, cf_hostname_id = NULL,
                     domain_verification_status = 'none', domain_ssl_status = 'none',
                     verification_txt_name = NULL, verification_txt_value = NULL,
                     ssl_txt_name = NULL, ssl_txt_value = NULL, updated_at = ?1
       WHERE id = ?2`,
  ).bind(Math.floor(Date.now() / 1000), caller.orgID).run();
  const updated = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM orgs WHERE id = ?1`).bind(caller.orgID).first<OrgRow>();
  return json(updated ? shapeOrg(updated) : null);
}

async function handleRefreshCustomDomain(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return json({ error: "Cloudflare not configured" }, 503);
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT cf_hostname_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ cf_hostname_id: string | null }>();
  if (!org?.cf_hostname_id) return json({ error: "no custom domain configured" }, 400);
  const r = await cfAPI(env, "GET", `/zones/${env.CF_ZONE_ID}/custom_hostnames/${org.cf_hostname_id}`);
  if (!r.ok) return json({ error: `Cloudflare API: ${r.status}` }, 502);
  const data = (await r.json<{ result: CFCustomHostname }>()).result;

  const verifyName = data.ownership_verification?.name ?? null;
  const verifyValue = data.ownership_verification?.value ?? null;
  let sslName: string | null = null, sslValue: string | null = null;
  if (data.ssl.txt_name) { sslName = data.ssl.txt_name; sslValue = data.ssl.txt_value ?? null; }
  else if (data.ssl.validation_records?.[0]) { sslName = data.ssl.validation_records[0].name; sslValue = data.ssl.validation_records[0].value; }

  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE orgs SET domain_verification_status = ?1, domain_ssl_status = ?2,
                     verification_txt_name = ?3, verification_txt_value = ?4,
                     ssl_txt_name = ?5, ssl_txt_value = ?6, updated_at = ?7
       WHERE id = ?8`,
  ).bind(data.status, data.ssl.status, verifyName, verifyValue, sslName, sslValue, Math.floor(Date.now() / 1000), caller.orgID).run();
  const updated = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM orgs WHERE id = ?1`).bind(caller.orgID).first<OrgRow>();
  return json(updated ? shapeOrg(updated) : null);
}

// ── credits + billing ────────────────────────────────────────────────────

async function handleGetCredits(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const doStub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(caller.orgID));
  const snap = await doStub.fetch("https://do/snapshot");
  const orgRow = await env.OPENCOMPUTER_DB.prepare(`SELECT is_personal FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ is_personal: number }>();
  if (!snap.ok) {
    // DO might be uninitialized for an org that hasn't done /check yet.
    // Surface a sane default rather than 503'ing the dashboard.
    return json({ balanceCents: -1, isPersonal: !!orgRow?.is_personal });
  }
  const state = await snap.json<Record<string, any>>();
  const s = state.state ?? state;
  // Frontend Credits interface: { balanceCents, isPersonal }.
  return json({
    balanceCents: typeof s.balance_cents === "number" ? s.balance_cents : -1,
    isPersonal: !!orgRow?.is_personal,
    // Extras the dashboard may consume even though not on the strict type:
    plan: s.plan ?? caller.plan,
    status: s.status ?? "active",
    lifetimeSpentCents: s.lifetime_spent_cents ?? 0,
    haltedAt: typeof s.halted_at === "number" ? epochToISO(s.halted_at) : undefined,
  });
}

async function handleListAgentSubscriptions(_req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, agent_id, feature, status, stripe_item_id, created_at, cancelled_at
       FROM agent_subscriptions WHERE org_id = ?1 AND status = 'active'`,
  ).bind(caller.orgID).all();
  return json({ subscriptions: results ?? [] });
}

// ── WorkOS helpers ───────────────────────────────────────────────────────

async function workosUpdateOrg(env: DashboardEnv, workosOrgID: string, name: string): Promise<void> {
  await fetch(`https://api.workos.com/organizations/${workosOrgID}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.WORKOS_API_KEY}` },
    body: JSON.stringify({ name }),
  });
}

// Proxy /api/dashboard/v3/* → sessions-api /v3/*, asserting the logged-in OC org
// via a signed org-token in X-OC-Org-Token (a distinct header so /v3 doesn't
// mistake it for a bearer client token). Forwards only what /v3 needs (never the
// dashboard cookie); streams the response through unchanged so SSE passes back.
async function proxyToV3(
  req: Request,
  env: DashboardEnv,
  caller: Caller,
  sub: string,
): Promise<Response> {
  if (!env.OC_ORG_TOKEN_SECRET) {
    return json({ error: "agent sessions not configured" }, 503);
  }
  const base = (env.SESSIONS_API_URL ?? "https://api.opencomputer.dev").replace(
    /\/$/,
    "",
  );
  const url = new URL(req.url);
  const target = base + sub + url.search;
  const orgToken = await mintOrgToken(env.OC_ORG_TOKEN_SECRET, caller.orgID, caller.userID);

  const headers = new Headers();
  headers.set("x-oc-org-token", orgToken);
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const lastEventID = req.headers.get("last-event-id");
  if (lastEventID) headers.set("last-event-id", lastEventID);
  // Forward client idempotency keys so dashboard create-session / steer are safe
  // to retry end-to-end (sessions-api dedups on this header).
  const idem = req.headers.get("idempotency-key");
  if (idem) headers.set("idempotency-key", idem);

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }
  return fetch(target, init);
}

// ── dispatch ─────────────────────────────────────────────────────────────

export async function handleDashboard(
  req: Request,
  env: DashboardEnv,
  _ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  const caller = await authDashboard(req, env);
  if (!caller) return json({ error: "unauthenticated" }, 401);

  // /api/dashboard/* — strip the prefix for routing.
  const sub = path.replace(/^\/api\/dashboard/, "");
  const method = req.method.toUpperCase();

  // ── Durable Agent Sessions (/v3) — proxy to sessions-api ────────────────
  // Cookie-gated above. We inject OC_V3_KEY downstream so the osb_ key never
  // reaches the browser. (/v3 is per-key today, so this is that key's
  // workspace; org-scoping is a later refinement.)
  if (sub === "/v3" || sub.startsWith("/v3/")) {
    return proxyToV3(req, env, caller, sub);
  }

  // ── Sandbox lifecycle webhooks ─────────────────────────────────────────
  // Reuse the public /api/webhooks handler with the cookie-derived org, so the
  // dashboard manages destinations/deliveries org-scoped without an osb_ key in
  // the browser. The handler parses the path from the url arg; rewrite it back
  // to /api/webhooks/*. env carries the Svix bindings at runtime.
  if (sub === "/webhooks" || sub.startsWith("/webhooks/")) {
    const whUrl = new URL(req.url);
    whUrl.pathname = "/api" + sub;
    return handleWebhooksAPI(req, env as unknown as WebhookEnv, caller, whUrl);
  }

  // ── identity / org ─────────────────────────────────────────────────────
  if (sub === "/me" && method === "GET") return handleMe(req, env, caller);
  if (sub === "/orgs" && method === "GET") return handleListOrgs(req, env, caller);
  if (sub === "/org" && method === "GET") return handleGetOrg(req, env, caller);
  if (sub === "/org" && method === "PUT") return handleUpdateOrg(req, env, caller);
  if (sub === "/org/switch" && method === "POST") return handleOrgSwitch(req, env, caller);
  if (sub === "/org/members" && method === "GET") return handleListMembers(req, env, caller);
  {
    const m = sub.match(/^\/org\/members\/([^/]+)$/);
    if (m && method === "DELETE") return handleRemoveMember(req, env, caller, m[1]);
  }
  if (sub === "/org/invitations" && method === "GET") return handleListInvitations(req, env, caller);
  if (sub === "/org/invitations" && method === "POST") return handleSendInvitation(req, env, caller);
  {
    const m = sub.match(/^\/org\/invitations\/([^/]+)$/);
    if (m && method === "DELETE") return handleRevokeInvitation(req, env, caller, m[1]);
  }
  if (sub === "/org/credits" && method === "GET") return handleGetCredits(req, env, caller);
  if (sub === "/org/custom-domain" && method === "PUT") return handleSetCustomDomain(req, env, caller);
  if (sub === "/org/custom-domain" && method === "DELETE") return handleDeleteCustomDomain(req, env, caller);
  if (sub === "/org/custom-domain/refresh" && method === "POST") return handleRefreshCustomDomain(req, env, caller);

  // ── api keys ───────────────────────────────────────────────────────────
  if (sub === "/api-keys" && method === "GET") return handleListAPIKeys(req, env, caller);
  if (sub === "/api-keys" && method === "POST") return handleCreateAPIKey(req, env, caller);
  {
    const m = sub.match(/^\/api-keys\/([^/]+)$/);
    if (m && method === "DELETE") return handleDeleteAPIKey(req, env, caller, m[1]);
  }

  // ── sessions: cross-cell list, then per-cell proxy ─────────────────────
  if (sub === "/sessions" && method === "GET") return handleListSessions(req, env, caller);
  {
    const m = sub.match(/^\/sessions\/([^/]+)(\/.*)?$/);
    if (m) {
      const sandboxID = m[1];
      const rest = m[2] ?? ""; // "" means /sessions/:id only
      const target = await sandboxCell(env, sandboxID);
      if (!target) return json({ error: "sandbox not found" }, 404);
      if (target.org_id !== caller.orgID) return json({ error: "sandbox not in your org" }, 403);
      const cell = { cell_id: target.cell_id, base_url: target.base_url };
      const cellPath = `/internal/dashboard/sessions/${sandboxID}${rest}`;
      // WebSocket on PTY GET — anything else is a regular HTTP proxy.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && /^\/pty\/[^/]+$/.test(rest)) {
        return proxyWebSocket(req, env, caller, cell, cellPath);
      }
      return proxyToCell(req, env, caller, cell, cellPath);
    }
  }

  // ── checkpoints ───────────────────────────────────────────────────────
  if (sub === "/checkpoints" && method === "GET") return handleListCheckpoints(req, env, caller);
  {
    const m = sub.match(/^\/checkpoints\/([^/]+)$/);
    if (m && method === "DELETE") return handleDeleteCheckpoint(req, env, caller, m[1]);
  }

  // ── images: cross-cell list from D1 images_index ───────────────────────
  // CP emits image_cache_ready / image_cache_deleted events; events-ingest
  // upserts/deletes this table. The dashboard's Images page used to proxy
  // to the user's home_cell, which broke cross-cell visibility — building
  // a snapshot on cell A wouldn't show in the dashboard if the user later
  // moved to cell B. D1 is now authoritative.
  //
  // Mutations (DELETE) still need to land on the owning cell — only that
  // cell has the underlying bytes/checkpoint to clean up — so DELETE is
  // routed to the cell that owns the row.
  if (sub === "/images" && method === "GET") {
    return handleListImages(env, caller);
  }
  {
    const m = sub.match(/^\/images\/([^/]+)$/);
    if (m && method === "DELETE") {
      return handleDeleteImage(req, env, caller, m[1]);
    }
  }

  // ── agents: proxy to home cell (cell-side hits external agents service) ─
  if (sub === "/agents" || sub.startsWith("/agents/")) {
    if (sub === "/billing/agent-subscriptions" && method === "GET") return handleListAgentSubscriptions(req, env, caller);
    const cell = await homeCell(env, caller.orgID);
    if (!cell) return json({ error: "home cell unavailable" }, 503);
    return proxyToCell(req, env, caller, cell, `/internal/dashboard${sub}`);
  }
  if (sub === "/billing/agent-subscriptions" && method === "GET") return handleListAgentSubscriptions(req, env, caller);

  // /billing — basic billing read used by the dashboard billing page.
  // Surfaces the org's plan + credit state from D1 + DO. The full billing
  // UI (invoices, payment methods, plan changes) routes through Stripe and
  // isn't implemented edge-native yet; return a stable placeholder so the
  // dashboard renders instead of 404-erroring on a missing route.
  if (sub === "/billing" && method === "GET") {
    const org = await env.OPENCOMPUTER_DB.prepare(
      `SELECT plan, stripe_customer_id, stripe_subscription_id, free_credits_remaining_cents, credit_balance_cents, is_halted, max_concurrent_sandboxes, billing_provider, model_billing_status
         FROM orgs WHERE id = ?1`,
    ).bind(caller.orgID).first<{
      plan: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
      free_credits_remaining_cents: number; credit_balance_cents: number; is_halted: number;
      max_concurrent_sandboxes: number; billing_provider: string; model_billing_status: string | null;
    }>();
    if (!org) return json({ error: "org not found" }, 404);
    // Cross-check against the live DO state — the D1 mirror gets written by
    // the DO after every debit but lags a touch, and on initial signup the
    // column reads its column-default (500) before the DO has ever been
    // touched. Reading the DO here is one extra round-trip per billing page
    // load but keeps the displayed credit consistent with the actual halt
    // gate the create flow enforces.
    let liveBalance = org.free_credits_remaining_cents;
    if (org.plan === "free") {
      try {
        const stub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(caller.orgID));
        const snap = await stub.fetch("https://do/snapshot");
        if (snap.ok) {
          const state = await snap.json<Record<string, any>>();
          const s = state.state ?? state;
          if (typeof s.balance_cents === "number" && s.balance_cents >= 0) {
            liveBalance = s.balance_cents;
          }
        }
      } catch (e) {
        console.error("billing: DO snapshot failed, falling back to D1 mirror:", e);
      }
    }
    return json({
      plan: org.plan,
      stripeCustomerId: org.stripe_customer_id ?? undefined,
      stripeSubscriptionId: org.stripe_subscription_id ?? undefined,
      freeCreditsRemainingCents: liveBalance,
      creditBalanceCents: org.credit_balance_cents,
      isHalted: !!org.is_halted,
      maxConcurrentSandboxes: org.max_concurrent_sandboxes,
      billingProvider: org.billing_provider,
      // Managed model access (token-billing §6.6): the single gating authority the UI
      // reads to offer the "Managed" credential option. True only once the edge has
      // provisioned the org's OpenRouter key + bound it (model_billing_status='active').
      managedAvailable: org.model_billing_status === "active",
      // Upcoming-invoice + meters would come from Stripe API on demand;
      // surface stubs for now so the UI has stable keys to render against.
      upcomingInvoice: null,
      meters: [],
    });
  }

  // ── Stripe-backed billing ops ───────────────────────────────────────
  //
  // The legacy CP had these as dashboard_billing.go handlers. Edge equivalents
  // call Stripe's REST API directly with STRIPE_API_KEY. Customer state lives
  // in D1 orgs (stripe_customer_id, stripe_subscription_id) populated by the
  // stripe webhook handler.
  if (sub === "/billing/portal" && method === "POST") {
    return handleBillingPortal(req, env, caller);
  }
  if (sub === "/billing/setup" && method === "POST") {
    return handleBillingSetup(req, env, caller);
  }
  if (sub === "/billing/redeem" && method === "POST") {
    return handleBillingRedeem(req, env, caller);
  }
  if (sub === "/billing/invoices" && method === "GET") {
    return handleBillingInvoices(req, env, caller);
  }
  if (sub === "/usage/sandboxes" && method === "GET") {
    return handleSandboxUsage(req, env, caller);
  }
  if (sub === "/billing/autumn" && method === "GET") {
    return handleAutumnBilling(req, env, caller);
  }
  if (sub === "/billing/autumn/topup" && method === "POST") {
    return handleAutumnTopup(req, env, caller);
  }
  if (sub === "/billing/autumn/concurrency" && method === "POST") {
    return handleAutumnConcurrency(req, env, caller);
  }
  if (sub === "/billing/autumn/auto-topup" && method === "POST") {
    return handleAutumnAutoTopup(req, env, caller);
  }
  if (sub === "/billing/autumn/finalize-arm" && method === "GET") {
    return handleAutumnFinalizeArm(req, env, caller);
  }

  return json({ error: `not found: ${method} ${sub}` }, 404);
}

// ── Images (cross-cell via D1 images_index) ────────────────────────────

interface ImagesRow {
  id: string;
  org_id: string;
  owner_cell_id: string;
  content_hash: string;
  checkpoint_id: string | null;
  name: string | null;
  manifest: string;
  status: string;
  created_at: number;
  last_used_at: number;
}

async function handleListImages(env: DashboardEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, org_id, owner_cell_id, content_hash, checkpoint_id, name, manifest, status, created_at, last_used_at
       FROM images_index WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(caller.orgID)
    .all<ImagesRow>();
  const out = (results ?? []).map((r) => {
    let manifest: unknown = {};
    try { manifest = JSON.parse(r.manifest); } catch { /* keep empty */ }
    return {
      id: r.id,
      orgId: r.org_id,
      cellId: r.owner_cell_id,
      contentHash: r.content_hash,
      checkpointId: r.checkpoint_id,
      name: r.name,
      manifest,
      status: r.status,
      createdAt: new Date(r.created_at * 1000).toISOString(),
      lastUsedAt: new Date(r.last_used_at * 1000).toISOString(),
    };
  });
  return json(out);
}

async function handleDeleteImage(req: Request, env: DashboardEnv, caller: Caller, imageID: string): Promise<Response> {
  // Look up owning cell to forward the DELETE to (bytes + checkpoint live there).
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT owner_cell_id, name FROM images_index WHERE id = ?1 AND org_id = ?2`,
  )
    .bind(imageID, caller.orgID)
    .first<{ owner_cell_id: string; name: string | null }>();
  if (!row) return json({ error: "image not found" }, 404);
  if (!row.name) return json({ error: "auto-cached images are managed by the cell — only named snapshots can be deleted via dashboard" }, 400);

  // Find the cell's base_url and forward via tunnel.
  const cell = await env.OPENCOMPUTER_DB.prepare(
    `SELECT base_url FROM cells WHERE cell_id = ?1`,
  )
    .bind(row.owner_cell_id)
    .first<{ base_url: string }>();
  if (!cell) return json({ error: "owning cell not registered" }, 503);

  // Reuse proxyToCell so the cap-token / cookie auth chain handles auth.
  // Path mirrors what the legacy dashboard called: /internal/dashboard/images/{name}
  return proxyToCell(req, env, caller, { cell_id: row.owner_cell_id, base_url: cell.base_url }, `/internal/dashboard/images/${row.name}`);
}

// ── Stripe helpers ─────────────────────────────────────────────────────

// stripeApi POSTs form-urlencoded to Stripe's REST API. GET is supported via
// the `method` arg; body is ignored for GET. Returns parsed JSON or throws.
async function stripeApi(env: DashboardEnv, path: string, body: Record<string, string> | null, method: "GET" | "POST" = "POST"): Promise<any> {
  const url = `https://api.stripe.com${path}`;
  const init: RequestInit = {
    method,
    headers: {
      authorization: "Bearer " + env.STRIPE_API_KEY,
      "stripe-version": "2024-06-20",
    },
  };
  if (method === "POST" && body) {
    (init.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(body).toString();
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    const msg = parsed?.error?.message ?? parsed?.raw ?? `stripe ${path} returned ${resp.status}`;
    throw new Error(msg);
  }
  return parsed;
}

// loadOrgStripe pulls just the Stripe-relevant columns for a caller's org.
async function loadOrgStripe(env: DashboardEnv, orgID: string): Promise<{ name: string; stripe_customer_id: string | null; stripe_subscription_id: string | null } | null> {
  return env.OPENCOMPUTER_DB.prepare(
    `SELECT name, stripe_customer_id, stripe_subscription_id FROM orgs WHERE id = ?1`,
  )
    .bind(orgID)
    .first();
}

// ── Stripe billing handlers ────────────────────────────────────────────

async function handleBillingPortal(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const org = await loadOrgStripe(env, caller.orgID);
  if (!org) return json({ error: "org not found" }, 404);
  if (!org.stripe_customer_id) {
    return json({ error: "no billing customer — upgrade to Pro first" }, 400);
  }
  // Bounce back wherever the dashboard came from when the user closes the portal.
  const returnURL = req.headers.get("referer") ?? `${new URL(req.url).origin}/dashboard/billing`;
  try {
    const session = await stripeApi(env, "/v1/billing_portal/sessions", {
      customer: org.stripe_customer_id,
      return_url: returnURL,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("billing/portal:", e);
    return json({ error: (e as Error).message }, 500);
  }
}

// ── Per-sandbox usage breakdown ──────────────────────────────────────────

// Per-sandbox DISPLAY rate for PREPAID (autumn) orgs only — this breakdown is
// rendered solely in the autumn billing view, and this constant has exactly one
// consumer (handleSandboxUsage below). It is intentionally decoupled from
// internal/billing/pricing.go (legacy billing): the source of truth for prepaid
// charges is the Autumn `credits` credit-schema (credit_cost per compute
// feature), and these values MUST mirror it exactly or the breakdown won't
// reconcile with what's actually deducted. Current basis: $0.06/GB-hour
// (0.00001666666666 per GB-second × the tier's GB). Change the Autumn schema →
// change these too.
const AUTUMN_TIER_RATE_PER_SEC: Record<number, number> = {
  1024: 0.00001666666666,
  4096: 0.00006666666664,
  8192: 0.00013333333328,
  16384: 0.00026666666656,
  32768: 0.00053333333312,
  65536: 0.00106666666624,
};

// GET /api/dashboard/usage/sandboxes?days=N — per-sandbox compute cost over a
// recent window, for billing transparency. Sourced from D1 usage_samples
// (global across cells); disk overage is excluded (samples carry no disk size),
// so this is compute cost only. usage_samples is short-lived, hence the window.
async function handleSandboxUsage(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const url = new URL(req.url);
  let days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
  if (!Number.isFinite(days) || days < 1) days = 30;
  if (days > 90) days = 90;
  const cutoffMs = (Math.floor(Date.now() / 1000) - days * 86400) * 1000;

  const rows = await env.OPENCOMPUTER_DB.prepare(
    `SELECT u.sandbox_id AS sandbox_id, u.memory_mb AS memory_mb, SUM(u.interval_s) AS secs,
            MAX(si.status) AS status, MAX(si.created_at) AS created_at
       FROM usage_samples u
       LEFT JOIN sandboxes_index si ON si.id = u.sandbox_id
      WHERE u.org_id = ?1 AND u.ts >= ?2
      GROUP BY u.sandbox_id, u.memory_mb`,
  )
    .bind(caller.orgID, cutoffMs)
    .all<{ sandbox_id: string; memory_mb: number; secs: number; status: string | null; created_at: number | null }>();

  // Fold per-(sandbox, tier) rows into per-sandbox totals.
  const bySandbox = new Map<string, { costCents: number; seconds: number; status: string | null; createdAt: number | null }>();
  for (const r of rows.results ?? []) {
    const rate = AUTUMN_TIER_RATE_PER_SEC[r.memory_mb] ?? 0;
    const secs = r.secs ?? 0;
    const cur = bySandbox.get(r.sandbox_id) ?? { costCents: 0, seconds: 0, status: r.status, createdAt: r.created_at };
    cur.costCents += secs * rate * 100;
    cur.seconds += secs;
    if (cur.status == null) cur.status = r.status;
    if (cur.createdAt == null) cur.createdAt = r.created_at;
    bySandbox.set(r.sandbox_id, cur);
  }

  const sandboxes = [...bySandbox.entries()]
    .map(([sandboxId, v]) => ({
      sandboxId,
      status: v.status ?? "deleted",
      createdAt: v.createdAt ?? undefined,
      seconds: Math.round(v.seconds),
      // Keep FRACTIONAL cents. Rounding each sandbox to whole cents here meant a
      // cheap/short sandbox (e.g. 4GB for ~15 min ≈ 0.5¢) showed $0.00, and the
      // total summed already-zeroed rows — so a page of real usage read $0.00.
      // The frontend formats the precision for display.
      costCents: v.costCents,
    }))
    .sort((a, b) => b.costCents - a.costCents);

  const totalCents = sandboxes.reduce((s, x) => s + x.costCents, 0);
  return json({ windowDays: days, totalCents, sandboxes });
}

// ── Autumn prepaid billing ───────────────────────────────────────────────

// Concurrency plans the user can self-serve subscribe to. Mirrors
// autumn.ConcurrencyByPlan (the "base" tier is the free default, not purchasable).
const AUTUMN_CONCURRENCY_PRODUCTS: Record<string, number> = {
  concurrency_pro: 100,
  concurrency_pro_plus: 600,
  concurrency_pro_plus_plus: 1000,
};

// GET /api/dashboard/billing/autumn — prepaid credit balance + concurrency plan.
// Re-syncs Autumn → D1 on the way (this is the checkout-return / page-view resume
// trigger: a just-topped-up user's is_halted clears here even if the webhook lagged).
async function handleAutumnBilling(_req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let r;
  try {
    r = await syncAutumnToD1(env, caller.orgID);
  } catch (e) {
    console.error("billing/autumn sync:", e);
    return json({ error: "autumn unavailable" }, 502);
  }
  if (!r) return json({ error: "no autumn customer for org" }, 404);

  // The active concurrency plan = the highest non-base plan the customer holds.
  let concurrencyPlan = "base";
  let best = 0;
  for (const s of r.customer.subscriptions ?? []) {
    if (s.status && s.status !== "active") continue;
    const v = AUTUMN_CONCURRENCY_PRODUCTS[s.plan_id];
    if (v !== undefined && v > best) {
      best = v;
      concurrencyPlan = s.plan_id;
    }
  }

  const at = r.customer.billing_controls?.auto_topups?.find((a) => a.feature_id === "credits");

  // Has the customer charged a top-up? That's when auto-recharge becomes armed,
  // so the UI uses it to tell whether enabling auto-recharge will run a first
  // recharge or just save. Free — the customer is already loaded above.
  const hasToppedUp = (r.customer.purchases ?? []).some((p) => p.plan_id === "top_up");

  return json({
    creditsRemainingCents: Math.round(r.creditsRemaining * 100),
    maxConcurrentSandboxes: r.maxConcurrent,
    concurrencyPlan,
    isHalted: r.halted,
    hasToppedUp,
    autoTopup: at ? { enabled: at.enabled, threshold: at.threshold, quantity: at.quantity } : null,
  });
}

// POST /api/dashboard/billing/autumn/auto-topup { enabled, threshold, quantity }
// — configure automatic credit recharge. threshold/quantity are in credits ($1
// each). A saved payment method is required for the charge to succeed; the
// config itself persists regardless.
async function handleAutumnAutoTopup(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let body: { enabled?: boolean; threshold?: number; quantity?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const enabled = !!body.enabled;
  const threshold = Math.floor(body.threshold ?? 0);
  const quantity = Math.floor(body.quantity ?? 0);
  if (enabled && (threshold < 0 || quantity < 1)) {
    return json({ error: "threshold ≥ 0 and quantity ≥ 1 required when enabling" }, 400);
  }
  try {
    await autumnSetAutoTopup(env, caller.orgID, { enabled, threshold, quantity });

    // Auto-recharge is armed once the customer has charged a top-up (a
    // saved-but-never-charged card is unarmed). If they've already topped up, just
    // save — no redundant charge. If not, run their first recharge now to arm it
    // (no card → one hosted setup_payment flow saves the card off-session AND
    // charges; card on file → /attach charges directly).
    if (enabled && !(await autumnHasToppedUp(env, caller.orgID))) {
      const origin = new URL(req.url).origin;
      const co = await autumnTopUpCharge(env, {
        customerId: caller.orgID,
        quantity,
        successUrl: `${origin}/api/dashboard/billing/autumn/finalize-arm?credits=${quantity}`,
      });
      return json({ ok: true, url: co.url });
    }
    return json({ ok: true, url: null });
  } catch (e) {
    console.error("billing/autumn auto-topup:", e);
    return json({ error: (e as Error).message }, 502);
  }
}

// GET /billing/autumn/finalize-arm?credits=N — the return target Stripe sends the
// browser to after a setup_payment card setup. The card is now saved, so we
// charge the deferred first recharge HERE (server-side, immune to browser cache /
// dropped query params), which both adds the credits and arms auto-recharge, then
// 302 back to the billing page. Authenticated by the session cookie carried on
// the redirect.
async function handleAutumnFinalizeArm(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const origin = new URL(req.url).origin;
  const billing = `${origin}/dashboard/billing`;
  if (!env.AUTUMN_SECRET_KEY) return Response.redirect(billing, 302);
  const credits = Math.floor(Number(new URL(req.url).searchParams.get("credits") ?? "0"));
  // Idempotency: only charge if not already topped up — so a refresh / double
  // redirect to this URL can't charge twice (after the first charge, hasToppedUp
  // is true).
  if (credits >= 1 && !(await autumnHasToppedUp(env, caller.orgID))) {
    try {
      await autumnAttach(env, {
        customerId: caller.orgID,
        productId: "top_up",
        options: [{ feature_id: "credits", quantity: credits }],
      });
    } catch (e) {
      console.error("billing/autumn finalize-arm:", e);
      return Response.redirect(`${billing}?arm=failed`, 302);
    }
  }
  return Response.redirect(`${billing}?arm=ok`, 302);
}

// POST /api/dashboard/billing/autumn/topup { credits } — one-off prepaid credit
// purchase. Returns a Stripe checkout URL; success returns to the billing page
// where handleAutumnBilling re-syncs the new balance.
async function handleAutumnTopup(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let body: { credits?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const credits = Math.floor(body.credits ?? 0);
  if (!Number.isFinite(credits) || credits < 1) {
    return json({ error: "credits must be a positive integer" }, 400);
  }
  const origin = new URL(req.url).origin;
  try {
    // Charge via the off-session-establishing flow so a top-up also arms
    // auto-recharge. url present → redirect (hosted card setup, no card yet);
    // url null → existing card charged directly. Frontend redirects or refreshes.
    const co = await autumnTopUpCharge(env, {
      customerId: caller.orgID,
      quantity: credits,
      successUrl: `${origin}/api/dashboard/billing/autumn/finalize-arm?credits=${credits}`,
    });
    return json({ url: co.url });
  } catch (e) {
    console.error("billing/autumn topup:", e);
    return json({ error: (e as Error).message }, 502);
  }
}

// POST /api/dashboard/billing/autumn/concurrency { plan } — subscribe/upgrade a
// monthly concurrency tier. Returns a Stripe subscription checkout URL.
async function handleAutumnConcurrency(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let body: { plan?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const plan = body.plan ?? "";
  if (!(plan in AUTUMN_CONCURRENCY_PRODUCTS)) {
    return json({ error: `unknown concurrency plan '${plan}'` }, 400);
  }
  const origin = new URL(req.url).origin;
  try {
    // Same dual flow as top-up: redirect for a new card, or attach the existing
    // card directly (url null) when upgrading a tier with a payment method on file.
    const co = await autumnPurchase(env, {
      customerId: caller.orgID,
      productId: plan,
      successUrl: `${origin}/dashboard/billing?plan=success`,
    });
    return json({ url: co.url });
  } catch (e) {
    console.error("billing/autumn concurrency:", e);
    return json({ error: (e as Error).message }, 502);
  }
}

async function handleBillingSetup(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const org = await loadOrgStripe(env, caller.orgID);
  if (!org) return json({ error: "org not found" }, 404);

  // Ensure a Stripe customer exists — create one if this org has never been
  // through checkout. Persist the ID back to D1 so the webhook flow can find
  // it later (subscription.created carries customer_id + metadata.org_id).
  let customerID = org.stripe_customer_id;
  if (!customerID) {
    try {
      const cust = await stripeApi(env, "/v1/customers", {
        name: org.name ?? "",
        "metadata[org_id]": caller.orgID,
      });
      customerID = cust.id as string;
      await env.OPENCOMPUTER_DB.prepare(
        `UPDATE orgs SET stripe_customer_id = ?1, updated_at = ?2 WHERE id = ?3`,
      )
        .bind(customerID, Math.floor(Date.now() / 1000), caller.orgID)
        .run();
    } catch (e) {
      console.error("billing/setup create customer:", e);
      return json({ error: "failed to create customer" }, 500);
    }
  }

  const origin = new URL(req.url).origin;
  try {
    // SetupIntent-style checkout — Stripe collects the payment method, then
    // the webhook (subscription.created or checkout.session.completed) marks
    // the org as Pro. Mirrors legacy CreateSetupCheckoutSession field-for-
    // field (mode=setup + currency=usd + metadata.type=setup); Stripe rejects
    // setup-mode checkouts without `currency`.
    const session = await stripeApi(env, "/v1/checkout/sessions", {
      mode: "setup",
      currency: "usd",
      customer: customerID!,
      success_url: `${origin}/dashboard/billing?setup=success`,
      cancel_url: `${origin}/dashboard/billing?setup=cancel`,
      "metadata[org_id]": caller.orgID,
      "metadata[type]": "setup",
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("billing/setup create checkout:", e);
    // Surface Stripe's error message instead of a generic 500 so the
    // dashboard / CLI can show it. Stripe errors carry useful detail
    // (test/live mode mismatch, invalid customer, missing capability, etc).
    return json({ error: (e as Error).message }, 500);
  }
}

async function handleBillingRedeem(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { code?: string } | null;
  if (!body?.code) return json({ error: "code is required" }, 400);

  const org = await loadOrgStripe(env, caller.orgID);
  if (!org) return json({ error: "org not found" }, 404);
  if (!org.stripe_customer_id) {
    return json({ error: "billing not set up — upgrade to Pro first" }, 400);
  }

  try {
    // Look up the promotion code → coupon
    const promos = await stripeApi(env, `/v1/promotion_codes?code=${encodeURIComponent(body.code)}&active=true`, null, "GET");
    const pc = promos?.data?.[0];
    if (!pc) return json({ error: "promo code not found or inactive" }, 400);
    const couponAmount = pc?.coupon?.amount_off as number | undefined;
    if (!couponAmount || couponAmount <= 0) {
      return json({ error: "promo code has no fixed amount_off" }, 400);
    }

    // Apply as a negative customer balance transaction (= credit). Stripe
    // pulls from this on the next invoice.
    await stripeApi(env, `/v1/customers/${org.stripe_customer_id}/balance_transactions`, {
      amount: String(-couponAmount),
      currency: pc?.coupon?.currency ?? "usd",
      description: `Promotion code ${body.code}`,
    });

    return json({ creditAppliedCents: couponAmount });
  } catch (e) {
    console.error("billing/redeem:", e);
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleBillingInvoices(_req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const org = await loadOrgStripe(env, caller.orgID);
  if (!org) return json({ error: "org not found" }, 404);
  if (!org.stripe_customer_id) return json({ invoices: [] });
  try {
    const list = await stripeApi(env, `/v1/invoices?customer=${org.stripe_customer_id}&limit=25`, null, "GET");
    const invoices = (list?.data ?? []).map((inv: any) => ({
      id: inv.id,
      status: inv.status,
      total: inv.total,
      amountPaid: inv.amount_paid,
      amountDue: inv.amount_due,
      currency: inv.currency,
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf,
      created: inv.created,
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
    }));
    return json({ invoices });
  } catch (e) {
    console.error("billing/invoices:", e);
    return json({ error: (e as Error).message }, 500);
  }
}
