import { Suspense } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import AppShell from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { loginPathForReturn } from '@/lib/login-path'

// Layout for pages a visitor may open before signing up (a shared template
// link). Signed-in users get the regular AppShell; anonymous visitors get a
// bare header with a sign-in link that brings them back to the same URL.
export default function PublicTemplateRoute() {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (user) return <AppShell />

  return (
    <div className="bg-background text-foreground min-h-screen font-sans">
      <header className="bg-sidebar flex h-16 items-center justify-between border-b px-6">
        <Link to="/" className="flex items-center" aria-label="OpenComputer">
          <span className="text-foreground font-mono text-[17px] font-semibold tracking-tight">
            opencomputer
          </span>
        </Link>
        <Button asChild size="sm">
          <a href={loginPathForReturn(location.pathname + location.search)}>
            Sign in
          </a>
        </Button>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Suspense
          fallback={
            <div className="flex min-h-[60vh] items-center justify-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}
