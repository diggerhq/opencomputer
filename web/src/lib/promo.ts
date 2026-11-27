import type { BillingPromo } from '@/api/schemas'
import { PLAN_OFFERS, type PaidPlanId } from '@/lib/billing-onramp'

// The Black Friday / Cyber Monday 2026 deal: Pro and Max at half price with
// double the work minutes, locked for 12 months for the first workspaces to
// claim it and 3 months after that. The edge owns the offer and who may claim
// it (GET /billing/promo); the dashboard only shows it and passes the id with
// the plan checkout.
export const BFCM_PROMO_ID = 'bfcm2026'

// What a plan costs this org right now. `normal*` is set only while a deal
// applies, so the card can strike the usual price through.
export interface PlanPricing {
  priceUsd: number
  minutes: number
  normalPriceUsd: number | null
  normalMinutes: number | null
}

// Whether a checkout opened now would claim the deal: it is running, this org
// may claim it, and hasn't already.
export function promoApplies(
  promo: BillingPromo | undefined,
  now = Date.now(),
): boolean {
  return (
    !!promo &&
    promo.active &&
    promo.eligible &&
    promo.claim == null &&
    new Date(promo.endsAt).getTime() > now
  )
}

// The deal's price for `plan` when this org would get it (or already holds it
// on that plan); the normal catalog price otherwise.
export function planPricing(
  plan: PaidPlanId,
  promo: BillingPromo | undefined,
  now = Date.now(),
): PlanPricing {
  const normal = PLAN_OFFERS[plan]
  const deal = promo?.plans[plan]
  const discounted =
    !!deal &&
    (promoApplies(promo, now) || activeClaim(promo, now)?.plan === plan)
  if (!discounted)
    return {
      priceUsd: normal.priceUsd,
      minutes: normal.minutes,
      normalPriceUsd: null,
      normalMinutes: null,
    }
  return {
    priceUsd: deal.price,
    minutes: deal.minutes,
    normalPriceUsd: deal.normalPrice,
    normalMinutes: deal.normalMinutes,
  }
}

// How long the price is locked for whoever claims next: 12 months while early
// spots remain, 3 after.
export function promoMonths(promo: Pick<BillingPromo, 'earlyLeft'>): 3 | 12 {
  return promo.earlyLeft > 0 ? 12 : 3
}

// "Locked for 12 months for the first 50 workspaces. 37 spots left." /
// "The 50 twelve-month spots are taken. Claim now to lock it in for 3 months."
export function promoTermText(
  promo: Pick<BillingPromo, 'earlyCap' | 'earlyLeft'>,
): string {
  if (promo.earlyLeft > 0) {
    const spots = `${promo.earlyLeft} ${promo.earlyLeft === 1 ? 'spot' : 'spots'} left`
    return `Locked for 12 months for the first ${promo.earlyCap} workspaces. ${spots}.`
  }
  return `The ${promo.earlyCap} twelve-month spots are taken. Claim now to lock it in for 3 months.`
}

const pad = (n: number) => String(n).padStart(2, '0')

// "2d 04h 12m" a day or more out, "04h 12m 09s" inside the last day, null
// once it has passed.
export function countdownText(endsAt: string, now = Date.now()): string | null {
  const ms = new Date(endsAt).getTime() - now
  if (!(ms > 0)) return null
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return days > 0
    ? `${days}d ${pad(hours)}h ${pad(minutes)}m`
    : `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`
}

// Why a `?promo=` link isn't giving this org the deal, or null if it is (or
// the offer is unknown, e.g. the endpoint failed, in which case the page just
// shows normal prices).
export function promoUnavailableText(
  promo: BillingPromo | undefined,
  now = Date.now(),
): string | null {
  if (!promo || promoApplies(promo, now)) return null
  if (promo.claim) return null
  if (!promo.active || new Date(promo.endsAt).getTime() <= now)
    return 'The Black Friday deal has ended. Plans are at their normal price.'
  return "The Black Friday deal is for workspaces that aren't on a paid plan yet, so this workspace keeps its current price."
}

// The site's deal CTAs link `/?plan=pro|max&promo=bfcm2026`; the params
// survive login via returnTo. A plain `/?plan=` lands in the product on the
// trial (plan_intent is recorded at signup), but a deal link means "claim it",
// so it opens Billing with that plan's checkout and the promo carried along.
export function promoIntentPath(params: URLSearchParams): string | null {
  if (params.get('promo') !== BFCM_PROMO_ID) return null
  const plan = params.get('plan')
  const next = new URLSearchParams()
  if (plan === 'pro' || plan === 'max') next.set('plan', plan)
  next.set('promo', BFCM_PROMO_ID)
  next.set('from', 'signup')
  return `/billing?${next.toString()}#plans`
}

// The deal this org holds, while its locked price still runs.
export function activeClaim(
  promo: BillingPromo | undefined,
  now = Date.now(),
): BillingPromo['claim'] {
  const claim = promo?.claim ?? null
  return claim && new Date(claim.endsAt).getTime() > now ? claim : null
}
