import { useQuery } from '@tanstack/react-query'
import { getAutumnBilling } from '@/api/client'
import type { AutumnBilling } from '@/api/schemas'
import {
  billingOnrampV2Enabled,
  lowCreditThresholdCents,
  upgradePlanFor,
  type PaidPlanId,
  type UsagePlanId,
} from '@/lib/billing-onramp'

export interface CreditState {
  billing: AutumnBilling | undefined
  usagePlan: UsagePlanId | undefined
  creditsRemainingCents: number | undefined
  isHalted: boolean
  // Out of credits on base: agent sessions are blocked until the org upgrades.
  sessionsBlocked: boolean
  // Out of credits on Pro/Max: agents keep running on the fallback model.
  modelFallback: boolean
  // Below the low-credit threshold but not yet halted; only for prepaid orgs
  // with the on-ramp experiment enabled.
  isLow: boolean
  upgradePlan: PaidPlanId
}

// Shares the same 30s poll as useHalted/HaltBanner via the 'autumn-billing' key.
export function useCreditState(): CreditState {
  const { data } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  })
  const usagePlan = data?.usagePlan
  const isHalted = data?.isHalted ?? false
  const paid = usagePlan === 'pro' || usagePlan === 'max'
  const isLow =
    billingOnrampV2Enabled &&
    !isHalted &&
    data !== undefined &&
    data.creditsRemainingCents <= lowCreditThresholdCents(data.usagePlan)
  return {
    billing: data,
    usagePlan,
    creditsRemainingCents: data?.creditsRemainingCents,
    isHalted,
    sessionsBlocked: isHalted && !paid,
    modelFallback: isHalted && paid,
    isLow,
    upgradePlan: upgradePlanFor(usagePlan ?? 'base'),
  }
}
