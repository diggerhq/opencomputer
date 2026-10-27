import { useQuery } from '@tanstack/react-query'
import { getAutumnBilling } from '@/api/client'
import { haltBlocksAgents } from '@/lib/billing-onramp'

// Halted state for the credit-gated agent controls (composer, new-session),
// sharing the app shell's 30s poll. Every work-minute halt blocks them; a paid
// org halted by the old credit rule keeps the fallback model (haltBlocksAgents).
// Autumn orgs only; legacy orgs 404 on /billing/autumn → error → treated as not halted.
export function useHalted(): boolean {
  const { data } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  })
  return haltBlocksAgents(data)
}
