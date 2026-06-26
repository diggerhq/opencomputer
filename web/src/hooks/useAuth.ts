import { createContext, useContext } from 'react'
import type { OrgInfo } from '../api/client'

export interface AuthUser {
  id: string
  email: string
  orgId: string
  orgs?: OrgInfo[]
}

export interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  error: string | null
  switchOrg: (orgId: string) => Promise<void>
  refreshUser: () => Promise<void>
}

// Nullable context: `useAuth` throws when used outside <AuthProvider>, so
// consumers never have to handle a placeholder default.
export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
