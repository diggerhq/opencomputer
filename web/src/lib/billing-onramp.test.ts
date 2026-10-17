import { describe, expect, it } from 'vitest'
import {
  FREE_CREDITS_PAYWALL,
  PLAN_NAMES,
  UPGRADE_PLAN,
  UPGRADE_PLAN_LABEL,
  deepLinkedPlanFor,
  formatCredits,
  selectablePaidPlans,
  upgradeHref,
  upgradePlanFor,
} from '@/lib/billing-onramp'

describe('billing on-ramp plans', () => {
  it('sells only the $200 plan (Autumn id max), named Pro', () => {
    expect(UPGRADE_PLAN).toBe('max')
    expect(PLAN_NAMES).toEqual({
      base: 'Free',
      pro: 'Pro (legacy)',
      max: 'Pro',
    })
    expect(UPGRADE_PLAN_LABEL).toBe('Pro ($200/mo)')
    expect(upgradeHref()).toBe('/billing?plan=max')
  })

  it('prompts Free and legacy Pro orgs to the $200 Pro, and nobody to legacy Pro', () => {
    expect(upgradePlanFor('base')).toBe('max')
    expect(upgradePlanFor('pro')).toBe('max')
    expect(upgradePlanFor('max')).toBeNull()
  })

  it('lists legacy Pro only to its own subscribers', () => {
    expect(selectablePaidPlans('base')).toEqual(['max'])
    expect(selectablePaidPlans('max')).toEqual(['max'])
    expect(selectablePaidPlans('pro')).toEqual(['pro', 'max'])
  })

  it('opens the $200 Pro checkout for ?plan= deep links, old plan=pro links included', () => {
    expect(deepLinkedPlanFor('max', 'base')).toBe('max')
    expect(deepLinkedPlanFor('pro', 'base')).toBe('max')
    expect(deepLinkedPlanFor('pro', 'pro')).toBe('max')
    expect(deepLinkedPlanFor('max', 'max')).toBeNull()
    expect(deepLinkedPlanFor(null, 'base')).toBeNull()
    expect(deepLinkedPlanFor('top_up', 'base')).toBeNull()
  })

  it('uses one paywall message without the grant amount or a top-up', () => {
    expect(FREE_CREDITS_PAYWALL).toBe(
      "You've used your free credits. Upgrade to Pro ($200/mo) to keep going.",
    )
    expect(FREE_CREDITS_PAYWALL).not.toMatch(/top.?up|\$5\b|\$10\b/i)
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
