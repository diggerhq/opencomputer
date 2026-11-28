// Plan promotions over HTTP, and the sweep that ends them (offer and claims:
// promo_claims.ts).
//
//   GET  /api/public/promo/:id       — anonymous, CORS *, cacheable 30s (site, signup)
//   GET  /api/dashboard/billing/promo — the same plus the org's eligibility and claim
//   POST /api/dashboard/billing/autumn/plan { plan, promo } — dashboard.ts, via promoCheckout
//
// The promo price is Autumn's per-customer `customize` on billing.attach. When
// the claim's months are up, runPromoRevertSweep schedules the catalog plan
// for the end of that billing cycle.

import {
  autumnRevertUsagePlan,
  getAutumnCustomer,
  type AutumnApiEnv,
  type AutumnCustomer,
} from "./autumn_webhook";
import {
  claimSummary,
  getPromoClaim,
  promoActive,
  promoByID,
  promoEligible,
  publicPromoBody,
  reservePromoClaim,
  type DashboardPromoBody,
  type PromoClaimRow,
  type PromoOffer,
  type PromoPlan,
  type PublicPromoBody,
} from "./promo_claims";

export const PUBLIC_PROMO_PREFIX = "/api/public/promo/";

const PUBLIC_CACHE_SEC = 30;
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Per-isolate memo of the public body, so a burst of site visitors costs one
// D1 read per isolate per window rather than one each.
const publicMemo = new Map<string, { atMs: number; body: PublicPromoBody }>();

/** GET|OPTIONS /api/public/promo/:id */
export async function handlePublicPromo(req: Request, db: D1Database, path: string, nowMs = Date.now()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, CORS_HEADERS);
  }
  const offer = promoByID(decodeURIComponent(path.slice(PUBLIC_PROMO_PREFIX.length)));
  if (!offer) return json({ error: "unknown promo" }, 404, CORS_HEADERS);
  let body: PublicPromoBody;
  const memo = publicMemo.get(offer.id);
  if (memo && nowMs - memo.atMs < PUBLIC_CACHE_SEC * 1_000) {
    body = { ...memo.body, active: promoActive(offer, nowMs) };
  } else {
    try {
      body = await publicPromoBody(db, offer, nowMs);
    } catch (err) {
      console.error("promo: public body", err);
      return json({ error: "promo unavailable" }, 503, { ...CORS_HEADERS, "cache-control": "no-store" });
    }
    publicMemo.set(offer.id, { atMs: nowMs, body });
  }
  return json(body, 200, {
    ...CORS_HEADERS,
    "cache-control": `public, max-age=${PUBLIC_CACHE_SEC}`,
  });
}

/** Test hook: forget the public memo. */
export function resetPublicPromoMemo(): void {
  publicMemo.clear();
}

/** GET /api/dashboard/billing/promo — the offer, the org's eligibility and its claim. */
export async function dashboardPromo(
  db: D1Database,
  orgID: string,
  offer: PromoOffer,
  nowMs = Date.now(),
): Promise<DashboardPromoBody> {
  const [pub, claim, org] = await Promise.all([
    publicPromoBody(db, offer, nowMs),
    getPromoClaim(db, offer, orgID),
    db.prepare("SELECT usage_plan FROM orgs WHERE id = ?1").bind(orgID).first<{ usage_plan: string | null }>(),
  ]);
  // The D1 projection of Autumn is enough for the badge; the checkout below
  // re-checks against Autumn itself.
  const paid = org?.usage_plan === "pro" || org?.usage_plan === "max";
  return { ...pub, eligible: promoEligible(offer, nowMs, claim, paid), claim: claimSummary(claim) };
}

export function hasActivePaidPlan(customer: AutumnCustomer | null): boolean {
  return (customer?.subscriptions ?? []).some(
    (s) => (s.plan_id === "pro" || s.plan_id === "max") && (!s.status || s.status === "active"),
  );
}

export type PromoCheckout =
  | { ok: true; offer: PromoOffer; customer: AutumnCustomer | null; customize: { price: number; workMinutes: number } }
  | { ok: false; status: number; error: string };

/**
 * Admits a promo checkout for POST /billing/autumn/plan: an open offer, an
 * eligible org (checked against Autumn, not the projection), and its claim
 * reserved. The caller attaches with `customize` and passes `customer` on.
 */
export async function promoCheckout(
  env: AutumnApiEnv & { OPENCOMPUTER_DB: D1Database },
  orgID: string,
  promoID: string,
  plan: PromoPlan,
  nowMs = Date.now(),
): Promise<PromoCheckout> {
  const offer = promoByID(promoID);
  if (!offer) return { ok: false, status: 400, error: `unknown promo '${promoID}'` };
  if (!promoActive(offer, nowMs)) return { ok: false, status: 410, error: "this promotion has ended" };
  const [customer, existing] = await Promise.all([
    getAutumnCustomer(env, orgID),
    getPromoClaim(env.OPENCOMPUTER_DB, offer, orgID),
  ]);
  if (!promoEligible(offer, nowMs, existing, hasActivePaidPlan(customer))) {
    return {
      ok: false,
      status: 409,
      error: existing && existing.status !== "pending"
        ? "this workspace has already claimed the promotion"
        : "the promotion is for new Pro and Max subscriptions",
    };
  }
  const claim = await reservePromoClaim(env.OPENCOMPUTER_DB, offer, orgID, plan, nowMs);
  if (!claim) return { ok: false, status: 409, error: "this workspace has already claimed the promotion" };
  const terms = offer.plans[plan];
  return { ok: true, offer, customer, customize: { price: terms.price, workMinutes: terms.minutes } };
}

// ── revert ─────────────────────────────────────────────────────────────────

const DAY_SEC = 86_400;
// Claims whose term ends within a cycle are looked at; each at most hourly.
const REVERT_LOOKAHEAD_SEC = 35 * DAY_SEC;
const RECHECK_SEC = 3_600;
// A billing period that ends this close to (or after) the claim's end is the
// promo's last one: the claim was activated when its subscription started, so
// the two line up to within the checkout's minutes.
const PERIOD_TOLERANCE_SEC = 3 * DAY_SEC;
const MAX_REVERT_ATTEMPTS = 5;
const SWEEP_BATCH = 25;

// Autumn reports times in milliseconds; older payloads used seconds.
function toSec(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? Math.floor(value) : Math.floor(value / 1_000);
}

export interface PromoRevertResult {
  checked: number;
  reverted: number;
  ended: number;
  failed: number;
}

/**
 * Cron: for each active claim nearing its end, once its subscription is in the
 * promo's last billing period, schedule the catalog plan for that period's end
 * (autumnRevertUsagePlan). A claim whose org has left the promo plan (its
 * subscription gone, or another plan switched to or scheduled) just ends.
 */
export async function runPromoRevertSweep(
  env: AutumnApiEnv & { OPENCOMPUTER_DB: D1Database },
  nowMs: number,
): Promise<PromoRevertResult> {
  const nowSec = Math.floor(nowMs / 1_000);
  const out: PromoRevertResult = { checked: 0, reverted: 0, ended: 0, failed: 0 };
  const due = await env.OPENCOMPUTER_DB.prepare(
    `SELECT * FROM promo_claims
     WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?1
       AND (checked_at IS NULL OR checked_at <= ?2)
     ORDER BY ends_at
     LIMIT ?3`,
  )
    .bind(nowSec + REVERT_LOOKAHEAD_SEC, nowSec - RECHECK_SEC, SWEEP_BATCH)
    .all<PromoClaimRow>();
  for (const claim of due.results ?? []) {
    out.checked++;
    const key = [claim.promo_id, claim.org_id];
    await env.OPENCOMPUTER_DB.prepare(
      "UPDATE promo_claims SET checked_at = ?3 WHERE promo_id = ?1 AND org_id = ?2",
    ).bind(...key, nowSec).run();
    try {
      const customer = await getAutumnCustomer(env, claim.org_id);
      const subs = customer?.subscriptions ?? [];
      const sub = subs.find((s) => s.plan_id === claim.plan && (!s.status || s.status === "active"));
      // Another plan already scheduled for the period end (say Max → Pro)
      // replaces the promo plan by itself; attaching would overwrite it.
      const changeScheduled = subs.some(
        (s) => (s.plan_id === "pro" || s.plan_id === "max") && s.status === "scheduled",
      );
      // A pending cancellation can still be undone: keep watching, never
      // attach (which would undo it for them).
      if (sub && sub.canceled_at != null && !changeScheduled) continue;
      if (!sub || changeScheduled) {
        await env.OPENCOMPUTER_DB.prepare(
          "UPDATE promo_claims SET status = 'ended' WHERE promo_id = ?1 AND org_id = ?2 AND status = 'active'",
        ).bind(...key).run();
        out.ended++;
        continue;
      }
      const periodEnd = toSec(sub.current_period_end);
      const lastPeriod = periodEnd == null
        ? nowSec >= (claim.ends_at ?? 0)
        : periodEnd >= (claim.ends_at ?? 0) - PERIOD_TOLERANCE_SEC;
      if (!lastPeriod) continue;
      await autumnRevertUsagePlan(env, { customerId: claim.org_id, planId: claim.plan });
      await env.OPENCOMPUTER_DB.prepare(
        "UPDATE promo_claims SET status = 'reverted', reverted_at = ?3 WHERE promo_id = ?1 AND org_id = ?2",
      ).bind(...key, nowSec).run();
      out.reverted++;
    } catch (err) {
      out.failed++;
      console.error(`promo: revert org=${claim.org_id} promo=${claim.promo_id}`, err);
      await env.OPENCOMPUTER_DB.prepare(
        `UPDATE promo_claims SET revert_attempts = revert_attempts + 1,
           status = CASE WHEN revert_attempts + 1 >= ?3 THEN 'revert_failed' ELSE status END
         WHERE promo_id = ?1 AND org_id = ?2`,
      ).bind(...key, MAX_REVERT_ATTEMPTS).run();
    }
  }
  return out;
}
