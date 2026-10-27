import posthog from 'posthog-js'
import { USAGE_PLAN_NAMES } from '@/lib/plan-label'

// Payment on-ramp experiment (header pill, warning banner, post-session
// upsell). Set the build-time value to "0" to fall back to the halt-only
// behaviour.
export const billingOnrampV2Enabled =
  import.meta.env.VITE_BILLING_ONRAMP_V2 !== '0'

export type UsagePlanId = 'trial' | 'base' | 'pro' | 'max'
export type PaidPlanId = 'pro' | 'max'

// Work-minute plans (serverless-agents-ws 086): a 7-day trial with 600 work
// minutes and $10 of model credits, then Pro ($20/mo, 2,000 min) or Max
// ($200/mo, 25,000 min). Past the allowance, work draws prepaid credits at
// $0.01/min, bought in packs.
export const TRIAL_DAYS = 7
export const TRIAL_MINUTES = 600
export const TRIAL_CREDITS_USD = 10
export const OVERAGE_USD_PER_MINUTE = 0.01
export const CREDIT_PACKS_USD = [10, 50, 200] as const
export type CreditPackUsd = (typeof CREDIT_PACKS_USD)[number]

export const PAID_PLANS: PaidPlanId[] = ['pro', 'max']

export const PLAN_OFFERS: Record<
  PaidPlanId,
  { priceUsd: number; minutes: number }
> = {
  pro: { priceUsd: 20, minutes: 2_000 },
  max: { priceUsd: 200, minutes: 25_000 },
}

export const PLAN_NAMES: Record<UsagePlanId, string> = USAGE_PLAN_NAMES

// The entry plan, offered first wherever one plan is named.
export const UPGRADE_PLAN = 'pro' as const satisfies PaidPlanId
export type UpgradePlanId = PaidPlanId

// "Pro ($20/mo)".
export function planPriceLabel(plan: PaidPlanId): string {
  return `${PLAN_NAMES[plan]} ($${PLAN_OFFERS[plan].priceUsd}/mo)`
}

// How a prompt that doesn't name one plan sends people to the picker.
export const CHOOSE_PLAN_LABEL = 'Choose a plan'

// Composer and new-session gates while halted; the halt modal says why.
export const WORK_PAUSED = 'Work is paused.'
export const WORK_PAUSED_TITLE = `${WORK_PAUSED} Open Billing to resume.`

export const TRIAL_OVER = 'Your free trial is over.'
export const TRIAL_PAYWALL = `${TRIAL_OVER} Choose $20 or $200 a month to keep going.`

// The plan an org is prompted to upgrade to: Pro from the trial, Max from Pro.
export function upgradePlanFor(plan: UsagePlanId): UpgradePlanId | null {
  if (plan === 'max') return null
  return plan === 'pro' ? 'max' : 'pro'
}

// No plan → the picker on the Billing page.
export function upgradeHref(plan?: PaidPlanId): string {
  return plan ? `/billing?plan=${plan}` : '/billing#plans'
}

// When a switch to `target` takes effect: upgrades now, $200 → $20 at the end
// of the period (the edge asks Autumn for the same).
export function planChangeTiming(
  current: UsagePlanId,
  target: PaidPlanId,
): 'now' | 'period_end' {
  return current === 'max' && target === 'pro' ? 'period_end' : 'now'
}

// `?plan=` deep link → the checkout to open. Only upgrades: a link never
// downgrades an org or reopens the plan it is on.
export function deepLinkedPlanFor(
  requested: string | null,
  current: UsagePlanId,
): PaidPlanId | null {
  if (requested !== 'pro' && requested !== 'max') return null
  if (requested === current) return null
  return planChangeTiming(current, requested) === 'now' ? requested : null
}

const minuteNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

export function formatMinutes(minutes: number): string {
  return `${minuteNumber.format(minutes)} min`
}

// "$12", "$2.50".
export function formatUsd(cents: number): string {
  const whole = cents % 100 === 0
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100)
}

// Whole days left until `iso`, never negative.
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000))
}

interface PillSource {
  usagePlan: UsagePlanId
  creditsRemainingCents: number
  workMinutes?: { granted: number; remaining: number } | null
  trialEndsAt?: string | null
}

// The header pill: "Trial · 412 min · 5 days left" or
// "1,240 / 2,000 min · $12 credits" (minutes left of the month's allowance).
export function billingPillText(
  b: PillSource,
  now = Date.now(),
): string | null {
  const minutes = b.workMinutes
  if (b.usagePlan === 'trial') {
    const parts = ['Trial']
    if (minutes) parts.push(formatMinutes(minutes.remaining))
    if (b.trialEndsAt) {
      const days = daysUntil(b.trialEndsAt, now)
      parts.push(`${days} ${days === 1 ? 'day' : 'days'} left`)
    }
    return parts.join(' · ')
  }
  if (b.usagePlan === 'base' || !minutes) return null
  return `${minuteNumber.format(minutes.remaining)} / ${formatMinutes(minutes.granted)} · ${formatUsd(b.creditsRemainingCents)} credits`
}

export type BillingAction = 'plans' | 'credits' | 'card'

export interface BillingNotice {
  title: string
  body: string
  actions: BillingAction[]
}

const TRIAL_HALTS: Record<string, string> = {
  trial_minutes: `You've used the trial's ${TRIAL_MINUTES} work minutes.`,
  trial_days: `Your ${TRIAL_DAYS}-day trial has ended.`,
  trial_tokens: `You've used the trial's $${TRIAL_CREDITS_USD} of model credits.`,
}

// The blocking modal shown on every page while the org is halted, worded by
// orgs.halt_reason.
export function haltNotice(reason: string | null | undefined): BillingNotice {
  if (reason && reason in TRIAL_HALTS) {
    return {
      title: TRIAL_OVER.replace(/\.$/, ''),
      body: `${TRIAL_HALTS[reason]} Choose Pro ($20/mo) or Max ($200/mo) to keep your computer and automations running.`,
      actions: ['plans'],
    }
  }
  if (reason === 'credits_empty' || reason === 'credits_exhausted') {
    return {
      title: "You're out of credits",
      body: "You've used this month's work minutes and your prepaid credits. Buy credits or upgrade to keep going.",
      actions: ['credits', 'plans'],
    }
  }
  if (reason === 'payment') {
    return {
      title: 'Your payment failed',
      body: "We couldn't charge your card, so work is paused. Update your card to keep going.",
      actions: ['card'],
    }
  }
  return {
    title: 'Your plan has ended',
    body: 'Work is paused. Choose a plan to keep going.',
    actions: ['plans'],
  }
}

// The banner shown while orgs.billing_warning is set, before any halt.
export function warningNotice(
  warning: string,
  b: {
    workMinutes?: { remaining: number } | null
    trialEndsAt?: string | null
    creditsRemainingCents: number
  },
  now = Date.now(),
): { text: string; action: BillingAction } {
  switch (warning) {
    case 'trial_minutes':
      return {
        text: `Your trial has ${formatMinutes(b.workMinutes?.remaining ?? 0)} of work left.`,
        action: 'plans',
      }
    case 'trial_days': {
      const days = b.trialEndsAt ? daysUntil(b.trialEndsAt, now) : 0
      return {
        text:
          days <= 1
            ? 'Your trial ends tomorrow.'
            : `Your trial ends in ${days} days.`,
        action: 'plans',
      }
    }
    case 'trial_tokens':
      return {
        text: "Your trial's model credits are almost used up.",
        action: 'plans',
      }
    case 'allowance_80':
      return {
        text: "You've used 80% of this month's work minutes. After that, work draws credits at $0.01/min.",
        action: 'credits',
      }
    case 'credits_low':
      return {
        text: `Your credits are running low (${formatUsd(b.creditsRemainingCents)} left).`,
        action: 'credits',
      }
    case 'payment_failed':
      return {
        text: 'Your last payment failed. Update your card to avoid a pause.',
        action: 'card',
      }
    default:
      return { text: 'Check your plan and credits.', action: 'plans' }
  }
}

export const BILLING_ACTION_LABELS: Record<BillingAction, string> = {
  plans: CHOOSE_PLAN_LABEL,
  credits: 'Buy credits',
  card: 'Update card',
}

const ACTION_SECTIONS: Record<BillingAction, string> = {
  plans: 'plans',
  credits: 'credits',
  card: 'payment',
}

// Where each action lands on the Billing page; `from` rides along so a
// checkout opened there is attributed to the prompt (billing.checkout_opened).
export function billingActionHref(
  action: BillingAction,
  from?: 'paywall' | 'warning',
): string {
  return `/billing${from ? `?from=${from}` : ''}#${ACTION_SECTIONS[action]}`
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
  | 'header_pill'
  | 'warning_banner'
  | 'halt_modal'
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

// Work-minute plan funnel (serverless-agents-ws 086, "Surfaces"): the same
// events the CLI and the edge send, tagged with where they were seen.
export function trackWarningShown(reason: string): void {
  posthog.capture('billing.warning_shown', { reason, surface: 'web' })
}

export function trackPaywallShown(reason: string): void {
  posthog.capture('billing.paywall_shown', { reason, surface: 'web' })
}
