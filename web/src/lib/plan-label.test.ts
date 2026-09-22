import { describe, expect, it } from 'vitest'
import { organizationPlanDetails, planLabel } from '@/lib/plan-label'

describe('planLabel', () => {
  it.each([
    ['free', 'Free'],
    ['pro', 'Pro'],
    ['base', 'Base'],
    ['concurrency_pro', 'Pro'],
    ['concurrency_pro_plus', 'Pro+'],
    ['concurrency_pro_plus_plus', 'Pro++'],
  ])('formats %s as %s', (plan, label) => {
    expect(planLabel(plan)).toBe(label)
  })

  it('formats an unknown concurrency tier instead of exposing its identifier', () => {
    expect(planLabel('concurrency_enterprise_custom')).toBe('Enterprise Custom')
  })
})

describe('organizationPlanDetails', () => {
  const org = { plan: 'free', maxConcurrentSandboxes: 50 }

  it('uses the Autumn usage plan instead of the legacy org plan or concurrency tier', () => {
    expect(
      organizationPlanDetails(
        org,
        {
          plan: 'free',
          maxConcurrentSandboxes: 50,
          billingProvider: 'autumn',
        },
        {
          usagePlan: 'max',
          maxConcurrentSandboxes: 50,
        },
      ),
    ).toEqual({ label: 'Max', maxConcurrentSandboxes: 50 })
  })

  it('uses the standard billing plan for legacy billing', () => {
    expect(
      organizationPlanDetails(
        org,
        { plan: 'pro', maxConcurrentSandboxes: 100 },
        undefined,
      ),
    ).toEqual({ label: 'Pro', maxConcurrentSandboxes: 100 })
  })
})
