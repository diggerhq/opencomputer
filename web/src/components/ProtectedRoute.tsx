import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

export default function ProtectedRoute() {
  const { user, loading } = useAuth()

  // Not authenticated → go straight to WorkOS. /auth/login is a server route
  // (proxied by Vite) that 302s to the WorkOS hosted login, so we do a
  // full-page navigation rather than an in-app route. No intermediate
  // "Sign in" screen — the spinner below shows until the browser leaves.
  // Carry the requested URL as `returnTo` so the login round-trip lands the
  // user back where they aimed (a shared session link, a /do deferred action)
  // instead of the dashboard. The edge threads it through the WorkOS `state`.
  useEffect(() => {
    if (!loading && !user) {
      const returnTo = window.location.pathname + window.location.search
      window.location.replace(
        returnTo === '/'
          ? '/auth/login'
          : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      )
    }
  }, [loading, user])

  if (loading || !user) {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-3">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="text-muted-foreground font-mono text-xs tracking-wide">
          Loading&hellip;
        </span>
      </div>
    )
  }

  return <Outlet />
}
