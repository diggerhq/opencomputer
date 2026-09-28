import { QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/errors'

export const ME_QUERY_KEY = ['me'] as const

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

// Any authenticated request answering 401 means the dashboard session is gone
// (the cookie has a fixed TTL and expires while a laptop sleeps). Re-check /me
// so ProtectedRoute redirects to login instead of every screen degrading into
// its own "not found" state against a cached user.
export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!isUnauthorized(error)) return
        if (query.queryKey[0] === ME_QUERY_KEY[0]) return
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY })
      },
    }),
  })
  return queryClient
}
