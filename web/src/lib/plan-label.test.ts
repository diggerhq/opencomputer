import { describe, expect, it } from 'vitest'
import { organizationPlanLabel, planLabel } from '@/lib/plan-label'

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

  it('uses the standard billing plan for legacy billing', () => {
    expect(organizationPlanLabel(org, { plan: 'pro' }, undefined)).toBe('Pro')
  })
})
