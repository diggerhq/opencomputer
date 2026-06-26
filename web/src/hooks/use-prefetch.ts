import { useQueryClient } from '@tanstack/react-query'
import { getSessionDetail } from '@/api/client'

/**
 * Returns a prefetcher for a sandbox detail page. Call it on row hover/focus to
 * warm the lazy route chunk and the detail query, so the click feels instant.
 * Cheap + idempotent — the chunk import dedupes and the query has a staleTime.
 */
export function usePrefetchSandbox() {
  const queryClient = useQueryClient()
  return (sandboxId: string) => {
    // Warm the code-split SessionDetail chunk (same module the route lazy-loads).
    void import('@/pages/SessionDetail')
    void queryClient.prefetchQuery({
      queryKey: ['session-detail', sandboxId],
      queryFn: () => getSessionDetail(sandboxId),
      staleTime: 10_000,
    })
  }
}
