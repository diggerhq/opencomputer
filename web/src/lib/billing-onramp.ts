import posthog from 'posthog-js'

// Payment on-ramp experiment (low-credit banner, sidebar meter, post-session
// upsell, Pro-first halt copy). Set the build-time value to "0" to fall back to
// the halt-only behaviour.
export const billingOnrampV2Enabled =
  import.meta.env.VITE_BILLING_ONRAMP_V2 !== '0'

export type UsagePlanId = 'base' | 'pro' | 'max'
export type PaidPlanId = Exclude<UsagePlanId, 'base'>

export const PLAN_OFFERS: Record<
  PaidPlanId,
  { priceUsd: number; creditsUsd: number }
> = {
  pro: { priceUsd: 20, creditsUsd: 200 },
  max: { priceUsd: 200, creditsUsd: 2000 },
}

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

export function upgradePlanFor(plan: UsagePlanId): PaidPlanId {
  return plan === 'pro' ? 'max' : 'pro'
}

export function upgradeHref(plan: PaidPlanId): string {
  return `/billing?plan=${plan}`
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
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
  topupUsd?: number
  usagePlan?: UsagePlanId
}): void {
  posthog.capture('checkout_started', {
    ...props,
    surface: attributedSurface(),
  })
}

export function trackPlanActivated(props: {
  plan?: PaidPlanId
  topupUsd?: number
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
