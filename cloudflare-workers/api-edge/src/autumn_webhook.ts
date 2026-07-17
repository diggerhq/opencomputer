// Autumn (useautumn.com) webhook handler — the edge projection of Autumn's
// authoritative billing state into D1, replacing the CreditAccount DO.
//
// Delivery is Svix. We verify the Svix signature, then follow the locked
// "re-check, not payload" design: the ONLY field we read from the body is
// data.customer_id (= our org id). We then GET the customer from Autumn and
// project the *authoritative* balance + plans into D1:
//   - orgs.is_halted / halted_at        (credits balance <= 0)
//   - orgs.max_concurrent_sandboxes     (highest active concurrency plan,
//                                        unless autumn_concurrency_override is set)
// On a halt/resume transition we dispatch /admin/halt-org or /admin/resume-org
// to the cells running the org's sandboxes (same HMAC scheme the DO used).
//
// Event catalog (Svix): billing.updated, billing.auto_topup_succeeded,
// balances.limit_reached, balances.usage_alert_triggered. customer.products.updated
// is Deprecated and ignored. Because we always re-check, every event is handled
// uniformly — the type only decides whether we bother projecting at all.

// AutumnApiEnv is the minimal binding set for calling Autumn's REST API
// (GetCustomer / checkout). The dashboard handlers satisfy this without the
// webhook/dispatch secrets.
export interface AutumnApiEnv {
  AUTUMN_SECRET_KEY: string;
  AUTUMN_BASE_URL?: string;
}

// AutumnSyncEnv adds D1 — enough to project Autumn state without dispatching.
export interface AutumnSyncEnv extends AutumnApiEnv {
  OPENCOMPUTER_DB: D1Database;
}

// AutumnEnv adds the secrets needed to dispatch halt to cells + verify webhooks.
export interface AutumnEnv extends AutumnSyncEnv {
  CF_ADMIN_SECRET: string;
  EVENT_SECRET: string;
  AUTUMN_WEBHOOK_SECRET: string;
  BROWSER_USAGE_HMAC_SECRET?: string;
}

const DEFAULT_BASE_URL = "https://api.useautumn.com/v1";
const CREDITS_FEATURE_ID = "credits";
const SVIX_TOLERANCE_SEC = 300;

// Mirror of internal/billing/autumn.ConcurrencyByPlan — keep in sync.
const CONCURRENCY_BY_PLAN: Record<string, number> = {
  base: 50,
  concurrency_pro: 100,
  concurrency_pro_plus: 600,
  concurrency_pro_plus_plus: 1000,
};
const DEFAULT_CONCURRENCY = 50;

const HANDLED_EVENTS = new Set([
  "billing.updated",
  "billing.auto_topup_succeeded",
  "balances.limit_reached",
  "balances.usage_alert_triggered",
]);

export interface AutumnSubscription {
  plan_id: string;
  add_on: boolean;
  status: string;
}
export interface AutumnAutoTopup {
  feature_id: string;
  enabled: boolean;
  threshold: number;
  quantity: number;
}
export interface AutumnCustomer {
  id: string;
  subscriptions?: AutumnSubscription[];
  // Completed one-off purchases. A `top_up` here means the customer has charged a
  // top-up — and since every top-up goes through the off-session flow
  // (autumnTopUpCharge), that's also when auto-recharge becomes armed. So it's our
  // "auto-recharge will fire" signal (Autumn exposes no payment-method field).
  purchases?: Array<{ plan_id: string }>;
  balances?: Record<string, { remaining?: number }>;
  billing_controls?: { auto_topups?: AutumnAutoTopup[] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function autumnWebhook(req: Request, env: AutumnEnv): Promise<Response> {
  const rawBody = await req.text();

  if (!env.AUTUMN_WEBHOOK_SECRET) {
    console.error("autumn-webhook: AUTUMN_WEBHOOK_SECRET unset — rejecting");
    return json({ error: "webhook not configured" }, 503);
  }
  if (!(await verifySvix(env.AUTUMN_WEBHOOK_SECRET, req.headers, rawBody))) {
    return json({ error: "signature mismatch" }, 401);
  }

  let evt: { type?: string; data?: { customer_id?: string } };
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const type = evt.type ?? "";
  const orgID = evt.data?.customer_id;
  // Ack-and-ignore unknown/deprecated events so Svix doesn't retry them.
  if (!HANDLED_EVENTS.has(type) || !orgID) {
    return json({ ok: true, ignored: type });
  }

  try {
    await projectOrg(env, orgID);
  } catch (err) {
    // 5xx → Svix retries with backoff (the Go reconciler is the longer backstop).
    console.error(`autumn-webhook: project ${orgID} (${type}) failed`, err);
    return json({ error: "projection failed" }, 502);
  }
  return json({ ok: true, type, org_id: orgID });
}

// autumnProjectInternal is the cell/reconciler-facing trigger for the SAME
// re-check+project logic, behind the in-house EVENT_SECRET HMAC ({ts}.{body}).
// The cell's inline halt (off track()) and the Go reconciler POST this so they
// can drive the D1 projection without owning Autumn reads or D1 writes —
// keeping all of that at the edge, exactly as the Svix path does.
export async function autumnProjectInternal(req: Request, env: AutumnEnv): Promise<Response> {
  const rawBody = await req.text();
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature headers" }, 400);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > SVIX_TOLERANCE_SEC) {
    return json({ error: "timestamp out of window" }, 401);
  }
  // POST signs {ts}.{path}{query}.{body} — matches edgeclient.sign + templates.ts.
  const url = new URL(req.url);
  const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${url.pathname}${url.search}.${rawBody}`);
  if (!timingSafeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  let payload: { org_id?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!payload.org_id) return json({ error: "org_id required" }, 400);

  try {
    await projectOrg(env, payload.org_id);
  } catch (err) {
    console.error(`autumn-webhook: internal project ${payload.org_id} failed`, err);
    return json({ error: "projection failed" }, 502);
  }
  return json({ ok: true, org_id: payload.org_id });
}


// browserUsageInternal records Browser Session runtime into Autumn. Browser API
// sends micro-USD usage at the flat OpenComputer rate and owns the idempotency
// key, so this endpoint only authenticates, validates, tracks, and projects.
export async function browserUsageInternal(req: Request, env: AutumnEnv): Promise<Response> {
  const rawBody = await req.text();
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature headers" }, 400);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > SVIX_TOLERANCE_SEC) {
    return json({ error: "timestamp out of window" }, 401);
  }
  const secret = env.BROWSER_USAGE_HMAC_SECRET || env.EVENT_SECRET;
  const url = new URL(req.url);
  const expected = await hmacHex(secret, `${ts}.${url.pathname}.${rawBody}`);
  if (!timingSafeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  let p: {
    org_id?: string;
    browser_id?: string;
    provider_session_id?: string;
    seconds?: number;
    value?: number;
    usage_micro?: number;
    idempotency_key?: string;
    feature_id?: string;
    metadata?: unknown;
  };
  try {
    p = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const featureID = p.feature_id || "browser_runtime";
  if (!p.org_id || !p.browser_id || !p.idempotency_key) {
    return json({ error: "org_id, browser_id, and idempotency_key required" }, 400);
  }
  if (featureID !== "browser_runtime") return json({ error: "unsupported feature_id" }, 400);
  const value = p.value ?? p.seconds;
  if (!Number.isFinite(value) || Number(value) < 0) {
    return json({ error: "value must be a non-negative number of browser seconds" }, 400);
  }

  try {
    const remaining = await trackAutumnUsage(env, {
      customerID: p.org_id,
      featureID,
      value: Math.ceil(Number(value)),
      idempotencyKey: p.idempotency_key,
    });
    if (remaining !== null && remaining <= 0) await projectOrg(env, p.org_id);
    return json({ ok: true, billed: true, org_id: p.org_id, browser_id: p.browser_id, remaining });
  } catch (err) {
    console.error(`browser-usage: track failed org=${p.org_id} browser=${p.browser_id}`, err);
    return json({ error: "browser usage billing failed" }, 502);
  }
}

// ── self-healing gate ──────────────────────────────────────────────────────

// Negative cache so a broke org retrying in a loop can't hammer Autumn: at most
// one re-check per org per cooldown. Per-isolate + ephemeral, which is exactly
// the best-effort rate-limit we want (Workers recycle isolates frequently).
const lastHealCheck = new Map<string, number>();
const HEAL_COOLDOWN_MS = 10_000;
const HEAL_CACHE_CAP = 10_000;

// selfHealHalt is the 4th resume trigger: when a halted org actually hits a
// create/wake gate, re-check Autumn's authoritative balance (cooldown-gated)
// and re-project D1, so a user who just topped up isn't stuck behind a lagging
// webhook/reconciler. Returns whether the org is STILL halted afterward — the
// caller 402s on true, proceeds on false.
export async function selfHealHalt(env: AutumnEnv, orgID: string): Promise<boolean> {
  const now = Date.now();
  const last = lastHealCheck.get(orgID) ?? 0;
  if (now - last >= HEAL_COOLDOWN_MS) {
    if (lastHealCheck.size > HEAL_CACHE_CAP) lastHealCheck.clear();
    lastHealCheck.set(orgID, now);
    try {
      await projectOrg(env, orgID);
    } catch (err) {
      // Re-check failed — fall through and trust whatever D1 already holds
      // (fail closed: a still-halted projection keeps the org gated).
      console.error(`autumn: self-heal project ${orgID} failed`, err);
    }
  }
  const row = await env.OPENCOMPUTER_DB.prepare("SELECT is_halted FROM orgs WHERE id = ?1")
    .bind(orgID)
    .first<{ is_halted: number }>();
  return row?.is_halted === 1;
}

// syncAutumnToD1 reads Autumn's authoritative balance/plans and writes the D1
// projection (is_halted / max_concurrent) WITHOUT any cell dispatch. Returns the
// halt transition so callers can decide whether to actively hibernate. Reusable
// by the dashboard (checkout-return) since it needs no dispatch secrets.
export interface AutumnSyncResult {
  customer: AutumnCustomer;
  creditsRemaining: number; // dollars
  maxConcurrent: number;
  halted: boolean;
  wasHalted: boolean;
}

export async function syncAutumnToD1(env: AutumnSyncEnv, orgID: string): Promise<AutumnSyncResult | null> {
  const cust = await getAutumnCustomer(env, orgID);
  if (!cust) {
    console.error(`autumn: customer ${orgID} not found in Autumn`);
    return null;
  }

  const creditsRemaining = cust.balances?.[CREDITS_FEATURE_ID]?.remaining ?? 0;
  const halted = creditsRemaining <= 0;
  const projectedMaxConcurrent = maxConcurrency(cust.subscriptions ?? []);
  const nowSec = Math.floor(Date.now() / 1000);

  const prevRow = await env.OPENCOMPUTER_DB.prepare("SELECT is_halted, autumn_concurrency_override FROM orgs WHERE id = ?1")
    .bind(orgID)
    .first<{ is_halted: number; autumn_concurrency_override: number | null }>();
  const wasHalted = prevRow?.is_halted === 1;
  const maxConcurrent = prevRow?.autumn_concurrency_override ?? projectedMaxConcurrent;

  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE orgs SET is_halted = ?1, halted_at = ?2, max_concurrent_sandboxes = ?3, updated_at = ?4 WHERE id = ?5`,
  )
    .bind(halted ? 1 : 0, halted ? nowSec : null, maxConcurrent, nowSec, orgID)
    .run();

  return { customer: cust, creditsRemaining, maxConcurrent, halted, wasHalted };
}

// autumnSetProviderInternal flips D1 orgs.billing_provider for one org (the
// migrate tool's D1 half; cell-PG is flipped by the Go cmd). EVENT_SECRET HMAC.
// On →autumn it also projects (is_halted/max_concurrent from Autumn) so the
// edge gates are correct the instant the flag flips. Body: {org_id, provider}.
export async function autumnSetProviderInternal(req: Request, env: AutumnEnv): Promise<Response> {
  const rawBody = await req.text();
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return json({ error: "missing signature headers" }, 400);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > SVIX_TOLERANCE_SEC) {
    return json({ error: "timestamp out of window" }, 401);
  }
  const url = new URL(req.url);
  const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${url.pathname}${url.search}.${rawBody}`);
  if (!timingSafeEqual(expected, sig)) return json({ error: "signature mismatch" }, 401);

  let p: { org_id?: string; provider?: string };
  try {
    p = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!p.org_id || (p.provider !== "autumn" && p.provider !== "legacy")) {
    return json({ error: "org_id + provider ('autumn'|'legacy') required" }, 400);
  }
  try {
    await env.OPENCOMPUTER_DB.prepare("UPDATE orgs SET billing_provider = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(p.provider, Math.floor(Date.now() / 1000), p.org_id)
      .run();
    if (p.provider === "autumn") await projectOrg(env, p.org_id);
  } catch (err) {
    console.error(`autumn-set-provider ${p.org_id} → ${p.provider} failed`, err);
    return json({ error: "set provider failed" }, 502);
  }
  return json({ ok: true, org_id: p.org_id, provider: p.provider });
}

// projectOrg = syncAutumnToD1 + actively hibernate on a fresh halt.
//
// On halt we dispatch /admin/halt-org to hibernate running boxes. On RESUME we
// do NOT dispatch — D1.is_halted is already cleared, which unblocks the gates;
// hibernated boxes wake lazily on the next request. This is the locked "no
// auto-wake for prepaid" decision: a top-up unblocks but never force-wakes.
export async function projectOrg(env: AutumnEnv, orgID: string): Promise<void> {
  const r = await syncAutumnToD1(env, orgID);
  if (!r || !r.halted) return;
  // Dispatch halt on the fresh transition, OR whenever a halted org STILL has
  // running sandboxes — so a halt is eventually complete even if a single
  // hibernation flaked on the first dispatch. The autumn-meter cron + the
  // webhook both call projectOrg, so this is the straggler safety net (a halted
  // org with a leftover running box gets re-dispatched on the next sight).
  if (!r.wasHalted || (await hasRunningSandboxes(env, orgID))) {
    await dispatchToCells(env, orgID, "/admin/halt-org", { org_id: orgID, reason: "credits_exhausted" });
  }
}

// hasRunningSandboxes — does this org have any sandbox still running (across all
// cells)? Cheap indexed lookup; gates the straggler re-dispatch so a fully
// hibernated halted org costs no dispatch.
async function hasRunningSandboxes(env: AutumnSyncEnv, orgID: string): Promise<boolean> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT 1 AS one FROM sandboxes_index WHERE org_id = ?1 AND status = 'running' LIMIT 1",
  )
    .bind(orgID)
    .first<{ one: number }>();
  return row != null;
}

function maxConcurrency(subs: AutumnSubscription[]): number {
  let limit = DEFAULT_CONCURRENCY;
  for (const s of subs) {
    if (s.status && s.status !== "active") continue;
    const v = CONCURRENCY_BY_PLAN[s.plan_id];
    if (v !== undefined && v > limit) limit = v;
  }
  return limit;
}

// createAutumnCustomer provisions an Autumn customer (id = our org UUID) →
// Autumn auto-attaches the `base` plan + grants the $5 signup credit. POSTing an
// existing id returns the existing customer, so it's idempotent/retry-safe.
export async function createAutumnCustomer(
  env: AutumnApiEnv,
  p: { id: string; name: string; email: string },
): Promise<void> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const resp = await fetch(`${base}/customers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ id: p.id, name: p.name, email: p.email }),
  });
  if (!resp.ok) throw new Error(`autumn create customer ${resp.status}: ${await resp.text()}`);
}

export async function getAutumnCustomer(env: AutumnApiEnv, customerID: string): Promise<AutumnCustomer | null> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const resp = await fetch(`${base}/customers/${encodeURIComponent(customerID)}`, {
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`autumn GET customer ${resp.status}: ${await resp.text()}`);
  return (await resp.json()) as AutumnCustomer;
}

// trackAutumnUsage records metered usage against a feature. Autumn dedupes on
// idempotency_key across ALL customers, so the key must be globally unique and
// stable across retries (see usageIdempotencyKey). Returns the post-track
// `credits` balance so the caller can halt on exhaustion.
//
// A 409 duplicate_idempotency_key means this bucket already landed on an earlier
// run (the watermark write failed after the track) — not an error. We re-read
// the balance so the halt check still fires if this was the exhausting bucket.
export async function trackAutumnUsage(
  env: AutumnApiEnv,
  p: { customerID: string; featureID: string; value: number; idempotencyKey: string },
): Promise<number | null> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const resp = await fetch(`${base}/track`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      customer_id: p.customerID,
      feature_id: p.featureID,
      value: p.value,
      idempotency_key: p.idempotencyKey,
    }),
  });
  if (resp.ok) {
    const body = (await resp.json()) as { balance?: { remaining?: number } };
    return body.balance?.remaining ?? null;
  }
  if (resp.status === 409) {
    const text = await resp.text();
    if (text.includes("duplicate_idempotency_key")) {
      const cust = await getAutumnCustomer(env, p.customerID);
      return cust?.balances?.[CREDITS_FEATURE_ID]?.remaining ?? null;
    }
    throw new Error(`autumn track 409: ${text}`);
  }
  throw new Error(`autumn track ${resp.status}: ${await resp.text()}`);
}

// CheckoutOption sets a quantity for a priced feature in the product (e.g. the
// number of $1 credits in a top-up).
export interface AutumnCheckoutOption {
  feature_id: string;
  quantity: number;
}

export interface AutumnCheckoutResult {
  // null when the customer already has a payment method on file — Autumn expects
  // a direct /attach instead of a hosted checkout redirect (see autumnPurchase).
  url: string | null;
  total?: number;
  currency?: string;
}

// autumnCheckout creates an Autumn (Stripe-backed) checkout — a one-off credit
// top-up (product_id="top_up", options=[{feature_id:"credits", quantity:N}]) or
// a concurrency plan subscription (product_id="concurrency_pro" etc.). Shape
// confirmed live against the Autumn sandbox.
export async function autumnCheckout(
  env: AutumnApiEnv,
  params: { customerId: string; productId: string; options?: AutumnCheckoutOption[]; successUrl: string },
): Promise<AutumnCheckoutResult> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const body: Record<string, unknown> = {
    customer_id: params.customerId,
    product_id: params.productId,
    success_url: params.successUrl,
  };
  if (params.options && params.options.length > 0) body.options = params.options;
  const resp = await fetch(`${base}/checkout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`autumn checkout ${resp.status}: ${await resp.text()}`);
  return (await resp.json()) as AutumnCheckoutResult;
}

// autumnAttach completes a purchase using the customer's existing payment method
// — no hosted checkout. Used when /checkout returns url=null (a card is on file).
export async function autumnAttach(
  env: AutumnApiEnv,
  params: { customerId: string; productId: string; options?: AutumnCheckoutOption[] },
): Promise<void> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const body: Record<string, unknown> = { customer_id: params.customerId, product_id: params.productId };
  if (params.options && params.options.length > 0) body.options = params.options;
  const resp = await fetch(`${base}/attach`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`autumn attach ${resp.status}: ${await resp.text()}`);
  // code=checkout_created means there was no chargeable card so Autumn made a
  // hosted checkout instead of charging — for our "charge the card on file" path
  // that's a failure, not success. Surface it rather than silently no-op'ing.
  const d = (await resp.json()) as { code?: string };
  if (d.code === "checkout_created") {
    throw new Error("autumn attach: no payment method on file (got checkout_created)");
  }
}

// autumnPurchase buys a product (concurrency tier), handling both Autumn flows.
// It gates the direct /attach on hasToppedUp — a real prior charge means a card
// is RELIABLY on file. We deliberately do NOT use the /checkout `url` probe to
// detect a card: it can spuriously return null for a CARDLESS org, which then
// takes the attach path → Autumn returns checkout_created → autumnAttach throws
// → 502 (the same failure we fixed for top-up via autumnTopUpCharge). So:
//   card on file (hasToppedUp) → /attach, immediate charge, return url=null
//   no card                    → hosted checkout to collect a card + purchase
// Returns the url to redirect to, or null when the charge already completed
// (caller should just refresh the balance — no redirect).
export async function autumnPurchase(
  env: AutumnApiEnv,
  params: { customerId: string; productId: string; options?: AutumnCheckoutOption[]; successUrl: string },
): Promise<{ url: string | null }> {
  if (await autumnHasToppedUp(env, params.customerId)) {
    await autumnAttach(env, { customerId: params.customerId, productId: params.productId, options: params.options });
    return { url: null };
  }
  const co = await autumnCheckout(env, params);
  return { url: co.url };
}

// autumnSetupPayment creates a Stripe SETUP session that saves a card for future
// OFF-SESSION use — POST /v1/billing.setup_payment. It does NOT charge (setup
// mode), so arming auto-recharge takes a follow-up /attach once the card is on
// file (see autumnTopUpCharge + the ?charge_topup return handler). Returns the
// URL to redirect the customer to.
export async function autumnSetupPayment(
  env: AutumnApiEnv,
  params: { customerId: string; successUrl: string },
): Promise<{ url: string | null }> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const resp = await fetch(`${base}/billing.setup_payment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ customer_id: params.customerId, success_url: params.successUrl }),
  });
  if (!resp.ok) throw new Error(`autumn setup_payment ${resp.status}: ${await resp.text()}`);
  const d = (await resp.json()) as { url?: string };
  return { url: d.url ?? null };
}

// autumnOpenCustomerPortal creates a Stripe billing-portal session (hosted by
// Stripe, brokered by Autumn) so the customer can view / update / remove their
// saved card and download invoices — POST /billing.open_customer_portal.
// Compliance: anyone with a card on file must be able to manage it. The card for
// an Autumn org lives under Autumn's Stripe account, so this — NOT the edge's
// direct /billing/portal — is the correct surface for prepaid orgs. Returns the
// hosted portal URL (null if the customer has no billing account yet).
export async function autumnOpenCustomerPortal(
  env: AutumnApiEnv,
  params: { customerId: string; returnUrl: string },
): Promise<{ url: string | null }> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const resp = await fetch(`${base}/billing.open_customer_portal`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`,
      "content-type": "application/json",
      "x-api-version": "2.3.0",
    },
    body: JSON.stringify({ customer_id: params.customerId, return_url: params.returnUrl }),
  });
  if (!resp.ok) throw new Error(`autumn open_customer_portal ${resp.status}: ${await resp.text()}`);
  const d = (await resp.json()) as { url?: string };
  return { url: d.url ?? null };
}

// autumnTopUpCharge buys `quantity` credits while ensuring the card ends up saved
// OFF-SESSION — so a top-up also ARMS auto-recharge. No single Autumn hosted flow
// does both (a /checkout top-up charges but leaves the card on-session-only;
// setup_payment saves off-session but doesn't charge), so:
//   - card already on file → /attach charges directly (no redirect), {url:null}.
//   - no card → setup_payment saves the card off-session and returns a redirect
//     URL; the CHARGE happens when the user returns — the caller's successUrl must
//     carry ?charge_topup=<quantity> so the UI fires the /attach on return.
export async function autumnTopUpCharge(
  env: AutumnApiEnv,
  params: { customerId: string; quantity: number; successUrl: string },
): Promise<{ url: string | null }> {
  // hasToppedUp = a top-up has been charged = a card is on file (reliable). We do
  // NOT probe /checkout — it spuriously returns url=null for cardless customers.
  if (await autumnHasToppedUp(env, params.customerId)) {
    const options = [{ feature_id: "credits", quantity: params.quantity }];
    await autumnAttach(env, { customerId: params.customerId, productId: "top_up", options });
    return { url: null };
  }
  return autumnSetupPayment(env, { customerId: params.customerId, successUrl: params.successUrl });
}

// autumnHasToppedUp reports whether the customer has ever charged a top-up. Since
// every top-up goes through autumnTopUpCharge (off-session), this doubles as the
// "auto-recharge is armed" signal: true means enabling auto-recharge needs no new
// charge; false means the first recharge must run to arm it.
export async function autumnHasToppedUp(env: AutumnApiEnv, customerId: string): Promise<boolean> {
  const cust = await getAutumnCustomer(env, customerId);
  return (cust?.purchases ?? []).some((p) => p.plan_id === "top_up");
}

// autumnSetAutoTopup configures (or disables) automatic credit top-up for the
// `credits` feature. POST /customers/{id} with billing_controls.auto_topups —
// confirmed live: after every track() Autumn checks the balance and, if below
// `threshold`, charges the saved card for `quantity` credits (30s cooldown).
// Requires a payment method on file to actually charge (config persists either way).
export async function autumnSetAutoTopup(
  env: AutumnApiEnv,
  customerID: string,
  cfg: { enabled: boolean; threshold: number; quantity: number },
): Promise<void> {
  const base = env.AUTUMN_BASE_URL || DEFAULT_BASE_URL;
  const resp = await fetch(`${base}/customers/${encodeURIComponent(customerID)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      billing_controls: {
        auto_topups: [
          { feature_id: CREDITS_FEATURE_ID, enabled: cfg.enabled, threshold: cfg.threshold, quantity: cfg.quantity },
        ],
      },
    }),
  });
  if (!resp.ok) throw new Error(`autumn set auto-topup ${resp.status}: ${await resp.text()}`);
}

// ── cell dispatch (mirrors the DO's halt/resume fan-out) ───────────────────

interface CellRow {
  cell_id: string;
  base_url: string;
}
const DISPATCH_BACKOFFS_MS = [200, 1000, 3000];

async function dispatchToCells(env: AutumnEnv, orgID: string, path: string, payload: unknown): Promise<void> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT DISTINCT c.cell_id, c.base_url
       FROM sandboxes_index s
       JOIN cells c ON s.cell_id = c.cell_id
      WHERE s.org_id = ?1 AND s.status IN ('running', 'hibernated', 'migrating')`,
  )
    .bind(orgID)
    .all<CellRow>();
  const cells = results ?? [];
  if (cells.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(cells.map((c) => postWithRetry(env, c, path, body)));
}

async function postWithRetry(env: AutumnEnv, cell: CellRow, path: string, body: string): Promise<void> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(env.CF_ADMIN_SECRET, `${ts}.${body}`);
  const url = cell.base_url.replace(/\/$/, "") + path;

  for (let attempt = 0; attempt <= DISPATCH_BACKOFFS_MS.length; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Timestamp": ts, "X-Signature": sig },
        body,
      });
      if (resp.status >= 200 && resp.status < 300) return;
      console.error(`autumn-webhook: dispatch ${path} → ${cell.cell_id} status=${resp.status} attempt=${attempt}`);
    } catch (err) {
      console.error(`autumn-webhook: dispatch ${path} → ${cell.cell_id} error=${(err as Error).message}`);
    }
    if (attempt < DISPATCH_BACKOFFS_MS.length) {
      await new Promise((r) => setTimeout(r, DISPATCH_BACKOFFS_MS[attempt]));
    }
  }
}

// ── crypto ─────────────────────────────────────────────────────────────────

// Svix signature: base64( HMAC_SHA256( "{id}.{ts}.{body}", base64decode(secret) ) ),
// matched against any "v1,<sig>" entry in the space-separated svix-signature header.
async function verifySvix(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > SVIX_TOLERANCE_SEC) return false;

  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = base64ToBytes(rawSecret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = bytesToBase64(new Uint8Array(mac));

  for (const part of sigHeader.split(" ")) {
    const comma = part.indexOf(",");
    const sig = comma >= 0 ? part.slice(comma + 1) : part;
    if (sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
