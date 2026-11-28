// Plan promotions: the offer itself and its claims in D1 (promo_claims,
// migration 0026). No Autumn calls here, so autumn_webhook.ts can activate a
// claim from its projection without an import cycle; the HTTP surfaces and the
// revert sweep are in promo.ts.
//
// Black Friday 2026 (`bfcm2026`): Pro $10 with 4,000 work minutes and Max $100
// with 50,000, claimable until Cyber Monday ends in Los Angeles. The first 50
// orgs to activate keep it 12 months, everyone after 3; then the plan returns to
// its catalog price and minutes at the end of that billing cycle.

export type PromoPlan = "pro" | "max";

export interface PromoPlanTerms {
  price: number;
  minutes: number;
  normalPrice: number;
  normalMinutes: number;
}

export interface PromoOffer {
  id: string;
  /** Unix ms; claims are accepted strictly before it. */
  endsAtMs: number;
  earlyCap: number;
  earlyMonths: number;
  lateMonths: number;
  plans: Record<PromoPlan, PromoPlanTerms>;
}

export const BFCM_2026: PromoOffer = {
  id: "bfcm2026",
  // 2026-11-30 23:59 America/Los_Angeles (PST, UTC-8).
  endsAtMs: Date.parse("2026-12-01T07:59:00Z"),
  earlyCap: 50,
  earlyMonths: 12,
  lateMonths: 3,
  plans: {
    pro: { price: 10, minutes: 4_000, normalPrice: 20, normalMinutes: 2_000 },
    max: { price: 100, minutes: 50_000, normalPrice: 200, normalMinutes: 25_000 },
  },
};

// Whether an org already on an active paid Pro or Max subscription may claim.
// Off for now: the offer is for new paid subscribers (trial and free orgs
// included). Flip this one constant to open it to existing customers.
export const PROMO_ALLOWS_EXISTING_PAID = false;

const PROMOS: Record<string, PromoOffer> = { [BFCM_2026.id]: BFCM_2026 };

export function promoByID(id: string | null | undefined): PromoOffer | null {
  return (id && PROMOS[id]) || null;
}

export function promoActive(offer: PromoOffer, nowMs: number): boolean {
  return nowMs < offer.endsAtMs;
}

export type PromoClaimStatus = "pending" | "active" | "reverted" | "ended" | "revert_failed";

export interface PromoClaimRow {
  promo_id: string;
  org_id: string;
  plan: PromoPlan;
  status: PromoClaimStatus;
  early_slot: number | null;
  months: number | null;
  claimed_at: number;
  activated_at: number | null;
  ends_at: number | null;
  checked_at: number | null;
  revert_attempts: number;
  reverted_at: number | null;
}

/** The public body (GET /api/public/promo/:id). */
export interface PublicPromoBody {
  id: string;
  active: boolean;
  endsAt: string;
  earlyCap: number;
  earlyLeft: number;
  plans: Record<PromoPlan, PromoPlanTerms>;
}

export interface DashboardPromoBody extends PublicPromoBody {
  eligible: boolean;
  claim: { plan: PromoPlan; months: number; endsAt: string } | null;
}

export async function earlySlotsTaken(db: D1Database, offer: PromoOffer): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM promo_claims WHERE promo_id = ?1 AND early_slot IS NOT NULL")
    .bind(offer.id)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function publicPromoBody(db: D1Database, offer: PromoOffer, nowMs: number): Promise<PublicPromoBody> {
  const taken = await earlySlotsTaken(db, offer);
  return {
    id: offer.id,
    active: promoActive(offer, nowMs),
    endsAt: new Date(offer.endsAtMs).toISOString().replace(".000Z", "Z"),
    earlyCap: offer.earlyCap,
    earlyLeft: Math.max(0, offer.earlyCap - taken),
    plans: offer.plans,
  };
}

export async function getPromoClaim(db: D1Database, offer: PromoOffer, orgID: string): Promise<PromoClaimRow | null> {
  return db
    .prepare("SELECT * FROM promo_claims WHERE promo_id = ?1 AND org_id = ?2")
    .bind(offer.id, orgID)
    .first<PromoClaimRow>();
}

/**
 * Whether an org may start a promo checkout: the offer is open, the org has no
 * claim past pending (one claim per org), and, unless PROMO_ALLOWS_EXISTING_PAID,
 * it holds no active paid plan.
 */
export function promoEligible(
  offer: PromoOffer,
  nowMs: number,
  claim: Pick<PromoClaimRow, "status"> | null,
  hasActivePaidPlan: boolean,
): boolean {
  if (!promoActive(offer, nowMs)) return false;
  if (claim && claim.status !== "pending") return false;
  if (hasActivePaidPlan && !PROMO_ALLOWS_EXISTING_PAID) return false;
  return true;
}

export function claimSummary(claim: PromoClaimRow | null): DashboardPromoBody["claim"] {
  if (!claim || claim.status === "pending" || claim.months == null || claim.ends_at == null) return null;
  return { plan: claim.plan, months: claim.months, endsAt: new Date(claim.ends_at * 1_000).toISOString() };
}

/**
 * Reserves the org's claim as it opens the promo checkout. A pending claim
 * follows the latest plan chosen; an activated (or finished) one is never
 * replaced. Returns the claim, or null when the org has already used the promo.
 */
export async function reservePromoClaim(
  db: D1Database,
  offer: PromoOffer,
  orgID: string,
  plan: PromoPlan,
  nowMs: number,
): Promise<PromoClaimRow | null> {
  await db
    .prepare(
      `INSERT INTO promo_claims (promo_id, org_id, plan, status, claimed_at)
       VALUES (?1, ?2, ?3, 'pending', ?4)
       ON CONFLICT (promo_id, org_id) DO UPDATE SET plan = excluded.plan, claimed_at = excluded.claimed_at
       WHERE promo_claims.status = 'pending'`,
    )
    .bind(offer.id, orgID, plan, Math.floor(nowMs / 1_000))
    .run();
  const claim = await getPromoClaim(db, offer, orgID);
  if (!claim || claim.status !== "pending" || claim.plan !== plan) return null;
  return claim;
}

/** `ms` plus whole calendar months, in UTC, clamped to the month's last day. */
export function addMonthsUTC(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

const EARLY_COUNT = "(SELECT COUNT(*) FROM promo_claims WHERE promo_id = ?1 AND early_slot IS NOT NULL)";

/**
 * Turns the org's pending claim active once Autumn shows it on a paid plan,
 * taking the next early slot while any are left. Race-safe: the count and the
 * write are one statement, which D1 runs serially, and the unique slot index
 * refuses a duplicate slot outright (then the claim takes the late term).
 * Returns whether this call activated the claim.
 */
export async function activatePromoClaim(
  db: D1Database,
  orgID: string,
  paidPlan: string,
  nowMs: number,
): Promise<boolean> {
  if (paidPlan !== "pro" && paidPlan !== "max") return false;
  let activated = false;
  for (const offer of Object.values(PROMOS)) {
    const nowSec = Math.floor(nowMs / 1_000);
    const earlyEnds = Math.floor(addMonthsUTC(nowMs, offer.earlyMonths) / 1_000);
    const lateEnds = Math.floor(addMonthsUTC(nowMs, offer.lateMonths) / 1_000);
    const pending = "WHERE promo_id = ?1 AND org_id = ?2 AND status = 'pending'";
    let res;
    try {
      res = await db
        .prepare(
          `UPDATE promo_claims SET status = 'active', plan = ?3, activated_at = ?4,
             early_slot = CASE WHEN ${EARLY_COUNT} < ?5 THEN ${EARLY_COUNT} + 1 ELSE NULL END,
             months     = CASE WHEN ${EARLY_COUNT} < ?5 THEN ?6 ELSE ?7 END,
             ends_at    = CASE WHEN ${EARLY_COUNT} < ?5 THEN ?8 ELSE ?9 END
           ${pending}`,
        )
        .bind(offer.id, orgID, paidPlan, nowSec, offer.earlyCap, offer.earlyMonths, offer.lateMonths, earlyEnds, lateEnds)
        .run();
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err;
      res = await db
        .prepare(
          `UPDATE promo_claims SET status = 'active', plan = ?3, activated_at = ?4,
             early_slot = NULL, months = ?5, ends_at = ?6
           ${pending}`,
        )
        .bind(offer.id, orgID, paidPlan, nowSec, offer.lateMonths, lateEnds)
        .run();
    }
    if (Number(res.meta?.changes ?? 0) > 0) activated = true;
  }
  return activated;
}
