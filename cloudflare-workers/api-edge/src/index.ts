// api-edge Worker — global API entry point.
//
// Implemented:
//   POST /api/sandboxes        — auth (D1 api_keys) → pick org.home_cell →
//                                mint capability token → proxy to that cell's
//                                CP /internal/sandboxes/create → record in
//                                sandboxes_index → return the CP's response
//   GET  /api/sandboxes        — list this org's sandboxes from sandboxes_index
//   GET  /api/sandboxes/:id    — one row + cell_endpoint
//   ANY  /api/sandboxes/:id/*  — 307 to the owning cell's CP (dumb-client path)
//   GET  /internal/halt-list   — HMAC-auth'd; halted org_ids from D1 (CP halt_reconciler)
//   GET  /auth/login           — kicks off WorkOS Authkit flow
//   GET  /auth/callback        — WorkOS code exchange → upsert user/org → session JWT cookie
//   POST /auth/logout          — clear session cookie
//   POST /auth/refresh         — rotate session JWT (extends expiry)
//   POST /auth/cli/device      — begin WorkOS device authorization for `oc login`
//   POST /auth/cli/device/exchange — poll device authorization → one ordinary org key
//   DELETE /auth/cli/credential — revoke the exact CLI-presented org key
//   POST /webhooks/stripe      — Stripe webhook → DO /mark-pro or /mark-free
//   GET  /health

export { CreditAccount } from "../../shared/credit_account";
// Shared with the vm-do worker's MicrovmSession: the same minimal HTTP/2 client,
// used here only by the dev-only direct-exec probe.
import { H2Grpc, encodeExecRequest, decodeExecResponse } from "../../shared/h2grpc";
export { PoolStock } from "./pool_stock";
// VmSession (VM-DO exec data plane) lives in its own worker
// (cloudflare-workers/vm-do) and is bound cross-script via VM_SESSIONS —
// deliberately NOT exported here, so the edge's deploy cadence (every merge
// touching web/ or edge code) can't reset the DOs and sever the host-dialed
// VM WebSockets.
import { coloGet, coloPut } from "./colo_cache";
import { handleDashboard, type DashboardEnv } from "./dashboard";
import {
  AGENT_SECURITY_NOTIFICATION_PATH,
  receiveAgentSecurityNotification,
} from "./agent_security_notifications";
import {
  autumnWebhook,
  autumnProjectInternal,
  autumnSetProviderInternal,
  browserUsageInternal,
  selfHealHalt,
  createAutumnCustomer,
} from "./autumn_webhook";
import { runAutumnMeter } from "./autumn_meter";
import { disableManagedBilling, enableManagedBilling } from "./model_billing";
import { runModelMeter } from "./model_meter";
import { runRetentionSweep } from "./retention";
import * as secretStores from "./secret_stores";
import * as snapshots from "./snapshots";
import * as templates from "./templates";
import * as webhooks from "./webhooks";
import { createAPIKey, hashAPIKey } from "./api_keys";
import {
  handleManagedAgentChannelConnection,
  proxyManagedAgents,
} from "./managed_agents";

export interface Env extends DashboardEnv {
  CF_ADMIN_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
  EVENT_SECRET: string;
  // Coarse distributed abuse limits for the two unauthenticated WorkOS device
  // endpoints. These are separate because one login normally polls exchange
  // several times after a single start request.
  CLI_AUTH_START_RATE_LIMIT: RateLimit;
  CLI_AUTH_EXCHANGE_RATE_LIMIT: RateLimit;
  // Dedicated HMAC secret for the Sessions API's minimal Agent Hook exposure
  // alert. It is intentionally not shared with other internal routes.
  OC_SECURITY_NOTIFICATION_SECRET?: string;
  // Per-org cross-cell paused-sandbox cap (default 100). Set lower on dev to
  // exercise the promotion path without paused hundreds of boxes.
  PAUSED_CAP?: string;
  // Autumn (useautumn.com) billing. AUTUMN_WEBHOOK_SECRET is the Svix signing
  // secret (whsec_…) for /webhooks/autumn. AUTUMN_SECRET_KEY / AUTUMN_BASE_URL
  // are inherited from DashboardEnv. Unset on deployments not yet on Autumn.
  AUTUMN_WEBHOOK_SECRET: string;
  // HMAC secret used by Browser API to submit runtime usage. Falls back to
  // EVENT_SECRET in the handler when unset for compatibility during rollout.
  BROWSER_USAGE_HMAC_SECRET?: string;
  // Shared with every CP via Infisical /shared/ → per-cell KV/SM. Used for
  // envelope encryption of secret_store_entries.encrypted_value. Matches
  // internal/crypto.Encryptor key format (hex-encoded 32 bytes).
  SECRET_ENCRYPTION_KEY: string;
  // Svix API token (managed webhook delivery). Region is in the token suffix.
  SVIX_API_TOKEN: string;
  // CF_API_TOKEN and CF_ZONE_ID are optional in DashboardEnv (custom domain
  // feature gates on them). Inherited.
  ASSETS?: Fetcher;
  // Optional alpha Burst Sandbox cell. When unset, burst=true creates
  // fail closed rather than silently landing on on-demand capacity.
  BURST_CELL_ID?: string;
  // act-as-org provisioning (agent-sandbox-ownership): shared HS256 secret with
  // sessions-api. When set, authenticate() accepts a signed "act for org X" JWT
  // as the API key so /v3 sandboxes are owned by + billed to the customer org.
  // Unset → the feature is inert (JWT keys rejected). See dashboard.ts.
  OC_PROVISION_SECRET?: string;
  // Token / model-usage billing (token-billing.md). The edge holds ONE OpenRouter
  // secret — a management/provisioning key — and mints per-org inference keys.
  OPENROUTER_PROVISIONING_KEY: string;
  OPENROUTER_BASE_URL?: string; // default https://openrouter.ai/api/v1
  OPENROUTER_MARKUP_BPS?: string; // env-default markup (bps) when the org's is 0
  // DEDICATED HMAC secret for handing a freshly-minted OR key to sessions-api
  // (NOT the generic internal-auth — this route carries a live model key). §6.7.5.
  OC_MANAGED_CRED_HMAC_SECRET: string;
  // Edge claim (pool_stock.ts): per-cell Durable Object stocking pre-reserved
  // hot pool boxes so default-shape creates are answered at the edge with zero
  // origin round trips. EDGE_CLAIM="0" is the kill switch (default on).
  POOL_STOCK: DurableObjectNamespace;
  EDGE_CLAIM?: string;
  // VM-DO exec data plane (vm_do_datapane_validation). One DO per sandbox holds a
  // persistent host-dialed WebSocket to the QEMU worker; exec routes edge→DO→VM
  // instead of tunnel→CP→worker, with automatic tunnel fallback when unconnected.
  // The host's /connect is authed by a per-sandbox HMAC over SESSION_JWT_SECRET
  // (see the /internal/vms/:id/connect route) — no dedicated secret.
  VM_SESSIONS: DurableObjectNamespace;
  // MicroVM exec data plane — the DO dials the box's agent directly, so exec
  // never touches the control plane. See vm-do/src/microvm_session.ts.
  MICROVM_SESSIONS: DurableObjectNamespace;
  // Off-isolate edge-claim finalize. finalizeEdgeClaim (CP claim-finalize fetch +
  // D1 index insert) was the dominant burst-create cost: run per create in
  // waitUntil, ~100 of them accumulate on the create isolate and saturate its
  // concurrent-subrequest budget, queueing every later create's pool pop. The
  // create now enqueues a tiny message and returns; the queue() consumer runs the
  // finalize on its own invocations, off the create hot path. Optional — an
  // unbound queue falls back to the old inline waitUntil (safe during rollout).
  FINALIZE_QUEUE?: Queue<FinalizeMsg>;
  DIAG?: string; // "1" enables per-op diagnostic logging (create-timing etc.)
}

// Serializable payload for the off-isolate finalize (see FINALIZE_QUEUE).
export interface FinalizeMsg {
  orgID: string;
  userID: string | null;
  cellID: string;
  baseURL: string;
  plan: string;
  billingProvider: string;
  runtime: string;
  sandboxID: string;
  workerID: string;
  bodyText: string;
}

const DEFAULT_MAX_CONCURRENT_SANDBOXES = 50;

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

// Mint the capability token the regional CP expects on /internal/sandboxes/create:
// HS256 JWT signed with SESSION_JWT_SECRET, iss="opensandbox-edge", carrying
// org_id + cell_id + plan (+ optional user_id). Mirrors auth.CapabilityClaims
// in Go. Plan flows through so the worker can tag usage_tick events without
// a per-event PG lookup.
// Cap-tokens are org+cell scoped with exp=120s — memoize for 60s so a battery's
// ~400 mints (per-DELETE proxy, finalize, CP fallback) collapse to ~1/min of
// HMAC CPU on the create/destroy hot path.
const capTokenCache = new Map<string, { token: string; mintedAtMs: number }>();

async function cachedCapToken(
  secret: string,
  orgID: string,
  cellID: string,
  plan: string,
  billingProvider: string,
  runtime: string,
  userID: string | null,
): Promise<string> {
  // runtime is in the cache key deliberately. It is the org's sandbox backend
  // assignment, and leaving it out would mean a D1 change did not take effect
  // until the entry aged out — an org would keep landing on the old runtime for
  // up to a minute after being reassigned, with nothing to explain why.
  const key = `${orgID}|${cellID}|${plan}|${billingProvider}|${runtime}|${userID ?? ""}`;
  const hit = capTokenCache.get(key);
  const nowMs = Date.now();
  if (hit && nowMs - hit.mintedAtMs < 60_000) return hit.token;
  const token = await mintCapToken(secret, orgID, cellID, plan, billingProvider, runtime, userID);
  if (capTokenCache.size >= CACHE_MAX) capTokenCache.clear();
  capTokenCache.set(key, { token, mintedAtMs: nowMs });
  return token;
}

async function mintCapToken(
  secret: string,
  orgID: string,
  cellID: string,
  plan: string,
  billingProvider: string,
  runtime: string,
  userID: string | null,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: orgID,
    iss: "opensandbox-edge",
    iat: now,
    exp: now + 120, // short-lived — it's only the edge→CP hop
    org_id: orgID,
    cell_id: cellID,
    plan,
  };
  // Only set when known; empty lets the cell keep its existing cell-PG value
  // (so a wake/preview token never clobbers an autumn flag set at create time).
  if (billingProvider) payload.billing_provider = billingProvider;
  // Which sandbox runtime this org's creates belong on (orgs.runtime). Omitted
  // when unset, and the cell reads absent as "the QEMU fleet" — so an org with
  // no assignment, and every token minted before this field existed, resolves
  // to the backend with the full feature set rather than a specialised one.
  if (runtime) payload.runtime = runtime;
  if (userID) payload.user_id = userID;
  const enc = new TextEncoder();
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacSignKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

// Cache the imported HMAC signing key. The secret is constant, but
// crypto.subtle.importKey ran on every token mint — and the create hot path
// mints per create, where the code notes the HMAC work was a top CPU item
// driving isolate queueing at burst-100. Memoize the imported CryptoKey per
// secret (shared Promise so concurrent first-callers don't double-import) so
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

// NOTE: the sandbox-scoped JWT that the create response carries is now minted in
// the PoolStock DO (mintSandboxTokenDO), once per batch rather than once per
// create — see the magazine below. It stays byte-compatible with Go's
// auth.IssueSandboxToken (same secret, iss="opensandbox", same claim names, 24h
// TTL), so cells/workers validate it identically.

interface Caller {
  orgID: string;
  userID: string | null;
  // Set only for act-as-org provisioning tokens (sessions-api). Least-privilege:
  // the dispatch gates these to sandbox + secret-store routes (provisionScopeGate).
  scope?: "sandbox-provision";
}

interface SandboxCreateResult {
  sandboxID?: string;
  workerID?: string;
  status?: string;
  memoryMB?: number;
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

// Length-hiding constant-time secret compare: hash both sides to a fixed 32
// bytes before XOR so the loop time can't leak the expected length. Used for the
// VM-DO host-dial connect secret (vm_session.ts), which arrives as a WS
// subprotocol value rather than an HMAC signature.
async function tokenMatches(provided: string | null, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

// The host presents the connect secret as the 2nd WS subprotocol, after the
// wire-format marker "oc-protobuf-v1". Browsers/proxies can't set arbitrary WS
// headers but CAN set Sec-WebSocket-Protocol, so this carries the credential on
// the upgrade without a query-string leak. Returns null if the marker is absent.
function socketSecret(req: Request): string | null {
  const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map((v) => v.trim()) ?? [];
  return protocols[0] === "oc-protobuf-v1" ? (protocols[1] ?? null) : null;
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

function stripApiKeyQueryParam(target: string): string {
  const url = new URL(target);
  url.searchParams.delete("api_key");
  return url.toString();
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
const ORG_POLICY_TTL_MS = 5_000; // short: bounds is_halted / cap staleness
// SWR window for org policy in the colo tier: a ≤60s-stale not-halted policy
// may gate a create while a background refresh runs (see loadCreateContext).
const ORG_STALE_MAX_MS = 60_000;
const LAST_USED_BUMP_MS = 60_000; // at most once/min/key/isolate
const CACHE_MAX = 10_000;

interface AuthEntry {
  caller: Caller;
  expiresAt: number | null;
  cachedAtMs: number;
  lastBumpMs: number;
  // SHA-256 of the key, carried so a cache HIT never has to recompute it
  // (bumpLastUsed + the colo tier are keyed by hash).
  hash: string;
}
// Keyed by the RAW api key, not its hash: hashing costs a crypto.subtle SHA-256
// plus a 32-byte hex encode on EVERY request, and at burst-100 that CPU
// serializes on the isolate's single JS thread — pure overhead when the answer
// is already cached. The raw key is per-isolate memory only (it arrived in this
// request's header); the SHARED colo tier stays hash-keyed, so a key is never
// persisted in plaintext.
const authCache = new Map<string, AuthEntry>();
// In-flight auth misses, keyed by raw api key — single-flights concurrent cold
// lookups so a burst doesn't fan out N identical colo/D1 reads (see authenticate).
const authInflight = new Map<string, Promise<Caller | null>>();
const orgPolicyCache = new Map<string, { policy: OrgPolicy | null; cachedAtMs: number }>();
// The create concurrency cap counts running sandboxes from the global
// sandboxes_index — a per-create D1 read. That index already trails events, so
// the cap is approximate under burst anyway; cache the count per-isolate for a
// short window so a burst fires ~one COUNT/isolate/window instead of one per
// create. Under burst the cached value reads low (index lag), so it stays
// permissive — no spurious 429s.
const CONCURRENCY_COUNT_TTL_MS = 1_500;
// Optimistic-gate stale window + headroom: a count up to 30s old may gate a
// create IF it sits at least HEADROOM below the org's limit (see
// loadCreateContext). Bounds the worst-case cap overshoot to ~HEADROOM boxes.
const CONCURRENCY_STALE_MAX_MS = 30_000;
const CONCURRENCY_STALE_HEADROOM = 8;
const concurrencyCountCache = new Map<string, { count: number; cachedAtMs: number }>();
// Sandbox → owning-cell route. proxyToCellSDK otherwise pays a blocking D1
// read per sub-op (exec run-async + each result poll = 2-3 reads per SDK
// runCommand). The route is immutable for a sandbox's lifetime — cells never
// hand off sandboxes and org ownership never changes — so no TTL: entries are
// dropped on DELETE and bounded by CACHE_MAX + isolate recycling. Populated at
// create, which also closes the same-isolate race where a sub-op lands before
// the waitUntil-deferred insertSandboxIndex write does. Never caches misses.
const sandboxRouteCache = new Map<string, { cellID: string; orgID: string }>();

// The route is immutable for a sandbox's lifetime, but a destroyed sandbox's
// entry can linger — same semantics as the isolate Map (the cell 404s). 15 min
// bounds colo-level lingering.
const ROUTE_COLO_TTL_SEC = 900;

// How long a box's agent reach-info stays cached. The AWS proxy credential is
// minted for 60 minutes and a CLAIMED box is out of the pool, so nothing
// re-mints it — the cache must expire comfortably before the credential does,
// or execs would dial with a dead token and fall back for the rest of the hour.
// 30 minutes leaves a wide margin; past it, tryMicrovmDirectExec re-fetches from
// the cell and re-caches.
const MVM_REACH_TTL_SEC = 1800;

interface MvmReach {
  endpoint: string;
  token: string;
  port: number;
}

// resolveSandboxRoute returns a sandbox's { cellID, orgID } from the route cache,
// falling back to the colo-shared tier (colo_cache.ts) and then a single D1 read
// (each hit backfills the tier above it). null = no such sandbox. Shared by
// proxyToCellSDK and the VM-DO exec fast path so both enforce the same
// org-ownership authz off the same cached mapping. The colo tier matters for the
// SDK's create → exec shape: the exec routinely lands on a different isolate
// than the create that seeded the Map, and this read is the exec path's only
// blocking D1 dependency.
async function resolveSandboxRoute(env: Env, id: string): Promise<{ cellID: string; orgID: string } | null> {
  const warm = sandboxRouteCache.get(id);
  if (warm) return warm;
  let route = await coloGet<{ cellID: string; orgID: string }>("route", id);
  if (!route) {
    const row = await env.OPENCOMPUTER_DB.prepare("SELECT cell_id, org_id FROM sandboxes_index WHERE id = ?1")
      .bind(id)
      .first<{ cell_id: string; org_id: string }>();
    if (!row) return null;
    route = { cellID: row.cell_id, orgID: row.org_id };
    await coloPut("route", id, route, ROUTE_COLO_TTL_SEC);
  }
  if (sandboxRouteCache.size >= CACHE_MAX) sandboxRouteCache.clear();
  sandboxRouteCache.set(id, route);
  return route;
}

function bumpLastUsed(env: Env, hash: string, entry: AuthEntry, nowMs: number): void {
  if (nowMs - entry.lastBumpMs < LAST_USED_BUMP_MS) return;
  entry.lastBumpMs = nowMs;
  env.OPENCOMPUTER_DB.prepare("UPDATE api_keys SET last_used = ?1 WHERE key_hash = ?2")
    .bind(Math.floor(nowMs / 1000), hash)
    .run()
    .catch(() => {});
}

async function authenticate(req: Request, env: Env): Promise<Caller | null> {
  const apiKey = apiKeyFromRequest(req);
  if (!apiKey) return null;
  // Act-as-org provisioning token (sessions-api): a signed JWT, not an osb_ key.
  // Recognized only when OC_PROVISION_SECRET is configured — inert otherwise, so
  // a stray JWT can't authenticate. The edge re-derives the org from the token;
  // create stamps it, sub-ops match it, billing follows it.
  if (
    env.OC_PROVISION_SECRET &&
    !apiKey.startsWith("osb_") &&
    apiKey.split(".").length === 3
  ) {
    return verifyProvisionToken(env.OC_PROVISION_SECRET, apiKey);
  }
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // Warm path: one Map lookup, ZERO crypto. (The hash is only needed on a miss.)
  const cached = authCache.get(apiKey);
  if (cached && nowMs - cached.cachedAtMs < AUTH_TTL_MS) {
    if (cached.expiresAt && cached.expiresAt < nowSec) return null;
    bumpLastUsed(env, cached.hash, cached, nowMs);
    return cached.caller;
  }

  // Single-flight the cold miss: a burst-100 of a fresh (uncached) key otherwise
  // fires ~100 identical SHA-256s + colo-gets + api_keys D1 reads from this one
  // isolate, piling onto the concurrent-subrequest fan-out that gates burst
  // creates. Coalesce by key so only the leader hashes and touches colo/D1; the
  // rest await it. Deleted on settle, so a revoked key still re-checks within
  // AUTH_TTL_MS.
  let inflight = authInflight.get(apiKey);
  if (!inflight) {
    inflight = resolveAuthMiss(env, apiKey);
    authInflight.set(apiKey, inflight);
    void inflight.finally(() => {
      if (authInflight.get(apiKey) === inflight) authInflight.delete(apiKey);
    });
  }
  return inflight;
}

// resolveAuthMiss is the (coalesced) cold path for authenticate(): hash → colo
// tier → D1 → populate both caches. Kept separate so authenticate() can
// single-flight it per key, and so the SHA-256 is paid ONCE per miss instead of
// once per request. Negatives are never cached (a freshly-created key must work
// at once).
async function resolveAuthMiss(env: Env, apiKey: string): Promise<Caller | null> {
  const hash = await hashAPIKey(apiKey);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // Colo tier: a fresh box's sub-ops usually land on isolates that never saw
  // this key. cachedAtMs travels with the entry so the total staleness bound
  // (revocation lag) stays AUTH_TTL_MS, not colo-TTL + isolate-TTL stacked.
  const shared = await coloGet<{ caller: Caller; expiresAt: number | null; cachedAtMs: number }>("auth", hash);
  if (shared && nowMs - shared.cachedAtMs < AUTH_TTL_MS) {
    if (shared.expiresAt && shared.expiresAt < nowSec) return null;
    if (authCache.size >= CACHE_MAX) authCache.clear();
    const entry: AuthEntry = { caller: shared.caller, expiresAt: shared.expiresAt, cachedAtMs: shared.cachedAtMs, lastBumpMs: 0, hash };
    authCache.set(apiKey, entry);
    bumpLastUsed(env, hash, entry, nowMs);
    return shared.caller;
  }

  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT org_id, created_by, expires_at FROM api_keys WHERE key_hash = ?1",
  )
    .bind(hash)
    .first<{ org_id: string; created_by: string | null; expires_at: number | null }>();
  if (!row) return null; // never cache negatives — a freshly-created key must work at once
  if (row.expires_at && row.expires_at < nowSec) return null;

  const caller: Caller = { orgID: row.org_id, userID: row.created_by };
  if (authCache.size >= CACHE_MAX) authCache.clear();
  const entry: AuthEntry = { caller, expiresAt: row.expires_at, cachedAtMs: nowMs, lastBumpMs: 0, hash };
  authCache.set(apiKey, entry);
  await coloPut("auth", hash, { caller, expiresAt: row.expires_at, cachedAtMs: nowMs }, AUTH_TTL_MS / 1000);
  bumpLastUsed(env, hash, entry, nowMs);
  return caller;
}

interface CellRow {
  cell_id: string;
  cloud: string;
  region: string;
  base_url: string;
  status: string;
  available_workers: number;
  capacity_updated_at: number | null;
}

// Cell rows are semi-static (base_url is fixed; capacity refreshes ~30s and
// isHealthy already tolerates 120s staleness). Every create AND every exec/
// sub-op resolves the cell — a burst does 100 identical reads for the same 1-2
// cells. Cache per-isolate for a short window.
const CELL_TTL_MS = 5_000;
const cellCache = new Map<string, { cell: CellRow | null; cachedAtMs: number }>();
// Per-isolate cache of the active-cells list. pickCell ran this SELECT uncached
// on every no-cellId create — ~65ms of the burst prework. Cells change rarely,
// so a short TTL is safe and the routing decision recomputes from cached rows.
let activeCellsCache: { cells: CellRow[]; cachedAtMs: number } | null = null;

async function listActiveCells(env: Env): Promise<CellRow[]> {
  const nowMs = Date.now();
  if (activeCellsCache && nowMs - activeCellsCache.cachedAtMs < CELL_TTL_MS) return activeCellsCache.cells;
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT cell_id, cloud, region, base_url, status, available_workers, capacity_updated_at
       FROM cells WHERE status = 'active'`,
  ).all<CellRow>();
  const cells = results ?? [];
  activeCellsCache = { cells, cachedAtMs: nowMs };
  return cells;
}

// In-flight create-context loads, keyed by org — single-flights concurrent cold
// loads so a burst-100 for one org does ONE org/count/cells load instead of 100
// (see loadCreateContext).
const createCtxInflight = new Map<
  string,
  Promise<{ org: OrgPolicy | null; activeCount: number; cells: CellRow[] }>
>();

// loadCreateContext is a thin coalescing wrapper over loadCreateContextCold: a
// fully-warm isolate returns immediately (no map churn); otherwise concurrent
// cold loads for the same org share one in-flight load. The concurrency-count
// snapshot is shared across the coalesced creates — no weaker than the existing
// gate, which already reads low under burst (the sandboxes_index count trails
// create events), so a same-instant burst overshoots identically today.
async function loadCreateContext(
  env: Env,
  orgID: string,
  ctx?: ExecutionContext,
): Promise<{ org: OrgPolicy | null; activeCount: number; cells: CellRow[] }> {
  const nowMs = Date.now();
  const oc = orgPolicyCache.get(orgID);
  const cc = concurrencyCountCache.get(orgID);
  if (
    oc !== undefined && nowMs - oc.cachedAtMs < ORG_POLICY_TTL_MS &&
    cc !== undefined && nowMs - cc.cachedAtMs < CONCURRENCY_COUNT_TTL_MS &&
    activeCellsCache !== null && nowMs - activeCellsCache.cachedAtMs < CELL_TTL_MS
  ) {
    return { org: oc.policy, activeCount: cc.count, cells: activeCellsCache.cells };
  }
  let inflight = createCtxInflight.get(orgID);
  if (!inflight) {
    inflight = loadCreateContextCold(env, orgID, ctx);
    createCtxInflight.set(orgID, inflight);
    void inflight.finally(() => {
      if (createCtxInflight.get(orgID) === inflight) createCtxInflight.delete(orgID);
    });
  }
  return inflight;
}

// loadCreateContextCold fetches the three org-keyed reads the create hot path
// needs — org policy, running-sandbox count, active-cells list — in a SINGLE D1
// round trip via db.batch(), instead of three sequential awaits. Under a cold
// burst (fresh isolates, caches empty) that collapses ~3×D1-latency into one.
// Each piece still honours + populates its existing per-isolate cache, so warm/
// sustained traffic skips D1 entirely and only the cold misses are batched.
async function loadCreateContextCold(
  env: Env,
  orgID: string,
  ctx?: ExecutionContext,
): Promise<{ org: OrgPolicy | null; activeCount: number; cells: CellRow[] }> {
  const nowMs = Date.now();
  const oc = orgPolicyCache.get(orgID);
  const cc = concurrencyCountCache.get(orgID);
  const orgWarm = oc !== undefined && nowMs - oc.cachedAtMs < ORG_POLICY_TTL_MS;
  const cntWarm = cc !== undefined && nowMs - cc.cachedAtMs < CONCURRENCY_COUNT_TTL_MS;
  const cellsWarm = activeCellsCache !== null && nowMs - activeCellsCache.cachedAtMs < CELL_TTL_MS;

  let org = orgWarm ? oc!.policy : null;
  let activeCount = cntWarm ? cc!.count : 0;
  let cells = cellsWarm ? activeCellsCache!.cells : [];

  // Colo tier: try the shared cache (same TTLs as the isolate caches) for the
  // cold pieces before falling to D1 — cross-isolate creates in the same colo
  // then skip the batch entirely. Parallel lookups; each hit backfills the
  // isolate cache so the next create here is a pure memory hit.
  let orgHave = orgWarm;
  let cntHave = cntWarm;
  let cellsHave = cellsWarm;
  // Stale-but-usable count for the optimistic concurrency gate below.
  let staleCount: { count: number; cachedAtMs: number } | null =
    cc !== undefined && nowMs - cc.cachedAtMs < CONCURRENCY_STALE_MAX_MS ? cc : null;
  {
    const [so, sc, scl] = await Promise.all([
      orgHave ? null : coloGet<{ policy: OrgPolicy | null; cachedAtMs: number }>("org", orgID),
      cntHave ? null : coloGet<{ count: number; cachedAtMs: number }>("count", orgID),
      cellsHave ? null : coloGet<{ cells: CellRow[]; cachedAtMs: number }>("cells", "active"),
    ]);
    if (so && nowMs - so.cachedAtMs < ORG_POLICY_TTL_MS) {
      org = so.policy;
      orgHave = true;
      if (orgPolicyCache.size >= CACHE_MAX) orgPolicyCache.clear();
      orgPolicyCache.set(orgID, { policy: so.policy, cachedAtMs: so.cachedAtMs });
    } else if (so && nowMs - so.cachedAtMs < ORG_STALE_MAX_MS && so.policy && !so.policy.is_halted) {
      // Stale-while-revalidate (mirrors the count gate): a ≤60s-stale,
      // not-halted org policy gates this create while a background refresh
      // brings it fresh — removing the periodic org+count D1 batch (~130ms)
      // from every Nth create. Halt latency worst case = ORG_STALE_MAX_MS.
      org = so.policy;
      orgHave = true;
      if (ctx) {
        ctx.waitUntil(
          env.OPENCOMPUTER_DB.prepare(
            "SELECT home_cell, plan, is_halted, max_concurrent_sandboxes, max_disk_mb, billing_provider, runtime FROM orgs WHERE id = ?1",
          )
            .bind(orgID)
            .first<OrgPolicy>()
            .then(async (row) => {
              const at = Date.now();
              if (orgPolicyCache.size >= CACHE_MAX) orgPolicyCache.clear();
              orgPolicyCache.set(orgID, { policy: row ?? null, cachedAtMs: at });
              await coloPut("org", orgID, { policy: row ?? null, cachedAtMs: at }, ORG_STALE_MAX_MS / 1000);
            })
            .catch(() => {}),
        );
      }
    }
    if (sc && nowMs - sc.cachedAtMs < CONCURRENCY_COUNT_TTL_MS) {
      activeCount = sc.count;
      cntHave = true;
      if (concurrencyCountCache.size >= CACHE_MAX) concurrencyCountCache.clear();
      concurrencyCountCache.set(orgID, { count: sc.count, cachedAtMs: sc.cachedAtMs });
    } else if (sc && nowMs - sc.cachedAtMs < CONCURRENCY_STALE_MAX_MS) {
      if (!staleCount || sc.cachedAtMs > staleCount.cachedAtMs) staleCount = sc;
    }
    if (scl && nowMs - scl.cachedAtMs < CELL_TTL_MS) {
      cells = scl.cells;
      cellsHave = true;
      activeCellsCache = { cells: scl.cells, cachedAtMs: scl.cachedAtMs };
    }
  }

  // Optimistic concurrency gate: the COUNT read is the last per-create D1
  // dependency once org+cells are cache-served (its 1.5s TTL is shorter than a
  // typical create→exec→destroy cycle, so it expires between benchmark-shaped
  // creates). When the org's policy is already known WITHOUT D1 and a stale
  // (≤30s) count sits comfortably below the limit, use the stale value and
  // refresh it in the background — the cap stays enforced within
  // CONCURRENCY_STALE_HEADROOM of the limit, matching the gate's existing
  // "index trails events, reads low under burst" approximate semantics. Near
  // the limit (or with nothing cached) the blocking read still happens.
  if (!cntHave && orgHave && staleCount) {
    const limit = org?.max_concurrent_sandboxes ?? DEFAULT_MAX_CONCURRENT_SANDBOXES;
    if (staleCount.count + CONCURRENCY_STALE_HEADROOM <= limit) {
      activeCount = staleCount.count;
      cntHave = true;
      const refresh = env.OPENCOMPUTER_DB.prepare(
        "SELECT COUNT(*) AS n FROM sandboxes_index WHERE org_id = ?1 AND status = 'running'",
      )
        .bind(orgID)
        .first<{ n: number }>()
        .then(async (row) => {
          const n = row?.n ?? 0;
          const at = Date.now();
          if (concurrencyCountCache.size >= CACHE_MAX) concurrencyCountCache.clear();
          concurrencyCountCache.set(orgID, { count: n, cachedAtMs: at });
          await coloPut("count", orgID, { count: n, cachedAtMs: at }, CONCURRENCY_STALE_MAX_MS / 1000);
        })
        .catch(() => {});
      if (ctx) ctx.waitUntil(refresh);
    }
  }

  const orgWarm2 = orgHave;
  const cntWarm2 = cntHave;
  const cellsWarm2 = cellsHave;

  const stmts: D1PreparedStatement[] = [];
  const kinds: Array<"org" | "count" | "cells"> = [];
  if (!orgWarm2) {
    stmts.push(
      env.OPENCOMPUTER_DB.prepare(
        "SELECT home_cell, plan, is_halted, max_concurrent_sandboxes, max_disk_mb, billing_provider, runtime FROM orgs WHERE id = ?1",
      ).bind(orgID),
    );
    kinds.push("org");
  }
  if (!cntWarm2) {
    stmts.push(
      env.OPENCOMPUTER_DB.prepare("SELECT COUNT(*) AS n FROM sandboxes_index WHERE org_id = ?1 AND status = 'running'").bind(orgID),
    );
    kinds.push("count");
  }
  if (!cellsWarm2) {
    stmts.push(
      env.OPENCOMPUTER_DB.prepare(
        "SELECT cell_id, cloud, region, base_url, status, available_workers, capacity_updated_at FROM cells WHERE status = 'active'",
      ),
    );
    kinds.push("cells");
  }

  if (stmts.length > 0) {
    const res = await env.OPENCOMPUTER_DB.batch(stmts);
    const puts: Promise<void>[] = [];
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === "org") {
        org = ((res[i].results?.[0] as OrgPolicy) ?? null);
        if (orgPolicyCache.size >= CACHE_MAX) orgPolicyCache.clear();
        orgPolicyCache.set(orgID, { policy: org, cachedAtMs: nowMs });
        puts.push(coloPut("org", orgID, { policy: org, cachedAtMs: nowMs }, ORG_STALE_MAX_MS / 1000));
      } else if (kinds[i] === "count") {
        activeCount = (res[i].results?.[0] as { n: number } | undefined)?.n ?? 0;
        if (concurrencyCountCache.size >= CACHE_MAX) concurrencyCountCache.clear();
        concurrencyCountCache.set(orgID, { count: activeCount, cachedAtMs: nowMs });
        puts.push(coloPut("count", orgID, { count: activeCount, cachedAtMs: nowMs }, CONCURRENCY_STALE_MAX_MS / 1000));
      } else {
        cells = (res[i].results as CellRow[]) ?? [];
        activeCellsCache = { cells, cachedAtMs: nowMs };
        puts.push(coloPut("cells", "active", { cells, cachedAtMs: nowMs }, CELL_TTL_MS / 1000));
      }
    }
    await Promise.all(puts);
  }
  return { org, activeCount, cells };
}

async function lookupCell(env: Env, cellID: string): Promise<CellRow | null> {
  const nowMs = Date.now();
  const c = cellCache.get(cellID);
  if (c && nowMs - c.cachedAtMs < CELL_TTL_MS) return c.cell;
  const cell = await env.OPENCOMPUTER_DB.prepare(
    `SELECT cell_id, cloud, region, base_url, status, available_workers, capacity_updated_at
       FROM cells WHERE cell_id = ?1`,
  )
    .bind(cellID)
    .first<CellRow>();
  if (cellCache.size >= CACHE_MAX) cellCache.clear();
  cellCache.set(cellID, { cell, cachedAtMs: nowMs });
  return cell;
}

// Freshness window — the CP emits capacity events every ~30s; 120s is a
// generous 4× margin that covers a missed sample without flapping.
const CAPACITY_FRESH_SEC = 120;

function isHealthy(cell: CellRow, nowSec: number): boolean {
  if (cell.status !== "active") return false;
  if (cell.capacity_updated_at == null) return false;
  if (nowSec - cell.capacity_updated_at > CAPACITY_FRESH_SEC) return false;
  if (cell.available_workers <= 0) return false;
  return true;
}

// Continent buckets used by distanceRank when cells span clouds. Coarse on
// purpose — we just need "near" vs "far" for the cascade. Unknown regions
// fall through to tier 3 (global).
//
// Region names follow the cell-id convention: AWS-style hyphenated form for
// every cloud (e.g., Azure's westus2 is mapped to us-west-2 at provision
// time, so the cells table never sees the cloud-native variant). One table
// for all clouds.
const REGION_CONTINENT: Record<string, string> = {
  // North America
  "us-east-1": "na", "us-east-2": "na",
  "us-west-1": "na", "us-west-2": "na", "us-west-3": "na",
  "us-central-1": "na", "us-north-central-1": "na", "us-south-central-1": "na",
  "ca-central-1": "na", "ca-east-1": "na",
  // Europe
  "eu-west-1": "eu", "eu-west-2": "eu", "eu-west-3": "eu",
  "eu-north-1": "eu", "eu-central-1": "eu", "eu-south-1": "eu",
  "uk-south-1": "eu", "uk-west-1": "eu",
  // Asia / Pacific
  "ap-southeast-1": "ap", "ap-southeast-2": "ap",
  "ap-northeast-1": "ap", "ap-northeast-2": "ap", "ap-northeast-3": "ap",
  "ap-east-1": "ap", "ap-south-1": "ap",
};

// Tier distance from `a` to `b`. Lower is closer.
//   0 — same cloud + same region (cell siblings)
//   1 — same cloud, different region
//   2 — different cloud, same continent
//   3 — anywhere else (different continent, or unknown region)
function distanceRank(a: CellRow, b: CellRow): number {
  if (a.cloud === b.cloud && a.region === b.region) return 0;
  if (a.cloud === b.cloud) return 1;
  const aCont = REGION_CONTINENT[a.region];
  const bCont = REGION_CONTINENT[b.region];
  if (aCont && bCont && aCont === bCont) return 2;
  return 3;
}

// pickCell — layered placement.
//   0. Hard pin from request body (cellId) — strict; if pinned cell is
//      unhealthy/missing, fail rather than silently fall back.
//   1. Healthy candidates (status+freshness+available_workers gates).
//   2. Home cell first, then siblings ordered by tier-distance from home.
//   3. First candidate with capacity wins.
// Returns null if nothing is eligible — caller turns that into 503.
async function pickCell(
  env: Env,
  homeCell: string,
  requestedCellID: string | null,
  prefetchedCells?: CellRow[],
): Promise<CellRow | null> {
  const nowSec = Math.floor(Date.now() / 1000);

  // 0. Hard pin
  if (requestedCellID) {
    const c = await lookupCell(env, requestedCellID);
    return c && isHealthy(c, nowSec) ? c : null;
  }

  // Active-cells list: use the batch-prefetched rows on the create hot path
  // (loadCreateContext), else fetch (cached).
  const results = prefetchedCells ?? (await listActiveCells(env));

  // Home anchor for distance ranking. Derive it from the active list when
  // present (no extra read); only fall back to a direct lookup if home isn't
  // active — we still want its {cloud, region} as the anchor in that case.
  let home = results.find((c) => c.cell_id === homeCell) ?? null;
  if (!home) home = await lookupCell(env, homeCell);

  const healthy = results.filter((c) => isHealthy(c, nowSec));
  if (healthy.length === 0) return null;

  if (home) {
    healthy.sort((a, b) => {
      const da = distanceRank(home, a);
      const db = distanceRank(home, b);
      if (da !== db) return da - db;
      // Tie-break: home wins ties (distance 0 to itself), then alphabetical for
      // deterministic ordering across cells the same distance from home.
      if (a.cell_id === home.cell_id) return -1;
      if (b.cell_id === home.cell_id) return 1;
      return a.cell_id.localeCompare(b.cell_id);
    });
  } else {
    // Home cell not registered in the table at all — degenerate config; pick
    // alphabetically rather than randomly so behavior is at least deterministic.
    healthy.sort((a, b) => a.cell_id.localeCompare(b.cell_id));
  }

  return healthy[0] ?? null;
}

// ── preview URL dispatch ─────────────────────────────────────────────────

// parsePreviewHost detects whether the request's hostname is a sandbox
// preview URL of the form `sb-{id}-p{port}.{anything}` and pulls out the
// sandbox_id + port. Returns null for anything else (the request falls
// through to the regular /api routes / /health / etc).
//
// The sandbox_id itself may contain hyphens (it's "sb-" + 8 hex chars in
// practice, but we don't lock the format here — only the trailing -p<port>
// shape matters), so the regex anchors `-p<digits>` at the END of the first
// subdomain label and grabs everything before it as the id.
function parsePreviewHost(hostname: string): { sandboxID: string; port: number } | null {
  const firstLabel = hostname.split(".", 1)[0];
  if (!firstLabel.startsWith("sb-")) return null;
  const m = firstLabel.match(/^(sb-.+)-p(\d+)$/);
  if (!m) return null;
  const port = Number.parseInt(m[2], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { sandboxID: m[1], port };
}

// handlePreviewURL is the edge-routed equivalent of the cell-local
// ControlPlaneProxy.Middleware: resolve the sandbox to its owning cell via
// D1, then forward the request through that cell's Tunnel to its CP's
// /internal/preview/{id}/{port}/* route. The CP synthesizes the Host
// header the worker's SandboxProxy expects, then routes to the worker.
//
// Cross-cell migration becomes invisible from this design — moving a
// sandbox from cell A to cell B updates sandboxes_index.cell_id, and the
// next request resolves to the new cell. No DNS or hostname changes.
async function handlePreviewURL(
  req: Request,
  env: Env,
  m: { sandboxID: string; port: number },
): Promise<Response> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT s.cell_id, s.status, c.base_url
       FROM sandboxes_index s
       JOIN cells c ON s.cell_id = c.cell_id
      WHERE s.id = ?1`,
  )
    .bind(m.sandboxID)
    .first<{ cell_id: string; status: string; base_url: string }>();

  if (!row) return new Response(`sandbox ${m.sandboxID} not found`, { status: 404 });
  if (row.status === "stopped" || row.status === "error") {
    return new Response(`sandbox ${m.sandboxID} is ${row.status}`, { status: 410 });
  }
  // status="hibernated" is fine — CP's doProxy will wake-on-request.

  const url = new URL(req.url);
  const base = row.base_url.replace(/\/$/, "");
  const target = `${base}/internal/preview/${m.sandboxID}/${m.port}${url.pathname}${url.search}`;

  try {
    // Forward the request as-is via the Request copy-constructor — preserves
    // method, body (including streamed/large bodies), headers, AND the
    // Upgrade: websocket handshake. Cloudflare's fetch propagates WebSocket
    // pairs transparently when both ends speak it.
    return await fetch(new Request(target, req));
  } catch (e) {
    return new Response(
      `cell ${row.cell_id} unreachable: ${(e as Error).message}`,
      { status: 502 },
    );
  }
}

// ── route handlers ───────────────────────────────────────────────────────

// OrgPolicy is the subset of the D1 `orgs` row the create/fork paths gate on.
// Mirrors runtimeMicrovm in internal/api/backend.go — the value stored in
// orgs.runtime that routes an org's creates to the AWS MicroVM backend.
const RUNTIME_MICROVM = "microvm";

interface OrgPolicy {
  home_cell: string;
  plan: string;
  is_halted: number;
  max_concurrent_sandboxes: number;
  max_disk_mb: number;
  billing_provider: string;
  // Which sandbox runtime this org's creates belong on. NULL/"" is the QEMU
  // fleet — so every org that predates this column keeps its current runtime
  // and opting one in is a single-row change.
  runtime: string | null;
}

// loadOrgPolicy reads an org's routing + policy fields from D1. Returns null
// when the org doesn't exist (callers 401).
async function loadOrgPolicy(env: Env, orgID: string): Promise<OrgPolicy | null> {
  const nowMs = Date.now();
  const cached = orgPolicyCache.get(orgID);
  if (cached && nowMs - cached.cachedAtMs < ORG_POLICY_TTL_MS) return cached.policy;
  const policy = await env.OPENCOMPUTER_DB.prepare(
    "SELECT home_cell, plan, is_halted, max_concurrent_sandboxes, max_disk_mb, billing_provider, runtime FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<OrgPolicy>();
  if (orgPolicyCache.size >= CACHE_MAX) orgPolicyCache.clear();
  orgPolicyCache.set(orgID, { policy, cachedAtMs: nowMs });
  return policy;
}

// enforceCreatePolicy applies every org-level gate for creating or forking a
// sandbox, reading authoritative state from D1 (and the CreditAccount DO for
// free orgs). Returns an error Response to short-circuit, or null when allowed.
//
// This is the edge's job post-cutover: cells are interchangeable executors
// that don't know about each other, so org policy can only be enforced
// correctly here. The concurrent limit especially — it's a count across the
// global sandboxes_index, and a per-cell count would let an org exceed its
// limit once its sandboxes spread across cells.
//
// `sizes` carries the caller-requested cpu/mem/disk; 0 means "unspecified"
// (inherit the checkpoint's value or the default), so size gates skip it —
// the defaults are always within limits.
async function enforceCreatePolicy(
  env: Env,
  orgID: string,
  org: OrgPolicy,
  sizes: { cpuCount: number; memoryMB: number; diskMB: number },
  activeCount: number,
): Promise<Response | null> {
  const plan = org.plan === "pro" ? "pro" : "free";

  // Autumn orgs: Autumn owns the balance, so the credit gate is purely the
  // is_halted projection — no CreditAccount DO. On a halt, self-heal (re-check
  // Autumn) so a just-topped-up user isn't stuck behind a lagging webhook. The
  // free-tier memory/CPU/disk ceilings below are skipped for autumn orgs (they
  // pay per GB-second); only the per-org max_disk_mb cap applies.
  if (org.billing_provider === "autumn") {
    if (org.is_halted === 1 && (await selfHealHalt(env, orgID))) {
      return json({ error: "credits exhausted — top up to resume" }, 402);
    }
  } else if (plan === "free") {
    // Legacy free-tier gate. is_halted is the D1 fast path; otherwise ask the
    // CreditAccount DO for an authoritative balance read. Pro orgs skip this.
    if (org.is_halted === 1) {
      return json({ error: "free trial credits exhausted — upgrade to resume" }, 402);
    }
    const doStub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(orgID));
    const checkResp = await doStub.fetch(`https://do/check?org_id=${encodeURIComponent(orgID)}`, { method: "POST" });
    if (checkResp.status !== 200) {
      // Don't soft-fail open — credit gating exists for a reason. A genuinely
      // down DO surfaces as a 5xx.
      return json({ error: "credit check unavailable" }, 503);
    }
    const check = await checkResp.json<{ allowed: boolean; balance_cents: number }>();
    if (!check.allowed) {
      return json({ error: "free trial credits exhausted — upgrade to resume", balance_cents: check.balance_cents }, 402);
    }
  }

  // Free-tier ceilings: 4GB / 1 vCPU, 20GB disk. Legacy only — autumn (prepaid)
  // orgs pay per GB-second and are gated by balance/halt, so they may launch any
  // size. Disk is still bounded for everyone by the per-org max_disk_mb check below.
  if (org.billing_provider !== "autumn" && plan === "free") {
    if (sizes.memoryMB > 4096 || sizes.cpuCount > 1) {
      return json({ error: "upgrade to pro for larger instances" }, 402);
    }
    if (sizes.diskMB > 20480) {
      return json({ error: "upgrade to pro for larger disk sizes" }, 402);
    }
  }

  // Per-org disk ceiling (all plans). 0 in D1 means "use the 20GB default".
  if (sizes.diskMB > 0) {
    const maxDisk = org.max_disk_mb > 0 ? org.max_disk_mb : 20480;
    if (sizes.diskMB > maxDisk) {
      return json({ error: `disk size ${sizes.diskMB}MB exceeds org limit of ${maxDisk}MB` }, 403);
    }
  }

  // Concurrent-sandbox limit (all plans). Counts `running` only — hibernated
  // sandboxes live in S3 and don't consume worker capacity. The count spans
  // every cell via the global sandboxes_index, which is the whole reason it
  // must live at the edge and not on any single cell.
  const limit = org.max_concurrent_sandboxes ?? DEFAULT_MAX_CONCURRENT_SANDBOXES;
  // active count is pre-fetched by loadCreateContext (batched with org+cells)
  // and cached there; enforceCreatePolicy no longer reads it itself.
  const active = activeCount;
  if (active >= limit) {
    return json(
      { error: `concurrent sandbox limit reached (${active}/${limit}) — hibernate or delete one before creating another`, active, limit },
      429,
    );
  }

  return null;
}

async function insertSandboxIndex(
  env: Env,
  caller: Caller,
  cellID: string,
  parsed: SandboxCreateResult,
  fallbackCpuCount: number,
  fallbackMemoryMB: number,
): Promise<void> {
  if (!parsed.sandboxID) return;
  // Guarded upsert (was INSERT OR REPLACE): the edge-claim finalize insert runs
  // ~1.5s after the box is returned, so a destroy in that window can land a
  // 'stopped' tombstone first (see the DELETE handler). The WHERE clause makes
  // this insert refuse to resurrect a row that a concurrent destroy already
  // moved to a terminal state — closing the create→destroy leak. On a normal
  // create the row doesn't exist yet, so the plain INSERT branch runs.
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO sandboxes_index
       (id, org_id, user_id, cell_id, worker_id, status, cpu_count, memory_mb, created_at, last_event_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(id) DO UPDATE SET
       org_id=excluded.org_id, user_id=excluded.user_id, cell_id=excluded.cell_id,
       worker_id=excluded.worker_id, status=excluded.status,
       cpu_count=excluded.cpu_count, memory_mb=excluded.memory_mb,
       last_event_at=excluded.last_event_at
     WHERE sandboxes_index.status NOT IN ('stopped', 'error')`,
  )
    .bind(
      parsed.sandboxID,
      caller.orgID,
      caller.userID,
      cellID,
      parsed.workerID ?? null,
      parsed.status ?? "running",
      fallbackCpuCount,
      parsed.memoryMB ?? fallbackMemoryMB,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

function indexSandboxFromSSE(
  resp: Response,
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  cellID: string,
  fallbackCpuCount: number,
  fallbackMemoryMB: number,
): Response {
  if (!resp.ok || !resp.body) return resp;

  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let indexed = false;

  const handleEvent = async () => {
    if (eventName !== "result" || dataLines.length === 0 || indexed) {
      eventName = "message";
      dataLines = [];
      return;
    }

    indexed = true;
    const data = dataLines.join("\n");
    eventName = "message";
    dataLines = [];

    try {
      const parsed = JSON.parse(data) as SandboxCreateResult;
      // Fire the D1 index write off the response path (waitUntil keeps it alive
      // after we return). Under a burst these serialize on D1's single writer,
      // so awaiting them here stretches the create tail; the index is also
      // reconciled by events-ingest, so a slightly-late row is harmless.
      ctx.waitUntil(
        insertSandboxIndex(env, caller, cellID, parsed, fallbackCpuCount, fallbackMemoryMB).catch((e) =>
          console.error("sandboxes_index SSE create insert failed:", e),
        ),
      );
    } catch (e) {
      console.error("sandboxes_index SSE create parse failed:", e);
    }
  };

  const processLine = async (line: string) => {
    if (line === "") {
      await handleEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        await processLine(line);
      }
      controller.enqueue(chunk);
    },
    async flush() {
      const tail = decoder.decode();
      if (tail) buffer += tail;
      if (buffer) await processLine(buffer);
      await handleEvent();
    },
  });

  return new Response(resp.body.pipeThrough(stream), resp);
}

// Stock shard fan-out (see pool_stock.ts for sizing): shard 0 uses the bare
// cellID as its DO name — that's the pre-sharding instance, kept addressable so
// its stock drains via claims + surplus-trim instead of stranding until TTL.
//
// SHARD_GEN: bump to mint fresh DO instances when placement went wrong — a DO
// pins to the colo of its FIRST request forever, so shards must only ever be
// first-touched by traffic from the cell's own metro (create from a sandbox in
// the cell, never a laptop). g1's shards 1-7 were armed from off-metro and
// pinned cross-country; g2 exists to re-place them. Old-gen shards strand their
// reservations at most ENTRY_TTL + the cell's 15-min reaper.
const POOL_STOCK_SHARDS = 8;
const POOL_STOCK_SHARD_GEN = "g2";

function poolStockStub(env: Env, cellID: string, shard: number): DurableObjectStub {
  const name = shard === 0 ? cellID : `${cellID}#${POOL_STOCK_SHARD_GEN}#${shard}`;
  // Deterministic placement hint: pin the stock DO to eastern North America
  // (covers eastus2 / the IAD leaderboard runner) so a claim never eats a
  // cross-colo hop even if the first touch comes from an off-metro edge. A
  // no-op for DOs already placed; guards future/new shards from the
  // first-touch-colo placement trap that previously cost ~70ms/claim.
  return env.POOL_STOCK.get(env.POOL_STOCK.idFromName(name), { locationHint: "enam" });
}

// ---------------------------------------------------------------------------
// Pool claim: one DO pop per create.
//
// There used to be a third tier here — an isolate-local "magazine" that batched
// a refill across shards and served subsequent creates from memory. It is gone.
// The idea was sound (amortize the DO subrequest + HMAC over a burst) but it
// could not be made correct: a magazine lives in isolate-local memory, so a
// burst that fragments across isolates leaves each one holding stock no other
// create can reach, and Cloudflare may evict the isolate at any time. Sizing it
// was a forced choice between over-fetching (boxes strand until the cell's
// 15-min reaper) and under-fetching (misses fall through to a 9-17s cold
// launch). Measured on dev at 100-way: of 104 boxes staged in the shards, 48
// served creates, 24 were still in the shards, and ~32 were simply gone.
//
// It was also solving the wrong problem. The magazine bought back a ~10ms
// server-side claim while every create and exec was paying ~165ms to cross the
// continent to a control plane in westus2 for boxes in us-east-1. Removing a
// tier of cache is worth more than tuning one: what remains has a single owner
// (the DO) and one expiry (ENTRY_TTL), so a box cannot be in two places.
interface PoolBox {
  id: string;
  workerID: string;
  region: string;
  sandboxDomain: string;
  token: string;
  // How to reach the box's agent, when the backend keeps its own stock and so
  // already knows. `token` above is the CUSTOMER's sandbox token; these are the
  // AWS proxy's port-scoped credential and never leave the edge. Cached at
  // create so the first exec can dial the guest without asking westus2.
  agentEndpoint?: string;
  agentToken?: string;
  agentPort?: number;
}

// claimPoolBox pops one ready-to-serve box (token already minted in the DO).
// Returns null to fall through to the CP create.
//
// One /claim-batch(count:1) against a random shard. When the shards are evenly
// stocked — the steady state, since each targets POOL_STOCK_TARGET — the first
// call hits and a create costs exactly one DO round trip. The walk below is the
// uneven-drain path, not the common one.
async function claimPoolBox(
  env: Env,
  cell: CellRow,
  orgID: string,
): Promise<{ box: PoolBox; stock: number } | null> {
  const body = JSON.stringify({
    cell: { cellID: cell.cell_id, baseURL: cell.base_url },
    orgID,
    count: 1,
  });
  let shard = Math.floor(Math.random() * POOL_STOCK_SHARDS);
  // Odd stride only, so the walk is a full cycle of the 8 shards rather than a
  // sub-orbit. An even stride shares a factor with POOL_STOCK_SHARDS and can
  // only ever reach half of them (stride 2 visits 4, stride 4 visits 2), so a
  // create could exhaust its attempts against shards that are empty while the
  // ones holding stock were unreachable by construction.
  const stride = 1 + 2 * Math.floor(Math.random() * (POOL_STOCK_SHARDS / 2));
  // Walk every shard before giving up. Measured on dev: with a 3-attempt walk,
  // 56 of 100 concurrent creates fell through to the control plane while the
  // shards still held 22-81 boxes. Falling back to a cold MicroVM launch while
  // warm stock is sitting one shard away is the expensive mistake here: those
  // creates then serialize behind the RunMicrovm 5/s quota, which is what turns
  // a burst into a 25s tail.
  for (let attempt = 0; attempt < POOL_STOCK_SHARDS; attempt++) {
    try {
      const r = await poolStockStub(env, cell.cell_id, shard).fetch("https://pool-stock/claim-batch", {
        method: "POST",
        body,
      });
      shard = (shard + stride) % POOL_STOCK_SHARDS;
      if (!r.ok) continue;
      const data = (await r.json()) as { boxes?: PoolBox[]; stock?: number };
      const b = data.boxes?.[0];
      if (!b) continue;
      return { box: b, stock: data.stock ?? -1 };
    } catch {
      shard = (shard + stride) % POOL_STOCK_SHARDS;
    }
  }
  return null;
}

// edgeClaimEligible: a create qualifies for the edge fast path only when it
// asks for exactly what pool boxes are manufactured as — base template at the
// default shape (4GB/1cpu/default disk), no guest-side customization (envs,
// secrets, image, snapshot, webhooks, preview auth). Anything else falls
// through to the cell, which handles it exactly as before (including its own
// pool claim for claimable shapes). metadata/timeout are pure bookkeeping the
// finalize call persists, so they don't disqualify.
function edgeClaimEligible(bodyText: string, b: Record<string, unknown> | null): boolean {
  if (!bodyText) return true;
  if (!b) return false; // non-empty body that didn't parse
  const template = typeof b.templateID === "string" ? b.templateID : "";
  if (template !== "" && template !== "base") return false;
  if (b.envs && Object.keys(b.envs as object).length > 0) return false;
  if (b.secretStore || b.image || b.snapshot || b.previewAuth || b.burst) return false;
  if (Array.isArray(b.webhooks) && b.webhooks.length > 0) return false;
  if (b.sandboxFamily || b.alias || b.cellId || b.networkEnabled != null) return false;
  if (typeof b.port === "number" && b.port !== 0 && b.port !== 80) return false;
  if (typeof b.cpuCount === "number" && b.cpuCount !== 0 && b.cpuCount !== 1) return false;
  if (typeof b.memoryMB === "number" && b.memoryMB !== 0 && b.memoryMB !== 4096) return false;
  if (typeof b.diskMB === "number" && b.diskMB !== 0 && b.diskMB !== 20480) return false;
  return true;
}

// finalizeEdgeClaim runs off the response path (waitUntil): D1 index row so
// the dashboard/GET sees the box, then the cell's claim-finalize (PG rebind +
// worker ClaimSandbox: billing on, idle timeout). On failure the box is dead —
// mark the index row error and drop the route so the customer's next op
// surfaces a clean failure instead of a phantom.
async function finalizeEdgeClaim(
  env: Env,
  caller: Caller,
  cell: CellRow,
  plan: string,
  billingProvider: string,
  runtime: string,
  sandboxID: string,
  workerID: string,
  bodyText: string,
): Promise<void> {
  // Index insert is DEFERRED below the finalize call + a short delay: D1 has a
  // single writer, and a create burst otherwise queues ~100 inserts exactly
  // when cold-isolate hot-path READS (auth/route/count) need D1. The colo route
  // cache serves the box's own sub-ops, and events-ingest reconciles the row
  // regardless — the insert only backstops dashboard/list visibility.
  try {
    // Minted HERE (off the response path) rather than on the create hot path —
    // only this finalize call ever consumes it on the edge-claim route, and the
    // HMAC sign was one of the larger CPU items at burst-100 concurrency.
    const capToken = await cachedCapToken(env.SESSION_JWT_SECRET, caller.orgID, cell.cell_id, plan, billingProvider, runtime, caller.userID);
    let body: Record<string, unknown> = {};
    try {
      body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch {
      /* eligibility already vetted the body; belt-and-braces */
    }
    body.sandboxID = sandboxID;
    // Bill/grow at the default create shape the box was manufactured as.
    if (!body.memoryMB) body.memoryMB = 4096;
    if (!body.cpuCount) body.cpuCount = 1;
    const r = await fetch(cell.base_url.replace(/\/$/, "") + "/internal/sandboxes/claim-finalize", {
      method: "POST",
      headers: { authorization: "Bearer " + capToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await insertSandboxIndex(env, caller, cell.cell_id, { sandboxID, workerID, status: "running", memoryMB: 4096 }, 1, 4096).catch((e) =>
      console.error(`edge-claim: index insert failed for ${sandboxID}:`, e),
    );
  } catch (e) {
    console.error(`edge-claim: FINALIZE FAILED for ${sandboxID} — marking error:`, e);
    sandboxRouteCache.delete(sandboxID);
    const nowSec = Math.floor(Date.now() / 1000);
    await env.OPENCOMPUTER_DB.prepare(
      "UPDATE sandboxes_index SET status='error', last_event_at=?2 WHERE id=?1",
    )
      .bind(sandboxID, nowSec)
      .run()
      .catch(() => {});
  }
}

async function createSandbox(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Per-phase timing → Server-Timing response header (Date.now advances on I/O
  // in Workers, so deltas attribute I/O waits; pure CPU shows ~0).
  const phases: string[] = [];
  let tPrev = Date.now();
  const mark = (name: string): void => {
    const t = Date.now();
    phases.push(`${name};dur=${t - tPrev}`);
    tPrev = t;
  };
  const caller = await authenticate(req, env);
  mark("auth");
  if (!caller) return json({ error: "missing or invalid API key" }, 401);

  // One batched D1 round-trip for org + running-count + active-cells (was three
  // serial reads on the create hot path). Cache-aware: warm isolates skip D1.
  const { org, activeCount, cells } = await loadCreateContext(env, caller.orgID, ctx);
  mark("ctx");
  if (!org) return json({ error: "org not found" }, 401);
  const plan = org.plan === "pro" ? "pro" : "free";

  // Read body once — used for size-gating, the hard-pin cell peek, and the
  // verbatim forward to the CP.
  let bodyText = await req.text();
  let requestedCellID: string | null = null;
  let bodyCpuCount = 0;
  let bodyMemoryMB = 0;
  let bodyDiskMB = 0;
  let burst = false;
  // Single parse, shared with edgeClaimEligible below (it used to re-parse —
  // measurable CPU at burst-100 where create cpuTime is the queueing driver).
  let parsedBody: Record<string, unknown> | null = null;
  try {
    if (bodyText) {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
      const parsed = parsedBody as {
        cellId?: unknown;
        cpuCount?: unknown;
        memoryMB?: unknown;
        diskMB?: unknown;
        burst?: unknown;
        image?: unknown;
        snapshot?: unknown;
      };
      if (typeof parsed.cellId === "string") requestedCellID = parsed.cellId;
      if (typeof parsed.cpuCount === "number") bodyCpuCount = parsed.cpuCount;
      if (typeof parsed.memoryMB === "number") bodyMemoryMB = parsed.memoryMB;
      if (typeof parsed.diskMB === "number") bodyDiskMB = parsed.diskMB;
      if (typeof parsed.burst === "boolean") burst = parsed.burst;

      if (burst) {
        if (!env.BURST_CELL_ID) {
          return json({ error: "Burst Sandboxes alpha is not configured" }, 503);
        }
        if (requestedCellID && requestedCellID !== env.BURST_CELL_ID) {
          return json({ error: "burst cannot be combined with a different cellId" }, 400);
        }
        if (parsed.image != null || parsed.snapshot != null) {
          return json({ error: "Burst Sandboxes do not support image or snapshot creates in alpha" }, 400);
        }
        parsed.burst = true;
        requestedCellID = env.BURST_CELL_ID;
        bodyText = JSON.stringify(parsed);
      }
    }
  } catch {
    /* malformed JSON — let the CP reject with a proper 400 */
  }

  // Every org-policy gate (billing, instance size, disk, concurrency) is
  // enforced here against D1. Cells trust the cap-token and no longer
  // re-check — see enforceCreatePolicy for why the concurrent limit in
  // particular can only be correct at the edge.
  // The org-policy gate and cell selection both depend only on `org`, so run
  // them concurrently — under a burst these were two serial D1 round-trips
  // (~90ms) sitting on the create hot path.
  const [gate, cell] = await Promise.all([
    enforceCreatePolicy(env, caller.orgID, org, {
      cpuCount: bodyCpuCount,
      memoryMB: bodyMemoryMB,
      diskMB: bodyDiskMB,
    }, activeCount),
    pickCell(env, org.home_cell, requestedCellID, cells),
  ]);
  mark("gatecell");
  if (gate) return gate;
  if (!cell) {
    return json(
      requestedCellID
        ? { error: `cell ${requestedCellID} is not available` }
        : { error: "no cells available with capacity" },
      503,
    );
  }

  // Edge claim: for a default-shape create, pop a pre-reserved hot box from
  // this cell's PoolStock DO and answer right here — token minted at the edge,
  // zero origin round trips. Finalize (billing on, PG rebind, idle timeout)
  // runs async; exec arriving before it lands routes fine (the cell proxy
  // resolves by worker_id regardless of claim status). Miss/error falls
  // through to the normal cell create, which is never worse than before.
  // NOTE: the cap-token is NOT minted here — the edge-claim response doesn't
  // need it (finalizeEdgeClaim mints its own off the response path), and the
  // HMAC sign was one of the larger CPU items driving isolate queueing at
  // burst-100. The CP-fallback path mints it below, after a miss.
  if (env.EDGE_CLAIM !== "0" && env.POOL_STOCK && edgeClaimEligible(bodyText, parsedBody)) {
    try {
      // Sharded stock (see pool_stock.ts): a single DO serializes burst claims
      // (~2ms each → ~90ms queue tail at 100-way), so claims spread across
      // POOL_STOCK_SHARDS instances. Shard 0 keeps the legacy unsharded name so
      // the pre-sharding DO (holding the fleet's stock at cutover) drains as a
      // first-class shard instead of hoarding reservations until TTL. One empty
      // shard (404) gets one retry on a different shard before the CP fallback.
      mark("cap");
      // One DO pop. The token was minted in the DO when it filled its stock, so
      // a hit costs one subrequest and no crypto on this isolate.
      const claimed = await claimPoolBox(env, cell, caller.orgID);
      const box = claimed?.box ?? null;
      if (box && claimed) {
        mark("claim");
        // Telemetry: stock left in the shard that served this claim. `dur` is a
        // value here, not a duration.
        phases.push(`stock;dur=${claimed.stock}`);
        const token = box.token;
        if (sandboxRouteCache.size >= CACHE_MAX) sandboxRouteCache.clear();
        sandboxRouteCache.set(box.id, { cellID: cell.cell_id, orgID: caller.orgID });
        // Seed the colo-shared route so the first exec — which usually lands on
        // a different isolate — skips its blocking D1 route read. waitUntil is
        // race-safe here: the client can't send that exec until the 201 crosses
        // the network (≥ one RTT), and the put lands in ~5ms.
        ctx.waitUntil(coloPut("route", box.id, { cellID: cell.cell_id, orgID: caller.orgID }, ROUTE_COLO_TTL_SEC));
        // Same trick for the box's agent reach-info, which the claim response
        // carries because the pool already knew it. This is what lets the first
        // exec dial the guest itself — see tryMicrovmDirectExec. Without it that
        // exec's only source is the control plane in westus2, a cross-country
        // round trip measured at 67-401ms, which would cost more than the whole
        // exec it is trying to enable.
        if (box.agentEndpoint && box.agentToken && box.agentPort) {
          const reach = { endpoint: box.agentEndpoint, token: box.agentToken, port: box.agentPort };
          ctx.waitUntil(coloPut("mvmreach", box.id, reach, MVM_REACH_TTL_SEC));
          // Open and immediately drop a tunnel to the box, purely to warm this
          // colo's outbound connection to its host.
          //
          // The dial cost is sharply bimodal — ~50ms or ~260ms, measured across
          // several runs — and the slow half is a cold TLS handshake to a host
          // this edge has never contacted. It used to be hidden because the
          // MicrovmSession DO had dialled the box at stock time, so the
          // connection was already warm; dialling from the edge instead moved
          // that cost onto the customer's first exec. Paying it here, on
          // waitUntil, puts it back where nobody is waiting.
          ctx.waitUntil(warmEdgeTunnel(reach));
        }
        // NOTE: the MicroVM exec channel is deliberately NOT warmed here. It is
        // warmed at stock-prep in pool_stock.ts, where the box sits idle for
        // minutes — warming from this path both loses the race against the
        // customer's first exec and fans out a DO subrequest per create under
        // burst. See PoolStock.warmMicrovmBox.
        mark("mintseed");
        const resp: Record<string, unknown> = {
          sandboxID: box.id,
          token,
          status: "running",
          region: box.region,
          workerID: box.workerID,
        };
        if (box.sandboxDomain) resp.sandboxDomain = box.sandboxDomain;
        // NOTE: the VmSession pre-wake was MOVED off this create hot path to
        // stock-prep (pool_stock.ts reserveOnce). At burst-100 the per-create
        // prewake fanned out ~100 DO /status subrequests from the create
        // isolate, saturating its subrequest budget — create p100 549ms at
        // 100-way vs ~140ms at 30-way. Warming at reserve keeps the DO hot for
        // the common case; a box that re-hibernates before claim wakes on the
        // host dial / first exec as before.
        // Finalize off the create isolate: enqueue a tiny message (one cheap
        // send) instead of running the CP fetch + D1 insert here. ~100 inline
        // finalizes otherwise accumulate on the isolate and stall the burst (dev
        // A/B: 888ms→~150ms with finalize removed from the hot path). An unbound
        // queue (rollout / non-queue env) falls back to the old inline path.
        if (env.FINALIZE_QUEUE) {
          const msg: FinalizeMsg = {
            orgID: caller.orgID,
            userID: caller.userID ?? null,
            cellID: cell.cell_id,
            baseURL: cell.base_url,
            plan,
            billingProvider: org.billing_provider,
            runtime: org.runtime ?? "",
            sandboxID: box.id,
            workerID: box.workerID,
            bodyText,
          };
          ctx.waitUntil(
            env.FINALIZE_QUEUE.send(msg).catch((e) => {
              // Enqueue failed — finalize inline so the box still binds.
              console.error(`edge-claim: finalize enqueue failed for ${box.id}, running inline:`, e);
              return finalizeEdgeClaim(env, caller, cell, plan, org.billing_provider, org.runtime ?? "", box.id, box.workerID, bodyText);
            }),
          );
        } else {
          ctx.waitUntil(finalizeEdgeClaim(env, caller, cell, plan, org.billing_provider, org.runtime ?? "", box.id, box.workerID, bodyText));
        }
        if (env.DIAG === "1") console.log(`create-timing ${box.id} ${phases.join(" ")}`);
        return new Response(JSON.stringify(resp), {
          status: 201,
          headers: { "content-type": "application/json", "server-timing": phases.join(", ") },
        });
      }
    } catch (e) {
      console.error("edge-claim: falling back to cell create:", e);
    }
  }

  // Reaching here means edge-claim was skipped or missed. Marked separately so a
  // fallback create's header shows whether it paid for a failed claim attempt
  // (DO round-trip + retry) before falling through, or never tried at all.
  mark("claimmiss");

  // CP fallback from here on — mint the cap-token the cell requires (the
  // edge-claim path above returns without ever needing it).
  const capToken = await cachedCapToken(env.SESSION_JWT_SECRET, caller.orgID, cell.cell_id, plan, org.billing_provider, org.runtime ?? "", caller.userID);
  mark("capmint");

  // SSE build streaming: image/snapshot creates can take minutes (apt installs,
  // etc.). Preserve live streaming, but index the final `result` event inline
  // before the stream closes. Relying only on async lifecycle events leaves a
  // race where immediate GET/DELETE after create sees no sandboxes_index row.
  const wantsSSE = req.headers.get("accept") === "text/event-stream";
  if (wantsSSE) {
    try {
      const cpResp = await fetch(cell.base_url.replace(/\/$/, "") + "/internal/sandboxes/create", {
        method: "POST",
        headers: { authorization: "Bearer " + capToken, "content-type": "application/json", accept: "text/event-stream" },
        body: bodyText || "{}",
      });
      return indexSandboxFromSSE(cpResp, env, ctx, caller, cell.cell_id, bodyCpuCount, bodyMemoryMB);
    } catch (e) {
      return json({ error: `cell ${cell.cell_id} unreachable: ${(e as Error).message}` }, 502);
    }
  }

  let cpResp: Response;
  try {
    cpResp = await fetch(cell.base_url.replace(/\/$/, "") + "/internal/sandboxes/create", {
      method: "POST",
      headers: { authorization: "Bearer " + capToken, "content-type": "application/json" },
      body: bodyText || "{}",
    });
  } catch (e) {
    return json({ error: `cell ${cell.cell_id} unreachable: ${(e as Error).message}` }, 502);
  }
  // The edge→cell leg, isolated. This is the fork in the road for the fallback
  // create: `cell` covers network RTT to the cell plus everything the CP does,
  // and the CP logs its own handler time, so `cell` minus that is the tunnel.
  // Everything before it is edge compute + D1.
  mark("cell");

  const cpText = await cpResp.text();
  mark("cellbody");
  if (cpResp.status >= 200 && cpResp.status < 300) {
    let parsed: SandboxCreateResult = {};
    try {
      parsed = JSON.parse(cpText);
    } catch {
      /* leave parsed empty — still record what we can */
    }
    // Seed the route cache so this isolate's sub-ops (exec/files/delete) skip
    // the sandboxes_index read — and don't race the deferred insert below.
    if (parsed.sandboxID) {
      if (sandboxRouteCache.size >= CACHE_MAX) sandboxRouteCache.clear();
      sandboxRouteCache.set(parsed.sandboxID, { cellID: cell.cell_id, orgID: caller.orgID });
      ctx.waitUntil(coloPut("route", parsed.sandboxID, { cellID: cell.cell_id, orgID: caller.orgID }, ROUTE_COLO_TTL_SEC));
    }
    // Off the response path (see indexSandboxFromSSE) — waitUntil keeps the D1
    // write alive after we return; events-ingest reconciles the row anyway.
    ctx.waitUntil(
      insertSandboxIndex(env, caller, cell.cell_id, parsed, bodyCpuCount, bodyMemoryMB).catch((e) =>
        console.error("sandboxes_index create insert failed:", e),
      ),
    );
  }
  if (env.DIAG === "1") console.log(`create-timing fallback ${cell.cell_id} ${phases.join(" ")}`);
  // Pass the CP's response through verbatim (status + body), plus the phase
  // breakdown — the edge-claim path above already returns one, and a fallback
  // create with no header is exactly the case that needed attributing.
  return new Response(cpText, {
    status: cpResp.status,
    headers: { "content-type": "application/json", "server-timing": phases.join(", ") },
  });
}

// sandboxRowToJSON reshapes a D1 sandboxes_index row into the JSON the legacy
// CP /api/sandboxes returned — which the Go CLI's types.Sandbox struct + the
// Python/TS SDKs all unmarshal against. Important translations:
//   id            → sandboxID  (Go json tag is `sandboxID`)
//   template_id   → templateID
//   cell_id       → cellID
//   worker_id     → workerID
//   created_at    → startedAt  (unix int → ISO string)
//   stopped_at    → endAt      (unix int / null → ISO string; null becomes the
//                                Go time.Time zero value, "0001-01-01T00:00:00Z")
//   cpu_count     → cpuCount
//   memory_mb     → memoryMB
interface SandboxRow {
  id: string;
  cell_id: string;
  worker_id: string | null;
  status: string;
  template_id: string | null;
  cpu_count: number | null;
  memory_mb: number | null;
  created_at: number;
  last_event_at: number | null;
  stopped_at: number | null;
}

function isoFromUnix(secs: number | null): string {
  // Go time.Time zero value when the column is NULL. The CLI tolerates this.
  if (secs == null || secs === 0) return "0001-01-01T00:00:00Z";
  return new Date(secs * 1000).toISOString();
}

function sandboxRowToJSON(r: SandboxRow): Record<string, unknown> {
  return {
    sandboxID: r.id,
    templateID: r.template_id ?? "",
    cellID: r.cell_id,
    workerID: r.worker_id ?? "",
    status: r.status,
    cpuCount: r.cpu_count ?? 0,
    memoryMB: r.memory_mb ?? 0,
    startedAt: isoFromUnix(r.created_at),
    endAt: isoFromUnix(r.stopped_at),
  };
}

async function listSandboxes(req: Request, env: Env): Promise<Response> {
  const caller = await authenticate(req, env);
  if (!caller) return json({ error: "missing or invalid API key" }, 401);
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, cell_id, worker_id, status, template_id, cpu_count, memory_mb,
            created_at, last_event_at, stopped_at
       FROM sandboxes_index WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(caller.orgID)
    .all<SandboxRow>();
  return json((results ?? []).map(sandboxRowToJSON));
}

async function getSandbox(req: Request, env: Env, id: string): Promise<Response> {
  const caller = await authenticate(req, env);
  if (!caller) return json({ error: "missing or invalid API key" }, 401);
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, org_id, cell_id, worker_id, status, template_id, cpu_count, memory_mb,
            created_at, last_event_at, stopped_at
       FROM sandboxes_index WHERE id = ?1`,
  )
    .bind(id)
    .first<SandboxRow & { org_id: string }>();
  if (!row || row.org_id !== caller.orgID) return json({ error: "sandbox not found" }, 404);
  const cell = await lookupCell(env, row.cell_id);
  return json({ ...sandboxRowToJSON(row), cellEndpoint: cell ? cell.base_url : null });
}

// tryVmDoExec routes POST /:id/exec/run-async through the sandbox's VmSession
// Durable Object (the VM-DO exec data plane, vm_do_datapane_validation) instead
// of the tunnel→CP→worker chain. Returns a Response when the DO handled it (a
// served result, or an authz 404), or null to tell the caller to fall back to
// the tunnel (proxyToCellSDK) — the automatic, flag-free degradation whenever
// the host→DO channel isn't live. The DO's 200 body is already the SDK's inline
// run-async shape ({exitCode,stdout,stderr}, no execId), so exec.run()
// short-circuits without polling — one edge→DO→host→agent hop. Authz mirrors
// proxyToCellSDK exactly (same route lookup + org-ownership check) so the DO
// path can't be used to exec on another org's sandbox. See vm_session.ts.
async function tryVmDoExec(req: Request, env: Env, ctx: ExecutionContext, caller: Caller, id: string, authMs = 0): Promise<Response | null> {
  if (!env.VM_SESSIONS) return null; // binding absent mid-cutover → tunnel
  // MicroVM-backed orgs never have a live VmSession: the host dialer that opens
  // the channel is a QEMU-worker component (internal/worker/dodialer.go), and a
  // MicroVM box has no worker behind it. So the DO can only ever answer "not
  // connected" — but it answers that only AFTER its 400ms entry grace
  // (vm_session.ts), which exists to absorb a hibernated-DO wake race that this
  // backend cannot have. Measured on prod: that grace was ~437ms of every
  // MicroVM exec — 79% of benchmark TTI, against a control plane that served
  // the exec itself in 10ms. Skip straight to the tunnel.
  const orgPolicy = await loadOrgPolicy(env, caller.orgID);
  if (orgPolicy?.runtime === RUNTIME_MICROVM) return tryMicrovmDirectExec(req, env, ctx, caller, id, authMs);
  const tRoute = Date.now();
  const route = await resolveSandboxRoute(env, id);
  const routeMs = Date.now() - tRoute;
  if (!route) return json({ error: "sandbox not found" }, 404);
  if (route.orgID !== caller.orgID) return json({ error: "sandbox not found" }, 404);
  try {
    // clone() so the original request body stays readable for the tunnel
    // fallback when the DO reports the channel isn't connected.
    const body = await req.clone().text();
    const stub = env.VM_SESSIONS.get(env.VM_SESSIONS.idFromName(id)) as DurableObjectStub & {
      execCommand?: (b: unknown, sid: string) => Promise<
        | { ok: true; exitCode: number; stdout: string; stderr: string; agentMs: number; internalMs?: number }
        | { ok: false; error: string }
      >;
    };
    const tDo = Date.now();
    // Prefer the RPC entrypoint (skips HTTP serialization on the edge→DO hop);
    // fall back to the fetch route if the DO build predates it.
    if (typeof stub.execCommand === "function") {
      let parsed: unknown = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return json({ error: "invalid body" }, 400);
      }
      const res = await stub.execCommand(parsed, id);
      const doMs = Date.now() - tDo;
      if (res.ok) {
        return new Response(JSON.stringify({ exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "server-timing": `auth;dur=${authMs}, route;dur=${routeMs}, do;dur=${doMs}, doin;dur=${res.internalMs ?? -1}, agent;dur=${res.agentMs}`,
          },
        });
      }
      console.log(`vmdo-exec ${id}: DO rpc not-connected — tunnel fallback`);
      return null;
    }
    const doResp = await stub.fetch("https://do/exec?sid=" + id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const doMs = Date.now() - tDo;
    // 200 = DO ran it. 409 (connected:false / channel error) = fall back.
    if (doResp.status === 200) {
      // agent = host-side manager.Exec time (from the result frame); do − agent
      // ≈ edge→DO + DO→host WS round trips.
      const agentMs = doResp.headers.get("x-agent-ms") ?? "-1";
      return new Response(doResp.body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "server-timing": `auth;dur=${authMs}, route;dur=${routeMs}, do;dur=${doMs}, agent;dur=${agentMs}`,
        },
      });
    }
    console.log(`vmdo-exec ${id}: DO ${doResp.status} — tunnel fallback`);
  } catch {
    // DO unreachable — fall through to the tunnel.
  }
  return null;
}

/**
 * tryMicrovmDirectExec routes POST /:id/exec/run-async straight from this
 * Worker to the sandbox's in-guest agent, and returns null to fall back to the
 * control-plane tunnel whenever it cannot.
 *
 * WHY THERE IS NO DURABLE OBJECT HERE ANY MORE
 *
 * This used to go through a MicrovmSession DO that held the agent tunnel open
 * so execs could share it. Measured on dev from an IAD client, that reuse never
 * paid for itself, because every sandbox gets its own object and the benchmark
 * shape uses it once:
 *
 *   first exec, unshared boxes    DO 137ms median / 389ms p90
 *                                 direct 90ms median / 345ms p90
 *   2nd-4th exec, same box        DO 49-74ms   direct 44-47ms
 *
 * Direct won or tied everywhere. The DO's hop plus its per-sandbox cold start
 * cost more than the dial it was avoiding. The machinery it was built on — the
 * hand-rolled HTTP/2 client in shared/h2grpc.ts — is what this path runs on, so
 * what went away is the wrapper, not the mechanism.
 *
 * The RPC itself is the steady part of all this: unary measured 15-23ms on
 * every sample in every run. Everything above that is connection setup, which
 * is where the remaining work is.
 *
 * SCOPE: one-shot Exec only. Streaming, PTY and file transfer stay on the
 * control-plane path via the null return.
 */
async function tryMicrovmDirectExec(req: Request, env: Env, ctx: ExecutionContext, caller: Caller, id: string, authMs = 0): Promise<Response | null> {
  const tRoute = Date.now();
  const route = await resolveSandboxRoute(env, id);
  const routeMs = Date.now() - tRoute;
  if (!route) return json({ error: "sandbox not found" }, 404);
  // Authorization mirrors proxyToCellSDK: this path talks to the box with a
  // credential the caller never sees, so org ownership has to be proven here.
  if (route.orgID !== caller.orgID) return json({ error: "sandbox not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await req.clone().text()) || "{}") as Record<string, unknown>;
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  // The SDK sends a single shell string; the agent's Exec takes an argv. Match
  // what the control plane does for this backend rather than word-splitting
  // here, where quoting and redirection would be silently mangled.
  const cmd = typeof body.cmd === "string" ? body.cmd : typeof body.command === "string" ? body.command : "";
  if (!cmd) return null;
  const execReq = {
    command: "/bin/sh",
    args: ["-lc", cmd],
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: (body.env as Record<string, string> | undefined) ?? undefined,
    timeoutSeconds: typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : undefined,
  };

  const tReach = Date.now();
  let reach = await coloGet<MvmReach>("mvmreach", id);
  let reachFromCell = false;
  if (!reach) {
    // Cache miss: a box claimed before this deployed, an expired credential, or
    // a colo that never saw the create. Ask the cell — expensive (it is in
    // westus2) but self-healing, because we cache what it returns.
    reach = await fetchMvmReach(env, caller, route.cellID, id);
    reachFromCell = true;
    if (!reach) return null; // not a MicroVM box, or the cell won't say — tunnel
  }
  const reachMs = Date.now() - tReach;

  const run = async (r: MvmReach): Promise<Response> => {
    const conn = await dialAgent(r);
    try {
      const res = await conn.unary("/agent.SandboxAgent/Exec", encodeExecRequest(execReq), MVM_EXEC_TIMEOUT_MS);
      return json(decodeExecResponse(res));
    } finally {
      conn.close();
    }
  };

  const tExec = Date.now();
  try {
    let resp: Response;
    try {
      resp = await run(reach);
    } catch (e) {
      // A cached credential that has aged out fails here and nowhere else, and
      // it fails for every exec until the entry expires. Re-fetch once so the
      // box heals immediately instead of an hour later. Only worth doing when
      // the credential could be stale — a fresh one from the cell just failed
      // for a different reason.
      if (reachFromCell) throw e;
      const fresh = await fetchMvmReach(env, caller, route.cellID, id);
      if (!fresh) throw e;
      resp = await run(fresh);
      reach = fresh;
    }
    const execMs = Date.now() - tExec;
    // Cache whatever actually worked. On a hit this is a cheap refresh; on a
    // miss it is the whole point — the next exec in this colo skips westus2.
    ctx.waitUntil(coloPut("mvmreach", id, reach, MVM_REACH_TTL_SEC));
    return new Response(resp.body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "server-timing": `auth;dur=${authMs}, route;dur=${routeMs}, reach;dur=${reachMs}, exec;dur=${execMs}`,
      },
    });
  } catch (e) {
    // Every failure lands here and the answer to all of them is the same: the
    // tunnel still works. Logged rather than distinguished, because a path that
    // silently degrades is worse than one that is loudly slow.
    console.log(`microvm-direct-exec ${id}: ${e} — tunnel fallback`);
    return null;
  }
}

// Bounded well under the SDK's own patience: a command that outlives this is
// one the caller has already re-run through the tunnel.
const MVM_EXEC_TIMEOUT_MS = 10_000;

/**
 * warmEdgeTunnel dials the box and drops the connection straight away, so the
 * handshake is already done when the customer's first exec dials for real.
 *
 * Errors are swallowed on purpose: this is speculative work off the create
 * path, and a box that refuses now simply means the first exec pays what it
 * would have paid anyway.
 */
async function warmEdgeTunnel(r: MvmReach): Promise<void> {
  try {
    const conn = await dialAgent(r);
    conn.close();
  } catch {
    /* first exec dials cold, exactly as it would have */
  }
}

/** dialAgent opens one agent tunnel and returns an HTTP/2 client on it. */
async function dialAgent(r: MvmReach): Promise<H2Grpc> {
  const host = r.endpoint.replace(/^https?:\/\//, "").split("/")[0];
  const up = await fetch(`https://${host}/osb/agent-grpc`, {
    signal: AbortSignal.timeout(5000),
    headers: {
      Upgrade: "websocket",
      "X-aws-proxy-auth": r.token,
      "X-aws-proxy-port": String(r.port),
    },
  });
  const ws = (up as unknown as { webSocket: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`agent tunnel upgrade failed (http ${up.status})`);
  ws.accept();
  const conn = new H2Grpc(ws, host);
  // Wait for the GUEST, not just the AWS proxy: the 101 comes from the proxy,
  // which only connects to the guest port once payload arrives. Its SETTINGS
  // frame is the first proof the agent is actually there.
  await Promise.race([
    conn.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error("guest did not answer")), 8000)),
  ]);
  return conn;
}

/**
 * fetchMvmReach asks the owning cell how to reach a sandbox's box.
 *
 * The slow path on purpose: the cell is in Azure westus2 and this is measured
 * at 67-401ms from an IAD edge. It exists so a cache miss still works, not so
 * it can be on the hot path — the create seeds the cache precisely to avoid it.
 * Returns null for a sandbox whose backend has no such endpoint.
 */
async function fetchMvmReach(env: Env, caller: Caller, cellID: string, id: string): Promise<MvmReach | null> {
  const cell = await lookupCell(env, cellID);
  if (!cell) return null;
  const org = await loadOrgPolicy(env, caller.orgID);
  const capToken = await cachedCapToken(
    env.SESSION_JWT_SECRET, caller.orgID, cellID, "",
    org?.billing_provider ?? "", org?.runtime ?? "", caller.userID,
  );
  const resp = await fetch(`${cell.base_url.replace(/\/$/, "")}/internal/microvm/direct/${id}`, {
    headers: { authorization: "Bearer " + capToken },
  });
  if (!resp.ok) return null;
  const info = await resp.json<MvmReach>();
  return info?.endpoint && info?.token && info?.port ? info : null;
}

/**
 * directExecProbe runs one exec straight from this Worker to the box's agent,
 * with no Durable Object anywhere in the path, and reports each leg separately.
 *
 * It exists to settle whether MicrovmSession earns its place on the exec path.
 * The DO's value is holding the tunnel open between execs; its cost is a hop
 * plus a cold start per sandbox. Only a measurement of the no-DO path makes
 * those comparable, and this is that measurement.
 *
 * Dev-only, and deliberately not wired into any customer route.
 */
async function directExecProbe(req: Request, env: Env, id: string): Promise<Response> {
  const caller = await authenticate(req, env);
  if (!caller) return json({ error: "unauthorized" }, 401);
  const route = await resolveSandboxRoute(env, id);
  if (!route || route.orgID !== caller.orgID) return json({ error: "sandbox not found" }, 404);

  let cmd = "node -v";
  try {
    const b = (await req.json()) as { cmd?: string };
    if (typeof b?.cmd === "string" && b.cmd) cmd = b.cmd;
  } catch {
    /* default command */
  }

  // Leg 1: reach-info. Cross-country to the control plane in westus2, and NOT
  // part of what a real direct path would cost — see the route comment.
  const tCreds = Date.now();
  const cell = await lookupCell(env, route.cellID);
  if (!cell) return json({ error: "cell not registered" }, 503);
  const org = await loadOrgPolicy(env, caller.orgID);
  const capToken = await cachedCapToken(
    env.SESSION_JWT_SECRET, caller.orgID, route.cellID, "",
    org?.billing_provider ?? "", org?.runtime ?? "", caller.userID,
  );
  const infoResp = await fetch(`${cell.base_url.replace(/\/$/, "")}/internal/microvm/direct/${id}`, {
    headers: { authorization: "Bearer " + capToken },
  });
  if (!infoResp.ok) return json({ error: `reach-info ${infoResp.status}` }, 502);
  const info = await infoResp.json<{ endpoint: string; token: string; port: number; path?: string }>();
  const credsMs = Date.now() - tCreds;

  // Leg 2: open the agent tunnel from here.
  const tDial = Date.now();
  const host = info.endpoint.replace(/^https?:\/\//, "").split("/")[0];
  let conn: H2Grpc;
  try {
    const up = await fetch(`https://${host}${info.path ?? "/osb/agent-grpc"}`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        Upgrade: "websocket",
        "X-aws-proxy-auth": info.token,
        "X-aws-proxy-port": String(info.port),
      },
    });
    const ws = (up as unknown as { webSocket: WebSocket | null }).webSocket;
    if (!ws) return json({ error: `tunnel upgrade failed (${up.status})` }, 502);
    ws.accept();
    conn = new H2Grpc(ws, host);
    await Promise.race([
      conn.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error("guest did not answer")), 8000)),
    ]);
  } catch (e) {
    return json({ error: `dial: ${e}` }, 502);
  }
  const dialMs = Date.now() - tDial;

  // Leg 3: the RPC itself.
  const tUnary = Date.now();
  try {
    const res = await conn.unary(
      "/agent.SandboxAgent/Exec",
      encodeExecRequest({ command: "/bin/sh", args: ["-lc", cmd] }),
      10_000,
    );
    const unaryMs = Date.now() - tUnary;
    return new Response(JSON.stringify(decodeExecResponse(res)), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // creds is listed but is the excluded leg; direct = dial + unary.
        "server-timing": `creds;dur=${credsMs}, dial;dur=${dialMs}, unary;dur=${unaryMs}, direct;dur=${dialMs + unaryMs}`,
      },
    });
  } catch (e) {
    return json({ error: `unary: ${e}` }, 502);
  }
}

// attachMicrovmSession teaches a DO how to reach its box. Temporary shape: the
// control plane is asked for endpoint+token on demand. The pool already holds
// both (awsvm.StockEntry), so the durable version delivers them with the box at
// claim time and this call disappears.
async function attachMicrovmSession(
  env: Env,
  caller: Caller,
  cellID: string,
  id: string,
  stub: DurableObjectStub,
  dial = false,
): Promise<boolean> {
  const cell = await lookupCell(env, cellID);
  if (!cell) return false;
  const org = await loadOrgPolicy(env, caller.orgID);
  const capToken = await cachedCapToken(
    env.SESSION_JWT_SECRET,
    caller.orgID,
    cellID,
    "",
    org?.billing_provider ?? "",
    org?.runtime ?? "",
    caller.userID,
  );
  const resp = await fetch(`${cell.base_url.replace(/\/$/, "")}/internal/microvm/direct/${id}`, {
    headers: { authorization: "Bearer " + capToken },
  });
  if (!resp.ok) return false;
  const info = await resp.json<{ endpoint: string; token: string; port: number }>();
  const att = await stub.fetch("https://do/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...info, dial }),
  });
  return att.ok;
}

// Proxy the request to the owning cell's CP. Used for SDK runtime calls
// (`/api/sandboxes/:id/exec`, `/files`, `/pty`, etc.). The caller has been
// authenticated at the edge against D1; we mint a short-lived IdentityToken
// the cell's PGAPIKeyMiddleware already accepts (audience `opencomputer-api`)
// and stream the response back. Pre-fix this was a 307 redirect, which broke
// when the SDK's API key didn't exist in cell PG (api_keys are global in D1
// now, not mirrored per-cell).

async function proxyToCellSDK(req: Request, env: Env, ctx: ExecutionContext, caller: Caller, id: string, authMs = 0, vmdoMs = 0): Promise<Response> {
  // Step timing for the data-plane path. Measured on dev, an exec through here
  // cost ~718-851ms end to end while the network legs account for only ~200ms
  // (client↔CP 118ms + CP↔box 81ms), so ~500ms was unattributed. Nothing on
  // this path emitted server-timing, which is why it stayed invisible.
  const t0 = Date.now();
  let tPrev = t0;
  const phases: string[] = [];
  if (authMs > 0) phases.push(`auth;dur=${authMs}`);
  if (vmdoMs > 0) phases.push(`vmdo;dur=${vmdoMs}`);
  const mark = (name: string): void => {
    const now = Date.now();
    phases.push(`${name};dur=${now - tPrev}`);
    tPrev = now;
  };
  // Route cache first — the sandbox→cell mapping is immutable, and the D1 read
  // it replaces is a blocking per-sub-op cost (2-3× per SDK runCommand).
  const route = await resolveSandboxRoute(env, id);
  mark("route");
  if (!route) return json({ error: "sandbox not found" }, 404);
  // Authorization: the sandbox must belong to the caller's org. Without this,
  // any authenticated org could exec/files/pty/delete/hibernate/wake another
  // org's sandbox by id (the cell trusts the edge for authz). 404 not 403 so
  // we don't leak which sandbox ids exist.
  if (route.orgID !== caller.orgID) return json({ error: "sandbox not found" }, 404);
  const cell = await lookupCell(env, route.cellID);
  mark("cell");
  if (!cell) return json({ error: `cell ${route.cellID} not registered` }, 503);

  const url = new URL(req.url);
  const target = stripApiKeyQueryParam(cell.base_url.replace(/\/$/, "") + url.pathname + url.search);
  // Look up the org's plan so the cap-token carries it (worker resolver uses
  // plan to tag usage_tick events; without it free-tier debit fan-out skips
  // the org).
  // Reuse the per-isolate org-policy cache instead of a separate per-request
  // SELECT plan — under a burst these are all the same org.
  const orgPol = await loadOrgPolicy(env, caller.orgID);
  mark("pol");
  // Mint a cap-token (iss=opensandbox-edge, signed with SESSION_JWT_SECRET).
  // The cell's PGAPIKeyMiddleware accepts cap-tokens too (alongside identity
  // tokens and API keys), so the same handler chain that runs for SDK
  // X-API-Key auth runs here. cell_id in the token guards against replay
  // against a different cell.
  // "" runtime: this token is for data-plane sub-ops on an EXISTING sandbox,
  // whose backend is already fixed by its persisted worker_id. Runtime only
  // decides placement, and placement has already happened.
  const token = await cachedCapToken(env.SESSION_JWT_SECRET, caller.orgID, route.cellID, orgPol?.plan ?? "free", "", "", caller.userID);
  mark("tok");

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    // Drop the caller's X-API-Key — the cell would try to validate it against
    // its own PG and fail. We replace it with the IdentityToken JWT below.
    if (lk === "host" || lk === "cookie" || lk === "x-api-key" || lk.startsWith("cf-") || lk.startsWith("x-forwarded-")) continue;
    headers.set(k, v);
  }
  headers.set("authorization", "Bearer " + token);

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;

  // Intercept lifecycle ops to keep D1 sandboxes_index in sync with cell PG.
  // Edge already writes the row on CREATE; here we mirror the cell's status
  // changes on DELETE / hibernate / wake. Otherwise the dashboard accumulates
  // phantoms — D1 rows stuck at "running" after the actual sandbox stopped.
  const path = url.pathname;
  // mode mirrors hibernation_mode: customer hibernate = the paused tier, wake =
  // running (NULL). Set it here (authoritative + immediate) so the cross-cell
  // paused-cap sees the box right away; the cell's async "paused" event would
  // otherwise no-op against this write's newer last_event_at.
  let postUpdate: { status: string; setStopped: boolean; mode: string | null } | null = null;
  if (req.method === "DELETE" && path === `/api/sandboxes/${id}`) {
    postUpdate = { status: "stopped", setStopped: true, mode: null };
    sandboxRouteCache.delete(id); // route is dead once the sandbox is destroyed
    // Tell the box's session DO to stop keeping itself warm. Without this its
    // alarm keeps re-dialing a terminated endpoint until the failure counter
    // gives up — bounded, but pointless work against AWS for every destroy.
    // MicroVM only: other runtimes have no MicrovmSession, and asking for one
    // by id would instantiate a Durable Object just to tear it down.
    if (env.MICROVM_SESSIONS && orgPol?.runtime === RUNTIME_MICROVM) {
      const ns = env.MICROVM_SESSIONS;
      ctx.waitUntil(
        ns
          .get(ns.idFromName(id), { locationHint: "enam" })
          .fetch("https://do/detach", { method: "POST" })
          .then(() => undefined)
          .catch(() => undefined),
      );
    }
  } else if (req.method === "POST" && path === `/api/sandboxes/${id}/hibernate`) {
    postUpdate = { status: "hibernated", setStopped: false, mode: "paused" };
  } else if (req.method === "POST" && path === `/api/sandboxes/${id}/wake`) {
    postUpdate = { status: "running", setStopped: false, mode: null };
    // Halt-gate the wake. D1 is authoritative for is_halted. The cell-side
    // gate that used to do this read the dropped orgs table post-041 and
    // silently fell through, letting halted orgs wake. Mirror the create
    // flow's halt check here so wake gets the same treatment.
    const haltRow = await env.OPENCOMPUTER_DB.prepare(
      "SELECT is_halted, billing_provider FROM orgs WHERE id = ?1",
    )
      .bind(caller.orgID)
      .first<{ is_halted: number; billing_provider: string }>();
    if (haltRow?.is_halted === 1) {
      // Autumn orgs self-heal: re-check the authoritative balance before
      // blocking a wake, so a just-topped-up user resumes without waiting for
      // the webhook/reconciler. Legacy orgs stay hard-gated on the D1 flag.
      const stillHalted =
        haltRow.billing_provider === "autumn" ? await selfHealHalt(env, caller.orgID) : true;
      if (stillHalted) {
        return json(
          { error: "org is halted — upgrade to pro or wait for credit refill" },
          402,
        );
      }
    }
  }

  // WebSocket upgrade — preserve the upgrade context by cloning the inbound
  // Request, then swap Authorization. The manual fetch + Sec-WebSocket-Key
  // copy / WebSocketPair bridge dance below was buggy ("bad handshake" on
  // the CLI side because the upgrade headers got rebuilt without proper
  // accept-key derivation). CF Workers + CF Tunnel forward WebSocket
  // upgrades transparently when you pass a Request clone — same pattern
  // handlePreviewURL uses and that's verified to work end-to-end with WS.
  if (isWebSocketUpgrade(req)) {
    const fwd = new Request(target, req);
    fwd.headers.set("authorization", "Bearer " + token);
    fwd.headers.delete("x-api-key");
    return await fetch(fwd);
  }

  // Non-WebSocket path. Run the proxy and then, on success, fan out the
  // status update to D1 so the dashboard sees the new state immediately.
  // Otherwise the dashboard accumulates phantoms — D1 rows stuck at
  // "running" after the actual sandbox stopped.
  const resp = await fetch(target, init);
  mark("origin");
  // Copy through so the step breakdown rides along with the cell's own answer.
  // Response headers are immutable, hence the rewrap.
  const timed = new Response(resp.body, resp);
  timed.headers.set("server-timing", phases.join(", "));
  if (postUpdate && resp.status >= 200 && resp.status < 300) {
    const nowSec = Math.floor(Date.now() / 1000);
    let stmt: D1PreparedStatement;
    if (postUpdate.setStopped) {
      // Tombstone UPSERT (was a bare UPDATE ... WHERE id). On an edge-claim the
      // index row is inserted ~1.5s after the box is returned (finalizeEdgeClaim
      // deferral). A destroy inside that window would UPDATE zero rows and be
      // lost, then the deferred finalize insert would resurrect the box as
      // 'running'. Writing a durable 'stopped' tombstone here — which the
      // guarded finalize upsert (insertSandboxIndex) refuses to overwrite —
      // closes the create→destroy leak regardless of which write lands first.
      stmt = env.OPENCOMPUTER_DB.prepare(
        `INSERT INTO sandboxes_index (id, org_id, user_id, cell_id, status, hibernation_mode, created_at, last_event_at, stopped_at)
         VALUES (?1, ?2, ?3, ?4, 'stopped', ?5, ?6, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET status='stopped', hibernation_mode=?5, stopped_at=?6, last_event_at=?6`,
      ).bind(id, route.orgID, caller.userID ?? null, route.cellID, postUpdate.mode, nowSec);
    } else {
      stmt = env.OPENCOMPUTER_DB.prepare(
        "UPDATE sandboxes_index SET status = ?1, hibernation_mode = ?4, last_event_at = ?2 WHERE id = ?3",
      ).bind(postUpdate.status, nowSec, id, postUpdate.mode);
    }
    // ctx.waitUntil keeps the background D1 write alive after the response
    // returns. Without it the Worker terminates the in-flight Promise and
    // the write never runs — sandboxes_index drifts behind cell PG.
    ctx.waitUntil(
      stmt.run().catch((e) => {
        console.error(`sandboxes_index ${postUpdate!.status} update failed for ${id}:`, e);
      }),
    );
  }
  return timed;
}

// proxyToCellAuthed forwards an authenticated SDK/CLI request to a cell with an
// edge-minted cap-token, replacing the caller's X-API-Key (which the cell can no
// longer validate — api_keys live in D1 post-cutover). The response is streamed
// through unbuffered, so SSE build-log streams (image/snapshot create) flow to
// the client frame-by-frame instead of being collapsed to a single JSON blob.
//
// Routing:
//   - opts.cellId set → route to that specific cell (e.g. owner_cell_id of a
//     snapshot being deleted; correct in a multi-cell world where the resource
//     lives in one cell only).
//   - opts.cellId unset → route to the org's home_cell (new-resource creates).
//
// This single helper is the backstop for every SDK route that doesn't have a
// dedicated D1-native handler: it gives correct auth + routing + streaming
// without the caller's key ever reaching the cell.
async function proxyToCellAuthed(
  req: Request,
  env: Env,
  caller: Caller,
  opts: { cellId?: string; pathOverride?: string } = {},
): Promise<Response> {
  const org = await env.OPENCOMPUTER_DB.prepare(
    "SELECT home_cell, plan FROM orgs WHERE id = ?1",
  ).bind(caller.orgID).first<{ home_cell: string; plan: string }>();
  if (!org) return json({ error: "org not found" }, 401);
  const plan = org.plan === "pro" ? "pro" : "free";

  const cell = opts.cellId
    ? await lookupCell(env, opts.cellId)
    : await pickCell(env, org.home_cell, null);
  if (!cell) return json({ error: "no cell available to serve request" }, 503);

  const token = await mintCapToken(env.SESSION_JWT_SECRET, caller.orgID, cell.cell_id, plan, "", "", caller.userID);
  const url = new URL(req.url);
  const target = cell.base_url.replace(/\/$/, "") + (opts.pathOverride ?? url.pathname) + url.search;

  // Forward all headers except the ones the cell shouldn't see: the raw
  // X-API-Key (replaced by the cap-token), the browser cookie, and CF's
  // hop-by-hop headers. WebSocket upgrades pass through transparently.
  const headers = new Headers(req.headers);
  headers.delete("x-api-key");
  headers.delete("cookie");
  headers.set("authorization", "Bearer " + token);
  if (isWebSocketUpgrade(req)) {
    const fwd = new Request(target, req);
    fwd.headers.set("authorization", "Bearer " + token);
    fwd.headers.delete("x-api-key");
    return await fetch(fwd);
  }
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
  return fetch(target, init);
}


// ── /internal/halt-list ─────────────────────────────────────────────────

// HMAC-auth'd endpoint the cell's halt_reconciler polls every 60s to
// reconcile any halt webhooks it might have missed. Returns the list of
// org_ids that the DO currently flags halted (mirrored in D1 orgs.is_halted).
// HMAC scheme matches the DO's dispatch: "{X-Timestamp}.{path-with-query}"
// signed with EVENT_SECRET (shared with CP), SHA-256 hex.
async function haltList(req: Request, env: Env): Promise<Response> {
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature headers" }, 400);
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return json({ error: "invalid timestamp" }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 5 * 60) return json({ error: "timestamp out of window" }, 401);

  const url = new URL(req.url);
  const cellID = url.searchParams.get("cell") ?? "";
  const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${url.pathname}${url.search}`);
  if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  // Return halted orgs that have any sandbox on the requesting cell. The
  // reconciler only needs to act on orgs it can do something about — orgs
  // halted with sandboxes on a DIFFERENT cell are that cell's reconciler's
  // problem. If no `cell` param is supplied, return all halted orgs (used
  // by parity-check cron / debugging).
  let results: { id: string; halted_at: number | null }[];
  if (cellID) {
    const res = await env.OPENCOMPUTER_DB.prepare(
      `SELECT DISTINCT o.id, o.halted_at
         FROM orgs o
         JOIN sandboxes_index s ON s.org_id = o.id
        WHERE o.is_halted = 1 AND s.cell_id = ?1`,
    )
      .bind(cellID)
      .all<{ id: string; halted_at: number | null }>();
    results = res.results ?? [];
  } else {
    const res = await env.OPENCOMPUTER_DB.prepare(
      `SELECT id, halted_at FROM orgs WHERE is_halted = 1`,
    ).all<{ id: string; halted_at: number | null }>();
    results = res.results ?? [];
  }
  return json({
    org_ids: results.map((r) => r.id),
    halted_at: Object.fromEntries(results.map((r) => [r.id, r.halted_at])),
    as_of: now,
  });
}

// ── /internal/org-policy ──────────────────────────────────────────────────

// HMAC-auth'd endpoint the cell pulls for an org's authoritative billing
// policy from D1. The autoscaler loop runs in-process on the cell with no
// request or cap-token to ride, so it can't get a fresh plan the way the
// resize handlers do (they read it off the cap-token). D1 is the source of
// truth for plan post-cutover — the cell's create-time-stamped cell-PG copy
// goes stale on upgrade/downgrade — so the autoscaler asks here before
// growing a sandbox past the free-tier ceiling. Same HMAC scheme as haltList.
async function orgPolicy(req: Request, env: Env): Promise<Response> {
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature headers" }, 400);
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return json({ error: "invalid timestamp" }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 5 * 60) return json({ error: "timestamp out of window" }, 401);

  const url = new URL(req.url);
  const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${url.pathname}${url.search}`);
  if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  const orgID = url.searchParams.get("org_id") ?? "";
  if (!orgID) return json({ error: "missing org_id" }, 400);
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT plan, max_memory_gb FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<{ plan: string; max_memory_gb: number }>();
  if (!row) return json({ error: "org not found" }, 404);
  return json({
    plan: row.plan === "pro" ? "pro" : "free",
    maxMemoryMb: (row.max_memory_gb ?? 0) * 1024,
  });
}

// ── /internal/usage-parity ────────────────────────────────────────────────

// HMAC-auth'd read-only endpoint the cell's usage-parity checker polls to
// compare edge-measured Pro usage against the cell's authoritative
// sandbox_scale_events. Returns per-org GB-seconds over [from,to) computed from
// the RAW tick samples (usage_samples), not the priced meter rows — the point
// is to validate measurement (ticks vs scale-event intervals) independent of
// the rollup/pricing layer, and it works for legacy and unified alike because
// GB-seconds is mode-independent.
//
// from/to are unix seconds; samples are keyed by ts (unix ms). Same HMAC scheme
// as haltList/orgPolicy. NOTE: this reads usage_samples, so the sample-retention
// window must exceed the parity lookback (samples aren't deleted at rollup, only
// flagged rolled_up).
async function usageParity(req: Request, env: Env): Promise<Response> {
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature headers" }, 400);
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return json({ error: "invalid timestamp" }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 5 * 60) return json({ error: "timestamp out of window" }, 401);

  const url = new URL(req.url);
  const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${url.pathname}${url.search}`);
  if (!constantTimeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  const from = Number.parseInt(url.searchParams.get("from") ?? "", 10);
  const to = Number.parseInt(url.searchParams.get("to") ?? "", 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return json({ error: "from/to required (unix seconds, to > from)" }, 400);
  }

  const res = await env.OPENCOMPUTER_DB.prepare(
    `SELECT org_id AS org_id,
            SUM(memory_mb * interval_s) AS mem_mb_secs,
            COUNT(*) AS samples
       FROM usage_samples
      WHERE ts >= ?1 AND ts < ?2
      GROUP BY org_id`,
  )
    .bind(from * 1000, to * 1000)
    .all<{ org_id: string; mem_mb_secs: number; samples: number }>();

  const orgs = (res.results ?? []).map((r) => ({
    org_id: r.org_id,
    gb_seconds: (r.mem_mb_secs ?? 0) / 1024,
    samples: r.samples ?? 0,
  }));
  return json({ window: { from, to }, orgs, as_of: now });
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
// `oc_session`. The same secret signs the cap-token, so the cell can
// verify a session JWT presented directly (browser fetch from dashboard)
// using the existing capTokenMiddleware — we just set Issuer="opensandbox-session"
// to distinguish.

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
}

type IdentitySelection = "browser" | "cli";

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
  if (returnTo) authURL.searchParams.set("state", JSON.stringify({ returnTo }));
  return Response.redirect(authURL.toString(), 302);
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
): Promise<ProvisionedIdentity> {
  const nowSec = Math.floor(Date.now() / 1000);
  const displayName =
    [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email;

  let userRow = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, email, name FROM users WHERE workos_user_id = ?1`,
  )
    .bind(profile.id)
    .first<{ id: string; email: string; name: string | null }>();

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
      `SELECT id, email, name FROM users WHERE workos_user_id = ?1`,
    )
      .bind(profile.id)
      .first<{ id: string; email: string; name: string | null }>();
    if (!userRow) throw new Error("workos user upsert did not resolve");
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
    const homeCell = await pickHomeCell(env, req);
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
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO orgs (id, name, slug, plan, home_cell, is_personal, owner_user_id, billing_provider, max_concurrent_sandboxes, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'free', ?4, 1, ?5, ?7, ?8, ?6, ?6)`,
    )
      .bind(
        orgID,
        orgName,
        slugify(profile.email + "-" + orgID.slice(0, 6)),
        homeCell,
        userID,
        nowSec,
        provider,
        DEFAULT_MAX_CONCURRENT_SANDBOXES,
      )
      .run();
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)`,
    )
      .bind(orgID, userID, nowSec)
      .run();
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
  };
}

async function authCallback(req: Request, env: Env): Promise<Response> {
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
  const tokenBody = await tokenResp.json<{ user: WorkOSProfile; organization_id?: string; access_token?: string }>();
  const profile = tokenBody.user;
  // WorkOS session id (sid) for the hosted logout flow — carried in our session JWT.
  const workosSessionID = workosSessionIdFromAccessToken(tokenBody.access_token);
  const identity = await provisionWorkOSIdentity(
    req,
    env,
    profile,
    tokenBody.organization_id ?? profile.organization_id,
    "browser",
  );

  // Mint session JWT — same signing secret as cap-token but a different
  // Issuer so cell middleware can distinguish.
  const sessionJWT = await mintSessionJWT(
    env.SESSION_JWT_SECRET,
    identity.org.id,
    identity.user.id,
    identity.org.plan,
    workosSessionID,
  );

  // Land on the deferred deep link if `state` carried a valid one, else the
  // dashboard. Re-validate here: `state` is attacker-influenceable, so the path
  // is only trusted after safeReturnTo passes a second time.
  let returnTo: string | null = null;
  const stateRaw = reqURL.searchParams.get("state");
  if (stateRaw) {
    try {
      returnTo = safeReturnTo((JSON.parse(stateRaw) as { returnTo?: string }).returnTo);
    } catch {
      returnTo = null;
    }
  }
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

async function authCLIExchange(req: Request, env: Env): Promise<Response> {
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
    identity = await provisionWorkOSIdentity(req, env, typedProfile, workosOrgID, "cli");
  } catch {
    return finish(cliAuthError("account_provisioning_unavailable", 503), "provisioning_error");
  }

  let credential;
  try {
    credential = await createAPIKey(env, {
      orgID: identity.org.id,
      userID: identity.user.id,
      name: credentialName,
    });
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

async function authCLIRevoke(req: Request, env: Env): Promise<Response> {
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
  if (!caller || caller.scope) {
    return finish(cliAuthError("missing or invalid API key", 401), "unauthorized");
  }
  try {
    const hash = await hashAPIKey(plainKey);
    await env.OPENCOMPUTER_DB.prepare(
      `DELETE FROM api_keys WHERE key_hash = ?1 AND org_id = ?2`,
    )
      .bind(hash, caller.orgID)
      .run();
  } catch {
    return finish(cliAuthError("credential_revocation_unavailable", 503), "storage_error");
  }
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

// pickHomeCell chooses a home cell for a brand-new org. Policy:
//   1. If the request carries a `cf-ipcountry` header, map to a continent and
//      prefer an onboarding-eligible cell whose region is on that continent.
//   2. Otherwise the first onboarding-eligible cell (alphabetical → deterministic).
//   3. None eligible → "" (downstream errors loudly).
//
// "Onboarding-eligible" = status='active' AND accepts_new_orgs=1. That gate is a
// property of the cell row itself — there's no separate env allowlist to keep in
// sync, so it can't drift from the `cells` table (which is what previously left
// new orgs with an empty home_cell). Opening a cell to new orgs is a D1 toggle,
// not a deploy. Geo lookup is intentionally coarse — continent-level is enough.
async function pickHomeCell(env: Env, req: Request): Promise<string> {
  const country = req.headers.get("cf-ipcountry") ?? "";
  const continent = COUNTRY_TO_CONTINENT[country.toUpperCase()] ?? "";

  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT cell_id, region FROM cells
       WHERE status = 'active' AND accepts_new_orgs = 1
       ORDER BY cell_id`,
  ).all<{ cell_id: string; region: string }>();
  const eligible = results ?? [];
  if (eligible.length === 0) return ""; // none open for onboarding — downstream errors

  if (continent) {
    const onContinent = eligible.find((c) => REGION_CONTINENT[c.region] === continent);
    if (onContinent) return onContinent.cell_id;
  }
  return eligible[0].cell_id;
}

// COUNTRY_TO_CONTINENT covers the countries we'd actually see on the
// edge. Missing entries fall through to "no continent hint" — we don't
// need to be exhaustive; an unknown country just means we pick the
// first active cell.
const COUNTRY_TO_CONTINENT: Record<string, string> = {
  US: "na", CA: "na", MX: "na",
  GB: "eu", IE: "eu", DE: "eu", FR: "eu", IT: "eu", ES: "eu", NL: "eu", SE: "eu", PL: "eu", CH: "eu", AT: "eu", BE: "eu", DK: "eu", FI: "eu", NO: "eu", PT: "eu", CZ: "eu",
  JP: "ap", KR: "ap", CN: "ap", IN: "ap", SG: "ap", AU: "ap", NZ: "ap", HK: "ap", TW: "ap", ID: "ap", PH: "ap", VN: "ap", TH: "ap", MY: "ap",
  BR: "sa", AR: "sa", CL: "sa", CO: "sa", PE: "sa",
  ZA: "af", NG: "af", EG: "af", KE: "af",
};

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

// Verify an act-as-org provisioning token (sessions-api → OC sandbox API),
// presented as the API key. HS256 signed with OC_PROVISION_SECRET; asserts
// "operate as org X". Mintable only by the secret holder; we re-derive org X
// from the verified token (never a client field). See agent-sandbox-ownership.md.
async function verifyProvisionToken(secret: string, token: string): Promise<Caller | null> {
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
    const p = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as {
      iss?: string; aud?: string; exp?: number; iat?: number; org_id?: string; scope?: string;
    };
    const now = Math.floor(Date.now() / 1000);
    const SKEW = 120;          // clock-skew tolerance (s)
    const MAX_AGE = 6 * 3600;  // sanity cap on lifetime; turn tokens live ~40min (maxTurnSeconds 1800 + 600)
    if (p.iss !== "sessions-api" || p.aud !== "opencomputer-api") return null;
    // P1-1: require the provisioning scope (gated to sandbox + secret-store routes).
    if (p.scope !== "sandbox-provision") return null;
    // P1-2: require finite exp + iat; reject expired, future-dated, or absurd-lifetime
    // tokens (a no-exp token is no longer accepted).
    if (typeof p.exp !== "number" || typeof p.iat !== "number") return null;
    if (p.exp <= now) return null;
    if (p.iat > now + SKEW) return null;
    if (p.exp - p.iat > MAX_AGE || p.exp > now + MAX_AGE + SKEW) return null;
    // P1-2: validate org_id shape (OC orgs are UUIDs).
    if (typeof p.org_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.org_id)) return null;
    return { orgID: p.org_id, userID: null, scope: "sandbox-provision" };
  } catch {
    return null;
  }
}

// Provision-scoped tokens (sessions-api act-as-org) are least-privilege: usable
// ONLY for sandbox + secret-store provisioning, never snapshots/images/other org
// resources. Call after authenticate() on any route OUTSIDE that allowlist to 403
// a provision token; returns null (pass) for normal org keys.
function provisionScopeGate(caller: Caller, path: string): Response | null {
  if (caller.scope !== "sandbox-provision") return null;
  if (path.startsWith("/api/sandboxes") || path.startsWith("/api/secret-stores")) return null;
  return json({ error: "forbidden: provision-scoped token is limited to sandbox + secret-store operations" }, 403);
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

// DEFAULT_PAUSED_CAP is the max RAM-resident paused sandboxes an org may hold
// across all cells. Paused boxes are free + off-quota, so this bounds per-tenant
// paused RAM; the oldest excess is promoted to deep hibernation (evicted to a
// checkpoint). Overridable per-deployment via env.PAUSED_CAP (dev lowers it to
// exercise the path). Enforced here because only D1 has the cross-cell view.
const DEFAULT_PAUSED_CAP = 100;

// runPausedCapEnforcer promotes each over-cap org's oldest paused sandboxes to
// deep hibernation, by calling the cell that hosts each one. Runs on the 5-min
// cron; the cell endpoint is idempotent (no-ops if the box already resumed or
// was promoted), so redundant calls are safe.
async function runPausedCapEnforcer(env: Env): Promise<void> {
  const cap = Number(env.PAUSED_CAP) || DEFAULT_PAUSED_CAP;
  const overCap = await env.OPENCOMPUTER_DB.prepare(
    `SELECT org_id, COUNT(*) AS n FROM sandboxes_index
      WHERE hibernation_mode = 'paused'
      GROUP BY org_id HAVING n > ?1`,
  )
    .bind(cap)
    .all<{ org_id: string; n: number }>();

  for (const org of overCap.results ?? []) {
    const excess = org.n - cap;
    const victims = await env.OPENCOMPUTER_DB.prepare(
      `SELECT s.id, s.cell_id, c.base_url
         FROM sandboxes_index s
         JOIN cells c ON s.cell_id = c.cell_id
        WHERE s.org_id = ?1 AND s.hibernation_mode = 'paused'
        ORDER BY s.last_event_at ASC
        LIMIT ?2`,
    )
      .bind(org.org_id, excess)
      .all<{ id: string; cell_id: string; base_url: string }>();

    let promoted = 0;
    for (const v of victims.results ?? []) {
      try {
        const token = await mintCapToken(env.SESSION_JWT_SECRET, org.org_id, v.cell_id, "", "", "", null);
        const resp = await fetch(
          v.base_url.replace(/\/$/, "") + `/internal/sandboxes/${v.id}/deep-hibernate`,
          { method: "POST", headers: { authorization: "Bearer " + token } },
        );
        if (resp.ok) promoted++;
        else console.error(`paused-cap: deep-hibernate ${v.id} on ${v.cell_id} → ${resp.status}`);
      } catch (err) {
        console.error(`paused-cap: deep-hibernate ${v.id} failed`, err);
      }
    }
    console.log(`paused-cap: org ${org.org_id} at ${org.n}/${cap} paused, promoted ${promoted} oldest to deep`);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Sandbox preview URL dispatch — matched by HOSTNAME, not path. Has to
    // run before the path-based routes below so that a sandbox app serving
    // its own /health or /api/* doesn't get shadowed by ours.
    const preview = parsePreviewHost(url.hostname);
    if (preview) {
      return handlePreviewURL(req, env, preview);
    }

    if (path === "/health") {
      return json({ ok: true, env: env.WORKER_ENV });
    }

    // VM-DO host dial: the QEMU worker host opens a persistent WebSocket to the
    // per-sandbox VmSession DO here (vm_session.ts). Auth is a per-sandbox connect
    // token = HMAC(SESSION_JWT_SECRET, "vmdo:"+id), minted by the CP and delivered
    // to the worker over the create/claim/wake gRPC; the worker holds no signing
    // secret. We re-derive it here from the id in the path and the shared secret
    // (same construction as auth.MintVMDOConnectToken) and compare to the token
    // the host presents as the 2nd WS subprotocol. No location hint on get() → CF
    // places the DO near the host's colo (eastus→IAD, westus2→SEA).
    {
      const vmConnect = path.match(/^\/internal\/vms\/([^/]+)\/connect$/);
      if (vmConnect && isWebSocketUpgrade(req)) {
        // 503 (not a crash) if the binding is absent — happens only during the
        // two-step cutover that moves VmSession between workers; hosts just
        // keep redialing until the rebind deploy lands.
        if (!env.VM_SESSIONS) return new Response("vm sessions unavailable", { status: 503 });
        const expected = env.SESSION_JWT_SECRET
          ? await hmacHex(env.SESSION_JWT_SECRET, "vmdo:" + vmConnect[1])
          : "";
        if (!expected || !(await tokenMatches(socketSecret(req), expected))) {
          return new Response("unauthorized", { status: 401 });
        }
        const stub = env.VM_SESSIONS.get(env.VM_SESSIONS.idFromName(vmConnect[1]));
        return stub.fetch(new Request("https://do/connect", req));
      }
    }

    if (path === "/internal/halt-list") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return haltList(req, env);
    }

    // Cell/reconciler trigger for the Autumn re-check+project (EVENT_SECRET HMAC).
    if (path === "/internal/autumn-project") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return autumnProjectInternal(req, env);
    }
    // Browser API runtime usage → Autumn browser_runtime (BROWSER_USAGE_HMAC_SECRET HMAC).
    if (path === "/internal/browser-usage") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return browserUsageInternal(req, env);
    }
    if (path === AGENT_SECURITY_NOTIFICATION_PATH) {
      return receiveAgentSecurityNotification(req, env);
    }

    // Migrate tool: flip D1 billing_provider for one org (EVENT_SECRET HMAC).
    if (path === "/internal/autumn-set-provider") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return autumnSetProviderInternal(req, env);
    }
    // Dev-only: measure what an exec would cost if the edge dialled the box
    // ITSELF instead of going through a MicrovmSession DO.
    //
    // The DO exists to hold the agent tunnel open across execs. Measured on dev
    // from an IAD client, that reuse is not paying for itself: the hop to the DO
    // plus its per-sandbox cold start costs ~77ms median, against the 22-102ms
    // dial it avoids — and it avoids it only about half the time, because every
    // sandbox gets its own object and uses it once. This route measures the
    // other side of that trade with the DO fully out of the path.
    //
    // creds;dur is reported separately and must NOT be counted against the
    // direct path: it is a round trip to the control plane in Azure westus2,
    // cross-country from this edge, and a real direct path would take the same
    // endpoint+token from the colo cache the create already passes through.
    if (path.startsWith("/internal/direct-exec-probe/") && req.method === "POST") {
      if (env.WORKER_ENV === "prod") return new Response("not found", { status: 404 });
      return directExecProbe(req, env, path.slice("/internal/direct-exec-probe/".length));
    }
    // Dev-only: force an autumn-meter run (the cron is */5). 404 in prod so only
    // the scheduled trigger moves money there. Deterministic testing aid.
    if (path === "/internal/run-autumn-meter" && req.method === "POST") {
      if (env.WORKER_ENV === "prod") return new Response("not found", { status: 404 });
      await runAutumnMeter(env, Date.now());
      return json({ ok: true });
    }
    // Dev-only: force a paused-cap enforcement run (cron is */5). Deterministic
    // testing aid for the promotion path.
    if (path === "/internal/run-paused-cap" && req.method === "POST") {
      if (env.WORKER_ENV === "prod") return new Response("not found", { status: 404 });
      await runPausedCapEnforcer(env);
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

    if (path === "/internal/org-policy") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return orgPolicy(req, env);
    }

    if (path === "/internal/usage-parity") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return usageParity(req, env);
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
      // scoped OC_MANAGED_CRED_HMAC_SECRET, so sessions-api can ensure-provision at
      // agent-create without holding the broad admin secret. `disable` stays admin-only.
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

    // /internal/secret-stores/:id — HMAC-auth'd, called by CP at sandbox-create
    // time to materialize the encrypted entry list. CP decrypts with the
    // shared SECRET_ENCRYPTION_KEY before injecting into worker env.
    if (path === "/internal/secret-stores/by-name") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return secretStores.internalGetStoreByName(req, env);
    }
    {
      const m = path.match(/^\/internal\/secret-stores\/([^/]+)$/);
      if (m) {
        if (req.method === "GET") return secretStores.internalGetStore(req, env, m[1]);
        if (req.method === "DELETE") return secretStores.internalDeleteStore(req, env, m[1]);
        return json({ error: "method not allowed" }, 405);
      }
    }

    // /internal/templates/* — HMAC-auth'd. by-name = sandbox-create lookup;
    // POST / = "save sandbox as template" registration; PUT /:id/status =
    // flip status='ready' once snapshot upload finishes.
    if (path === "/internal/templates/by-name") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return templates.internalGetByName(req, env);
    }
    if (path === "/internal/templates") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return templates.internalRegister(req, env);
    }
    {
      const m = path.match(/^\/internal\/templates\/([^/]+)\/status$/);
      if (m) {
        if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
        return templates.internalUpdateStatus(req, env, m[1]);
      }
    }

    // /internal/webhooks/register — HMAC-auth'd, called by the CP at
    // sandbox-create time to register inline webhooks (Svix endpoints) BEFORE
    // the sandbox emits `created`. (.agents/work/sandbox-webhooks-rearchitecture.md)
    if (path === "/internal/webhooks/register") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return webhooks.registerInlineWebhooksInternal(req, env, url);
    }

    // /api/secret-stores — org-scoped CRUD. Same X-API-Key auth as
    // /api/sandboxes; replaces the legacy CP-side PG routes (deleted in
    // the same PR as migration 041).
    if (path === "/api/secret-stores") {
      const caller = await authenticate(req, env);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      if (req.method === "POST") return secretStores.createStore(req, env, caller);
      if (req.method === "GET") return secretStores.listStores(req, env, caller);
      return json({ error: "method not allowed" }, 405);
    }
    {
      // /api/secret-stores/:id, /api/secret-stores/:id/secrets, /:id/secrets/:name
      const m = path.match(/^\/api\/secret-stores\/([^/]+)(?:\/secrets(?:\/([^/]+))?)?$/);
      if (m) {
        const storeID = m[1];
        const entryName = m[2];
        const isEntriesCollection = path.endsWith("/secrets");
        const isEntry = !!entryName;
        const caller = await authenticate(req, env);
        if (!caller) return json({ error: "missing or invalid API key" }, 401);
        if (isEntry) {
          if (req.method === "PUT") return secretStores.setEntry(req, env, caller, storeID, entryName);
          if (req.method === "DELETE") return secretStores.deleteEntry(req, env, caller, storeID, entryName);
          return json({ error: "method not allowed" }, 405);
        }
        if (isEntriesCollection) {
          if (req.method === "GET") return secretStores.listEntries(req, env, caller, storeID);
          return json({ error: "method not allowed" }, 405);
        }
        if (req.method === "GET") return secretStores.getStore(req, env, caller, storeID);
        if (req.method === "PUT") return secretStores.updateStore(req, env, caller, storeID);
        if (req.method === "DELETE") return secretStores.deleteStore(req, env, caller, storeID);
        return json({ error: "method not allowed" }, 405);
      }
    }

    // ── Snapshots + images (SDK/CLI, X-API-Key) ─────────────────────────
    // A snapshot is a named image; both are mirrored into D1 images_index.
    // Reads serve straight from D1 (no cell hop, multi-cell correct, survive
    // an owning-cell outage). Create routes to the org home_cell with SSE
    // build-log streaming. Delete routes to the cell that owns the bytes.
    if (path === "/api/snapshots") {
      const caller = await authenticate(req, env);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      { const g = provisionScopeGate(caller, path); if (g) return g; }
      if (req.method === "GET") return snapshots.listSnapshots(env, caller);
      if (req.method === "POST") return proxyToCellAuthed(req, env, caller); // build → home_cell, SSE
      return json({ error: "method not allowed" }, 405);
    }
    {
      // /api/snapshots/:name, /api/snapshots/:name/patches[/:patchId],
      // /api/snapshots/:name/publish, /api/snapshots/:name/unpublish
      const m = path.match(/^\/api\/snapshots\/([^/]+)(\/patches(?:\/[^/]+)?|\/(?:un)?publish)?$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        const sub = m[2] ?? "";
        const isPatch = sub.startsWith("/patches");
        const isPublishToggle = sub === "/publish" || sub === "/unpublish";
        const caller = await authenticate(req, env);
        if (!caller) return json({ error: "missing or invalid API key" }, 401);
        { const g = provisionScopeGate(caller, path); if (g) return g; }
        // Patches, publish/unpublish, and delete are cell-work — route to the
        // cell that owns the snapshot bytes (looked up from D1), not "any active
        // cell". is_public lives in the owning cell's image_cache.
        if (isPatch || isPublishToggle || req.method === "DELETE") {
          const ownerCell = await snapshots.ownerCellOfSnapshot(env, caller, name);
          if (ownerCell) return proxyToCellAuthed(req, env, caller, { cellId: ownerCell });
          // D1 images_index can lag the cell PG right after a snapshot is built.
          // For publish/unpublish (idempotent catalog toggles), fall back to the
          // org's home_cell — where a just-created snapshot lives — and let the
          // cell be the source of truth (it returns 404 if the row is really
          // absent). Patches/delete stay strict: a missing index row means the
          // bytes aren't addressable yet.
          if (isPublishToggle) return proxyToCellAuthed(req, env, caller);
          return json({ error: "snapshot not found" }, 404);
        }
        if (req.method === "GET") return snapshots.getSnapshot(env, caller, name);
        return json({ error: "method not allowed" }, 405);
      }
    }
    if (path === "/api/images") {
      const caller = await authenticate(req, env);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      { const g = provisionScopeGate(caller, path); if (g) return g; }
      if (req.method === "GET") return snapshots.listImages(env, caller);
      return json({ error: "method not allowed" }, 405);
    }

    // Auth flows. CLI device auth is deliberately edge-brokered: WorkOS tokens
    // never cross this boundary and the CLI receives one ordinary OC org key.
    if (path === "/auth/cli/device") {
      return authCLIStart(req, env);
    }
    if (path === "/auth/cli/device/exchange") {
      return authCLIExchange(req, env);
    }
    if (path === "/auth/cli/credential") {
      return authCLIRevoke(req, env);
    }

    // Browser auth flow.
    if (path === "/auth/login")    { if (req.method === "GET")  return authLogin(req, env); }
    if (path === "/auth/callback") { if (req.method === "GET")  return authCallback(req, env); }
    if (path === "/auth/logout")   { if (req.method === "POST") return authLogout(req, env); }
    if (path === "/auth/refresh")  { if (req.method === "POST") return authRefresh(req, env); }

    // Stripe webhook (test mode in app2, live in app).
    if (path === "/webhooks/stripe" && req.method === "POST") return stripeWebhook(req, env);

    // Autumn (useautumn.com) webhook — Svix-signed; projects authoritative
    // balance/plans into D1 (is_halted, max_concurrent) + dispatches to cells.
    if (path === "/webhooks/autumn" && req.method === "POST") return autumnWebhook(req, env);

    // Dashboard API — everything under /api/dashboard/*. Edge-native handlers
    // back D1 reads/writes; sandbox-runtime calls proxy to the sandbox's cell.
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
      path === "/api/managed-agents" ||
      path.startsWith("/api/managed-agents/")
    ) {
      const caller = await authenticate(req, env);
      if (!caller) {
        return json({ error: "missing or invalid API key" }, 401);
      }
      const scopeError = provisionScopeGate(caller, path);
      if (scopeError) return scopeError;
      return proxyManagedAgents(
        req,
        env,
        caller,
        "/api/managed-agents",
      );
    }

    // /api/sandboxes and /api/sandboxes/:id[/...]
    if (path === "/api/sandboxes") {
      if (req.method === "POST") return createSandbox(req, env, ctx);
      if (req.method === "GET") return listSandboxes(req, env);
      return json({ error: "method not allowed" }, 405);
    }

    // /api/sandboxes/from-checkpoint/{checkpointID} — spawn a new sandbox
    // from a checkpoint. Routing differs from regular sandbox-scoped ops
    // because the URL has no sandbox_id; we look up the cell from
    // checkpoints_index via the checkpoint UUID. The CP-side handler
    // (createFromCheckpoint) then pulls the checkpoint disks from Tigris
    // and boots a sandbox in the owning cell.
    {
      const fc = path.match(/^\/api\/sandboxes\/from-checkpoint\/([^/]+)$/);
      if (fc && req.method === "POST") {
        const caller = await authenticate(req, env);
        if (!caller) return json({ error: "missing or invalid API key" }, 401);
        const cpID = fc[1];
        const cpRow = await env.OPENCOMPUTER_DB.prepare(
          `SELECT owner_cell_id, org_id FROM checkpoints_index WHERE id = ?1`,
        )
          .bind(cpID)
          .first<{ owner_cell_id: string; org_id: string }>();
        if (!cpRow) return json({ error: "checkpoint not found" }, 404);
        if (cpRow.org_id !== caller.orgID) return json({ error: "checkpoint not in your org" }, 403);
        const cell = await lookupCell(env, cpRow.owner_cell_id);
        if (!cell) return json({ error: `cell ${cpRow.owner_cell_id} not registered` }, 503);
        const { org, activeCount: fcActive } = await loadCreateContext(env, caller.orgID);
        if (!org) return json({ error: "org not found" }, 401);
        // Read the body so we can size-gate, forward it, and record cpu/mem to
        // register the forked sandbox in sandboxes_index — same as createSandbox.
        // Without the index row, forked sandboxes run on the cell but are
        // invisible to the edge (exec/delete/get 404).
        const fcBody = await req.text();
        let fcCpu = 0;
        let fcMem = 0;
        let fcDisk = 0;
        try {
          const b = JSON.parse(fcBody || "{}");
          if (typeof b.cpuCount === "number") fcCpu = b.cpuCount;
          if (typeof b.memoryMB === "number") fcMem = b.memoryMB;
          if (typeof b.diskMB === "number") fcDisk = b.diskMB;
        } catch {
          /* malformed JSON — let the CP reject */
        }
        // Edge-authoritative org-policy gate, same as createSandbox. Forks were
        // previously ungated at the edge and leaned on a cell-side concurrent
        // check that read stale cell PG and could only ever count one cell's
        // sandboxes — wrong once an org spans cells. Enforce from D1 here.
        const fcGate = await enforceCreatePolicy(env, caller.orgID, org, { cpuCount: fcCpu, memoryMB: fcMem, diskMB: fcDisk }, fcActive);
        if (fcGate) return fcGate;
        const plan = org.plan === "pro" ? "pro" : "free";
        const token = await mintCapToken(env.SESSION_JWT_SECRET, caller.orgID, cpRow.owner_cell_id, plan, org.billing_provider, org.runtime ?? "", caller.userID);
        const fcResp = await fetch(cell.base_url.replace(/\/$/, "") + path, {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: fcBody || "{}",
        });
        const fcText = await fcResp.text();
        if (fcResp.status >= 200 && fcResp.status < 300) {
          let parsed: { sandboxID?: string; workerID?: string; status?: string; memoryMB?: number } = {};
          try {
            parsed = JSON.parse(fcText);
          } catch {
            /* leave empty */
          }
          if (parsed.sandboxID) {
            await env.OPENCOMPUTER_DB.prepare(
              `INSERT OR REPLACE INTO sandboxes_index
                 (id, org_id, user_id, cell_id, worker_id, status, cpu_count, memory_mb, created_at, last_event_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
            )
              .bind(
                parsed.sandboxID,
                caller.orgID,
                caller.userID,
                cell.cell_id,
                parsed.workerID ?? null,
                parsed.status ?? "running",
                fcCpu,
                parsed.memoryMB ?? fcMem,
                Math.floor(Date.now() / 1000),
              )
              .run();
          }
        }
        return new Response(fcText, {
          status: fcResp.status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // /api/sandboxes/checkpoints/:id[/...] — checkpoint-scoped ops (publish,
    // unpublish, patches). The URL carries no sandbox_id, so the generic
    // /api/sandboxes/:id matcher below would read "checkpoints" as a sandbox id
    // and 404 ("sandbox not found"). Route by the checkpoint's owning cell
    // (checkpoints_index), like the snapshot patch/publish paths.
    {
      const cpm = path.match(/^\/api\/sandboxes\/checkpoints\/([^/]+)(\/.*)?$/);
      if (cpm) {
        const caller = await authenticate(req, env);
        if (!caller) return json({ error: "missing or invalid API key" }, 401);
        { const g = provisionScopeGate(caller, path); if (g) return g; }
        const cpRow = await env.OPENCOMPUTER_DB.prepare(
          `SELECT owner_cell_id FROM checkpoints_index WHERE id = ?1`,
        ).bind(cpm[1]).first<{ owner_cell_id: string }>();
        if (!cpRow?.owner_cell_id) return json({ error: "checkpoint not found" }, 404);
        return proxyToCellAuthed(req, env, caller, { cellId: cpRow.owner_cell_id });
      }
    }

    const m = path.match(/^\/api\/sandboxes\/([^/]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const rest = m[2]; // undefined for /api/sandboxes/:id, "/exec/run" etc otherwise
      if (!rest) {
        if (req.method === "GET") return getSandbox(req, env, id);
        if (req.method === "DELETE") {
          const caller = await authenticate(req, env);
          if (!caller) return json({ error: "missing or invalid API key" }, 401);
          return proxyToCellSDK(req, env, ctx, caller, id);
        }
        return json({ error: "method not allowed" }, 405);
      }
      // Anything under /:id/* (exec, files, pty, hibernate, …) lives on the
      // cell — proxy with an edge-minted IdentityToken (the cell's existing
      // API-key middleware accepts that JWT shape) so we don't depend on the
      // SDK's api-key existing in cell PG.
      const tAuth = Date.now();
      const caller = await authenticate(req, env);
      const authMs = Date.now() - tAuth;
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      // VM-DO exec fast path: route POST /:id/exec/run-async through the
      // sandbox's VmSession DO. Automatic tunnel fallback (no flag) whenever the
      // channel isn't live (DO 409) — so this is safe even before/while workers
      // roll out the host dialer. Gated only on SESSION_JWT_SECRET (present
      // wherever the DO auth can be verified at all).
      let vmdoMs = 0;
      if (env.SESSION_JWT_SECRET && req.method === "POST" && rest === "/exec/run-async") {
        const tVmdo = Date.now();
        const doResp = await tryVmDoExec(req, env, ctx, caller, id, authMs);
        vmdoMs = Date.now() - tVmdo;
        if (doResp) return doResp;
      }
      // vmdo = time spent deciding NOT to use the VM-DO path. For MicroVM orgs
      // that decision needs an org-policy lookup, so it is not free.
      return proxyToCellSDK(req, env, ctx, caller, id, authMs, vmdoMs);
    }

    // Generic /api/* fallback for SDK/CLI routes without a dedicated D1-native
    // handler yet (/api/usage, /api/tags, /api/capacity/*, /api/workers,
    // /api/sessions, checkpoint patches, etc.). Authenticate against D1, mint a
    // cap-token, and route to the org's home_cell. Pre-fix this forwarded the
    // raw X-API-Key to "any active cell" — which 403'd because the cell can no
    // longer validate D1-only api_keys, and would mis-route in a multi-cell
    // world. proxyToCellAuthed streams the response (SSE-safe). This is a
    // backstop; prefer adding a native handler for high-traffic resources.
    // /api/whoami — return the authenticated caller's org (+ user). Lets a
    // trusted service resolve an osb_ key to its OC org without custodying it
    // (agent-sandbox-ownership Phase 0.5: sessions-api maps osb_ → oc-org:<id>).
    if (path === "/api/whoami" && req.method === "GET") {
      const caller = await authenticate(req, env);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      if (caller.scope) {
        return json({
          org_id: caller.orgID,
          user_id: caller.userID,
          email: null,
          org_name: null,
        });
      }
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

    // /api/webhooks* — sandbox lifecycle webhook management (Svix-backed,
    // all-at-edge). Same X-API-Key auth as the rest of the public API; must
    // precede the proxy catch-all below.
    if (path === "/api/webhooks" || path.startsWith("/api/webhooks/")) {
      const caller = await authenticate(req, env);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      return webhooks.handleWebhooksAPI(req, env, caller, url);
    }

    if (path.startsWith("/api/")) {
      const caller = await authenticate(req, env);
      if (!caller) return json({ error: "missing or invalid API key" }, 401);
      return proxyToCellAuthed(req, env, caller);
    }

    // Anything not matched above is the dashboard SPA — delegate to the
    // assets binding. run_worker_first=true in wrangler.toml means CF runs
    // this Worker before checking assets, so we have to explicitly hand
    // requests off here. The assets binding's not_found_handling=
    // "single-page-application" serves index.html for client-side routes.
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("not found", { status: 404 });
  },

  // Cron (*/5): edge-native autumn billing. Meters autumn orgs' usage_samples to
  // Autumn and halts on exhaustion — one place, not per-cell. Legacy orgs bill
  // via the separate billing-rollup worker; this no-ops unless AUTUMN_SECRET_KEY
  // is set (dormant until the cutover switch is flipped). The same tick also runs
  // the token/model-usage meter (token-billing §5.4): poll each managed OpenRouter
  // key's spend → debit Autumn `model_spend` → push the markup-correct cap + halt.
  // Dormant unless OPENROUTER_PROVISIONING_KEY is set + managed keys exist.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cross-cell paused-cap enforcement runs regardless of billing config.
    ctx.waitUntil(
      runPausedCapEnforcer(env).catch((err) => console.error("paused-cap: run failed", err)),
    );
    // Telemetry retention, also regardless of billing config. D1 caps a database
    // at 10 GB with no way to raise it, and when events/usage_samples reach it
    // EVERY insert fails — including the capacity heartbeat, which freezes
    // cells.capacity_updated_at and takes every create in the region down with
    // "no cells available with capacity". See retention.ts.
    ctx.waitUntil(
      runRetentionSweep(env).catch((err) => console.error("retention: run failed", err)),
    );
    if (!env.AUTUMN_SECRET_KEY) return;
    ctx.waitUntil(
      runAutumnMeter(env, Date.now()).catch((err) => console.error("autumn-meter: run failed", err)),
    );
    if (env.OPENROUTER_PROVISIONING_KEY) {
      ctx.waitUntil(
        runModelMeter(env, Date.now()).catch((err) => console.error("model-meter: run failed", err)),
      );
    }
  },

  // Off-isolate edge-claim finalize consumer (see FINALIZE_QUEUE). Runs on its
  // own invocations, so the CP claim-finalize fetch + D1 index insert never
  // contend with the create hot path. finalizeEdgeClaim handles its own failure
  // (marks the box error), so a message is acked once processed; genuine
  // enqueue-side failures already fell back to inline finalize at the producer.
  async queue(batch: MessageBatch<FinalizeMsg>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (m) => {
        const b = m.body;
        try {
          await finalizeEdgeClaim(
            env,
            { orgID: b.orgID, userID: b.userID } as Caller,
            { cell_id: b.cellID, base_url: b.baseURL } as CellRow,
            b.plan,
            b.billingProvider,
            b.runtime ?? "",
            b.sandboxID,
            b.workerID,
            b.bodyText,
          );
        } catch (e) {
          console.error(`finalize-queue: ${b.sandboxID} failed:`, e);
        }
        m.ack();
      }),
    );
  },
} satisfies ExportedHandler<Env, FinalizeMsg>;
