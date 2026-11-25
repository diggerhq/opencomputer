// The Mac app's sign-in (tracks and threads, spec 18.7, 20 and 43): OAuth
// authorization code with PKCE in the system browser, returning to a loopback
// redirect the app listens on for that one sign-in (RFC 8252).
//
//   GET    /auth/app/authorize   cookie; redirects to http://127.0.0.1:<port>/callback?code&state
//   POST   /auth/app/token       form: authorization_code or refresh_token grant
//   GET    /auth/app/devices     cookie or app token: the member's devices
//   DELETE /auth/app/devices/{id}
//
// The access token is the cookie's kind of JWT (HS256, SESSION_JWT_SECRET)
// with its own issuer, so no cookie verifier accepts it, a `dev` claim naming
// the device, and a 15 minute life. The refresh token is stored per device
// (migration 0025) as a hash and rotates on every use.

import { revokeLiveCredential } from "./computer_keys";
import { authDashboard, type DashboardEnv } from "./dashboard";
import type { ManagedAgentsEnv } from "./managed_agents";
import { memberPrincipal, type Principal } from "./principal";

export type AppAuthEnv = Pick<DashboardEnv, "OPENCOMPUTER_DB" | "SESSION_JWT_SECRET"> &
  Pick<ManagedAgentsEnv, "MANAGED_AGENTS_API_URL" | "OC_MANAGED_AGENTS_SECRET">;

export const APP_TOKEN_ISSUER = "opensandbox-app";
export const APP_ACCESS_TTL_SEC = 15 * 60;
const CODE_TTL_SEC = 120;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const DEVICE_NAME_MAX = 100;

const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** OAuth's error shape (RFC 6749 5.2). */
function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

export interface AppTokenClaims {
  iss: string;
  sub: string;
  org_id: string;
  user_id: string;
  dev: string;
  iat: number;
  exp: number;
}

export async function mintAppToken(secret: string, org: string, userId: string, device: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: AppTokenClaims = {
    iss: APP_TOKEN_ISSUER,
    sub: userId,
    org_id: org,
    user_id: userId,
    dev: device,
    iat: now,
    exp: now + APP_ACCESS_TTL_SEC,
  };
  const input =
    b64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))) +
    "." +
    b64url(encoder.encode(JSON.stringify(claims)));
  return `${input}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(input)))}`;
}

/** An app access token's claims; null unless it verifies and has not expired. */
export async function verifyAppToken(secret: string, token: string): Promise<AppTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return null;
  try {
    const signature = Uint8Array.from(atob(parts[2]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as AppTokenClaims;
    if (claims.iss !== APP_TOKEN_ISSUER || typeof claims.dev !== "string") return null;
    if (typeof claims.org_id !== "string" || typeof claims.user_id !== "string") return null;
    if (!(claims.exp > Math.floor(Date.now() / 1000))) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The member's role, `admin` for an owner or admin; null when not a member. */
export async function memberRole(db: D1Database, org: string, userId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2`)
    .bind(org, userId)
    .first<{ role: string }>();
  if (!row) return null;
  return row.role === "owner" || row.role === "admin" ? "admin" : row.role;
}

/**
 * The principal of an app token, checked against D1: the device still exists
 * and its member is still a member. For Live (the HTTP API checks only the
 * signature, so a revoked device keeps its access token up to 15 minutes).
 */
export async function appTokenPrincipal(env: AppAuthEnv, token: string): Promise<Principal | null> {
  const claims = await verifyAppToken(env.SESSION_JWT_SECRET, token);
  if (!claims || !(await appDeviceLive(env.OPENCOMPUTER_DB, claims.dev))) return null;
  const role = await memberRole(env.OPENCOMPUTER_DB, claims.org_id, claims.user_id);
  if (role === null) return null;
  return appPrincipal(claims, role);
}

export function appPrincipal(claims: AppTokenClaims, role: string): Promise<Principal> {
  return memberPrincipal({
    org: claims.org_id,
    userId: claims.user_id,
    admin: role === "admin",
    via: "app",
    credential: { id: claims.dev, expiresAt: claims.exp * 1000 },
  });
}

/** Whether a device (`dev_…`) is still signed in: its row exists and its member is a member. */
export async function appDeviceLive(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM app_devices d
         JOIN org_memberships m ON m.org_id = d.org_id AND m.user_id = d.user_id
        WHERE d.id = ?1`,
    )
    .bind(id)
    .first<{ ok: number }>();
  return row !== null;
}

// ── routes ───────────────────────────────────────────────────────────────

export async function handleAppAuth(
  req: Request,
  env: AppAuthEnv,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  const method = req.method.toUpperCase();
  if (path === "/auth/app/authorize" && method === "GET") return authorize(req, env);
  if (path === "/auth/app/token" && method === "POST") return token(req, env);
  if (path === "/auth/app/devices" && method === "GET") return listDevices(req, env);
  const device = /^\/auth\/app\/devices\/(dev_[A-Za-z0-9_-]{1,64})$/.exec(path);
  if (device && method === "DELETE") return revokeDevice(req, env, ctx, device[1]!);
  return json({ error: "not found" }, 404);
}

async function authorize(req: Request, env: AppAuthEnv): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const redirectURI = q.get("redirect_uri") ?? "";
  const port = LOOPBACK.exec(redirectURI);
  if (!port || Number(port[1]) > 65535) {
    return oauthError("invalid_request", "redirect_uri must be http://127.0.0.1:<port>/callback.");
  }
  // From here a fault goes back to the app, which is waiting on the loopback.
  const back = (params: Record<string, string>): Response => {
    const target = new URL(redirectURI);
    for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
    const state = q.get("state");
    if (state) target.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
  };
  if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) {
    return back({ error: "invalid_request", error_description: "PKCE with S256 is required." });
  }
  const session = await authDashboard(req, env as DashboardEnv);
  if (!session) {
    const login = new URL("/auth/login", url.origin);
    login.searchParams.set("returnTo", `${url.pathname}${url.search}`);
    return new Response(null, { status: 302, headers: { location: login.toString(), "cache-control": "no-store" } });
  }
  if ((await memberRole(env.OPENCOMPUTER_DB, session.orgID, session.userID)) === null) {
    return back({ error: "access_denied" });
  }
  const code = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const name = (q.get("device_name") ?? "").trim().slice(0, DEVICE_NAME_MAX) || "Mac";
  await env.OPENCOMPUTER_DB.batch([
    env.OPENCOMPUTER_DB.prepare(`DELETE FROM app_auth_codes WHERE expires_at < ?1`).bind(now),
    env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO app_auth_codes (code_hash, org_id, user_id, code_challenge, redirect_uri, device_name, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(await sha256Hex(code), session.orgID, session.userID, challenge, redirectURI, name, now + CODE_TTL_SEC),
  ]);
  return back({ code });
}

async function token(req: Request, env: AppAuthEnv): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const field = (name: string): string => {
    const value = form?.get(name);
    return typeof value === "string" ? value : "";
  };
  const grant = field("grant_type");
  const db = env.OPENCOMPUTER_DB;
  const now = Math.floor(Date.now() / 1000);
  if (grant === "authorization_code") {
    const codeHash = await sha256Hex(field("code"));
    const row = await db
      .prepare(`SELECT * FROM app_auth_codes WHERE code_hash = ?1`)
      .bind(codeHash)
      .first<{ org_id: string; user_id: string; code_challenge: string; redirect_uri: string; device_name: string; expires_at: number }>();
    // Single use: whoever deletes the row holds the code.
    const taken = row ? await db.prepare(`DELETE FROM app_auth_codes WHERE code_hash = ?1`).bind(codeHash).run() : null;
    if (!row || !taken || taken.meta.changes !== 1 || row.expires_at < now) {
      return oauthError("invalid_grant", "The code is unknown, used or expired.");
    }
    if (field("redirect_uri") !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match.");
    const verifier = field("code_verifier");
    const challenge = b64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
    if (!CHALLENGE.test(verifier) || challenge !== row.code_challenge) {
      return oauthError("invalid_grant", "code_verifier does not match.");
    }
    if ((await memberRole(db, row.org_id, row.user_id)) === null) return oauthError("invalid_grant", "Not a member.");
    const device = `dev_${randomToken(16)}`;
    const refresh = `ocr_${randomToken()}`;
    await db
      .prepare(
        `INSERT INTO app_devices (id, org_id, user_id, name, refresh_hash, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(device, row.org_id, row.user_id, row.device_name, await sha256Hex(refresh), now)
      .run();
    return issued(env, row.org_id, row.user_id, device, refresh);
  }
  if (grant === "refresh_token") {
    const oldHash = await sha256Hex(field("refresh_token"));
    const row = await db
      .prepare(`SELECT id, org_id, user_id FROM app_devices WHERE refresh_hash = ?1`)
      .bind(oldHash)
      .first<{ id: string; org_id: string; user_id: string }>();
    if (!row || (await memberRole(db, row.org_id, row.user_id)) === null) {
      return oauthError("invalid_grant", "The refresh token is unknown or revoked.");
    }
    const refresh = `ocr_${randomToken()}`;
    const rotated = await db
      .prepare(`UPDATE app_devices SET refresh_hash = ?1, last_used_at = ?2 WHERE id = ?3 AND refresh_hash = ?4`)
      .bind(await sha256Hex(refresh), now, row.id, oldHash)
      .run();
    if (rotated.meta.changes !== 1) return oauthError("invalid_grant", "The refresh token was already used.");
    return issued(env, row.org_id, row.user_id, row.id, refresh);
  }
  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

async function issued(env: AppAuthEnv, org: string, userId: string, device: string, refresh: string): Promise<Response> {
  return json({
    access_token: await mintAppToken(env.SESSION_JWT_SECRET, org, userId, device),
    token_type: "Bearer",
    expires_in: APP_ACCESS_TTL_SEC,
    refresh_token: refresh,
    device_id: device,
  });
}

/** The member a device route acts for: the cookie, or the app's own token. */
async function member(req: Request, env: AppAuthEnv): Promise<{ org: string; userId: string } | null> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    const claims = await verifyAppToken(env.SESSION_JWT_SECRET, bearer);
    return claims ? { org: claims.org_id, userId: claims.user_id } : null;
  }
  // A cookie on an unsafe method only from the edge's own origin.
  if (req.method !== "GET" && req.headers.get("origin") !== new URL(req.url).origin) return null;
  const session = await authDashboard(req, env as DashboardEnv);
  return session ? { org: session.orgID, userId: session.userID } : null;
}

async function listDevices(req: Request, env: AppAuthEnv): Promise<Response> {
  const who = await member(req, env);
  if (!who) return json({ error: "unauthenticated" }, 401);
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, name, created_at, last_used_at FROM app_devices
      WHERE org_id = ?1 AND user_id = ?2 ORDER BY created_at DESC`,
  )
    .bind(who.org, who.userId)
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
  return json({
    devices: results.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: new Date(d.created_at * 1000).toISOString(),
      lastUsedAt: d.last_used_at === null ? null : new Date(d.last_used_at * 1000).toISOString(),
    })),
  });
}

async function revokeDevice(req: Request, env: AppAuthEnv, ctx: ExecutionContext, id: string): Promise<Response> {
  const who = await member(req, env);
  if (!who) return json({ error: "unauthenticated" }, 401);
  const gone = await env.OPENCOMPUTER_DB.prepare(`DELETE FROM app_devices WHERE id = ?1 AND org_id = ?2 AND user_id = ?3`)
    .bind(id, who.org, who.userId)
    .run();
  if (gone.meta.changes !== 1) return json({ error: "not found" }, 404);
  ctx.waitUntil(revokeLiveCredential(env, who.org, id));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
