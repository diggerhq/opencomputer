import posthog from 'posthog-js'
import { USAGE_PLAN_NAMES } from '@/lib/plan-label'

// Payment on-ramp experiment (low-credit banner, sidebar meter, post-session
// upsell, Pro paywall copy). Set the build-time value to "0" to fall back to
// the halt-only behaviour.
export const billingOnrampV2Enabled =
  import.meta.env.VITE_BILLING_ONRAMP_V2 !== '0'

export type UsagePlanId = 'base' | 'pro' | 'max'
export type PaidPlanId = Exclude<UsagePlanId, 'base'>

// The one plan new customers can buy. Its Autumn id stays `max`; it is shown
// as "Pro". The old $20/mo plan (Autumn id `pro`) is retired: it shows as
// "Pro (legacy)" to its existing subscribers and is never offered to anyone
// else. Top-ups are no longer sold.
export const UPGRADE_PLAN = 'max' as const satisfies PaidPlanId
export type UpgradePlanId = typeof UPGRADE_PLAN

export const PLAN_OFFERS: Record<
  PaidPlanId,
  { priceUsd: number; creditsUsd: number }
> = {
  pro: { priceUsd: 20, creditsUsd: 200 },
  max: { priceUsd: 200, creditsUsd: 2000 },
}

export const PLAN_NAMES: Record<UsagePlanId, string> = USAGE_PLAN_NAMES

export const UPGRADE_OFFER = PLAN_OFFERS[UPGRADE_PLAN]

// "Pro ($200/mo)": how every upgrade prompt names the plan to buy.
export const UPGRADE_PLAN_LABEL = `${PLAN_NAMES[UPGRADE_PLAN]} ($${UPGRADE_OFFER.priceUsd}/mo)`

// The free-tier paywall, the same on every surface. It does not state the
// grant amount: that is still $5 today and changes in a later step.
export const FREE_CREDITS_USED = "You've used your free credits."
export const FREE_CREDITS_PAYWALL = `${FREE_CREDITS_USED} Upgrade to ${UPGRADE_PLAN_LABEL} to keep going.`

// Monthly grant per plan; the base grant is the signup allowance.
export const BASE_GRANT_CENTS = 500
const PLAN_GRANT_CENTS: Record<UsagePlanId, number> = {
  base: BASE_GRANT_CENTS,
  pro: 20_000,
  max: 200_000,
}
const LOW_CREDIT_FRACTION = 0.3

export function lowCreditThresholdCents(plan: UsagePlanId): number {
  return Math.round(PLAN_GRANT_CENTS[plan] * LOW_CREDIT_FRACTION)
}

// The plan an org is prompted to upgrade to: always the $200 Pro, from Free
// and from legacy Pro alike. null when the org is already on it.
export function upgradePlanFor(plan: UsagePlanId): UpgradePlanId | null {
  return plan === UPGRADE_PLAN ? null : UPGRADE_PLAN
}

export function upgradeHref(plan: PaidPlanId = UPGRADE_PLAN): string {
  return `/billing?plan=${plan}`
}

// Paid plans an org may pick on the Billing page: the $200 Pro for everyone,
// plus legacy Pro only for an org already subscribed to it.
export function selectablePaidPlans(current: UsagePlanId): PaidPlanId[] {
  return current === 'pro' ? ['pro', UPGRADE_PLAN] : [UPGRADE_PLAN]
}

// `?plan=` deep link → the plan whose checkout to open. Older links (and
// agent transcripts) still carry `plan=pro`; for anyone not on legacy Pro they
// mean "upgrade", so they open the $200 Pro. Never opens legacy Pro checkout.
export function deepLinkedPlanFor(
  requested: string | null,
  current: UsagePlanId,
): UpgradePlanId | null {
  if (requested !== 'pro' && requested !== 'max') return null
  return current === UPGRADE_PLAN ? null : UPGRADE_PLAN
}

// Cents of usage per credit (1 credit = $1 in the Autumn catalog today).
export const CENTS_PER_CREDIT = 100

const creditNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

// Balances and allowances are shown as credits, never dollars.
export function formatCreditCount(cents: number): string {
  return creditNumber.format(cents / CENTS_PER_CREDIT)
}

export function formatCredits(cents: number): string {
  const count = formatCreditCount(cents)
  return `${count} ${count === '1' ? 'credit' : 'credits'}`
}

export type UpsellSurface =
  | 'sidebar_meter'
  | 'low_credit_banner'
  | 'halt_banner'
  | 'session_composer'
  | 'post_session_card'
  | 'byok_gate'
  | 'billing_page'
  | 'billing_deeplink'

interface UpsellProps {
  surface: UpsellSurface
  plan?: PaidPlanId
  usagePlan?: UsagePlanId
  creditsRemainingCents?: number
}

const SURFACE_KEY = 'oc.billing.upsell_surface'

export function trackUpsellShown(props: UpsellProps): void {
  posthog.capture('upsell_shown', props)
}

export function trackUpsellClicked(props: UpsellProps): void {
  posthog.capture('upsell_clicked', props)
  try {
    sessionStorage.setItem(SURFACE_KEY, props.surface)
  } catch {
    // storage unavailable (private mode); attribution is best-effort
  }
}

// The surface that sent the user to /billing, so checkout/activation can be
// attributed to it after the Stripe round trip.
export function attributedSurface(): UpsellSurface | undefined {
  try {
    return (
      (sessionStorage.getItem(SURFACE_KEY) as UpsellSurface | null) ?? undefined
    )
  } catch {
    return undefined
  }
}

export function trackCheckoutStarted(props: {
  plan?: PaidPlanId
  usagePlan?: UsagePlanId
}): void {
  posthog.capture('checkout_started', {
    ...props,
    surface: attributedSurface(),
  })
}

export function trackPlanActivated(props: {
  plan?: PaidPlanId
  usagePlan?: UsagePlanId
}): void {
  posthog.capture('plan_activated', { ...props, surface: attributedSurface() })
  try {
    sessionStorage.removeItem(SURFACE_KEY)
  } catch {
    // ignore
  }
}

export function trackFirstSessionCompleted(props: {
  sessionId: string
  costCents?: number
  usagePlan?: UsagePlanId
}): void {
  posthog.capture('first_session_completed', props)
}
