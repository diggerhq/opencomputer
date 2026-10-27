// Display names of the Autumn usage plans (serverless-agents-ws 086): the
// 3-day trial, Pro ($20/mo, 2,000 work minutes) and Max ($200/mo, 25,000).
// `base` is the pre-trial free tier, until those orgs are migrated.
export const USAGE_PLAN_NAMES: Record<
  'trial' | 'base' | 'pro' | 'max',
  string
> = {
  trial: 'Trial',
  base: 'Free',
  pro: 'Pro',
  max: 'Max',
}

export function usagePlanLabel(plan: string): string {
  return plan === 'trial' || plan === 'base' || plan === 'pro' || plan === 'max'
    ? USAGE_PLAN_NAMES[plan]
    : planLabel(plan)
}

export function planLabel(plan: string): string {
  return plan
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

type PlanSource = {
  plan: string
}

type BillingPlanSource = PlanSource & {
  billingProvider?: string
}

type AutumnPlanSource = {
  usagePlan: string
}

export function organizationPlanLabel(
  org: PlanSource | undefined,
  billing: BillingPlanSource | undefined,
  autumn: AutumnPlanSource | undefined,
): string {
  if (billing?.billingProvider === 'autumn') {
    return usagePlanLabel(autumn?.usagePlan ?? 'base')
  }

  return planLabel(billing?.plan ?? org?.plan ?? 'free')
}
