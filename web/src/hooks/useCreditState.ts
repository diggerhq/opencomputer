import { useQuery } from '@tanstack/react-query'
import { getAutumnBilling } from '@/api/client'
import type { AutumnBilling } from '@/api/schemas'
import {
  upgradePlanFor,
  type UpgradePlanId,
  type UsagePlanId,
} from '@/lib/billing-onramp'

export interface CreditState {
  billing: AutumnBilling | undefined
  usagePlan: UsagePlanId | undefined
  creditsRemainingCents: number | undefined
  isHalted: boolean
  // Halted orgs can't start agent sessions until they pay (serverless-agents-ws
  // 086: no fallback model on any plan).
  sessionsBlocked: boolean
  // orgs.halt_reason while halted, and orgs.billing_warning before that.
  haltReason: string | null
  warning: string | null
  // The plan to prompt for: Pro from the trial, Max from Pro; null on Max.
  upgradePlan: UpgradePlanId | null
}

// Shares the same 30s poll as useHalted and the app shell via the
// 'autumn-billing' key.
export function useCreditState(): CreditState {
  const { data } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  })
  const usagePlan = data?.usagePlan
  const isHalted = data?.isHalted ?? false
  return {
    billing: data,
    usagePlan,
    creditsRemainingCents: data?.creditsRemainingCents,
    isHalted,
    sessionsBlocked: isHalted,
    haltReason: isHalted ? (data?.haltReason ?? null) : null,
    warning: isHalted ? null : (data?.warning ?? null),
    upgradePlan: upgradePlanFor(usagePlan ?? 'trial'),
  }
}
