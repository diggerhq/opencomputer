import { useQuery } from '@tanstack/react-query'
import { getBillingPromo } from '@/api/client'
import type { BillingPromo } from '@/api/schemas'
import { billingOnrampV2Enabled, type PaidPlanId } from '@/lib/billing-onramp'
import { planPricing, promoApplies } from '@/lib/promo'
import { SELFHOST } from '@/lib/selfhost'

export interface BillingPromoState {
  promo: BillingPromo | undefined
  // Settled (loaded or failed), so a price shown now won't flip a moment later.
  settled: boolean
  // A plan checkout opened now would claim the deal.
  applies: boolean
  pricing: (plan: PaidPlanId) => ReturnType<typeof planPricing>
  // The promo id to send with a plan checkout, when it applies.
  checkoutPromo: string | undefined
}

// The org's view of the current deal, shared by every price on screen and the
// checkout call. Any failure (no endpoint yet, 404 once the deal is gone, a
// shape mismatch) leaves `promo` undefined, which is normal pricing.
export function useBillingPromo(): BillingPromoState {
  const enabled = !SELFHOST && billingOnrampV2Enabled
  const { data, isPending } = useQuery({
    queryKey: ['billing-promo'],
    queryFn: getBillingPromo,
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.error ? false : 60_000),
  })
  const applies = promoApplies(data)
  return {
    promo: data,
    settled: !enabled || !isPending,
    applies,
    pricing: (plan) => planPricing(plan, data),
    checkoutPromo: applies ? data?.id : undefined,
  }
}
