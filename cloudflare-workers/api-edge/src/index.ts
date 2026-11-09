// api-edge Worker — global API entry point.
//
// Implemented:
//   GET  /auth/login           — kicks off WorkOS Authkit flow
//   GET  /auth/callback        — WorkOS code exchange → upsert user/org → session JWT cookie
//   POST /auth/logout          — clear session cookie
//   POST /auth/refresh         — rotate session JWT (extends expiry)
//   POST /auth/cli/device      — begin WorkOS device authorization for `oc login`
//   POST /auth/cli/device/exchange — poll device authorization → one ordinary org key
//   DELETE /auth/cli/credential — revoke the exact CLI-presented org key
//   POST /webhooks/stripe      — Stripe webhook → DO /mark-pro or /mark-free
//   ANY  /api/managed-agents/* — managed agents, behind the credit gate
//   ANY  /api/dashboard/*      — dashboard API (dashboard.ts)
//   GET  /health
//
// The sandbox API (/api/sandboxes, snapshots, preview hosts, the cell proxy,
// the edge pool and the VM-DO bindings) was removed in 097 step 7.2.

export { CreditAccount } from "../../shared/credit_account";
export { PoolStock } from "./pool_stock";
import { coloDelete, coloGet, coloPut } from "./colo_cache";
import { authDashboard, handleDashboard, type DashboardEnv } from "./dashboard";
import { handleAgentFeedback, isAgentFeedbackPath, type AgentFeedbackEnv } from "./agent_feedback";
import {
  autumnWebhook,
  autumnProjectInternal,
  autumnSetProviderInternal,
  agentRuntimeUsageInternal,
  browserUsageInternal,
  selfHealHalt,
  createAutumnCustomer,
} from "./autumn_webhook";
import { runAutumnMeter } from "./autumn_meter";
import { runBillingClock } from "./billing_clock";
import { runSlackConnectInvites } from "./slack_connect";
import { runActivationAlerts } from "./slack_alerts";
import { disableManagedBilling, enableManagedBilling } from "./model_billing";
import { runModelMeter, syncModelCaps } from "./model_meter";
import {
  enforceManagedAgentCreditGate,
} from "./managed_agent_credit_gate";
import {
  emitPaywallShown,
  handleCreditsStatus,
  insufficientCreditsResponse,
  paywallContext,
} from "./billing_onramp";
export { ManagedAgentBillingService } from "./managed_agent_billing_service";
import { runRetentionSweep } from "./retention";
import { createAPIKey, createAPIKeyWithHash, hashAPIKey } from "./api_keys";
import { envWithD1Retry } from "./d1_retry";
import {
  handleAgentWebhookInvocation,
  handleManagedGitHubCallback,
  handleManagedGitHubWebhook,
  handleManagedSlackCallback,
  handleManagedLinearCallback,
  handleComputerSlackCallback,
  handleComputerSlackWebhook,
  handleComputerAgentConnect,
  handleManagedAgentChannelConnection,
  proxyManagedAgents,
  type AssertedAPIKey,
} from "./managed_agents";
import {
  computerApiError,
  computerApiKey,
  computerApiOriginAllowed,
  computerApiPreflight,
  computerWorkspaceRoute,
  isComputerApiRoute,
  proxyComputerWorkspace,
  withComputerApiCors,
  COMPUTER_API_PREFIX,
} from "./computer_api";
import { emitBillingEvent, type BillingEventsEnv } from "./billing_events";
import { sendLoopsEvent, type LoopsEnv } from "./loops";
import {
  type EdgeRequestFacts,
  newEdgeRequestFacts,
  reportEdgeRequest,
} from "./computer_telemetry";
import { computerEnabledFor } from "./computer";
import { createdKeyForSync, revokeComputerKey, syncComputerKey } from "./computer_keys";
import { FIRST_TOUCH_COOKIE, readCookie, recordSignupAttribution, withFirstTouchCookie } from "./signup_attribution";

export interface Env extends DashboardEnv, AgentFeedbackEnv, BillingEventsEnv, LoopsEnv {
  CF_ADMIN_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
  EVENT_SECRET: string;
  // Coarse distributed abuse limits for the two unauthenticated WorkOS device
  // endpoints. These are separate because one login normally polls exchange
  // several times after a single start request.
  CLI_AUTH_START_RATE_LIMIT: RateLimit;
  CLI_AUTH_EXCHANGE_RATE_LIMIT: RateLimit;
  // Public CLI connect (work 082), per caller IP ahead of blue.
  COMPUTER_CONNECT_RATE_LIMIT?: RateLimit;
  // The computer API (work 084): HTTP calls per API key, ahead of blue.
  COMPUTER_API_RATE_LIMIT?: RateLimit;
  // The computer API (work 084): the wire Worker's HTTP base for workspace
  // files (default https://wire.opencomputer.dev), and extra browser origins
  // allowed to call /api/managed-agents/computer/* (comma-separated; the
  // edge's own origin is always allowed).
  WIRE_HTTP_URL?: string;
  COMPUTER_API_CORS_ORIGINS?: string;
  // Autumn (useautumn.com) billing. AUTUMN_WEBHOOK_SECRET is the Svix signing
  // secret (whsec_…) for /webhooks/autumn. AUTUMN_SECRET_KEY / AUTUMN_BASE_URL
  // are inherited from DashboardEnv. Unset on deployments not yet on Autumn.
  AUTUMN_WEBHOOK_SECRET: string;
  // HMAC secret used by Browser API to submit runtime usage. Falls back to
  // EVENT_SECRET in the handler when unset for compatibility during rollout.
  BROWSER_USAGE_HMAC_SECRET?: string;
  // Dedicated HMAC secret for finalized managed-agent runtime segments.
  AGENT_RUNTIME_USAGE_HMAC_SECRET?: string;
  ASSETS?: Fetcher;
  // Slack Connect per signup (slack_connect.ts), sent by the OpenComputer
  // Slack app: dormant unless the token
  // and SINCE (unix seconds) are set.
  SLACK_CONNECT_TOKEN?: string;
  SLACK_CONNECT_SINCE?: string;
  SLACK_CONNECT_TEAM_USER_IDS?: string;
  SLACK_CONNECT_BATCH?: string;
  // Token / model-usage billing (token-billing.md). The edge holds ONE OpenRouter
  // secret — a management/provisioning key — and mints per-org inference keys.
  OPENROUTER_PROVISIONING_KEY: string;
  OPENROUTER_BASE_URL?: string; // default https://openrouter.ai/api/v1
  OPENROUTER_MARKUP_BPS?: string; // env-default markup (bps) when the org's is 0
  // DEDICATED HMAC secret for handing a freshly-minted OR key to the managed
  // agents backend (blue) (NOT the generic internal-auth — this route carries a
  // live model key). §6.7.5.
  OC_MANAGED_CRED_HMAC_SECRET: string;
}

// ── small helpers ────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Cache the imported HMAC signing key used to sign session JWTs. Memoized per
// secret (shared Promise so concurrent first-callers don't double-import), so
// only sign() runs per mint. importKey is extractable:false, so the key never
// leaves the isolate.
let hmacSignKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;
function hmacSignKey(secret: string): Promise<CryptoKey> {
  if (hmacSignKeyCache && hmacSignKeyCache.secret === secret) return hmacSignKeyCache.key;
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  hmacSignKeyCache = { secret, key };
  return key;
}

interface Caller {
  orgID: string;
  userID: string | null;
  role?: string;
  // Set only for the organization's computer (work 080): its one-hour keys are
  // created_by COMPUTER_PRINCIPAL, a reserved id no person has. sessionKey is
  // the Slack thread the key was minted for, when the gateway named one.
  principal?: "computer";
  sessionKey?: string;
  // The key itself, for the computer API's assertion (work 084): blue records
  // which key acted. Absent on entries cached before these fields existed (the
  // computer path re-reads those).
  key?: AssertedAPIKey;
  userName?: string | null;
  userEmail?: string | null;
}

const COMPUTER_PRINCIPAL = "computer";
// The shape of blue's sessionKey(team, channel, thread); blue checks the
// session is live before it asks for a key.
const SESSION_KEY_RE = /^[A-Za-z0-9._-]{1,40}:[A-Za-z0-9._-]{1,40}:[A-Za-z0-9._-]{1,40}$/;

// One mapping from a key row to a Caller, for every reader (auth, refresh,
// warm-org), so the cached shapes cannot drift apart.
function callerFromRow(row: AuthRow): Caller {
  const computer = row.created_by === COMPUTER_PRINCIPAL;
  return {
    orgID: row.org_id,
    userID: row.created_by,
    ...(row.role ? { role: row.role } : {}),
    ...(computer ? { principal: "computer" as const } : {}),
    ...(computer && row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.key_id && row.key_hash
      ? {
          key: {
            id: row.key_id,
            hash: row.key_hash,
            name: row.key_name ?? "",
            // api_keys has no project keys: every key belongs to its creator.
            kind: "user" as const,
            scopes: (row.key_scopes ?? "")
              .split(",")
              .map((scope) => scope.trim())
              .filter(Boolean),
            expiresAt: epochToISO(row.expires_at),
            createdAt: epochToISO(row.key_created_at) ?? new Date(0).toISOString(),
          },
          userName: row.user_name ?? null,
          userEmail: row.user_email ?? null,
        }
      : {}),
  };
}

function epochToISO(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function apiKeyFromRequest(req: Request): string | null {
  const headerKey = req.headers.get("X-API-Key");
  if (headerKey) return headerKey;

  // Browser WebSocket clients cannot set custom headers, so SDK attach uses
  // `?api_key=`. Keep this limited to Upgrade requests to avoid normalizing
  // query-string credentials across the whole HTTP API.
  if (isWebSocketUpgrade(req)) {
    return new URL(req.url).searchParams.get("api_key");
  }
  return null;
}

// Authenticate via X-API-Key (looked up by sha256 in D1 api_keys). For
// WebSocket Upgrade requests, also accept ?api_key= because browser WS APIs
// cannot set custom headers. Session-JWT auth (browser flows) is a TODO;
// SDK/test traffic uses the API key.
// --- Per-isolate auth + org-policy caches (burst D1 relief) ------------------
// Every request authenticates with a D1 SELECT on api_keys, create additionally
// reads the org policy (D1 SELECT on orgs), and auth fired a same-row last_used
// write per request. A burst from ONE key => hundreds of concurrent D1 ops that
// serialize on D1's single writer, stalling requests at the edge while the
// backend sits idle. Cache the (stable) key->org auth and the org policy
// per-isolate for a few seconds so a burst collapses to a handful of D1 reads,
// and throttle the last_used bump. Isolates recycle so entries are naturally
// bounded; CACHE_MAX guards pathological key cardinality.
const AUTH_TTL_MS = 60_000;
// SWR window for the auth entry: a cold miss serves a stale value and refreshes
// behind the response instead of paying a blocking D1 read before the orgID is
// even known. (It was added for the sandbox create path, measured on dev
// 2026-08-25 at 26-49ms of `auth` on cold isolates; that path is gone since 097
// step 7.2, but every authenticated route still benefits.)
//
// What this widens: revocation lag for a key deleted out of band goes from
// AUTH_TTL_MS to AUTH_STALE_MAX_MS in the worst case — but only until the
// background refresh lands (~one D1 read), because that refresh EVICTS both
// tiers when the row is gone. Ordinary expiry is unaffected: expires_at travels
// with the cached entry and is still checked inline on every request, stale or
// not, so an expired key is rejected at the same instant it was before.
const AUTH_STALE_MAX_MS = 600_000; // 10 min
const LAST_USED_BUMP_MS = 60_000; // at most once/min/key/isolate
const CACHE_MAX = 10_000;

interface AuthEntry {
  caller: Caller;
  expiresAt: number | null;
  cachedAtMs: number;
  lastBumpMs: number;
}
const authCache = new Map<string, AuthEntry>();
function bumpLastUsed(env: Env, hash: string, entry: AuthEntry, nowMs: number): void {
  if (nowMs - entry.lastBumpMs < LAST_USED_BUMP_MS) return;
  entry.lastBumpMs = nowMs;
  env.OPENCOMPUTER_DB.prepare("UPDATE api_keys SET last_used = ?1 WHERE key_hash = ?2")
    .bind(Math.floor(nowMs / 1000), hash)
    .run()
    .catch(() => {});
}

const AUTH_KEY_SQL = `SELECT k.org_id, k.created_by, k.expires_at, k.session_key,
          k.id AS key_id, k.key_hash, k.name AS key_name, k.scopes AS key_scopes,
          k.created_at AS key_created_at, u.name AS user_name, u.email AS user_email,
          CASE WHEN m.role IN ('owner', 'admin') THEN 'admin' ELSE m.role END AS role
     FROM api_keys k
     LEFT JOIN org_memberships m
       ON m.org_id = k.org_id AND m.user_id = k.created_by
     LEFT JOIN users u ON u.id = k.created_by
    WHERE k.key_hash = ?1`;

// One row shape for both readers. refreshAuth repopulates the same cache tiers
// the hot path reads, so a role column present in one and absent in the other
// would drop an admin to member on the first background refresh.
type AuthRow = {
  org_id: string;
  created_by: string | null;
  expires_at: number | null;
  role: string | null;
  session_key?: string | null;
  key_id?: string | null;
  key_hash?: string | null;
  key_name?: string | null;
  key_scopes?: string | null;
  key_created_at?: number | null;
  user_name?: string | null;
  user_email?: string | null;
};

// In-flight auth refreshes, keyed by hash — same single-flight shape as
// createContextInflight and for the same reason: a burst that all lands stale
// would otherwise fire one D1 read per request, which is precisely the
// stampede the cache tiers exist to prevent.
const authRefreshInflight = new Map<string, Promise<void>>();

// refreshAuth re-reads the key row and repopulates both cache tiers. It runs
// BEHIND a response that was already served from a stale entry, so its latency
// is off the hot path; what matters is that it is authoritative — including
// when the row is gone, where it evicts rather than leaving a revoked key
// working until its TTL expires.
function refreshAuth(env: Env, hash: string): Promise<void> {
  const inflight = authRefreshInflight.get(hash);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const row = await env.OPENCOMPUTER_DB.prepare(AUTH_KEY_SQL)
        .bind(hash)
        .first<AuthRow>();
      if (!row) {
        authCache.delete(hash);
        await coloDelete("auth", hash);
        return;
      }
      const at = Date.now();
      const caller = callerFromRow(row);
      if (authCache.size >= CACHE_MAX) authCache.clear();
      authCache.set(hash, {
        caller,
        expiresAt: row.expires_at,
        cachedAtMs: at,
        lastBumpMs: authCache.get(hash)?.lastBumpMs ?? 0,
      });
      await coloPut("auth", hash, { caller, expiresAt: row.expires_at, cachedAtMs: at }, AUTH_STALE_MAX_MS / 1000);
    } catch {
      // Keep serving the stale entry; the next request retries. Failing closed
      // here would turn a transient D1 blip into a 401 storm.
    } finally {
      authRefreshInflight.delete(hash);
    }
  })();
  authRefreshInflight.set(hash, p);
  return p;
}

// Which tier answered auth, and what the slow parts cost. `auth` is one mark
// over four possible paths (isolate, colo, stale, D1) and a 226ms reading does
// not say which — the same ambiguity that made `ctx` unfixable until it was
// split. tier: 0 isolate, 1 colo, 2 stale, 3 D1.
export interface AuthProbe {
  tier: number;
  coloMs: number;
  d1Ms: number;
  hashMs: number;
}

async function authenticate(req: Request, env: Env, ctx?: ExecutionContext, probe?: AuthProbe): Promise<Caller | null> {
  const apiKey = apiKeyFromRequest(req);
  if (!apiKey) return null;
  return authenticateKey(apiKey, env, ctx, probe);
}

async function authenticateKey(apiKey: string, env: Env, ctx?: ExecutionContext, probe?: AuthProbe): Promise<Caller | null> {
  const tHash = Date.now();
  const hash = await hashAPIKey(apiKey);
  if (probe) probe.hashMs = Date.now() - tHash;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const cached = authCache.get(hash);
  if (cached && nowMs - cached.cachedAtMs < AUTH_TTL_MS) {
    if (cached.expiresAt && cached.expiresAt < nowSec) return null;
    if (probe) probe.tier = 0;
    bumpLastUsed(env, hash, cached, nowMs);
    return cached.caller;
  }

  // Colo tier: a fresh box's sub-ops usually land on isolates that never saw
  // this key. cachedAtMs travels with the entry so the total staleness bound
  // (revocation lag) stays AUTH_TTL_MS, not colo-TTL + isolate-TTL stacked.
  const tColo = Date.now();
  const shared = await coloGet<{ caller: Caller; expiresAt: number | null; cachedAtMs: number }>("auth", hash);
  if (probe) probe.coloMs = Date.now() - tColo;
  if (shared && nowMs - shared.cachedAtMs < AUTH_TTL_MS) {
    if (probe) probe.tier = 1;
    if (shared.expiresAt && shared.expiresAt < nowSec) return null;
    if (authCache.size >= CACHE_MAX) authCache.clear();
    const entry: AuthEntry = { caller: shared.caller, expiresAt: shared.expiresAt, cachedAtMs: shared.cachedAtMs, lastBumpMs: 0 };
    authCache.set(hash, entry);
    bumpLastUsed(env, hash, entry, nowMs);
    return shared.caller;
  }

  // Stale-while-revalidate. Take the FRESHEST stale copy either tier holds —
  // the isolate entry can outlive the colo entry or vice versa, and using the
  // older of the two would shorten the window for no benefit. Serving it costs
  // nothing; the refresh behind it is what keeps the entry honest.
  const staleShared = shared && nowMs - shared.cachedAtMs < AUTH_STALE_MAX_MS ? shared : null;
  const staleLocal = cached && nowMs - cached.cachedAtMs < AUTH_STALE_MAX_MS ? cached : null;
  const stale =
    staleShared && (!staleLocal || staleShared.cachedAtMs > staleLocal.cachedAtMs) ? staleShared : staleLocal;
  if (stale) {
    // Expiry is still enforced inline, exactly as on the fresh paths — the
    // stale window widens revocation lag, never expiry.
    if (stale.expiresAt && stale.expiresAt < nowSec) return null;
    if (authCache.size >= CACHE_MAX) authCache.clear();
    const entry: AuthEntry = {
      caller: stale.caller,
      expiresAt: stale.expiresAt,
      cachedAtMs: stale.cachedAtMs,
      lastBumpMs: cached?.lastBumpMs ?? 0,
    };
    authCache.set(hash, entry);
    if (probe) probe.tier = 2;
    const refresh = refreshAuth(env, hash);
    if (ctx) ctx.waitUntil(refresh);
    bumpLastUsed(env, hash, entry, nowMs);
    return stale.caller;
  }

  const tD1 = Date.now();
  const row = await env.OPENCOMPUTER_DB.prepare(AUTH_KEY_SQL)
    .bind(hash)
    .first<AuthRow>();
  if (probe) {
    probe.tier = 3;
    probe.d1Ms = Date.now() - tD1;
  }
  if (!row) return null; // never cache negatives — a freshly-created key must work at once
  if (row.expires_at && row.expires_at < nowSec) return null;

  const caller = callerFromRow(row);
  if (authCache.size >= CACHE_MAX) authCache.clear();
  const entry: AuthEntry = { caller, expiresAt: row.expires_at, cachedAtMs: nowMs, lastBumpMs: 0 };
  authCache.set(hash, entry);
  // TTL is the STALE bound, not AUTH_TTL_MS: an entry that evaporates at 60s
  // can never be stale-served, which would leave the SWR branch above reachable
  // only from the isolate tier — i.e. never on the cross-isolate misses that
  // are the whole reason the colo tier exists.
  await coloPut("auth", hash, { caller, expiresAt: row.expires_at, cachedAtMs: nowMs }, AUTH_STALE_MAX_MS / 1000);
  bumpLastUsed(env, hash, entry, nowMs);
  return caller;
}

// The 402 for a halted Autumn org, so its message fits the org: a work-minute
// halt names its reason and links Billing; on the credit rule, free gets the
// paywall, legacy $20 Pro the upgrade to Pro, $200 Pro no upsell. Counted as
// billing.paywall_shown. Only read on the (rare) halted path, after the
// self-heal re-projected the row; any failure falls back to the paywall.
async function haltedOrgResponse(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  orgID: string,
): Promise<Response> {
  const paywall = await paywallContext(env.OPENCOMPUTER_DB, orgID);
  ctx.waitUntil(emitPaywallShown(env, orgID, paywall.haltReason));
  // Structured body only: the string-`error` flavour served the sandbox routes,
  // removed in 097 step 7.2.
  return insufficientCreditsResponse(req, paywall);
}

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

// ── WorkOS auth flow ─────────────────────────────────────────────────────
//
// Browser flow:
//   GET /auth/login           → 302 to WorkOS AuthKit authorization URL
//   GET /auth/callback?code=  → exchange code, upsert user+org in D1, mint
//                                session JWT, set cookie, redirect to /dashboard
//   POST /auth/logout         → clear session cookie
//   POST /auth/refresh        → rotate session JWT (extends expiry)
//
// Session JWT lives in an httpOnly Secure SameSite=Lax cookie named
// `oc_session`, signed with SESSION_JWT_SECRET under Issuer
// "opensandbox-session" (the issuer string is kept so existing sessions stay
// valid).

const SESSION_COOKIE = "oc_session";
const SESSION_TTL_SEC = 60 * 60 * 8; // 8h

interface WorkOSProfile {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  organization_id?: string;
}

interface ProvisionedIdentity {
  user: {
    id: string;
    email: string;
    name: string;
  };
  org: {
    id: string;
    name: string;
    plan: string;
  };
  /**
   * True when this login is part of a signup: it created the user row, or the
   * row is younger than SIGNUP_RETRY_WINDOW_SEC (a signup whose first callback
   * failed after the insert and was retried). Attribution writes are
   * idempotent, so a repeat inside the window records nothing new.
   */
  created: boolean;
}

type IdentitySelection = "browser" | "cli";

// A signup whose callback failed after inserting the user is retried at once
// (authCallback restarts the login); within this window it still counts as
// the signup for attribution.
const SIGNUP_RETRY_WINDOW_SEC = 60 * 60;

// A post-login destination is only honored if it is a same-origin PATH: it must
// start with a single "/", carry no host (no "//" protocol-relative form) and no
// backslash tricks. Tampering with the WorkOS `state` can then at most pick a
// different page on our own origin, so the value needs no signing. Anything else
// → null and the caller falls back to /dashboard.
//
// The 4096 cap is sized to comfortably fit an encoded /do?action=<envelope> for
// the 1000-char prompt limit (web/src/lib/deferred-actions.ts) through the
// WorkOS `state` round-trip — keep the two limits in sync. WorkOS documents no
// `state` maximum, so we bound it here rather than rely on a large round-trip.
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  // Reject ASCII control chars: a CR/LF surviving URL-decoding would corrupt or
  // inject into the callback's Location header (or throw a 500).
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

async function authLogin(req: Request, env: Env): Promise<Response> {
  const reqURL = new URL(req.url);
  const redirectURI = `${reqURL.origin}/auth/callback`;
  // WorkOS AuthKit hosted login URL. authorize_url uses provider=authkit
  // for the "magic-link or oauth" hosted page.
  const authURL = new URL("https://api.workos.com/user_management/authorize");
  authURL.searchParams.set("client_id", env.WORKOS_CLIENT_ID);
  authURL.searchParams.set("provider", "authkit");
  authURL.searchParams.set("redirect_uri", redirectURI);
  authURL.searchParams.set("response_type", "code");
  // Deferred deep link: carry the originally-requested path through WorkOS via
  // the OAuth `state` param so the callback can land the user back on it (incl.
  // a /do?action=… deferred action). Only same-origin paths survive validation.
  const returnTo = safeReturnTo(reqURL.searchParams.get("returnTo"));
  // `retried` marks a login restarted by a failed callback; it rides `state` so
  // the callback restarts at most once instead of looping on a WorkOS session.
  const retried = reqURL.searchParams.get("retried") === "1";
  if (returnTo || retried) {
    authURL.searchParams.set("state", JSON.stringify({ ...(returnTo ? { returnTo } : {}), ...(retried ? { retried: true } : {}) }));
  }
  return Response.redirect(authURL.toString(), 302);
}

/**
 * Converts every pending, unexpired invitation addressed to `email` into an
 * org membership. Returns the most recently invited org's id (if any) so the
 * login can land the user in the team they were invited to.
 */
export async function acceptPendingInvitations(
  env: Pick<Env, "OPENCOMPUTER_DB">,
  userID: string,
  email: string,
  nowSec: number,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, org_id, role FROM invitations
      WHERE lower(email) = ?1 AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > ?2)
      ORDER BY created_at DESC`,
  )
    .bind(normalized, nowSec)
    .all<{ id: string; org_id: string; role: string }>();
  const pending = results ?? [];
  if (pending.length === 0) return null;

  const statements: D1PreparedStatement[] = [];
  for (const inv of pending) {
    const role = ["owner", "admin", "member"].includes(inv.role) ? inv.role : "member";
    statements.push(
      env.OPENCOMPUTER_DB.prepare(
        `INSERT INTO org_memberships (org_id, user_id, role, created_at)
         SELECT ?1, ?2, ?3, ?4 FROM invitations WHERE id = ?5 AND status = 'pending'
         ON CONFLICT(org_id, user_id) DO NOTHING`,
      ).bind(inv.org_id, userID, role, nowSec, inv.id),
      env.OPENCOMPUTER_DB.prepare(
        `UPDATE invitations SET status = 'accepted', accepted_at = ?1 WHERE id = ?2 AND status = 'pending'`,
      ).bind(nowSec, inv.id),
    );
  }
  await env.OPENCOMPUTER_DB.batch(statements);
  return pending[0].org_id;
}

/**
 * Upserts the WorkOS user and guarantees at least one local membership.
 * Browser login deliberately preserves its historical "first membership"
 * selection; CLI login uses the deterministic policy in work 031 §3.2.
 */
async function provisionWorkOSIdentity(
  req: Request,
  env: Env,
  profile: WorkOSProfile,
  workosOrgID: string | undefined,
  selection: IdentitySelection,
  planIntent: string | null = null,
  ctx?: ExecutionContext,
): Promise<ProvisionedIdentity> {
  const nowSec = Math.floor(Date.now() / 1000);
  const displayName =
    [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email;

  let userRow = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, email, name, created_at FROM users WHERE workos_user_id = ?1`,
  )
    .bind(profile.id)
    .first<{ id: string; email: string; name: string | null; created_at: number | null }>();

  let created = userRow !== null && nowSec - (userRow.created_at ?? 0) < SIGNUP_RETRY_WINDOW_SEC;
  if (!userRow) {
    const candidateID = crypto.randomUUID();
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO users (
         id,
         email,
         workos_user_id,
         name,
         created_at,
         durable_sessions_enabled,
         infrastructure_enabled
       )
       VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)
       ON CONFLICT(email) DO UPDATE SET workos_user_id = excluded.workos_user_id`,
    )
      .bind(candidateID, profile.email, profile.id, displayName, nowSec)
      .run();
    // Re-read after the email-conflict path: the existing row retains its id.
    userRow = await env.OPENCOMPUTER_DB.prepare(
      `SELECT id, email, name, created_at FROM users WHERE workos_user_id = ?1`,
    )
      .bind(profile.id)
      .first<{ id: string; email: string; name: string | null; created_at: number | null }>();
    if (!userRow) throw new Error("workos user upsert did not resolve");
    // The email-conflict path keeps an existing account: not a signup.
    created = userRow.id === candidateID;
  }

  const userID = userRow.id;
  type MembershipRow = {
    id: string;
    name: string;
    plan: string;
    is_personal: number;
    workos_org_id: string | null;
    membership_created_at: number;
    org_created_at: number;
  };

  const selectMembershipByOrg = (orgID: string) =>
    env.OPENCOMPUTER_DB.prepare(
      `SELECT o.id, o.name, o.plan, o.is_personal, o.workos_org_id,
              m.created_at AS membership_created_at, o.created_at AS org_created_at
         FROM orgs o
         JOIN org_memberships m ON m.org_id = o.id
        WHERE m.user_id = ?1 AND o.id = ?2
        LIMIT 1`,
    )
      .bind(userID, orgID)
      .first<MembershipRow>();

  const selectBrowserMembership = () =>
    env.OPENCOMPUTER_DB.prepare(
      `SELECT o.id, o.name, o.plan, o.is_personal, o.workos_org_id,
              m.created_at AS membership_created_at, o.created_at AS org_created_at
         FROM orgs o
         JOIN org_memberships m ON m.org_id = o.id
        WHERE m.user_id = ?1
        LIMIT 1`,
    )
      .bind(userID)
      .first<MembershipRow>();

  const selectCLIMembership = async (): Promise<MembershipRow | null> => {
    const { results } = await env.OPENCOMPUTER_DB.prepare(
      `SELECT o.id, o.name, o.plan, o.is_personal, o.workos_org_id,
              m.created_at AS membership_created_at, o.created_at AS org_created_at
         FROM orgs o
         JOIN org_memberships m ON m.org_id = o.id
        WHERE m.user_id = ?1
        ORDER BY m.created_at ASC, o.created_at ASC, o.id ASC`,
    )
      .bind(userID)
      .all<MembershipRow>();
    const memberships = results ?? [];
    if (workosOrgID) {
      const mapped = memberships.find((row) => row.workos_org_id === workosOrgID);
      if (mapped) return mapped;
    }
    const personal = memberships.find((row) => row.is_personal === 1);
    if (personal) return personal;
    if (memberships.length === 1) return memberships[0];
    return memberships[0] ?? null;
  };

  let orgRow =
    selection === "browser"
      ? await selectBrowserMembership()
      : await selectCLIMembership();

  if (!orgRow) {
    const orgID = crypto.randomUUID();
    const orgName = `${profile.email}'s workspace`;
    let provider = "legacy";
    if (env.AUTUMN_NEW_ORGS === "true" && env.AUTUMN_SECRET_KEY) {
      try {
        await createAutumnCustomer(env, { id: orgID, name: orgName, email: profile.email });
        provider = "autumn";
      } catch {
        // The provider response can echo signup PII. Preserve the actionable
        // org/class without logging its raw error body.
        console.error(`signup: autumn customer create failed for ${orgID}, falling back to legacy`);
      }
    }
    // home_cell is a legacy NOT NULL column from the sandbox era. A new org has
    // no cell, so it gets '' (no cell); max_concurrent_sandboxes keeps its
    // column default.
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO orgs (id, name, slug, plan, home_cell, is_personal, owner_user_id, billing_provider, trial_started_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'free', '', 1, ?4, ?6, ?7, ?5, ?5)`,
    )
      .bind(
        orgID,
        orgName,
        slugify(profile.email + "-" + orgID.slice(0, 6)),
        userID,
        nowSec,
        provider,
        // A new Autumn customer starts on the trial plan (autoEnable).
        provider === "autumn" ? nowSec : null,
      )
      .run();
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)`,
    )
      .bind(orgID, userID, nowSec)
      .run();
    if (provider === "autumn") {
      await emitBillingEvent(env, "billing.trial_started", {
        orgId: orgID,
        userId: userID,
        data: { plan_intent: planIntent, via: selection },
      });
      // Welcome email (088): creates the Loops contact and starts its loops.
      // Off the login path; a Loops failure is logged, never fails the login.
      const welcome = sendLoopsEvent(env, { email: profile.email, userId: userID }, "signed_up", {
        idempotencyKey: `${orgID}:signed_up`,
        eventProperties: { via: selection },
        contactProperties: {
          ...(profile.first_name ? { firstName: profile.first_name } : {}),
          ...(profile.last_name ? { lastName: profile.last_name } : {}),
          orgId: orgID,
          plan: "base",
          signedUpAt: new Date(nowSec * 1000).toISOString(),
        },
      });
      if (ctx) ctx.waitUntil(welcome);
      else await welcome;
    }
    orgRow = {
      id: orgID,
      name: orgName,
      plan: "free",
      is_personal: 1,
      workos_org_id: null,
      membership_created_at: nowSec,
      org_created_at: nowSec,
    };
  }

  // Invitations are redeemed after the personal workspace exists so a
  // first-time invitee ends up with both orgs. Browser login lands in the
  // invited team; CLI login re-runs its deterministic selection policy.
  const invitedOrgID = await acceptPendingInvitations(env, userID, profile.email, nowSec);
  if (invitedOrgID) {
    if (selection === "browser") {
      orgRow = (await selectMembershipByOrg(invitedOrgID)) ?? orgRow;
    } else {
      orgRow = (await selectCLIMembership()) ?? orgRow;
    }
  }

  return {
    user: {
      id: userID,
      email: userRow.email || profile.email,
      name: userRow.name || displayName,
    },
    org: {
      id: orgRow.id,
      name: orgRow.name,
      plan: orgRow.plan,
    },
    created,
  };
}

async function authCallback(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const reqURL = new URL(req.url);
  const code = reqURL.searchParams.get("code");
  if (!code) return json({ error: "missing code" }, 400);
  const redirectURI = `${reqURL.origin}/auth/callback`;

  // Exchange code for user profile.
  const tokenResp = await fetch("https://api.workos.com/user_management/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectURI,
    }),
  });
  if (tokenResp.status !== 200) {
    const errText = await tokenResp.text();
    return json({ error: `workos exchange failed: ${tokenResp.status}: ${errText}` }, 401);
  }
  const tokenBody = await tokenResp.json<AuthenticateResponse>();
  // The code is spent from here on, so a throw would leave the user on a 1101
  // whose refresh fails with "code already exchanged". Restart the login once
  // (WorkOS issues a fresh code); a second failure gets a plain retry page.
  try {
    return await completeAuthCallback(req, env, reqURL, tokenBody, ctx);
  } catch (err) {
    console.error("auth callback: post-exchange failure", err);
    const state = parseAuthState(reqURL.searchParams.get("state"));
    if (state.retried) {
      return new Response(
        `<!doctype html><title>Sign-in failed</title><p>Sign-in hit a temporary error. <a href="/auth/login">Try again</a>.</p>`,
        { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "5" } },
      );
    }
    const retry = new URL("/auth/login", reqURL.origin);
    retry.searchParams.set("retried", "1");
    if (state.returnTo) retry.searchParams.set("returnTo", state.returnTo);
    return Response.redirect(retry.toString(), 302);
  }
}

// The plan a signup came for: the site's pricing CTAs link `/?plan=pro|max`,
// which reaches here inside returnTo.
export function planIntentOf(returnTo: string | null): string | null {
  if (!returnTo) return null;
  const plan = new URL(returnTo, "https://app.invalid").searchParams.get("plan");
  return plan === "pro" || plan === "max" ? plan : null;
}

function parseAuthState(raw: string | null): { returnTo: string | null; retried: boolean } {
  if (!raw) return { returnTo: null, retried: false };
  try {
    const parsed = JSON.parse(raw) as { returnTo?: string; retried?: boolean };
    return { returnTo: safeReturnTo(parsed.returnTo), retried: parsed.retried === true };
  } catch {
    return { returnTo: null, retried: false };
  }
}

type AuthenticateResponse = {
  user: WorkOSProfile;
  organization_id?: string;
  access_token?: string;
  authentication_method?: string;
};

async function completeAuthCallback(
  req: Request,
  env: Env,
  reqURL: URL,
  tokenBody: AuthenticateResponse,
  ctx?: ExecutionContext,
): Promise<Response> {
  const profile = tokenBody.user;
  // WorkOS session id (sid) for the hosted logout flow — carried in our session JWT.
  const workosSessionID = workosSessionIdFromAccessToken(tokenBody.access_token);
  // Re-validate here: `state` is attacker-influenceable, so the path is only
  // trusted after safeReturnTo passes a second time.
  const returnTo = parseAuthState(reqURL.searchParams.get("state")).returnTo;
  const planIntent = planIntentOf(returnTo);
  const identity = await provisionWorkOSIdentity(
    req,
    env,
    profile,
    tokenBody.organization_id ?? profile.organization_id,
    "browser",
    planIntent,
    ctx,
  );
  if (identity.created) {
    await recordSignupAttribution(env, {
      userId: identity.user.id,
      orgId: identity.org.id,
      client: "web",
      authMethod: tokenBody.authentication_method,
      planIntent,
      cookie: readCookie(req.headers.get("cookie"), FIRST_TOUCH_COOKIE),
    });
  }

  // Mint session JWT (SESSION_JWT_SECRET, Issuer "opensandbox-session").
  const sessionJWT = await mintSessionJWT(
    env.SESSION_JWT_SECRET,
    identity.org.id,
    identity.user.id,
    identity.org.plan,
    workosSessionID,
  );

  // Land on the deferred deep link if `state` carried a valid one, else the
  // dashboard.
  const landingURL = `${reqURL.origin}${returnTo ?? "/dashboard"}`;
  return new Response(null, {
    status: 302,
    headers: {
      location: landingURL,
      "set-cookie": `${SESSION_COOKIE}=${sessionJWT}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`,
    },
  });
}

const CLI_AUTH_MAX_BODY_BYTES = 4096;
const CLI_AUTH_MAX_DEVICE_CODE = 2048;
const CLI_AUTH_MAX_CREDENTIAL_NAME = 100;
const CLI_AUTH_DEFAULT_RETRY_SEC = 5;
const CLI_AUTH_MAX_PROVIDER_BODY_BYTES = 64 * 1024;
const CLI_AUTH_PROVIDER_TIMEOUT_MS = 10_000;
const CLI_AUTH_RATE_LIMIT_RETRY_SEC = 60;

function cliAuthJSON(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function cliAuthError(error: string, status: number): Response {
  return cliAuthJSON({ error }, status);
}

function cliAuthRateLimitError(): Response {
  const response = cliAuthError("rate_limited", 429);
  response.headers.set("retry-after", String(CLI_AUTH_RATE_LIMIT_RETRY_SEC));
  return response;
}

interface CLIAuthLogDetails {
  user_id?: string;
  org_id?: string;
  credential_id?: string;
  provider_status?: number;
  provider_error_name?: string;
  provider_error_message?: string;
}

function recordCLIAuth(
  event: "cli_auth_start" | "cli_auth_exchange" | "cli_auth_revoke",
  requestID: string,
  result: string,
  status: number,
  startedAt: number,
  details: CLIAuthLogDetails = {},
): void {
  console.log(JSON.stringify({
    event,
    request_id: requestID,
    result,
    http_status: status,
    duration_ms: Date.now() - startedAt,
    ...details,
  }));
}

function cliAuthProviderExceptionDetails(
  error: unknown,
  redactions: string[],
): Pick<CLIAuthLogDetails, "provider_error_name" | "provider_error_message"> {
  const provider_error_name = error instanceof Error ? error.name : "NonError";
  let provider_error_message =
    error instanceof Error ? error.message : "provider request threw a non-Error value";
  for (const secret of redactions) {
    if (!secret) continue;
    provider_error_message = provider_error_message
      .replaceAll(secret, "[redacted]")
      .replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  provider_error_message = provider_error_message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 256);
  return { provider_error_name, provider_error_message };
}

function isHTTPSURL(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function normalizeCLICredentialName(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "oc CLI";
  if (normalized.length > CLI_AUTH_MAX_CREDENTIAL_NAME) return null;
  return normalized;
}

function cliAuthCallerKey(req: Request): string {
  const value = req.headers.get("CF-Connecting-IP")?.trim();
  return value && value.length <= 64 ? value : "unknown";
}

async function consumeCLIAuthRateLimit(
  req: Request,
  limiter: RateLimit | undefined,
): Promise<"allowed" | "limited" | "unavailable"> {
  if (!limiter) return "unavailable";
  try {
    const result = await limiter.limit({ key: cliAuthCallerKey(req) });
    return result.success ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}

async function fetchCLIAuthProviderJSON(
  input: string,
  init: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLI_AUTH_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await parseProviderJSON(response);
    if (controller.signal.aborted) {
      throw new DOMException("WorkOS request timed out", "AbortError");
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function readSmallJSONObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > CLI_AUTH_MAX_BODY_BYTES) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CLI_AUTH_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function hasRequestBody(req: Request): Promise<boolean> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 0) return true;
  if (!req.body) return false;
  const reader = req.body.getReader();
  const first = await reader.read();
  await reader.cancel();
  return !first.done && first.value.byteLength > 0;
}

async function parseProviderJSON(resp: Response): Promise<Record<string, unknown> | null> {
  const contentLength = Number(resp.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > CLI_AUTH_MAX_PROVIDER_BODY_BYTES) {
    return null;
  }
  if (!resp.body) return null;
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CLI_AUTH_MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const raw = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function urlContainsOpaqueCode(rawURL: string, code: string): boolean {
  if (rawURL.includes(code)) return true;
  try {
    return decodeURIComponent(rawURL).includes(code);
  } catch {
    return true;
  }
}

async function authCLIStart(req: Request, env: Env): Promise<Response> {
  const requestID = crypto.randomUUID();
  const startedAt = Date.now();
  const finish = (
    response: Response,
    result: string,
    details: CLIAuthLogDetails = {},
  ): Response => {
    recordCLIAuth("cli_auth_start", requestID, result, response.status, startedAt, details);
    return response;
  };

  if (req.method !== "POST") {
    return finish(cliAuthError("method_not_allowed", 405), "invalid_request");
  }
  if (!env.WORKOS_CLIENT_ID) {
    return finish(cliAuthError("cli_login_unavailable", 503), "configuration_error");
  }
  const rateLimit = await consumeCLIAuthRateLimit(req, env.CLI_AUTH_START_RATE_LIMIT);
  if (rateLimit === "limited") {
    return finish(cliAuthRateLimitError(), "rate_limited");
  }
  if (rateLimit === "unavailable") {
    return finish(cliAuthError("cli_login_unavailable", 503), "configuration_error");
  }
  if (await hasRequestBody(req)) {
    return finish(cliAuthError("invalid_request", 400), "invalid_request");
  }

  let providerResp: Response;
  let bodyJSON: Record<string, unknown> | null;
  try {
    ({ response: providerResp, body: bodyJSON } = await fetchCLIAuthProviderJSON(
      "https://api.workos.com/user_management/authorize/device",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env.WORKOS_CLIENT_ID }).toString(),
        // Workers rejects RequestRedirect "error" at runtime. "manual" keeps
        // redirects fail-closed: the 3xx response is returned and rejected
        // below, without forwarding the form body to another origin.
        redirect: "manual",
      },
    ));
  } catch (error) {
    return finish(
      cliAuthError("auth_provider_unavailable", 503),
      "provider_error",
      cliAuthProviderExceptionDetails(error, [env.WORKOS_CLIENT_ID]),
    );
  }
  if (!providerResp.ok) {
    return finish(
      cliAuthError("auth_provider_unavailable", 503),
      "provider_error",
      { provider_status: providerResp.status },
    );
  }

  if (
    !bodyJSON ||
    typeof bodyJSON.device_code !== "string" ||
    bodyJSON.device_code.length === 0 ||
    bodyJSON.device_code.length > CLI_AUTH_MAX_DEVICE_CODE ||
    typeof bodyJSON.user_code !== "string" ||
    bodyJSON.user_code.length === 0 ||
    bodyJSON.user_code.length > 64 ||
    !isHTTPSURL(bodyJSON.verification_uri) ||
    !isHTTPSURL(bodyJSON.verification_uri_complete) ||
    !boundedInteger(bodyJSON.expires_in, 1, 3600) ||
    !boundedInteger(bodyJSON.interval, 1, 60) ||
    urlContainsOpaqueCode(bodyJSON.verification_uri, bodyJSON.device_code) ||
    urlContainsOpaqueCode(bodyJSON.verification_uri_complete, bodyJSON.device_code)
  ) {
    return finish(
      cliAuthError("auth_provider_invalid_response", 502),
      "provider_error",
      { provider_status: providerResp.status, provider_error_name: "InvalidResponse" },
    );
  }

  return finish(cliAuthJSON({
    device_code: bodyJSON.device_code,
    user_code: bodyJSON.user_code,
    verification_uri: bodyJSON.verification_uri,
    verification_uri_complete: bodyJSON.verification_uri_complete,
    expires_in: bodyJSON.expires_in,
    interval: bodyJSON.interval,
  }), "success");
}

function providerErrorCode(body: Record<string, unknown> | null): string {
  return typeof body?.error === "string" ? body.error : "";
}

async function authCLIExchange(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const requestID = crypto.randomUUID();
  const startedAt = Date.now();
  const finish = (
    response: Response,
    result: string,
    details: CLIAuthLogDetails = {},
  ): Response => {
    recordCLIAuth("cli_auth_exchange", requestID, result, response.status, startedAt, details);
    return response;
  };

  if (req.method !== "POST") {
    return finish(cliAuthError("method_not_allowed", 405), "invalid_request");
  }
  if (!env.WORKOS_CLIENT_ID) {
    return finish(cliAuthError("cli_login_unavailable", 503), "configuration_error");
  }
  const rateLimit = await consumeCLIAuthRateLimit(req, env.CLI_AUTH_EXCHANGE_RATE_LIMIT);
  if (rateLimit === "limited") {
    return finish(cliAuthRateLimitError(), "rate_limited");
  }
  if (rateLimit === "unavailable") {
    return finish(cliAuthError("cli_login_unavailable", 503), "configuration_error");
  }
  const body = await readSmallJSONObject(req);
  if (
    !body ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "device_code") ||
    !Object.hasOwn(body, "credential_name") ||
    typeof body.device_code !== "string" ||
    body.device_code.length === 0 ||
    body.device_code.length > CLI_AUTH_MAX_DEVICE_CODE
  ) {
    return finish(cliAuthError("invalid_request", 400), "invalid_request");
  }
  const credentialName = normalizeCLICredentialName(body.credential_name);
  if (!credentialName) {
    return finish(cliAuthError("invalid_request", 400), "invalid_request");
  }

  let providerResp: Response;
  let providerBody: Record<string, unknown> | null;
  try {
    ({ response: providerResp, body: providerBody } = await fetchCLIAuthProviderJSON(
      "https://api.workos.com/user_management/authenticate",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: body.device_code,
          client_id: env.WORKOS_CLIENT_ID,
        }).toString(),
        // See the start endpoint: manual redirects prevent the device code
        // from being forwarded and are rejected by the status handling below.
        redirect: "manual",
      },
    ));
  } catch (error) {
    return finish(
      cliAuthError("auth_provider_unavailable", 503),
      "provider_error",
      cliAuthProviderExceptionDetails(error, [env.WORKOS_CLIENT_ID, body.device_code]),
    );
  }

  if (!providerResp.ok) {
    const code = providerErrorCode(providerBody);
    if (code === "authorization_pending") {
      return finish(
        cliAuthJSON({ status: "authorization_pending", retry_after: CLI_AUTH_DEFAULT_RETRY_SEC }, 202),
        "pending",
      );
    }
    if (code === "slow_down") {
      return finish(
        cliAuthJSON({ status: "authorization_pending", retry_after: CLI_AUTH_DEFAULT_RETRY_SEC + 5 }, 202),
        "pending",
      );
    }
    if (code === "access_denied" || code === "authorization_denied") {
      return finish(cliAuthError("authorization_denied", 403), "denied");
    }
    if (code === "expired_token" || code === "invalid_grant") {
      return finish(cliAuthError("authorization_expired", 410), "expired");
    }
    if (providerResp.status >= 500) {
      return finish(
        cliAuthError("auth_provider_unavailable", 503),
        "provider_error",
        { provider_status: providerResp.status },
      );
    }
    return finish(
      cliAuthError("auth_provider_invalid_response", 502),
      "provider_error",
      { provider_status: providerResp.status },
    );
  }

  const profile = providerBody?.user;
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    typeof (profile as Record<string, unknown>).id !== "string" ||
    typeof (profile as Record<string, unknown>).email !== "string"
  ) {
    return finish(
      cliAuthError("auth_provider_invalid_response", 502),
      "provider_error",
      { provider_status: providerResp.status, provider_error_name: "InvalidResponse" },
    );
  }
  const typedProfile = profile as unknown as WorkOSProfile;
  const workosOrgID =
    typeof providerBody?.organization_id === "string"
      ? providerBody.organization_id
      : typedProfile.organization_id;

  let identity: ProvisionedIdentity;
  try {
    identity = await provisionWorkOSIdentity(req, env, typedProfile, workosOrgID, "cli", null, ctx);
  } catch {
    return finish(cliAuthError("account_provisioning_unavailable", 503), "provisioning_error");
  }
  if (identity.created) {
    await recordSignupAttribution(env, {
      userId: identity.user.id,
      orgId: identity.org.id,
      client: "cli",
      authMethod: providerBody?.authentication_method,
      planIntent: null,
      cookie: null,
    });
  }

  let credential;
  try {
    const made = await createAPIKeyWithHash(env, {
      orgID: identity.org.id,
      userID: identity.user.id,
      name: credentialName,
    });
    credential = made.created;
    // Tell the computer API about the key (work 084); never the key itself.
    ctx?.waitUntil(
      syncComputerKey(
        env,
        identity.org.id,
        createdKeyForSync(made.created, made.hash, identity.user.id),
      ),
    );
  } catch {
    return finish(
      cliAuthError("credential_creation_failed", 503),
      "credential_error",
      { user_id: identity.user.id, org_id: identity.org.id },
    );
  }

  return finish(cliAuthJSON({
    status: "authorized",
    credential: {
      id: credential.id,
      key: credential.key,
      key_prefix: credential.keyPrefix,
      name: credential.name,
    },
    user: identity.user,
    org: {
      id: identity.org.id,
      name: identity.org.name,
    },
  }), "success", {
    user_id: identity.user.id,
    org_id: identity.org.id,
    credential_id: credential.id,
  });
}

// ── computer API (work 084) ─────────────────────────────────────────────

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// The Workers rate limit counts per 60 s window; a refused caller waits for
// the next one.
const COMPUTER_API_RATE_LIMIT_RETRY_SEC = 60;

/**
 * /api/managed-agents/computer/*: authenticates an API key (`x-api-key` or
 * `Authorization: Bearer`) or a dashboard session, then streams the call to
 * blue (or, for workspace files, to the wire Worker). Errors here use the
 * documented shape; blue's own pass through untouched.
 */
async function handleComputerApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  if (req.method.toUpperCase() === "OPTIONS") return computerApiPreflight(req, env);
  // One `edge.request` per call (work 084 instrumentation), sent off the
  // response path; the duration ends when the response's headers are ready.
  const suffix = path.slice("/api/managed-agents".length);
  const facts = newEdgeRequestFacts();
  let response: Response | null = null;
  try {
    response = await computerApiCall(req, env, ctx, suffix, facts);
    return response;
  } finally {
    reportEdgeRequest(env, ctx, req, suffix, facts, response);
  }
}

async function computerApiCall(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  suffix: string,
  facts: EdgeRequestFacts,
): Promise<Response> {
  const method = req.method.toUpperCase();
  if (!isComputerApiRoute(method, suffix)) {
    return computerApiError(req, 404, "not_found", "No such route.");
  }

  const credential = computerApiKey(req);
  if ("conflict" in credential) {
    facts.auth = "conflicting";
    return computerApiError(
      req,
      401,
      "unauthenticated",
      "The x-api-key and Authorization headers name different keys.",
    );
  }
  let caller: Caller | null = null;
  let viaKey = false;
  if (credential.key) {
    viaKey = true;
    facts.via = "key";
    caller = await authenticateKey(credential.key, env, ctx);
    // Entries cached before the key fields existed: re-read the row once, so
    // blue always learns which key acted.
    if (caller && !caller.key) {
      await refreshAuth(env, await hashAPIKey(credential.key));
      caller = await authenticateKey(credential.key, env, ctx);
    }
    if (caller?.key && env.COMPUTER_API_RATE_LIMIT) {
      // Per key, ahead of blue. A limiter error fails open: blue still
      // authorizes every call.
      const allowed = await env.COMPUTER_API_RATE_LIMIT.limit({ key: caller.key.id }).then(
        (r) => r.success,
        () => true,
      );
      if (!allowed) {
        facts.auth = "ok";
        facts.rateLimited = true;
        const response = computerApiError(req, 429, "rate_limited", "Too many requests for this key. Slow down.", {
          retryAfterMs: COMPUTER_API_RATE_LIMIT_RETRY_SEC * 1000,
        });
        response.headers.set("retry-after", String(COMPUTER_API_RATE_LIMIT_RETRY_SEC));
        return response;
      }
    }
  } else {
    const session = await authDashboard(req, env);
    if (session) {
      facts.via = "dashboard";
      // A cookie rides along on cross-site requests SameSite=Lax still
      // allows (sibling subdomains); unsafe methods need an allowed Origin.
      if (!SAFE_METHODS.has(method) && !computerApiOriginAllowed(req, env)) {
        facts.auth = "origin";
        return computerApiError(req, 403, "forbidden", "Cross-origin request refused.", {
          reason: "origin_not_allowed",
        });
      }
      const membership = await env.OPENCOMPUTER_DB.prepare(
        `SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2`,
      )
        .bind(session.orgID, session.userID)
        .first<{ role: string }>();
      if (!membership) {
        facts.auth = "not_member";
        return computerApiError(req, 401, "unauthenticated", "Sign in again.");
      }
      caller = {
        orgID: session.orgID,
        userID: session.userID,
        role:
          membership.role === "owner" || membership.role === "admin"
            ? "admin"
            : membership.role,
      };
    }
  }
  if (!caller) {
    facts.auth = credential.key ? "invalid" : "missing";
    return computerApiError(req, 401, "unauthenticated", "Missing or invalid API key.");
  }
  facts.orgId = caller.orgID;
  if (caller.key?.id) facts.keyId = caller.key.id;
  if (!computerEnabledFor(env, caller.orgID)) {
    facts.auth = "disabled";
    return computerApiError(req, 404, "not_found", "No such route.");
  }

  const workspace = computerWorkspaceRoute(method, suffix);
  if (workspace) {
    // The wire Worker checks the caller's key itself; a cookie is not one.
    if (!viaKey) {
      facts.auth = "key_required";
      return computerApiError(
        req,
        403,
        "forbidden",
        "Workspace files need an API key; dashboard sessions cannot read them here.",
        { reason: "key_required" },
      );
    }
    facts.auth = "ok";
    facts.upstream = "wire";
    return proxyComputerWorkspace(req, env, workspace);
  }
  facts.auth = "ok";
  facts.upstream = "blue";
  return proxyManagedAgents(req, env, caller, "/api/managed-agents");
}

async function authCLIRevoke(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const requestID = crypto.randomUUID();
  const startedAt = Date.now();
  const finish = (response: Response, result: string): Response => {
    recordCLIAuth("cli_auth_revoke", requestID, result, response.status, startedAt);
    return response;
  };

  if (req.method !== "DELETE") {
    return finish(cliAuthError("method_not_allowed", 405), "invalid_request");
  }
  const plainKey = req.headers.get("X-API-Key");
  if (!plainKey || !plainKey.startsWith("osb_")) {
    return finish(cliAuthError("missing or invalid API key", 401), "unauthorized");
  }
  let caller: Caller | null;
  try {
    caller = await authenticate(req, env);
  } catch {
    return finish(cliAuthError("credential_revocation_unavailable", 503), "storage_error");
  }
  if (!caller) {
    return finish(cliAuthError("missing or invalid API key", 401), "unauthorized");
  }
  let keyID: string | null = caller.key?.id ?? null;
  try {
    const hash = await hashAPIKey(plainKey);
    if (!keyID && env.MANAGED_AGENTS_API_URL) {
      const row = await env.OPENCOMPUTER_DB.prepare(
        `SELECT id FROM api_keys WHERE key_hash = ?1 AND org_id = ?2`,
      )
        .bind(hash, caller.orgID)
        .first<{ id?: string }>();
      keyID = row?.id ?? null;
    }
    await env.OPENCOMPUTER_DB.prepare(
      `DELETE FROM api_keys WHERE key_hash = ?1 AND org_id = ?2`,
    )
      .bind(hash, caller.orgID)
      .run();
  } catch {
    return finish(cliAuthError("credential_revocation_unavailable", 503), "storage_error");
  }
  if (keyID) ctx?.waitUntil(revokeComputerKey(env, caller.orgID, caller.userID, keyID));
  return finish(new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  }), "success");
}

// Decode the WorkOS session id (`sid` claim) from a WorkOS access-token JWT
// without verifying the signature. The token came straight from WorkOS's token
// endpoint at callback; we only need the session id to build the hosted logout
// URL, so an unverified parse is sufficient.
function workosSessionIdFromAccessToken(accessToken?: string): string | undefined {
  if (!accessToken) return undefined;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sid?: string };
    return payload.sid;
  } catch {
    return undefined;
  }
}

async function authLogout(req: Request, env: Env): Promise<Response> {
  const clearCookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

  // Clearing oc_session alone leaves the WorkOS SSO session alive, so the
  // dashboard's /auth/login would silently re-authenticate the user. Hand back
  // WorkOS's hosted logout URL (built from the sid captured into the session JWT
  // at callback) so the browser also tears down the WorkOS session. No
  // return_to: the post-logout destination is WorkOS dashboard config (Sign-out
  // redirect), per environment. Old sessions without wsid fall back to a plain
  // cookie clear; the client then routes to /auth/login.
  let logoutUrl: string | undefined;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (m) {
    const claims = await verifySessionJWT(env.SESSION_JWT_SECRET, m[1]);
    if (claims?.wsid) {
      const u = new URL("https://api.workos.com/user_management/sessions/logout");
      u.searchParams.set("session_id", claims.wsid);
      logoutUrl = u.toString();
    }
  }

  return new Response(JSON.stringify({ message: "logged out", ...(logoutUrl ? { logoutUrl } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": clearCookie },
  });
}

async function authRefresh(req: Request, env: Env): Promise<Response> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!m) return json({ error: "no session" }, 401);
  const claims = await verifySessionJWT(env.SESSION_JWT_SECRET, m[1]);
  if (!claims) return json({ error: "invalid session" }, 401);
  // Re-mint with fresh expiry. Plan is re-read from D1 in case it changed.
  const orgRow = await env.OPENCOMPUTER_DB.prepare(
    `SELECT plan FROM orgs WHERE id = ?1`,
  )
    .bind(claims.org_id)
    .first<{ plan: string }>();
  const plan = orgRow?.plan ?? "free";
  // Preserve the WorkOS session id across refresh so hosted logout still works
  // (logout builds the WorkOS logout URL from claims.wsid; dropping it here
  // would silently downgrade post-refresh logout to local cookie clearing).
  const fresh = await mintSessionJWT(env.SESSION_JWT_SECRET, claims.org_id, claims.user_id, plan, claims.wsid);
  return new Response(JSON.stringify({ ok: true, plan }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${SESSION_COOKIE}=${fresh}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`,
    },
  });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

interface SessionClaims {
  org_id: string;
  user_id: string;
  plan: string;
  iat: number;
  exp: number;
  // WorkOS session id (sid). Carried so /auth/logout can build the WorkOS
  // hosted logout URL and tear down the SSO session, not just our cookie.
  // Optional: sessions minted before this existed won't have it.
  wsid?: string;
}

async function mintSessionJWT(secret: string, orgID: string, userID: string, plan: string, wsid?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "opensandbox-session",
    sub: userID,
    iat: now,
    exp: now + SESSION_TTL_SEC,
    org_id: orgID,
    user_id: userID,
    plan,
    ...(wsid ? { wsid } : {}),
  };
  const enc = new TextEncoder();
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacSignKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

async function verifySessionJWT(secret: string, token: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(`${headerB64}.${payloadB64}`));
  if (b64url(expected) !== sigB64) return null;
  try {
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as SessionClaims & { iss?: string };
    if (payload.iss !== "opensandbox-session") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Stripe webhook ───────────────────────────────────────────────────────
//
// Stripe POSTs subscription / invoice events. We verify the signature,
// translate the event into a CreditAccount DO call:
//   customer.subscription.created / checkout.session.completed → /mark-pro
//   customer.subscription.deleted                              → /mark-free
//
// org_id is recovered from Stripe customer metadata (set when we create
// the customer at upgrade-checkout time). For events without an org_id we
// log and return 200 — Stripe expects 2xx or it'll retry forever.

async function stripeWebhook(req: Request, env: Env): Promise<Response> {
  const sigHeader = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();

  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, sigHeader, body))) {
    return json({ error: "invalid signature" }, 401);
  }

  let event: { type: string; data: { object: any } };
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const obj = event.data?.object ?? {};
  const orgID = obj.metadata?.org_id || obj.customer_metadata?.org_id || "";

  switch (event.type) {
    case "customer.subscription.created":
    case "checkout.session.completed": {
      if (!orgID) {
        console.error(`stripe: ${event.type} without org_id metadata; logging and skipping`);
        return json({ received: true, skipped: "no org_id" });
      }
      // A completed setup-checkout IS the upgrade: provision the Stripe
      // subscription (every metered price from the D1 catalog + $30 credit)
      // BEFORE marking pro, so an org is never pro-but-unprovisioned. ONLY on
      // the setup checkout — never on customer.subscription.created, which our
      // own provisioning fires (that would loop). Idempotent, so Stripe webhook
      // retries can't create a second subscription.
      if (event.type === "checkout.session.completed" && obj.metadata?.type === "setup" && obj.customer) {
        try {
          await provisionProSubscription(env, orgID, obj.customer);
        } catch (e) {
          console.error(`stripe: provision subscription for ${orgID} failed`, e);
          return json({ error: "provisioning failed" }, 500); // 5xx → Stripe retries
        }
      }

      const stub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(orgID));
      const resp = await stub.fetch(`https://do/mark-pro?org_id=${encodeURIComponent(orgID)}`, { method: "POST" });
      if (resp.status >= 400) {
        console.error(`stripe: DO /mark-pro ${orgID} returned ${resp.status}`);
      }
      // Stamp stripe IDs on the org row for the next callback round-trip.
      if (obj.customer || obj.subscription) {
        await env.OPENCOMPUTER_DB.prepare(
          `UPDATE orgs SET stripe_customer_id = COALESCE(?1, stripe_customer_id),
                            stripe_subscription_id = COALESCE(?2, stripe_subscription_id),
                            updated_at = ?3
            WHERE id = ?4`,
        )
          .bind(obj.customer ?? null, obj.subscription ?? null, Math.floor(Date.now() / 1000), orgID)
          .run();
      }
      return json({ received: true });
    }
    case "customer.subscription.deleted": {
      if (!orgID) {
        console.error(`stripe: subscription.deleted without org_id; skipping`);
        return json({ received: true, skipped: "no org_id" });
      }
      const stub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(orgID));
      const resp = await stub.fetch(`https://do/mark-free?org_id=${encodeURIComponent(orgID)}`, { method: "POST" });
      if (resp.status >= 400) {
        console.error(`stripe: DO /mark-free ${orgID} returned ${resp.status}`);
      }
      return json({ received: true });
    }
    default:
      // Many event types we don't care about (invoice.*, payment_method.*, etc.).
      // Ack so Stripe stops retrying.
      return json({ received: true, ignored: event.type });
  }
}

// provisionProSubscription creates the org's Stripe subscription with every
// metered price from the D1 catalog (billing_prices, written once by
// cmd/ensure-products), applies the $30 promo credit, and persists the
// subscription + item IDs to D1. This is the edge replacement for the cell's
// CreateSubscription — necessary because the public Stripe webhook must
// terminate on the edge, not the (private) cell. Idempotent: a no-op if the
// org already has a subscription, and the Stripe-side Idempotency-Key keeps a
// retry/concurrent delivery from ever creating two.
async function provisionProSubscription(env: Env, orgID: string, customerID: string): Promise<void> {
  const existing = await env.OPENCOMPUTER_DB.prepare(
    "SELECT stripe_subscription_id FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<{ stripe_subscription_id: string | null }>();
  if (existing?.stripe_subscription_id) {
    return; // already provisioned — retry no-op
  }

  // Global price catalog. Empty = cmd/ensure-products hasn't run; refuse rather
  // than create a subscription with no metered items (silent under-bill).
  const cat = await env.OPENCOMPUTER_DB.prepare("SELECT key, price_id FROM billing_prices").all<{
    key: string;
    price_id: string;
  }>();
  const catalog = cat.results ?? [];
  if (catalog.length === 0) {
    throw new Error("billing_prices catalog empty — run cmd/ensure-products before provisioning");
  }

  // Subscription with every catalog price as a line item (mirrors the cell's
  // CreateSubscription: per-tier + overage + reserved + disk). Idempotency-Key
  // is org-scoped so a duplicate delivery can't create a second subscription.
  const subForm = new URLSearchParams();
  subForm.set("customer", customerID);
  catalog.forEach((r, i) => subForm.set(`items[${i}][price]`, r.price_id));
  const sub = await stripePost(env, "/v1/subscriptions", subForm, `sub-create-${orgID}`);

  // $30 promotional credit (negative customer balance), same as the cell.
  await stripePost(env, `/v1/customers/${encodeURIComponent(customerID)}`, new URLSearchParams({ balance: "-3000" }));

  const now = Math.floor(Date.now() / 1000);
  await env.OPENCOMPUTER_DB.prepare(
    "UPDATE orgs SET stripe_subscription_id = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(sub.id, now, orgID)
    .run();

  // Persist item IDs, mapping each back to its catalog key.
  const keyByPrice = new Map(catalog.map((r) => [r.price_id, r.key]));
  const itemStmt = env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO org_subscription_items (org_id, tier, stripe_item_id, price_id)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(org_id, tier) DO UPDATE SET stripe_item_id = excluded.stripe_item_id, price_id = excluded.price_id`,
  );
  const items = (sub.items?.data ?? []) as Array<{ id: string; price?: { id: string } }>;
  const batch: D1PreparedStatement[] = [];
  for (const it of items) {
    const priceID = it.price?.id ?? "";
    const key = keyByPrice.get(priceID);
    if (key) batch.push(itemStmt.bind(orgID, key, it.id, priceID));
  }
  if (batch.length > 0) await env.OPENCOMPUTER_DB.batch(batch);

  console.log(`stripe: provisioned subscription ${sub.id} for org ${orgID} (${batch.length} items, $30 credit)`);
}

// stripePost POSTs form-urlencoded to the Stripe API and returns parsed JSON,
// throwing on non-2xx. An optional Idempotency-Key makes a call safe to retry.
async function stripePost(env: Env, path: string, form: URLSearchParams, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = {
    authorization: "Bearer " + env.STRIPE_API_KEY,
    "stripe-version": "2024-06-20",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(`https://api.stripe.com${path}`, { method: "POST", headers, body: form.toString() });
  const text = await resp.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    throw new Error(parsed?.error?.message ?? parsed?.raw ?? `stripe ${path} returned ${resp.status}`);
  }
  return parsed;
}

// verifyStripeSignature checks the t=… v1=… Stripe-Signature header.
// Stripe signs `${timestamp}.${body}` with HMAC-SHA256.
async function verifyStripeSignature(secret: string, header: string, body: string): Promise<boolean> {
  const parts = header.split(",").map((p) => p.split("="));
  const ts = parts.find((p) => p[0] === "t")?.[1];
  const v1 = parts.find((p) => p[0] === "v1")?.[1];
  if (!ts || !v1) return false;
  // Reject signatures older than 5 minutes (Stripe replay defense recommendation).
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 5 * 60) return false;
  const expected = await hmacHex(secret, `${ts}.${body}`);
  return constantTimeEqual(expected, v1);
}

// ── entrypoint ───────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = envWithD1Retry(env);
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, env: env.WORKER_ENV });
    }

    // feedback.now protocol (agent_feedback.ts). Must precede both the generic
    // /api/* API-key gate (agents submit anonymously) and the SPA asset
    // fallthrough (which would otherwise answer /.well-known/* with index.html).
    if (isAgentFeedbackPath(path)) {
      return handleAgentFeedback(req, env, path, ctx);
    }

    // Reconciler trigger for the Autumn re-check+project (EVENT_SECRET HMAC).
    if (path === "/internal/autumn-project") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return autumnProjectInternal(req, env);
    }
    // Browser API runtime usage → Autumn browser_runtime (BROWSER_USAGE_HMAC_SECRET HMAC).
    if (path === "/internal/browser-usage") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return browserUsageInternal(req, env);
    }
    if (path === "/internal/agent-runtime-usage") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return agentRuntimeUsageInternal(req, env);
    }

    // Migrate tool: flip D1 billing_provider for one org (EVENT_SECRET HMAC).
    if (path === "/internal/autumn-set-provider") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return autumnSetProviderInternal(req, env);
    }
    // Dev-only: force an autumn-meter run (the cron is */5). 404 in prod so only
    // the scheduled trigger moves money there. Deterministic testing aid.
    if (path === "/internal/run-autumn-meter" && req.method === "POST") {
      if (env.WORKER_ENV === "prod") return new Response("not found", { status: 404 });
      await runAutumnMeter(env, Date.now());
      return json({ ok: true });
    }
    // Force a model-meter run (token billing §5.4). HMAC-auth'd (CF_ADMIN_SECRET) so
    // it's safe to run in prod for testing/ops — useful to debit + push caps right
    // after a Managed turn instead of waiting for the cron.
    if (path === "/internal/run-model-meter" && req.method === "POST") {
      const ts = req.headers.get("X-Timestamp") ?? "";
      const sig = req.headers.get("X-Signature") ?? "";
      const body = await req.text();
      const expected = await hmacHex(env.CF_ADMIN_SECRET, `${ts}.${body}`);
      if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return json({ error: "timestamp out of window" }, 401);
      await runModelMeter(env, Date.now());
      return json({ ok: true });
    }

    // /internal/admin/do-mark-free — operator-only escape hatch to flip a
    // CreditAccount DO's internal plan from "pro" back to "free" without
    // running a real Stripe subscription.deleted webhook. HMAC-auth'd with
    // the shared CF_ADMIN_SECRET. Body: { org_id }. Used by halt-flow tests
    // and incident recovery when Stripe webhooks are missed; not exposed
    // through any UI.
    if (path === "/internal/admin/do-mark-free" && req.method === "POST") {
      const ts = req.headers.get("X-Timestamp") ?? "";
      const sig = req.headers.get("X-Signature") ?? "";
      const body = await req.text();
      const expected = await hmacHex(env.CF_ADMIN_SECRET, `${ts}.${body}`);
      if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return json({ error: "timestamp out of window" }, 401);
      const parsed = JSON.parse(body) as { org_id?: string };
      if (!parsed.org_id) return json({ error: "org_id required" }, 400);
      const stub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(parsed.org_id));
      const r = await stub.fetch(`https://do/mark-free?org_id=${encodeURIComponent(parsed.org_id)}`, { method: "POST" });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    }

    // /internal/warm-org — pre-populate this colo's caches for one org.
    //
    // The auth tier lives in the colo cache, and its entries expire (10min).
    // (The sandbox create-context tier it also warmed is gone since 097 step
    // 7.2.) An API key used once
    // a week is therefore always cold when it matters, and a cold miss costs a
    // D1 read against a primary in WNAM while the request runs in IAD —
    // measured at 340ms, paid by EVERY request in a burst because the cold path
    // is not single-flighted. On a burst-100 that is the difference between a
    // 339ms TTI and a 1585ms one.
    //
    // Warming has to run IN the colo it warms: the cache is per-colo, and a
    // Worker cron fires wherever Cloudflare puts it. So this is a route, driven
    // from a host in the target metro, rather than a scheduled handler.
    //
    // Keys are warmed by HASH, read from D1 — the plaintext never leaves the
    // database and the caller never needs it. That also means every key on the
    // org is warmed, so this keeps working when a key is rotated.
    //
    // HMAC-auth'd with CF_ADMIN_SECRET, same scheme as do-mark-free.
    if (path === "/internal/warm-org" && req.method === "POST") {
      const ts = req.headers.get("X-Timestamp") ?? "";
      const sig = req.headers.get("X-Signature") ?? "";
      const body = await req.text();
      const expected = await hmacHex(env.CF_ADMIN_SECRET, `${ts}.${body}`);
      if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return json({ error: "timestamp out of window" }, 401);
      const parsed = JSON.parse(body) as { org_id?: string };
      if (!parsed.org_id) return json({ error: "org_id required" }, 400);

      // Same projection resolveCaller caches, so a warmed entry is byte-for-byte
      // what a real miss would have written. Drift here would be invisible: the
      // cache would hit and serve a subtly different caller.
      const rows = await env.OPENCOMPUTER_DB.prepare(
        `SELECT k.key_hash, k.org_id, k.created_by, k.expires_at, k.session_key,
                k.id AS key_id, k.name AS key_name, k.scopes AS key_scopes,
                k.created_at AS key_created_at, u.name AS user_name, u.email AS user_email,
                CASE WHEN m.role IN ('owner', 'admin') THEN 'admin' ELSE m.role END AS role
           FROM api_keys k
           LEFT JOIN org_memberships m
             ON m.org_id = k.org_id AND m.user_id = k.created_by
           LEFT JOIN users u ON u.id = k.created_by
          WHERE k.org_id = ?1`,
      ).bind(parsed.org_id).all<AuthRow & { key_hash: string }>();

      const at = Date.now();
      let warmed = 0;
      for (const row of rows.results ?? []) {
        const caller = callerFromRow(row);
        await coloPut("auth", row.key_hash, { caller, expiresAt: row.expires_at, cachedAtMs: at }, AUTH_STALE_MAX_MS / 1000);
        warmed++;
      }
      return json({
        warmed,
        org_id: parsed.org_id,
        colo: (req as { cf?: { colo?: string } }).cf?.colo ?? "unknown",
      });
    }

    // /internal/model-billing/enable|disable — operator-triggered managed-billing
    // provisioning for one autumn org (token-billing §5.1). HMAC-auth'd with the
    // shared CF_ADMIN_SECRET (same scheme as do-mark-free). Body: { org_id }. Not
    // UI-exposed; the driver for controlled rollout + tests until an automatic
    // enable trigger lands. `enable` drives off→provisioning→active idempotently
    // (safe to re-call to resume a partial provision); `disable` marks the org's
    // key for drain + offboard.
    if (
      (path === "/internal/model-billing/enable" || path === "/internal/model-billing/disable") &&
      req.method === "POST"
    ) {
      const ts = req.headers.get("X-Timestamp") ?? "";
      const sig = req.headers.get("X-Signature") ?? "";
      const body = await req.text();
      // CF_ADMIN_SECRET authorizes both ops. `enable` is additionally accepted with the
      // scoped OC_MANAGED_CRED_HMAC_SECRET (shared only with the managed agents
      // backend), so it can ensure-provision without holding the broad admin secret.
      // `disable` stays admin-only.
      const adminOk = constantTimeEqual(await hmacHex(env.CF_ADMIN_SECRET, `${ts}.${body}`), sig);
      const managedOk =
        path === "/internal/model-billing/enable" && env.OC_MANAGED_CRED_HMAC_SECRET
          ? constantTimeEqual(await hmacHex(env.OC_MANAGED_CRED_HMAC_SECRET, `${ts}.${body}`), sig)
          : false;
      if (!adminOk && !managedOk) return json({ error: "signature mismatch" }, 401);
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return json({ error: "timestamp out of window" }, 401);
      const parsed = JSON.parse(body) as { org_id?: string };
      if (!parsed.org_id) return json({ error: "org_id required" }, 400);
      try {
        if (path === "/internal/model-billing/disable") {
          await disableManagedBilling(env, parsed.org_id);
          return json({ ok: true });
        }
        const res = await enableManagedBilling(env, parsed.org_id);
        return json(res, res.status === "active" ? 200 : 500);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    // /internal/computer-keys — a one-hour org key for an organization's computer
    // (work 067): managed agents mints one when a session runs `opencomputer`,
    // instead of a long-lived key living on the VM. HMAC-auth'd with the scoped
    // OC_MANAGED_CRED_HMAC_SECRET over `${ts}.${body}`. Body: { org_id,
    // session_key? }: the Slack thread the key is for (work 080), recorded on
    // the key and forwarded as the assertion's session_key claim.
    if (path === "/internal/computer-keys" && req.method === "POST") {
      const ts = req.headers.get("X-Timestamp") ?? "";
      const sig = req.headers.get("X-Signature") ?? "";
      const body = await req.text();
      const ok = env.OC_MANAGED_CRED_HMAC_SECRET
        ? constantTimeEqual(await hmacHex(env.OC_MANAGED_CRED_HMAC_SECRET, `${ts}.${body}`), sig)
        : false;
      if (!ok) return json({ error: "signature mismatch" }, 401);
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return json({ error: "timestamp out of window" }, 401);
      const parsed = JSON.parse(body) as { org_id?: string; session_key?: unknown };
      if (!parsed.org_id) return json({ error: "org_id required" }, 400);
      const sessionKey = parsed.session_key;
      if (sessionKey !== undefined && (typeof sessionKey !== "string" || !SESSION_KEY_RE.test(sessionKey))) {
        return json({ error: "session_key must be team:channel:thread" }, 400);
      }
      const org = await env.OPENCOMPUTER_DB.prepare(`SELECT id FROM orgs WHERE id = ?1`).bind(parsed.org_id).first();
      if (!org) return json({ error: "org not found" }, 404);
      const created = await createAPIKey(env, {
        orgID: parsed.org_id,
        userID: COMPUTER_PRINCIPAL,
        name: "Computer session",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        ...(sessionKey ? { sessionKey } : {}),
      });
      return json({ key: created.key, expiresAt: created.expiresAt });
    }

    // Auth flows. CLI device auth is deliberately edge-brokered: WorkOS tokens
    // never cross this boundary and the CLI receives one ordinary OC org key.
    if (path === "/auth/cli/device") {
      return authCLIStart(req, env);
    }
    if (path === "/auth/cli/device/exchange") {
      return authCLIExchange(req, env, ctx);
    }
    if (path === "/auth/cli/credential") {
      return authCLIRevoke(req, env, ctx);
    }

    // Browser auth flow.
    if (path === "/auth/login")    { if (req.method === "GET")  return withFirstTouchCookie(req, await authLogin(req, env)); }
    if (path === "/auth/callback") { if (req.method === "GET")  return authCallback(req, env, ctx); }
    if (path === "/auth/logout")   { if (req.method === "POST") return authLogout(req, env); }
    if (path === "/auth/refresh")  { if (req.method === "POST") return authRefresh(req, env); }

    // Stripe webhook (test mode in app2, live in app).
    if (path === "/webhooks/stripe" && req.method === "POST") return stripeWebhook(req, env);

    // Autumn (useautumn.com) webhook — Svix-signed; projects authoritative
    // balance/plans into D1 (is_halted, usage_plan, halt_reason).
    if (path === "/webhooks/autumn" && req.method === "POST") return autumnWebhook(req, env, (orgID) => syncModelCaps(env, orgID));

    // Dashboard API — everything under /api/dashboard/*. Edge-native handlers
    // back D1 reads/writes (the sandbox-cell proxy was removed in 097 step 7.2).
    // Auth via the oc_session cookie minted at /auth/callback.
    if (path.startsWith("/api/dashboard")) {
      return handleDashboard(req, env, ctx, path);
    }

    // Managed Agents public API. Customers authenticate with their ordinary
    // OpenComputer API key; the edge replaces it with a short-lived org
    // assertion before calling the private deployment backend.
    if (path.startsWith("/api/managed-agents/channel-connections/")) {
      return handleManagedAgentChannelConnection(req, env);
    }
    if (
      path === "/api/managed-agents/github/callback" &&
      req.method === "GET"
    ) {
      return handleManagedGitHubCallback(req, env);
    }
    if (
      path === "/api/managed-agents/github/webhooks" &&
      req.method === "POST"
    ) {
      return handleManagedGitHubWebhook(req, env);
    }
    // Slack's OAuth redirect for apps created by the automated setup. This
    // exact URL is registered on every generated app; the backend answers
    // with a redirect into the project's Connections tab.
    if (
      path === "/api/managed-agents/slack/callback" &&
      req.method === "GET"
    ) {
      return handleManagedSlackCallback(req, env);
    }
    // Linear's OAuth redirect for a project's Linear agent connection. The
    // backend puts this exact URL in every authorize link and on the app it
    // prefills (BLUE_LINEAR_OAUTH_REDIRECT_URI, default: the Slack callback's
    // sibling); it answers with a redirect into the project's Connections tab.
    if (
      path === "/api/managed-agents/linear/callback" &&
      req.method === "GET"
    ) {
      return handleManagedLinearCallback(req, env);
    }
    // The organization-level OpenComputer Slack app (work 052). These exact
    // URLs are configured on the app; Slack calls them without OpenComputer
    // credentials, so they stay above the API-key check. The backend verifies
    // Slack's signature over the untouched body.
    if (
      path === "/api/managed-agents/computer/slack/callback" &&
      req.method === "GET"
    ) {
      return handleComputerSlackCallback(req, env);
    }
    if (
      path === "/api/managed-agents/computer/slack/events" &&
      req.method === "POST"
    ) {
      return handleComputerSlackWebhook(req, env, "events");
    }
    if (
      path === "/api/managed-agents/computer/slack/interactivity" &&
      req.method === "POST"
    ) {
      return handleComputerSlackWebhook(req, env, "interactivity");
    }
    // The CLI's one-command subscription connect (work 082): the
    // dashboard-minted code in the body is the only credential, so it stays
    // above the API-key check. Every method lands here (non-POST is a 405)
    // so the path never falls through to the API-key mount.
    if (path === "/api/managed-agents/computer/agent/connect") {
      return handleComputerAgentConnect(req, env);
    }
    if (path.startsWith("/api/agent-webhooks/")) {
      return handleAgentWebhookInvocation(req, env);
    }
    // The computer's session API (work 084), for API keys and dashboard
    // sessions alike. Below the Slack and connect mounts above, which keep
    // their own credentials.
    if (path === COMPUTER_API_PREFIX || path.startsWith(`${COMPUTER_API_PREFIX}/`)) {
      return withComputerApiCors(req, env, await handleComputerApi(req, env, ctx, path));
    }
    if (
      path === "/api/managed-agents" ||
      path.startsWith("/api/managed-agents/")
    ) {
      const caller = await authenticate(req, env, ctx);
      if (!caller) {
        return json({ error: "missing or invalid API key" }, 401);
      }
      if (path === "/api/managed-agents/sessions" && req.method === "POST") {
        try {
          const billing = await enableManagedBilling(env, caller.orgID, (id) =>
            selfHealHalt(env, id),
          );
          if (billing.status === "halted") {
            return haltedOrgResponse(req, env, ctx, caller.orgID);
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
      } else {
        const creditError = await enforceManagedAgentCreditGate(
          req,
          env,
          caller.orgID,
          (id) => selfHealHalt(env, id),
          (p) => ctx.waitUntil(p),
        );
        if (creditError) return creditError;
      }
      return proxyManagedAgents(
        req,
        env,
        caller,
        "/api/managed-agents",
      );
    }

    // /api/whoami — return the authenticated caller's org (+ user). Lets a
    // trusted service resolve an osb_ key to its OC org without custodying it.
    // /api/billing/credits — API-key credit status for the CLI (plan, balance,
    // low-balance flag, checkout deep links). See billing_onramp.ts.
    if (path === "/api/billing/credits" && req.method === "GET") {
      const caller = await authenticate(req, env, ctx);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      return handleCreditsStatus(req, env, caller, (p) => ctx.waitUntil(p));
    }

    if (path === "/api/whoami" && req.method === "GET") {
      const caller = await authenticate(req, env, ctx);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      const identity = await env.OPENCOMPUTER_DB.prepare(
        `SELECT o.name AS org_name, u.email AS email
           FROM orgs o
           LEFT JOIN users u ON u.id = ?1
          WHERE o.id = ?2`,
      )
        .bind(caller.userID, caller.orgID)
        .first<{ org_name: string; email: string | null }>();
      return json({
        org_id: caller.orgID,
        user_id: caller.userID,
        email: identity?.email ?? null,
        org_name: identity?.org_name ?? null,
      });
    }

    // Any other /api/* path used to fall through to a sandbox cell. The cells
    // are gone (097 step 7.2), so it is an authenticated 404: an unknown key
    // still gets 401, and the SPA never answers an API path with index.html.
    if (path.startsWith("/api/")) {
      const caller = await authenticate(req, env, ctx);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      return json({ error: "not found" }, 404);
    }

    // Anything not matched above is the dashboard SPA — delegate to the
    // assets binding. run_worker_first=true in wrangler.toml means CF runs
    // this Worker before checking assets, so we have to explicitly hand
    // requests off here. The assets binding's not_found_handling=
    // "single-page-application" serves index.html for client-side routes.
    // Visitors who land on the app first get the site's first-touch cookie
    // here (work 087).
    if (env.ASSETS) return withFirstTouchCookie(req, await env.ASSETS.fetch(req));
    return new Response("not found", { status: 404 });
  },

  // Cron (*/5): edge-native autumn billing. Meters autumn orgs' usage_samples to
  // Autumn and halts on exhaustion. Legacy orgs bill
  // via the separate billing-rollup worker; this no-ops unless AUTUMN_SECRET_KEY
  // is set (dormant until the cutover switch is flipped). The same tick also runs
  // the token/model-usage meter (token-billing §5.4): poll each managed OpenRouter
  // key's spend → debit Autumn `model_spend` → push the markup-correct cap + halt.
  // Dormant unless OPENROUTER_PROVISIONING_KEY is set + managed keys exist.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    env = envWithD1Retry(env);
    // Telemetry retention, regardless of billing config. D1 caps a database at
    // 10 GB with no way to raise it, and when events/usage_samples reach it
    // EVERY insert fails. See retention.ts.
    ctx.waitUntil(
      runRetentionSweep(env).catch((err) => console.error("retention: run failed", err)),
    );
    // Slack Connect invite per signup, regardless of billing config. Dormant
    // unless SLACK_CONNECT_TOKEN is set. See slack_connect.ts.
    ctx.waitUntil(
      runSlackConnectInvites(env, Date.now()).catch((err) => console.error("slack-connect: run failed", err)),
    );
    // First agent session per org into #signups (work 090). Dormant unless
    // SERVERLESS_AGENTS_DB, SLACK_CONNECT_TOKEN and a channel are set.
    ctx.waitUntil(
      runActivationAlerts(env, Date.now()).catch((err) => console.error("slack-alerts: activation run failed", err)),
    );
    if (!env.AUTUMN_SECRET_KEY) return;
    ctx.waitUntil(
      runAutumnMeter(env, Date.now()).catch((err) => console.error("autumn-meter: run failed", err)),
    );
    ctx.waitUntil(
      runBillingClock(env, Date.now()).catch((err) => console.error("billing-clock: run failed", err)),
    );
    if (env.OPENROUTER_PROVISIONING_KEY) {
      ctx.waitUntil(
        runModelMeter(env, Date.now()).catch((err) => console.error("model-meter: run failed", err)),
      );
    }
  },
} satisfies ExportedHandler<Env>;
