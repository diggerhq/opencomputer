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
  useEffect(() => {
    if (!loading && !user) {
      window.location.replace('/auth/login')
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
