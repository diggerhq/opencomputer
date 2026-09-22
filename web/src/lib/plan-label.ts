const CONCURRENCY_PLAN_LABELS: Record<string, string> = {
  base: 'Base',
  concurrency_pro: 'Pro',
  concurrency_pro_plus: 'Pro+',
  concurrency_pro_plus_plus: 'Pro++',
}

export function planLabel(plan: string): string {
  return (
    CONCURRENCY_PLAN_LABELS[plan] ??
    plan
      .replace(/^concurrency_/, '')
      .split('_')
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ')
  )
}

type PlanSource = {
  plan: string
  maxConcurrentSandboxes: number
}

type BillingPlanSource = PlanSource & {
  billingProvider?: string
}

type AutumnPlanSource = {
  concurrencyPlan: string
  maxConcurrentSandboxes: number
}

export function organizationPlanDetails(
  org: PlanSource | undefined,
  billing: BillingPlanSource | undefined,
  autumn: AutumnPlanSource | undefined,
): { label: string; maxConcurrentSandboxes: number | undefined } {
  if (billing?.billingProvider === 'autumn') {
    return {
      label: planLabel(autumn?.concurrencyPlan ?? 'base'),
      maxConcurrentSandboxes:
        autumn?.maxConcurrentSandboxes ?? org?.maxConcurrentSandboxes,
    }
  }

  return {
    label: planLabel(billing?.plan ?? org?.plan ?? 'free'),
    maxConcurrentSandboxes:
      billing?.maxConcurrentSandboxes ?? org?.maxConcurrentSandboxes,
  }
}
