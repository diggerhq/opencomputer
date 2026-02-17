import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getMe } from '../api/client'

interface AuthUser {
  id: string
  email: string
  orgId: string
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  error: string | null
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  error: null,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch((err: Error) => {
        if (!err.message.includes('Unauthorized')) {
          setError(err.message)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, error }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
