import { describe, expect, it } from 'vitest'
import {
  organizationPlanLabel,
  planLabel,
  usagePlanLabel,
} from '@/lib/plan-label'

describe('planLabel', () => {
  it.each([
    ['free', 'Free'],
    ['pro', 'Pro'],
    ['base', 'Base'],
    ['max', 'Max'],
  ])('formats %s as %s', (plan, label) => {
    expect(planLabel(plan)).toBe(label)
  })

  it('formats an unknown plan instead of exposing its identifier', () => {
    expect(planLabel('enterprise_custom')).toBe('Enterprise Custom')
  })
})

describe('usagePlanLabel', () => {
  it.each([
    ['trial', 'Trial'],
    ['base', 'Free'],
    ['pro', 'Pro'],
    ['max', 'Max'],
    ['enterprise_custom', 'Enterprise Custom'],
  ])('names usage plan %s as %s', (plan, label) => {
    expect(usagePlanLabel(plan)).toBe(label)
  })
})

describe('organizationPlanLabel', () => {
  const org = { plan: 'free' }

  it('uses the Autumn usage plan instead of the legacy org plan or concurrency tier', () => {
    expect(
      organizationPlanLabel(
        org,
        {
          plan: 'free',
          billingProvider: 'autumn',
        },
        {
          usagePlan: 'max',
        },
      ),
    ).toBe('Max')
  })

  it('names the $20 plan Pro, the trial Trial and the old free tier Free', () => {
    const autumnBilling = { plan: 'free', billingProvider: 'autumn' }
    expect(
      organizationPlanLabel(org, autumnBilling, { usagePlan: 'pro' }),
    ).toBe('Pro')
    expect(
      organizationPlanLabel(org, autumnBilling, { usagePlan: 'trial' }),
    ).toBe('Trial')
    expect(
      organizationPlanLabel(org, autumnBilling, { usagePlan: 'base' }),
    ).toBe('Free')
  })

  it('uses the standard billing plan for legacy billing', () => {
    expect(organizationPlanLabel(org, { plan: 'pro' }, undefined)).toBe('Pro')
  })
})
