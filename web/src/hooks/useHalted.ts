import { useQuery } from '@tanstack/react-query'
import { getAutumnBilling } from '@/api/client'

// Halted state for the credit-gated agent controls (composer, new-session),
// sharing the app shell's 30s poll. Every plan halts the same way now
// (serverless-agents-ws 086: no fallback model for paid orgs).
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
