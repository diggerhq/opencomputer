import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ProtectedRoute() {
  const { user, loading } = useAuth()

  // Not authenticated → go straight to WorkOS. /auth/login is a server route
  // (proxied by Vite) that 302s to the WorkOS hosted login, so we do a
  // full-page navigation rather than an in-app route. No intermediate
  // "Sign in" screen — the spinner below shows until the browser leaves.
  useEffect(() => {
    if (!loading && !user) {
      window.location.replace('/auth/login')
    }
  }, [loading, user])

  if (loading || !user) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 16,
        background: 'var(--bg-void)',
      }}>
        <div className="loading-spinner" />
        <span style={{
          fontSize: 12,
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
        }}>
          Loading&hellip;
        </span>
      </div>
    )
  }

  return <Outlet />
}
