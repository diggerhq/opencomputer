import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  autumnBillingPortal,
  autumnSubscribeUsagePlan,
  autumnTopup,
  type CheckoutFrom,
} from '@/api/client'
import { notifyError } from '@/lib/errors'
import {
  PLAN_NAMES,
  formatUsd,
  trackCheckoutStarted,
  trackPlanActivated,
  type PaidPlanId,
  type UsagePlanId,
} from '@/lib/billing-onramp'

// The three ways out of a billing prompt: open a plan checkout, buy a credit
// pack, or fix the card on Stripe. A returned url is a hosted Stripe page
// (no card on file yet); null means Autumn charged the saved card already.
export function useBillingActions(options: {
  from: CheckoutFrom
  usagePlan?: UsagePlanId
  onPlanChanged?: (plan: PaidPlanId) => void
}) {
  const queryClient = useQueryClient()
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })

  const subscribe = useMutation({
    mutationFn: (plan: PaidPlanId) =>
      autumnSubscribeUsagePlan(plan, options.from),
    onSuccess: (data, plan) => {
      trackCheckoutStarted({ plan, usagePlan: options.usagePlan })
      options.onPlanChanged?.(plan)
      if (data.url) {
        window.location.href = data.url
        return
      }
      toast.success(`${PLAN_NAMES[plan]} plan updated`, {
        description: 'Your minutes and billing status are refreshing.',
      })
      trackPlanActivated({ plan, usagePlan: options.usagePlan })
      refresh()
    },
    onError: (e) => notifyError("Couldn't update your plan.", e),
  })

  const buyPack = useMutation({
    // 1 credit = $1 in the Autumn catalog.
    mutationFn: (usd: number) => autumnTopup(usd),
    onSuccess: (data, usd) => {
      if (data.url) {
        window.location.href = data.url
        return
      }
      toast.success(`${formatUsd(usd * 100)} of credits added`)
      refresh()
    },
    onError: (e) => notifyError("Couldn't buy credits.", e),
  })

  const portal = useMutation({
    mutationFn: autumnBillingPortal,
    onSuccess: (data) => {
      window.location.href = data.url
    },
    onError: (e) => notifyError("Couldn't open the billing portal.", e),
  })

  return {
    subscribe,
    buyPack,
    portal,
    pending: subscribe.isPending || buyPack.isPending || portal.isPending,
  }
}
