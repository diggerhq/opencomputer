import { describe, expect, it } from 'vitest'
import {
  PLAN_NAMES,
  TRIAL_PAYWALL,
  billingActionHref,
  billingPillText,
  deepLinkedPlanFor,
  formatCredits,
  haltNotice,
  planChangeTiming,
  planPriceLabel,
  upgradeHref,
  upgradePlanFor,
  warningNotice,
} from '@/lib/billing-onramp'

const NOW = new Date('2026-06-26T12:00:00Z').getTime()
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString()

describe('billing on-ramp plans', () => {
  it('names the trial and the $20 / $200 plans', () => {
    expect(PLAN_NAMES).toEqual({
      trial: 'Trial',
      base: 'Free',
      pro: 'Pro',
      max: 'Max',
    })
    expect(planPriceLabel('pro')).toBe('Pro ($20/mo)')
    expect(planPriceLabel('max')).toBe('Max ($200/mo)')
    expect(upgradeHref()).toBe('/billing#plans')
    expect(upgradeHref('pro')).toBe('/billing?plan=pro')
    expect(billingActionHref('card', 'warning')).toBe(
      '/billing?from=warning#payment',
    )
    expect(billingActionHref('credits')).toBe('/billing#credits')
  })

  it('prompts the trial to Pro and Pro to Max', () => {
    expect(upgradePlanFor('trial')).toBe('pro')
    expect(upgradePlanFor('base')).toBe('pro')
    expect(upgradePlanFor('pro')).toBe('max')
    expect(upgradePlanFor('max')).toBeNull()
  })

  it('upgrades now and moves $200 to $20 at the end of the period', () => {
    expect(planChangeTiming('trial', 'pro')).toBe('now')
    expect(planChangeTiming('pro', 'max')).toBe('now')
    expect(planChangeTiming('max', 'pro')).toBe('period_end')
  })

  it('opens the linked checkout for upgrades only', () => {
    expect(deepLinkedPlanFor('pro', 'trial')).toBe('pro')
    expect(deepLinkedPlanFor('max', 'trial')).toBe('max')
    expect(deepLinkedPlanFor('max', 'pro')).toBe('max')
    expect(deepLinkedPlanFor('pro', 'pro')).toBeNull()
    expect(deepLinkedPlanFor('pro', 'max')).toBeNull()
    expect(deepLinkedPlanFor(null, 'trial')).toBeNull()
    expect(deepLinkedPlanFor('top_up', 'trial')).toBeNull()
  })

  it('states both plans in the paywall', () => {
    expect(TRIAL_PAYWALL).toBe(
      'Your free trial is over. Choose $20 or $200 a month to keep going.',
    )
  })
})

describe('billingPillText', () => {
  it('shows the trial minutes and days left', () => {
    expect(
      billingPillText(
        {
          usagePlan: 'trial',
          creditsRemainingCents: 1_000,
          workMinutes: { granted: 600, remaining: 412 },
          trialEndsAt: inDays(4.5),
        },
        NOW,
      ),
    ).toBe('Trial · 412 min · 5 days left')
  })

  it('shows minutes left of the allowance and credits on a paid plan', () => {
    expect(
      billingPillText({
        usagePlan: 'pro',
        creditsRemainingCents: 1_200,
        workMinutes: { granted: 2_000, remaining: 1_240 },
      }),
    ).toBe('1,240 / 2,000 min · $12 credits')
  })

  it('shows nothing for the old free tier', () => {
    expect(
      billingPillText({ usagePlan: 'base', creditsRemainingCents: 500 }),
    ).toBeNull()
  })
})

describe('haltNotice', () => {
  it.each([
    ['trial_minutes', ['plans']],
    ['trial_days', ['plans']],
    ['trial_tokens', ['plans']],
    ['credits_empty', ['credits', 'plans']],
    ['credits_exhausted', ['credits', 'plans']],
    ['payment', ['card']],
    ['lapsed', ['plans']],
    [null, ['plans']],
  ])('offers the way out of %s', (reason, actions) => {
    expect(haltNotice(reason).actions).toEqual(actions)
  })

  it('words the trial halts as the end of the trial', () => {
    const notice = haltNotice('trial_days')
    expect(notice.title).toBe('Your free trial is over')
    expect(notice.body).toContain('7-day trial has ended')
    expect(notice.body).toContain('$20')
  })
})

describe('warningNotice', () => {
  const billing = {
    creditsRemainingCents: 250,
    workMinutes: { remaining: 45 },
    trialEndsAt: inDays(2),
  }

  it.each([
    ['trial_minutes', 'Your trial has 45 min of work left.', 'plans'],
    ['trial_days', 'Your trial ends in 2 days.', 'plans'],
    ['credits_low', 'Your credits are running low ($2.50 left).', 'credits'],
    [
      'payment_failed',
      'Your last payment failed. Update your card to avoid a pause.',
      'card',
    ],
  ])('words %s', (warning, text, action) => {
    expect(warningNotice(warning, billing, NOW)).toEqual({ text, action })
  })
})

describe('formatCredits', () => {
  it('shows balances as credits, never dollars', () => {
    expect(formatCredits(229)).toBe('2.29 credits')
    expect(formatCredits(200_000)).toBe('2,000 credits')
    expect(formatCredits(100)).toBe('1 credit')
    expect(formatCredits(0)).toBe('0 credits')
  })
})
