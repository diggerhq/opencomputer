import type { SessionSource } from '@/api/client'

const ACTIVE_SOURCE_STATUSES = new Set(['pending', 'materializing'])

/**
 * Empty sessions keep a slow watch for the first lazy Flue checkout. Active
 * materialization polls quickly. Terminal sources return to the slow watch so
 * a later turn adding another source still appears. React Query pauses these
 * intervals while the page is backgrounded.
 */
export function sessionSourcesRefetchInterval(
  sources: SessionSource[] | undefined,
): number {
  if (sources?.some((source) => ACTIVE_SOURCE_STATUSES.has(source.status)))
    return 1_500
  return 5_000
}
