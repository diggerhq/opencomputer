import { useCallback, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import posthog from 'posthog-js'
import { getMe, switchOrg as switchOrgApi } from '../api/client'
import { ApiError } from '../api/errors'
import { AuthContext, ME_QUERY_KEY } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  // /me is server state, so React Query owns it. A 401 throws (see apiFetch)
  // and lands as an error with no data — ProtectedRoute redirects to login.
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: getMe,
    retry: false,
    staleTime: 60_000,
  })
  const { refetch } = query
  // A 401 on a background refetch keeps the previous data around; the session
  // is gone regardless, so treat it as signed out rather than trusting the
  // stale user.
  const unauthorized =
    query.error instanceof ApiError && query.error.status === 401
  const user = unauthorized ? null : (query.data ?? null)

  // Identify the analytics user once /me resolves (external-system sync).
  useEffect(() => {
    if (user?.id) {
      posthog.identify(user.id, { email: user.email, org_id: user.orgId })
    }
  }, [user])

  const refreshUser = useCallback(async () => {
    await refetch()
  }, [refetch])

  const switchOrg = useCallback(
    async (orgId: string) => {
      await switchOrgApi(orgId)
      // Drop all cached (previous-org) data, then explicitly refetch ['me'] —
      // clear() removes the query but does NOT refetch the active observer, so
      // the shell would otherwise keep showing the old org. Other screens'
      // queries refetch when they re-render against the cleared cache.
      queryClient.clear()
      await refetch()
    },
    [queryClient, refetch],
  )

  // A 401 is an expected unauthenticated state, not a surfaced error.
  const error =
    query.error && !unauthorized && !/unauthorized/i.test(query.error.message)
      ? query.error.message
      : null

  return (
    <AuthContext.Provider
      value={{ user, loading: query.isLoading, error, switchOrg, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}
