import { useQuery } from '@tanstack/react-query'
import { getAutumnBilling } from '@/api/client'

// Out-of-credits (halt) state, shared across the halt banner and the credit-gated
// controls (composer, new-session) so they stay in sync and share one 30s poll.
// Autumn orgs only; legacy orgs 404 on /billing/autumn → error → treated as not halted.
export function useHalted(): boolean {
  const { data } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  })
  return data?.isHalted ?? false
}
