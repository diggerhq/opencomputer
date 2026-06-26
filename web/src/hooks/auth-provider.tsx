import { useCallback, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import posthog from 'posthog-js'
import { getMe, switchOrg as switchOrgApi } from '../api/client'
import { AuthContext } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  // /me is server state, so React Query owns it. A 401 throws (see apiFetch)
  // and lands as an error with no data — ProtectedRoute redirects to login.
  const query = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    retry: false,
    staleTime: 60_000,
  })
  const { refetch } = query
  const user = query.data ?? null

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
      // Drop all cached queries so no previous-org data lingers in
      // sandboxes / billing / API keys; the active ['me'] query refetches.
      queryClient.clear()
    },
    [queryClient],
  )

  // A 401 is an expected unauthenticated state, not a surfaced error.
  const error =
    query.error && !/unauthorized/i.test(query.error.message)
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
