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
    return planLabel(autumn?.usagePlan ?? 'base')
  }

  return planLabel(billing?.plan ?? org?.plan ?? 'free')
}
