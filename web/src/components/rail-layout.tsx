import { SELFHOST } from '@/lib/selfhost'
import { Suspense, useState, type ReactNode } from 'react'
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import {
  CalendarClock,
  Check,
  CreditCard,
  KeyRound,
  Loader2,
  LogOut,
  Moon,
  Settings,
  SquareKanban,
  Sun,
  Plug,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { logout } from '@/api/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ErrorBoundary } from '@/components/error-boundary'
import { BillingWarningBanner, HaltModal } from '@/components/billing-surfaces'
import { cn } from '@/lib/utils'
import { OpenComputerMark } from '@/components/opencomputer-mark'

// The flat icon rail every page but projects and the onboarding opens in
// (automations, secrets, settings…), so nothing leads back to the old shell.
// The computer's sessions are the work surface (/computer/work), its own
// full-screen route.
export default function RailLayout() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  return (
    <div className="bg-background text-foreground flex h-dvh overflow-hidden">
      <Rail />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="sticky top-0 z-20">
          <BillingWarningBanner />
        </div>
        <HaltModal />
        <ErrorBoundary key={`${user?.orgId ?? ''}:${pathname}`}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="text-muted-foreground size-5 animate-spin" />
              </div>
            }
          >
            <div
              className={cn(
                'mx-auto flex w-full flex-1 flex-col px-8 py-8 lg:px-12',
                pathname.startsWith('/projects/') ||
                  pathname.startsWith('/managed-agents/')
                  ? 'max-w-[1600px]'
                  : 'max-w-7xl',
              )}
            >
              <Outlet />
            </div>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}

function RailLink({
  to,
  label,
  end,
  badge,
  children,
}: {
  to: string
  label: string
  end?: boolean
  badge?: number
  children: ReactNode
}) {
  const name = badge ? `${label}, ${badge}` : label
  return (
    <NavLink
      to={to}
      end={end}
      title={name}
      aria-label={name}
      className={({ isActive }) =>
        cn(
          'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground relative flex size-9 items-center justify-center rounded-md transition-colors',
          isActive && 'bg-sidebar-accent text-foreground',
        )
      }
    >
      {children}
      {badge ? (
        <span
          aria-hidden
          className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-medium"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </NavLink>
  )
}

function Rail() {
  const { user } = useAuth()
  const { dark, setDark } = useTheme()
  const navigate = useNavigate()
  const orgs = user?.orgs ?? []
  const activeOrg = orgs.find((o) => o.isActive)
  return (
    <nav className="bg-sidebar border-sidebar-border flex w-14 shrink-0 flex-col items-center gap-1 border-r py-3">
      <Link
        to={user?.computerEnabled ? '/computer/work' : '/automations'}
        title="Computer"
        className="mb-3 flex size-8 items-center justify-center"
      >
        <OpenComputerMark className="size-8" />
      </Link>
      {user?.computerEnabled ? (
        <RailLink to="/computer/work" label="Work">
          <SquareKanban className="size-4" aria-hidden />
        </RailLink>
      ) : null}
      <RailLink to="/automations" label="Automations">
        <CalendarClock className="size-4" aria-hidden />
      </RailLink>
      <RailLink to="/computer/secrets" label="Secrets">
        <KeyRound className="size-4" aria-hidden />
      </RailLink>
      <div className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open account menu"
            title={activeOrg?.name ?? user?.email}
            className="bg-secondary text-muted-foreground hover:text-foreground flex size-8 items-center justify-center rounded-full text-xs font-medium"
          >
            {(activeOrg?.name ?? user?.email ?? '?').charAt(0).toUpperCase()}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="min-w-52">
          <DropdownMenuLabel className="truncate">
            {activeOrg?.name ?? 'Account'}
            <span className="text-muted-foreground block truncate text-xs font-normal">
              {user?.email}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {orgs.length > 1 ? (
            <>
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                Organizations
              </DropdownMenuLabel>
              <OrgItems />
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            onClick={() => void navigate('/managed-agents/connections')}
          >
            <Plug className="size-4 opacity-60" aria-hidden />
            Connections
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigate('/settings')}>
            <Settings className="size-4 opacity-60" aria-hidden />
            Settings & members
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigate('/api-keys')}>
            <KeyRound className="size-4 opacity-60" aria-hidden />
            API keys
          </DropdownMenuItem>
          {!SELFHOST && (
            <DropdownMenuItem onClick={() => void navigate('/billing')}>
              <CreditCard className="size-4 opacity-60" aria-hidden />
              Billing
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              setDark(!dark)
            }}
          >
            {dark ? (
              <Sun className="size-4 opacity-60" aria-hidden />
            ) : (
              <Moon className="size-4 opacity-60" aria-hidden />
            )}
            {dark ? 'Light theme' : 'Dark theme'}
          </DropdownMenuItem>
          {user?.capabilities?.signOut !== false ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void logout()}>
                <LogOut className="size-4 opacity-60" aria-hidden />
                Sign out
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  )
}

/** The organizations to switch between, the active one checked (the old shell's OrgSwitcher). */
function OrgItems() {
  const { user, switchOrg } = useAuth()
  const [switching, setSwitching] = useState(false)
  return (user?.orgs ?? []).map((org) => (
    <DropdownMenuItem
      key={org.id}
      disabled={switching}
      onClick={() => {
        if (org.isActive || switching) return
        setSwitching(true)
        void switchOrg(org.id).finally(() => setSwitching(false))
      }}
    >
      <Check
        className={cn(
          'size-4 shrink-0',
          org.isActive ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      />
      <span className="truncate">{org.name}</span>
      {org.isPersonal ? (
        <span className="text-muted-foreground ml-auto text-xs">personal</span>
      ) : null}
    </DropdownMenuItem>
  ))
}
