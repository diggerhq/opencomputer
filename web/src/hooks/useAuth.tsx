import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import posthog from 'posthog-js'
import { getMe, switchOrg as switchOrgApi, type OrgInfo } from '../api/client'

interface AuthUser {
  id: string
  email: string
  orgId: string
  orgs?: OrgInfo[]
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  error: string | null
  switchOrg: (orgId: string) => Promise<void>
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  error: null,
  switchOrg: async () => {},
  refreshUser: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refreshUser = useCallback(async () => {
    try {
      const me = await getMe()
      setUser(me)
      if (me?.id) {
        posthog.identify(me.id, { email: me.email, org_id: me.orgId })
      }
    } catch (err: unknown) {
      if (err instanceof Error && !err.message.includes('Unauthorized')) {
        setError(err.message)
      }
    }
  }, [])

  useEffect(() => {
    // Initial auth load on mount. setLoading runs in the promise's .finally
    // (after the fetch settles), not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshUser().finally(() => setLoading(false))
  }, [refreshUser])

  const switchOrg = useCallback(
    async (orgId: string) => {
      await switchOrgApi(orgId)
      await refreshUser()
      // Drop all cached queries so no previous-org data lingers in
      // sessions / billing / API keys while the new org loads.
      queryClient.clear()
    },
    [refreshUser, queryClient],
  )

  return (
    <AuthContext.Provider
      value={{ user, loading, error, switchOrg, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// Co-located with the provider by design; the hook export trips react-refresh's
// component-only rule, which is a fast-refresh DX hint, not a correctness issue.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
