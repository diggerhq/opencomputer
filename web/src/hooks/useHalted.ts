import { useQuery } from '@tanstack/react-query'
import { getAutumnBilling } from '@/api/client'

// Out-of-credits state for the credit-gated agent controls (composer,
// new-session), sharing the halt banner's 30s poll. Only base orgs are blocked:
// Pro/Max orgs keep running agents on the fallback model once credits run out.
// Autumn orgs only; legacy orgs 404 on /billing/autumn → error → treated as not halted.
export function useHalted(): boolean {
  const { data } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  })
  if (!data?.isHalted) return false
  return data.usagePlan !== 'pro' && data.usagePlan !== 'max'
}
