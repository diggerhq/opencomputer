// The Mac app's sign-in (tracks and threads spec 34.3, 24.3): authorization
// code with PKCE. The app opens `GET /auth/app/authorize` in the system
// browser, where the dashboard's cookie says who is asking; the person
// confirms, and the browser is sent to the app's loopback listener with a
// code. `POST /auth/app/token` exchanges it (and later the refresh token) for
// a 15 minute access token of the same kind as the cookie's JWT. A device is
// one row of `app_devices`; deleting it revokes the app on that Mac.
import { memberId, memberPrincipal, type Principal } from "./principal";

export interface AppAuthEnv {
  OPENCOMPUTER_DB: D1Database;
  SESSION_JWT_SECRET: string;
}

export const APP_TOKEN_TTL_SEC = 15 * 60;
const CODE_TTL_SEC = 60;
const ACCESS_ISSUER = "opencomputer-app";
const CODE_ISSUER = "opencomputer-app-code";
const REDIRECT_URI = /^http:\/\/127\.0\.0\.1:([1-9]\d{1,4})\/callback$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_BODY = 8192;

type AccessClaims = { iss: string; org_id: string; user_id: string; dev: string; iat: number; exp: number };
type CodeClaims = {
  iss: string;
  org_id: string;
  user_id: string;
  jti: string;
  challenge: string;
  redirect_uri: string;
  name: string;
  exp: number;
};

/** Whether a bearer token is shaped like the app's access token (an API key never is). */
export function looksLikeAppToken(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}

export const appCredentialId = (deviceId: string) => `app:${deviceId}`;

export function parseAppCredentialId(id: string): string | null {
  return id.startsWith("app:dev_") ? id.slice(4) : null;
}

export interface AppCaller {
  orgID: string;
  userID: string;
  role: string;
  userName: string | null;
  userEmail: string | null;
  deviceId: string;
  principal: Principal;
}

/**
 * Who an access token is: null when it does not verify, its device was
 * revoked, or the person left the organization. Read from D1 each time, so a
 * revocation holds at once.
 */
export async function authenticateAppToken(token: string, env: AppAuthEnv): Promise<AppCaller | null> {
  const claims = await verify<AccessClaims>(env.SESSION_JWT_SECRET, token, ACCESS_ISSUER);
  if (!claims) return null;
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT m.role, u.name AS user_name, u.email AS user_email
       FROM app_devices d
       JOIN org_memberships m ON m.org_id = d.org_id AND m.user_id = d.user_id
       LEFT JOIN users u ON u.id = d.user_id
      WHERE d.id = ?1 AND d.org_id = ?2 AND d.user_id = ?3`,
  )
    .bind(claims.dev, claims.org_id, claims.user_id)
    .first<{ role: string; user_name: string | null; user_email: string | null }>();
  if (!row) return null;
  const role = row.role === "owner" || row.role === "admin" ? "admin" : row.role;
  return {
    orgID: claims.org_id,
    userID: claims.user_id,
    role,
    userName: row.user_name,
    userEmail: row.user_email,
    deviceId: claims.dev,
    principal: await memberPrincipal({
      org: claims.org_id,
      userId: claims.user_id,
      admin: role === "admin",
      via: "app",
      credential: { id: appCredentialId(claims.dev), expiresAt: claims.exp * 1000 },
    }),
  };
}

/** Whether a device's credential still verifies (Live's check, by id alone). */
export async function appDeviceLive(deviceId: string, env: AppAuthEnv): Promise<boolean> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT 1 AS ok FROM app_devices d
       JOIN org_memberships m ON m.org_id = d.org_id AND m.user_id = d.user_id
      WHERE d.id = ?1`,
  )
    .bind(deviceId)
    .first<{ ok: number }>();
  return row !== null;
}

export interface AppAuthDeps {
  /** The dashboard's cookie session, or null. */
  session(req: Request): Promise<{ orgID: string; userID: string } | null>;
  /** Ends the Live sockets a credential opened. */
  revoke(org: string, credentialId: string): Promise<void>;
  waitUntil(p: Promise<unknown>): void;
}

/** Every route under `/auth/app/`. */
export async function handleAppAuth(req: Request, env: AppAuthEnv, path: string, deps: AppAuthDeps): Promise<Response> {
  if (path === "/auth/app/authorize") {
    if (req.method === "GET" || req.method === "POST") return authorize(req, env, deps);
    return oauthError(405, "invalid_request", "GET or POST");
  }
  if (path === "/auth/app/token") {
    if (req.method === "POST") return token(req, env);
    return oauthError(405, "invalid_request", "POST");
  }
  if (path === "/auth/app/devices") {
    if (req.method === "GET") return listDevices(req, env, deps);
    return oauthError(405, "invalid_request", "GET");
  }
  const device = /^\/auth\/app\/devices\/(dev_[a-f0-9]{24})$/.exec(path);
  if (device && req.method === "DELETE") return deleteDevice(req, env, deps, device[1]!);
  return oauthError(404, "invalid_request", "No such route.");
}

async function authorize(req: Request, env: AppAuthEnv, deps: AppAuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const redirectUri = q.get("redirect_uri") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  const state = q.get("state") ?? "";
  const name = (q.get("device_name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "Mac";
  const port = Number(REDIRECT_URI.exec(redirectUri)?.[1] ?? 0);
  // Nothing is sent to a redirect address that is not the app's own listener.
  if (port < 1024 || port > 65535) return page(400, "Sign-in could not start", "The app's address is not valid. Start the sign-in again from the app.");
  if (
    q.get("code_challenge_method") !== "S256" ||
    !CHALLENGE.test(challenge) ||
    state.length < 8 ||
    state.length > 512
  ) {
    return page(400, "Sign-in could not start", "The request from the app is not valid. Start the sign-in again from the app.");
  }

  const session = await deps.session(req);
  if (!session) {
    const login = new URL("/auth/login", url.origin);
    login.searchParams.set("returnTo", url.pathname + url.search);
    return Response.redirect(login.toString(), 302);
  }
  const who = await env.OPENCOMPUTER_DB.prepare(
    `SELECT u.email, u.name, o.name AS org_name
       FROM org_memberships m JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ?1 AND m.user_id = ?2`,
  )
    .bind(session.orgID, session.userID)
    .first<{ email: string | null; name: string | null; org_name: string | null }>();
  if (!who) return page(403, "Sign-in could not start", "This account is not a member of the organization. Sign in to the dashboard again.");

  if (req.method === "GET") {
    return page(
      200,
      "Sign in to the OpenComputer app",
      `The OpenComputer app on <b>${esc(name)}</b> is asking to sign in as <b>${esc(who.email ?? who.name ?? "you")}</b> in <b>${esc(who.org_name ?? "your organization")}</b>.`,
      `<form method="post" action="${esc(url.pathname + url.search)}"><button type="submit">Continue</button></form>
       <p class="quiet">If you did not start this from the app, close this page.</p>`,
    );
  }

  // The confirmation. The cookie is SameSite=Lax, so it does not ride a POST
  // from another site; the Origin is checked as well.
  if (req.headers.get("origin") !== url.origin) return page(403, "Sign-in could not start", "Start the sign-in again from the app.");
  const now = Math.floor(Date.now() / 1000);
  const code = await sign<CodeClaims>(env.SESSION_JWT_SECRET, {
    iss: CODE_ISSUER,
    org_id: session.orgID,
    user_id: session.userID,
    jti: randomHex(16),
    challenge,
    redirect_uri: redirectUri,
    name,
    exp: now + CODE_TTL_SEC,
  });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", state);
  return new Response(null, { status: 303, headers: { location: back.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

async function token(req: Request, env: AppAuthEnv): Promise<Response> {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return oauthError(400, "invalid_request", "The body is too large.");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!body) return oauthError(400, "invalid_request", "The body is a JSON object.");
  const str = (k: string) => (typeof body![k] === "string" ? (body![k] as string) : "");
  const now = Math.floor(Date.now() / 1000);

  if (body.grant_type === "authorization_code") {
    const claims = await verify<CodeClaims>(env.SESSION_JWT_SECRET, str("code"), CODE_ISSUER);
    const verifier = str("code_verifier");
    if (
      !claims ||
      claims.redirect_uri !== str("redirect_uri") ||
      !VERIFIER.test(verifier) ||
      (await sha256b64url(verifier)) !== claims.challenge
    ) {
      return oauthError(400, "invalid_grant", "The code is not valid.");
    }
    const member = await env.OPENCOMPUTER_DB.prepare(
      `SELECT 1 AS ok FROM org_memberships WHERE org_id = ?1 AND user_id = ?2`,
    )
      .bind(claims.org_id, claims.user_id)
      .first<{ ok: number }>();
    if (!member) return oauthError(400, "invalid_grant", "The code is not valid.");
    const deviceId = `dev_${randomHex(12)}`;
    const refresh = `ocr_${randomHex(32)}`;
    try {
      await env.OPENCOMPUTER_DB.prepare(
        `INSERT INTO app_devices (id, org_id, user_id, name, refresh_hash, code_id, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      )
        .bind(deviceId, claims.org_id, claims.user_id, claims.name, await sha256hex(refresh), claims.jti, now)
        .run();
    } catch {
      // code_id is unique: the code was spent already.
      return oauthError(400, "invalid_grant", "The code is not valid.");
    }
    return tokenReply(env, claims.org_id, claims.user_id, deviceId, refresh);
  }

  if (body.grant_type === "refresh_token") {
    const refresh = str("refresh_token");
    if (!refresh.startsWith("ocr_")) return oauthError(400, "invalid_grant", "The refresh token is not valid.");
    // The refresh token is not rotated: a reply lost on the way would sign the
    // device out. It ends when the device is revoked.
    const row = await env.OPENCOMPUTER_DB.prepare(
      `UPDATE app_devices SET last_used_at = ?2
        WHERE refresh_hash = ?1
          AND EXISTS (SELECT 1 FROM org_memberships m
                       WHERE m.org_id = app_devices.org_id AND m.user_id = app_devices.user_id)
        RETURNING id, org_id, user_id`,
    )
      .bind(await sha256hex(refresh), now)
      .first<{ id: string; org_id: string; user_id: string }>();
    if (!row) return oauthError(400, "invalid_grant", "The refresh token is not valid.");
    return tokenReply(env, row.org_id, row.user_id, row.id, null);
  }

  return oauthError(400, "unsupported_grant_type", "authorization_code or refresh_token");
}

async function tokenReply(env: AppAuthEnv, org: string, userId: string, deviceId: string, refresh: string | null): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const access = await sign<AccessClaims>(env.SESSION_JWT_SECRET, {
    iss: ACCESS_ISSUER,
    org_id: org,
    user_id: userId,
    dev: deviceId,
    iat: now,
    exp: now + APP_TOKEN_TTL_SEC,
  });
  return jsonReply(200, {
    token_type: "Bearer",
    access_token: access,
    expires_in: APP_TOKEN_TTL_SEC,
    ...(refresh ? { refresh_token: refresh } : {}),
    device_id: deviceId,
    principal: { org, subject: await memberId(userId) },
  });
}

/** The member asking, by the app's token or by the dashboard's cookie. */
async function member(req: Request, env: AppAuthEnv, deps: AppAuthDeps): Promise<{ orgID: string; userID: string } | null> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  if (bearer) return authenticateAppToken(bearer, env);
  const session = await deps.session(req);
  if (!session) return null;
  // The cookie is ambient: a write needs the dashboard's own Origin.
  if (req.method !== "GET" && req.headers.get("origin") !== new URL(req.url).origin) return null;
  return session;
}

async function listDevices(req: Request, env: AppAuthEnv, deps: AppAuthDeps): Promise<Response> {
  const who = await member(req, env, deps);
  if (!who) return oauthError(401, "invalid_token", "Sign in again.");
  const rows = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, name, created_at, last_used_at FROM app_devices
      WHERE org_id = ?1 AND user_id = ?2 ORDER BY last_used_at DESC`,
  )
    .bind(who.orgID, who.userID)
    .all<{ id: string; name: string; created_at: number; last_used_at: number }>();
  return jsonReply(200, {
    devices: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at * 1000).toISOString(),
      lastUsedAt: new Date(r.last_used_at * 1000).toISOString(),
    })),
  });
}

async function deleteDevice(req: Request, env: AppAuthEnv, deps: AppAuthDeps, id: string): Promise<Response> {
  const who = await member(req, env, deps);
  if (!who) return oauthError(401, "invalid_token", "Sign in again.");
  const gone = await env.OPENCOMPUTER_DB.prepare(
    `DELETE FROM app_devices WHERE id = ?1 AND org_id = ?2 AND user_id = ?3 RETURNING id`,
  )
    .bind(id, who.orgID, who.userID)
    .first<{ id: string }>();
  if (gone) deps.waitUntil(deps.revoke(who.orgID, appCredentialId(id)).catch(() => {}));
  return new Response(null, { status: 204 });
}

// ── Tokens: HS256 under the session secret, told apart by issuer ──

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign<T extends object>(secret: string, payload: T): Promise<string> {
  const input = `${b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  return `${input}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(input)))}`;
}

async function verify<T extends { iss: string; exp: number }>(secret: string, token: string, issuer: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 4096) return null;
  try {
    const sig = Uint8Array.from(atob(parts[2]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${parts[0]}.${parts[1]}`)))) return null;
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as T;
    if (payload.iss !== issuer || !(payload.exp > Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

// ── Replies ──

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function oauthError(status: number, error: string, description: string): Response {
  return jsonReply(status, { error, error_description: description });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(status: number, title: string, lead: string, more = ""): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; color: #1a1a1a; background: #fafaf9; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  main { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  button { font: inherit; font-weight: 600; color: #fff; background: #1a1a1a; border: 0; border-radius: 8px; padding: .6rem 1.25rem; margin-top: 1rem; cursor: pointer; }
  .quiet { color: #777; font-size: 13px; margin-top: 1.5rem; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #161616; } button { color: #161616; background: #eee; } }
</style>
<main><h1>${esc(title)}</h1><p>${lead}</p>${more}</main></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
