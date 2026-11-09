// dashboard.ts — edge-native dashboard backend.
//
// The CF edge is authoritative for identity and billing, and the dashboard
// backend lives here: D1 is the source of truth for org/user/api-key data.
//
// Auth: session JWT cookie `oc_session` minted by /auth/callback. Browser
// hits /api/dashboard/...; we validate the cookie and execute the handler.
//
// The sandbox-runtime proxy to the cells (/internal/dashboard/* for sessions,
// PTY, agents, sandbox create, previews and snapshot deletes) was removed in
// 097 step 7.2, followed by the D1-only sandbox reads (sessions, checkpoints,
// images, per-sandbox usage), sandbox webhooks and org custom domains. The
// sandbox D1 tables and org columns stay until a later migration.

import {
  autumnPurchase,
  autumnUsagePlanPurchase,
  autumnTopUpCharge,
  autumnAttach,
  autumnHasToppedUp,
  syncAutumnToD1,
  summarizeAutumnCreditBalance,
  autumnSetAutoTopup,
  autumnOpenCustomerPortal,
  autumnCancelPlan,
} from "./autumn_webhook";
import { planSchedule, summarizeWorkMinutePlan, trialEndsAt } from "./billing_summary";
import { emitBillingEvent, type BillingEventsEnv } from "./billing_events";
import { createAPIKeyWithHash } from "./api_keys";
import { createdKeyForSync, revokeComputerKey, syncComputerKey } from "./computer_keys";
import {
  proxyManagedAgents,
  proxyPublicTemplateInspection,
} from "./managed_agents";
import { computerEnabledFor } from "./computer";
import { enableManagedBilling } from "./model_billing";
import { paywallContext } from "./billing_onramp";
import { insufficientManagedAgentCredits } from "./managed_agent_credit_gate";
import { sendSlackAlert, teammateInvitedAlert } from "./slack_alerts";

export interface DashboardEnv extends BillingEventsEnv {
  /** Computer rollout (work 052): see computerEnabledFor in computer.ts. */
  COMPUTER_ENABLED_FOR_ALL?: string;
  COMPUTER_ENABLED_ORGS?: string;
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
  // Private managed-agent backend. The browser only calls this Worker; it
  // never receives the backend URL or assertion secret.
  MANAGED_AGENTS_API_URL?: string;
  OC_MANAGED_AGENTS_SECRET?: string;
  OPENROUTER_PROVISIONING_KEY: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_MARKUP_BPS?: string;
  OC_MANAGED_CRED_HMAC_SECRET: string;
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

// shapeOrg maps a D1 orgs row to the frontend's Org interface (camelCase,
// timestamps as ISO strings, integer-flag booleans).
interface OrgRow {
  id: string; name: string; slug: string; plan: string;
  max_concurrent_sandboxes: number; max_sandbox_timeout_sec: number;
  autumn_concurrency_override: number | null;
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
    autumnConcurrencyOverride: r.autumn_concurrency_override ?? undefined,
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

// ── identity (/me, /orgs, /org, /org/switch) ─────────────────────────────

async function handleMe(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  // Load user + org list. Org list joins via org_memberships; each row carries
  // the active flag so the UI can highlight the current org.
  const user = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, email, name, workos_user_id, durable_sessions_enabled, infrastructure_enabled
       FROM users WHERE id = ?1`,
  ).bind(caller.userID).first<{
    id: string;
    email: string;
    name: string | null;
    workos_user_id: string | null;
    durable_sessions_enabled: number;
    infrastructure_enabled: number;
  }>();
  if (!user) return json({ error: "user not found" }, 404);

  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT o.id, o.name, o.is_personal, o.onboarding_experience FROM orgs o
       JOIN org_memberships m ON m.org_id = o.id
      WHERE m.user_id = ?1`,
  ).bind(caller.userID).all<{ id: string; name: string; is_personal: number; onboarding_experience: string | null }>();
  const orgs = (results ?? []).map((r) => ({
    id: r.id, name: r.name, isPersonal: !!r.is_personal, isActive: r.id === caller.orgID,
  }));

  return json({
    id: user.id,
    email: user.email,
    name: user.name,
    orgId: caller.orgID,
    orgs,
    durableSessionsEnabled: !!user.durable_sessions_enabled,
    infrastructureEnabled: !!user.infrastructure_enabled,
    computerEnabled: computerEnabledFor(env, caller.orgID),
    onboardingExperience: (results ?? []).find((org) => org.id === caller.orgID)?.onboarding_experience ?? null,
  });
}

async function handleUpdateMePreferences(req: Request, env: DashboardEnv, caller: Caller): Promise<Response> {
  type PreferenceUpdate = {
    durableSessionsEnabled?: unknown;
    infrastructureEnabled?: unknown;
  };
  const body = await req.json<PreferenceUpdate>().catch(() => ({} as PreferenceUpdate));
  if (body.durableSessionsEnabled !== undefined && typeof body.durableSessionsEnabled !== "boolean") {
    return json({ error: "durableSessionsEnabled must be a boolean" }, 400);
  }
  if (body.durableSessionsEnabled !== undefined) {
    return json({ error: "durable session navigation is managed by an administrator" }, 403);
  }
  if (body.infrastructureEnabled !== undefined && typeof body.infrastructureEnabled !== "boolean") {
    return json({ error: "infrastructureEnabled must be a boolean" }, 400);
  }
  if (body.durableSessionsEnabled === undefined && body.infrastructureEnabled === undefined) {
    return json({ error: "at least one navigation preference is required" }, 400);
  }
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE users
        SET infrastructure_enabled = COALESCE(?1, infrastructure_enabled)
      WHERE id = ?2`,
  )
    .bind(
      typeof body.infrastructureEnabled === "boolean" ? Number(body.infrastructureEnabled) : null,
      caller.userID,
    )
    .run();
  return handleMe(req, env, caller);
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
  type OrgUpdate = { name?: unknown };
  const body = await req.json<OrgUpdate>().catch(() => ({} as OrgUpdate));
  if (body.name !== undefined && typeof body.name !== "string") {
    return json({ error: "name must be a string" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (body.name !== undefined && !name) return json({ error: "name is required" }, 400);
  if (name === undefined) return json({ error: "name is required" }, 400);
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT owner_user_id, workos_org_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ owner_user_id: string | null; workos_org_id: string | null }>();
  if (!org) return json({ error: "org not found" }, 404);
  if (org.owner_user_id !== caller.userID) return json({ error: "only owner can rename" }, 403);

  await env.OPENCOMPUTER_DB.prepare(`UPDATE orgs SET name = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(name, Math.floor(Date.now() / 1000), caller.orgID).run();

  // Best-effort WorkOS sync. Errors logged, not surfaced.
  if (name && org.workos_org_id) {
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

  const now = Math.floor(Date.now() / 1000);
  // WorkOS invitation send. Returns the WorkOS invitation ID we mirror in D1.
  // Orgs provisioned at the edge have no WorkOS org yet; create one lazily so
  // WorkOS can deliver the invitation email.
  const org = await env.OPENCOMPUTER_DB.prepare(`SELECT name, workos_org_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ name: string; workos_org_id: string | null }>();
  let workosOrgID = org?.workos_org_id ?? null;
  if (org && !workosOrgID) {
    const created = await workosCreateOrg(env, org.name);
    if (created) {
      await env.OPENCOMPUTER_DB.prepare(`UPDATE orgs SET workos_org_id = ?1, updated_at = ?2 WHERE id = ?3 AND workos_org_id IS NULL`)
        .bind(created, now, caller.orgID).run();
      // A concurrent invite may have won the conditional update; always invite
      // into whichever WorkOS org is actually recorded.
      const stored = await env.OPENCOMPUTER_DB.prepare(`SELECT workos_org_id FROM orgs WHERE id = ?1`).bind(caller.orgID).first<{ workos_org_id: string | null }>();
      workosOrgID = stored?.workos_org_id ?? created;
    }
  }
  let workosInviteID: string | null = null;
  if (workosOrgID) {
    try {
      const r = await fetch("https://api.workos.com/user_management/invitations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.WORKOS_API_KEY}` },
        body: JSON.stringify({ email, organization_id: workosOrgID, expires_in_days: 7, role_slug: role }),
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
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO invitations (id, org_id, email, role, invited_by, workos_invitation_id, status, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
  ).bind(id, caller.orgID, email, role, caller.userID, workosInviteID, now + 7 * 86400, now).run();
  await sendSlackAlert(env, teammateInvitedAlert(caller.orgID, email));
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
  // Expired one-hour computer keys (/internal/computer-keys) are noise: hidden.
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, name, key_prefix, scopes, last_used, expires_at, created_at, created_by
       FROM api_keys WHERE org_id = ?1
        AND NOT (created_by = 'computer' AND expires_at < ?2)
      ORDER BY created_at DESC`,
  ).bind(caller.orgID, Math.floor(Date.now() / 1000)).all<{
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

async function handleCreateAPIKey(
  req: Request,
  env: DashboardEnv,
  ctx: ExecutionContext | undefined,
  caller: Caller,
): Promise<Response> {
  const body = await req.json<{ name?: string; expiresAt?: unknown }>()
    .catch(() => ({} as { name?: string; expiresAt?: unknown }));
  const name = (body.name ?? "Untitled").trim() || "Untitled";
  let expiresAt: number | undefined;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    const ms = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    if (Number.isNaN(ms)) return json({ error: "expiresAt must be an ISO 8601 timestamp" }, 400);
    if (ms <= Date.now()) return json({ error: "expiresAt must be in the future" }, 400);
    expiresAt = Math.floor(ms / 1000);
  }
  const { created, hash } = await createAPIKeyWithHash(env, {
    orgID: caller.orgID,
    userID: caller.userID,
    name,
    expiresAt,
  });
  // Tell the computer API about the key (work 084); never the key itself.
  ctx?.waitUntil(
    syncComputerKey(env, caller.orgID, createdKeyForSync(created, hash, caller.userID)),
  );
  return json(created, 201);
}

async function handleDeleteAPIKey(
  _req: Request,
  env: DashboardEnv,
  ctx: ExecutionContext | undefined,
  caller: Caller,
  keyID: string,
): Promise<Response> {
  const result = await env.OPENCOMPUTER_DB.prepare(`DELETE FROM api_keys WHERE id = ?1 AND org_id = ?2`).bind(keyID, caller.orgID).run();
  // Only a key this org held is reported revoked (D1 says how many rows went).
  if (result?.meta?.changes !== 0) {
    ctx?.waitUntil(revokeComputerKey(env, caller.orgID, caller.userID, keyID));
  }
  return new Response(null, { status: 204 });
}

async function handleRenameAPIKey(req: Request, env: DashboardEnv, caller: Caller, keyID: string): Promise<Response> {
  const body = await req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ error: "name is required" }, 400);

  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, key_prefix, scopes, last_used, expires_at, created_at
       FROM api_keys WHERE id = ?1 AND org_id = ?2`,
  ).bind(keyID, caller.orgID).first<{
    id: string; key_prefix: string; scopes: string;
    last_used: number | null; expires_at: number | null; created_at: number;
  }>();
  if (!row) return json({ error: "api key not found" }, 404);

  await env.OPENCOMPUTER_DB.prepare(`UPDATE api_keys SET name = ?1 WHERE id = ?2 AND org_id = ?3`)
    .bind(name, keyID, caller.orgID).run();
  return json({
    id: row.id,
    orgId: caller.orgID,
    name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes.split(",").map((s) => s.trim()).filter(Boolean),
    lastUsed: epochToISO(row.last_used),
    expiresAt: epochToISO(row.expires_at),
    createdAt: epochToISORequired(row.created_at),
  });
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

async function workosCreateOrg(env: DashboardEnv, name: string): Promise<string | null> {
  try {
    const r = await fetch("https://api.workos.com/organizations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.WORKOS_API_KEY}` },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      console.error(`workos org create returned ${r.status}: ${await r.text()}`);
      return null;
    }
    const data = await r.json<{ id?: string }>();
    return data.id ?? null;
  } catch (e) {
    console.error("workos org create threw", e);
    return null;
  }
}

async function workosUpdateOrg(env: DashboardEnv, workosOrgID: string, name: string): Promise<void> {
  await fetch(`https://api.workos.com/organizations/${workosOrgID}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.WORKOS_API_KEY}` },
    body: JSON.stringify({ name }),
  });
}

// ── dispatch ─────────────────────────────────────────────────────────────

export async function handleDashboard(
  req: Request,
  env: DashboardEnv,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  // /api/dashboard/* — strip the prefix for routing.
  const sub = path.replace(/^\/api\/dashboard/, "");
  const method = req.method.toUpperCase();

  const caller = await authDashboard(req, env);
  if (!caller) {
    // Template preview is the one anonymous entry point: visitors can see
    // a template's deploy form before signing up.
    if (sub === "/managed-agents/template-inspections" && method === "POST") {
      return proxyPublicTemplateInspection(req, env);
    }
    return json({ error: "unauthenticated" }, 401);
  }

  // ── Managed Agents experiment ───────────────────────────────────────────
  if (sub === "/managed-agents" || sub.startsWith("/managed-agents/")) {
    if (sub === "/managed-agents/sessions" && method === "POST") {
      try {
        // Re-check Autumn and re-project D1 (the same projection projectOrg
        // writes; it no longer dispatches anywhere since 097 step 7.2).
        const billing = await enableManagedBilling(
          env,
          caller.orgID,
          async (id) => (await syncAutumnToD1(env, id).catch(() => null))?.halted ?? true,
        );
        if (billing.status === "halted") {
          // No paywall_shown here: the web app counts its own (surface "web").
          return insufficientManagedAgentCredits(req, await paywallContext(env.OPENCOMPUTER_DB, caller.orgID));
        }
        if (billing.status !== "active") {
          return json({ error: "managed model billing is unavailable" }, 503);
        }
      } catch (error) {
        console.error(
          `managed-agents: model billing admission failed org=${caller.orgID}`,
          error,
        );
        return json({ error: "managed model billing is unavailable" }, 503);
      }
    }
    const membership = await env.OPENCOMPUTER_DB.prepare(
      `SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2`,
    ).bind(caller.orgID, caller.userID).first<{ role: string }>();
    return proxyManagedAgents(
      req,
      env,
      {
        orgID: caller.orgID,
        userID: caller.userID,
        role:
          membership?.role === "owner" || membership?.role === "admin"
            ? "admin"
            : membership?.role,
      },
      "/api/dashboard/managed-agents",
    );
  }

  // ── identity / org ─────────────────────────────────────────────────────
  if (sub === "/me" && method === "GET") return handleMe(req, env, caller);
  if (sub === "/orgs" && method === "GET") return handleListOrgs(req, env, caller);
  if (sub === "/me/preferences" && method === "PUT") return handleUpdateMePreferences(req, env, caller);
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

  // ── api keys ───────────────────────────────────────────────────────────
  if (sub === "/api-keys" && method === "GET") return handleListAPIKeys(req, env, caller);
  if (sub === "/api-keys" && method === "POST") return handleCreateAPIKey(req, env, ctx, caller);
  {
    const m = sub.match(/^\/api-keys\/([^/]+)$/);
    if (m && method === "DELETE") return handleDeleteAPIKey(req, env, ctx, caller, m[1]);
    if (m && method === "PATCH") return handleRenameAPIKey(req, env, caller, m[1]);
  }

  if (sub === "/billing/agent-subscriptions" && method === "GET") return handleListAgentSubscriptions(req, env, caller);

  // /billing — basic billing read used by the dashboard billing page.
  // Surfaces the org's plan + credit state from D1 + DO. The full billing
  // UI (invoices, payment methods, plan changes) routes through Stripe and
  // isn't implemented edge-native yet; return a stable placeholder so the
  // dashboard renders instead of 404-erroring on a missing route.
  if (sub === "/billing" && method === "GET") {
    const org = await env.OPENCOMPUTER_DB.prepare(
      `SELECT plan, stripe_customer_id, stripe_subscription_id, free_credits_remaining_cents, credit_balance_cents, is_halted, max_concurrent_sandboxes, autumn_concurrency_override, billing_provider
         FROM orgs WHERE id = ?1`,
    ).bind(caller.orgID).first<{
      plan: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
      free_credits_remaining_cents: number; credit_balance_cents: number; is_halted: number;
      max_concurrent_sandboxes: number; autumn_concurrency_override: number | null; billing_provider: string;
    }>();
    if (!org) return json({ error: "org not found" }, 404);
    // Managed is a universal capability (every org gets a managed credential provisioned
    // on demand at agent-create / first use), so there's no per-org "available" flag to
    // read or return — the UI always offers Managed.
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
    // Whether a card is on file + any Stripe promotional credit. Both drive the
    // Billing UI (the "manage payment method" portal gate + the promo-credit
    // line) and are REQUIRED by the client schema, so we must always return
    // them. Derived from the Stripe customer when one exists; a fetch failure
    // degrades to (no card, no credit) rather than breaking the billing page.
    // Only the direct-Stripe (legacy/Pro) path uses this; Autumn orgs manage
    // their card through Autumn's portal + surface hasToppedUp in /billing/autumn,
    // and this edge has no STRIPE_API_KEY for Autumn's account anyway.
    let hasPaymentMethod = false;
    let stripeCreditCents = 0;
    if (org.stripe_customer_id && org.billing_provider !== "autumn") {
      try {
        const cust = await stripeApi(env, `/v1/customers/${org.stripe_customer_id}`, null, "GET");
        hasPaymentMethod = !!(cust?.invoice_settings?.default_payment_method || cust?.default_source);
        if (typeof cust?.balance === "number" && cust.balance < 0) stripeCreditCents = -cust.balance;
      } catch (e) {
        console.error("billing: stripe customer fetch failed:", e);
      }
    }
    return json({
      plan: org.plan,
      stripeCustomerId: org.stripe_customer_id ?? undefined,
      stripeSubscriptionId: org.stripe_subscription_id ?? undefined,
      hasPaymentMethod,
      stripeCreditCents,
      freeCreditsRemainingCents: liveBalance,
      creditBalanceCents: org.credit_balance_cents,
      isHalted: !!org.is_halted,
      maxConcurrentSandboxes: org.max_concurrent_sandboxes,
      autumnConcurrencyOverride: org.autumn_concurrency_override ?? undefined,
      billingProvider: org.billing_provider,
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
  if (sub === "/billing/autumn" && method === "GET") {
    return handleAutumnBilling(req, env, caller);
  }
  if (sub === "/billing/autumn/topup" && method === "POST") {
    return handleAutumnTopup(req, env, caller);
  }
  if (sub === "/billing/autumn/plan" && method === "POST") {
    return handleAutumnUsagePlan(req, env, caller);
  }
  if (sub === "/billing/autumn/concurrency" && method === "POST") {
    return handleAutumnConcurrency(req, env, caller);
  }
  if (sub === "/billing/autumn/cancel" && method === "POST") {
    return handleAutumnCancel(req, env, caller);
  }
  if (sub === "/billing/autumn/auto-topup" && method === "POST") {
    return handleAutumnAutoTopup(req, env, caller);
  }
  if (sub === "/billing/autumn/portal" && method === "POST") {
    return handleAutumnPortal(req, env, caller);
  }
  if (sub === "/billing/autumn/finalize-arm" && method === "GET") {
    return handleAutumnFinalizeArm(req, env, caller);
  }

  return json({ error: `not found: ${method} ${sub}` }, 404);
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
    return json({ error: "no billing account on file yet — add a payment method first" }, 400);
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

// Autumn-org billing portal — the card lives under Autumn's Stripe account, so
// we broker the portal session through Autumn (the org id IS the Autumn
// customer id), NOT the edge's direct STRIPE_API_KEY.
async function handleAutumnPortal(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  const returnURL = req.headers.get("referer") ?? `${new URL(req.url).origin}/dashboard/billing`;
  try {
    const { url } = await autumnOpenCustomerPortal(env, { customerId: caller.orgID, returnUrl: returnURL });
    if (!url) return json({ error: "no billing account on file yet — add a payment method first" }, 400);
    return json({ url });
  } catch (e) {
    console.error("billing/autumn/portal:", e);
    return json({ error: (e as Error).message }, 500);
  }
}

// ── Autumn prepaid billing ───────────────────────────────────────────────

// Concurrency plans the user can self-serve subscribe to. Mirrors
// autumn.ConcurrencyByPlan (the "base" tier is the free default, not purchasable).
const AUTUMN_CONCURRENCY_PRODUCTS: Record<string, number> = {
  concurrency_pro: 100,
  concurrency_pro_plus: 600,
  concurrency_pro_plus_plus: 1000,
};

const AUTUMN_USAGE_PLANS: Record<string, number> = {
  base: 0,
  pro: 1,
  max: 2,
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
  let usagePlan = "base";
  let best = 0;
  let bestUsagePlan = 0;
  for (const s of r.customer.subscriptions ?? []) {
    if (s.status && s.status !== "active") continue;
    const v = AUTUMN_CONCURRENCY_PRODUCTS[s.plan_id];
    if (v !== undefined && v > best) {
      best = v;
      concurrencyPlan = s.plan_id;
    }
    const usageRank = AUTUMN_USAGE_PLANS[s.plan_id];
    if (usageRank !== undefined && usageRank >= bestUsagePlan) {
      bestUsagePlan = usageRank;
      usagePlan = s.plan_id;
    }
  }

  const at = r.customer.billing_controls?.auto_topups?.find((a) => a.feature_id === "credits");

  // Has the customer charged a top-up? That's when auto-recharge becomes armed,
  // so the UI uses it to tell whether enabling auto-recharge will run a first
  // recharge or just save. Free — the customer is already loaded above.
  const hasToppedUp = (r.customer.purchases ?? []).some((p) => p.plan_id === "top_up");
  const hasPaidSubscription = usagePlan === "pro" || usagePlan === "max";
  const creditBreakdown = summarizeAutumnCreditBalance(r.customer, usagePlan);
  const plan = summarizeWorkMinutePlan(r.customer);
  const billingState = await env.OPENCOMPUTER_DB.prepare(
    "SELECT halt_reason, payment_past_due_at, trial_started_at, max_concurrent_sandboxes FROM orgs WHERE id = ?1",
  ).bind(caller.orgID).first<{
    max_concurrent_sandboxes: number | null;
    halt_reason: string | null;
    payment_past_due_at: number | null;
    trial_started_at: number | null;
  }>();
  const warning = await billingWarning(env, caller.orgID);

  const model = await env.OPENCOMPUTER_DB.prepare(
    `SELECT
       o.model_billing_status AS status,
       o.model_markup_bps AS markup_bps,
       COUNT(CASE WHEN k.status = 'active' THEN 1 END) AS active_key_count,
       MIN(k.created_at) AS billing_started_at,
       COALESCE(SUM(k.committed_micro), 0) AS committed_micro
     FROM orgs o
     LEFT JOIN managed_model_keys k
       ON k.org_id = o.id
      AND k.status IN ('active', 'superseded', 'deleting')
     WHERE o.id = ?1
     GROUP BY o.model_billing_status, o.model_markup_bps`,
  ).bind(caller.orgID).first<{
    status: string;
    markup_bps: number;
    active_key_count: number;
    billing_started_at: number | null;
    committed_micro: number;
  }>();
  const modelStatus = model?.status ?? "off";
  const modelMarkupBps = model?.markup_bps ?? 0;
  const modelProviderSpendCents = Math.round((model?.committed_micro ?? 0) / 10_000);
  const modelBilledCreditsCents = Math.round(modelProviderSpendCents * (1 + modelMarkupBps / 10_000));
  const creditsRemainingCents = Math.max(0, Math.round(r.creditsRemaining * 100));
  const planRemainingCents = Math.min(
    creditsRemainingCents,
    Math.round(creditBreakdown.planRemaining * 100),
  );
  const topupRemainingCents = Math.min(
    creditsRemainingCents - planRemainingCents,
    Math.round(creditBreakdown.topupRemaining * 100),
  );

  return json({
    creditsRemainingCents,
    creditBreakdown: {
      available: creditBreakdown.available,
      planRemainingCents,
      topupRemainingCents,
      otherRemainingCents:
        creditsRemainingCents - planRemainingCents - topupRemainingCents,
      planResetsAt: creditBreakdown.planResetsAt == null
        ? null
        : new Date(creditBreakdown.planResetsAt).toISOString(),
    },
    maxConcurrentSandboxes: billingState?.max_concurrent_sandboxes ?? 0,
    concurrencyPlan,
    usagePlan: plan.usagePlan,
    isHalted: r.halted,
    haltReason: r.haltReason,
    warning,
    paymentPastDueAt: secondsToIso(billingState?.payment_past_due_at),
    trialStartedAt: secondsToIso(billingState?.trial_started_at),
    trialEndsAt: trialEndsAt(billingState?.trial_started_at),
    workMinutes: plan.workMinutes,
    periodEndsAt: plan.periodEndsAt,
    scheduledChange: plan.scheduledChange,
    hasToppedUp,
    hasPaidSubscription,
    autoTopup: at
      ? {
          enabled: at.enabled,
          threshold: at.threshold,
          quantity: at.quantity,
          budget:
            at.purchase_limit?.interval === "month"
              ? at.purchase_limit.limit * at.quantity
              : null,
        }
      : null,
    modelUsage: {
      enabled: modelStatus === "active",
      status: modelStatus,
      markupBps: modelMarkupBps,
      providerSpendCents: modelProviderSpendCents,
      billedCreditsCents: modelBilledCreditsCents,
      activeKeyCount: model?.active_key_count ?? 0,
      billingStartedAt:
        model?.billing_started_at != null
          ? new Date(Number(model.billing_started_at) * 1_000).toISOString()
          : null,
    },
  });
}

function secondsToIso(value: number | null | undefined): string | null {
  return value == null ? null : new Date(value * 1_000).toISOString();
}

// orgs.billing_warning (migration 0015) is written by the billing clock; read
// apart so the page still loads on a database that does not have it yet.
async function billingWarning(env: DashboardEnv, orgID: string): Promise<string | null> {
  try {
    const row = await env.OPENCOMPUTER_DB.prepare("SELECT billing_warning FROM orgs WHERE id = ?1")
      .bind(orgID)
      .first<{ billing_warning: string | null }>();
    return row?.billing_warning ?? null;
  } catch {
    return null;
  }
}

// Where a checkout was opened from (086 funnel); anything else is the Billing page.
const CHECKOUT_FROM = new Set(["paywall", "warning", "billing_page", "signup"]);

// POST /api/dashboard/billing/autumn/plan { plan, from? } — subscribe to or switch
// between the recurring Pro and Max shared-credit plans. Usage remains the
// automatic fallback when a paid subscription is cancelled in Stripe.
async function handleAutumnUsagePlan(req: Request, env: DashboardEnv, caller: { orgID: string; userID?: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let body: { plan?: string; from?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const plan = body.plan ?? "";
  if (plan !== "pro" && plan !== "max") {
    return json({ error: `unknown usage plan '${plan}'` }, 400);
  }
  const origin = new URL(req.url).origin;
  try {
    const current = await env.OPENCOMPUTER_DB.prepare("SELECT usage_plan FROM orgs WHERE id = ?1")
      .bind(caller.orgID)
      .first<{ usage_plan: string | null }>();
    const co = await autumnUsagePlanPurchase(env, {
      customerId: caller.orgID,
      planId: plan,
      successUrl: `${origin}/billing?usage-plan=${plan}`,
      planSchedule: planSchedule(current?.usage_plan === "max" ? "max" : "base", plan),
    });
    await emitBillingEvent(env, "billing.checkout_opened", {
      orgId: caller.orgID,
      userId: caller.userID,
      data: { plan, from: CHECKOUT_FROM.has(body.from ?? "") ? body.from! : "billing_page" },
    });
    return json({ url: co.url });
  } catch (e) {
    console.error("billing/autumn plan:", e);
    return json({ error: (e as Error).message }, 502);
  }
}

// POST /api/dashboard/billing/autumn/cancel { plan, undo? } — cancel the paid
// plan at the end of its period, or (undo) keep it, which also drops a
// scheduled $200 → $20 downgrade.
async function handleAutumnCancel(req: Request, env: DashboardEnv, caller: { orgID: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let body: { plan?: string; undo?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const plan = body.plan ?? "";
  if (plan !== "pro" && plan !== "max") {
    return json({ error: `unknown usage plan '${plan}'` }, 400);
  }
  try {
    await autumnCancelPlan(env, {
      customerId: caller.orgID,
      planId: plan,
      action: body.undo ? "uncancel" : "cancel_end_of_cycle",
    });
    return json({ ok: true });
  } catch (e) {
    console.error("billing/autumn cancel:", e);
    return json({ error: (e as Error).message }, 502);
  }
}

// POST /api/dashboard/billing/autumn/auto-topup
// { enabled, threshold, quantity, budget } — configure automatic credit
// recharge. Monetary values are integer credits ($1 each). Autumn expresses the
// hard monthly budget as a purchase count, so budget must be a whole multiple of
// quantity. A saved payment method is required for charges to succeed.
async function handleAutumnAutoTopup(req: Request, env: DashboardEnv, caller: { orgID: string; userID?: string }): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) return json({ error: "autumn billing not configured" }, 503);
  let body: { enabled?: boolean; threshold?: number; quantity?: number; budget?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const enabled = !!body.enabled;
  const threshold = Math.floor(body.threshold ?? 0);
  const quantity = Math.floor(body.quantity ?? 0);
  const budget = Math.floor(body.budget ?? 0);
  if (
    enabled &&
    (!Number.isFinite(threshold) ||
      threshold < 0 ||
      !Number.isFinite(quantity) ||
      quantity < 1 ||
      !Number.isFinite(budget) ||
      budget < quantity ||
      budget % quantity !== 0)
  ) {
    return json(
      { error: "threshold ≥ 0, quantity ≥ 1, and a monthly budget divisible by quantity are required" },
      400,
    );
  }
  try {
    await autumnSetAutoTopup(env, caller.orgID, { enabled, threshold, quantity, budget });

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
      if (!co.url) await emitCreditsPurchased(env, caller, quantity);
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
async function handleAutumnFinalizeArm(req: Request, env: DashboardEnv, caller: { orgID: string; userID?: string }): Promise<Response> {
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
      await emitCreditsPurchased(env, caller, credits);
    } catch (e) {
      console.error("billing/autumn finalize-arm:", e);
      return Response.redirect(`${billing}?arm=failed`, 302);
    }
  }
  return Response.redirect(`${billing}?arm=ok`, 302);
}

// A manual credit pack is charged here, server-side: directly when a card is on
// file (url null), or in finalize-arm after the hosted card setup. Auto top-ups
// are counted from Autumn's webhook instead.
async function emitCreditsPurchased(env: DashboardEnv, caller: { orgID: string; userID?: string }, credits: number) {
  await emitBillingEvent(env, "billing.credits_purchased", {
    orgId: caller.orgID,
    userId: caller.userID,
    data: { amount: credits, auto: false },
  });
}

// POST /api/dashboard/billing/autumn/topup { credits } — one-off prepaid credit
// purchase. Returns a Stripe checkout URL; success returns to the billing page
// where handleAutumnBilling re-syncs the new balance.
async function handleAutumnTopup(req: Request, env: DashboardEnv, caller: { orgID: string; userID?: string }): Promise<Response> {
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
    if (!co.url) await emitCreditsPurchased(env, caller, credits);
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
