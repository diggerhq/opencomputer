import { Suspense, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutGrid,
  Bot,
  MessagesSquare,
  Monitor,
  Boxes,
  Layers,
  Package,
  Webhook,
  KeyRound,
  KeySquare,
  CreditCard,
  Settings,
  LogOut,
  ChevronsUpDown,
  Check,
  Menu,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { logout, getAutumnBilling } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ErrorBoundary } from '@/components/error-boundary'
import { cn } from '@/lib/utils'

type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  preview?: boolean
}
type NavGroup = { label?: string; items: NavItem[] }

// Two planes, subtly separated: the durable-agent plane and the raw-compute
// (sandbox) plane, plus account/org. Groups render with spacing + a small muted
// label rather than hard dividers.
const NAV: NavGroup[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutGrid, end: true }] },
  {
    label: 'Agents',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot, preview: true },
      {
        to: '/sessions',
        label: 'Sessions',
        icon: MessagesSquare,
        preview: true,
      },
      {
        to: '/credentials',
        label: 'Credentials',
        icon: KeySquare,
        preview: true,
      },
    ],
  },
  {
    label: 'Browser Sessions',
    items: [
      {
        to: '/browsers',
        label: 'Browsers',
        icon: Monitor,
        preview: true,
      },
    ],
  },
  {
    label: 'Sandboxes',
    items: [
      { to: '/sandboxes', label: 'Sandboxes', icon: Boxes },
      { to: '/checkpoints', label: 'Checkpoints', icon: Layers },
      { to: '/templates', label: 'Templates', icon: Package },
      { to: '/sandbox-webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/api-keys', label: 'API Keys', icon: KeyRound },
      { to: '/billing', label: 'Billing', icon: CreditCard },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

function Brand() {
  return (
    <Link to="/" className="flex items-center" aria-label="OpenComputer">
      <span className="text-foreground font-mono text-[17px] font-semibold tracking-tight">
        opencomputer
      </span>
    </Link>
  )
}

function OrgSwitcher() {
  const { user, switchOrg } = useAuth()
  const [switching, setSwitching] = useState(false)
  const orgs = user?.orgs ?? []
  if (orgs.length <= 1) return null
  const active = orgs.find((o) => o.isActive)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between font-normal"
          size="sm"
          disabled={switching}
        >
          <span className="truncate">{active?.name || 'Select org'}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => {
              if (org.isActive || switching) return
              setSwitching(true)
              void switchOrg(org.id).finally(() => setSwitching(false))
            }}
            className="gap-2"
          >
            <Check
              className={cn(
                'size-4 shrink-0',
                org.isActive ? 'opacity-100' : 'opacity-0',
              )}
            />
            <span className="truncate">{org.name}</span>
            {org.isPersonal ? (
              <span className="text-muted-foreground ml-auto text-xs">
                personal
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(user?.orgs?.length ?? 0) > 1 ? (
        <div className="border-b px-3 py-3">
          <OrgSwitcher />
        </div>
      ) : null}

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {NAV.map((group, gi) => (
          <div key={group.label ?? gi} className="space-y-0.5">
            {group.label ? (
              <div className="text-muted-foreground/55 px-3 pb-1 text-[10px] font-medium tracking-wider uppercase">
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-9 items-center gap-2.5 rounded-md px-3 font-mono text-sm tracking-tight transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                  )
                }
              >
                <item.icon
                  className="size-4 shrink-0 opacity-50"
                  strokeWidth={1.25}
                  aria-hidden
                />
                {item.label}
                {item.preview ? (
                  <span className="border-border/70 text-muted-foreground ml-auto rounded border px-1 py-px font-sans text-[9px] font-medium tracking-wide uppercase">
                    Preview
                  </span>
                ) : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t p-3">
        <div className="flex items-center gap-2.5">
          <span className="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium">
            {user?.email?.charAt(0).toUpperCase() || '?'}
          </span>
          <span className="text-foreground min-w-0 flex-1 truncate text-xs">
            {user?.email}
          </span>
          <button
            onClick={() => void logout()}
            aria-label="Sign out"
            title="Sign out"
            className="text-muted-foreground/40 hover:text-foreground flex size-7 shrink-0 items-center justify-center transition-colors"
          >
            <LogOut className="size-4" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}

// Org-wide halt notice. Prepaid (autumn) orgs that exhaust credits get halted
// (sandboxes hibernate); show a banner everywhere except Billing so users know
// why things paused and where to resolve it. Legacy orgs 404 on /billing/autumn
// → no data → no banner.
function HaltBanner() {
  const location = useLocation()
  const { data } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  })
  const halted = data?.isHalted ?? false
  if (!halted || location.pathname.startsWith('/billing')) return null
  return (
    <div className="border-status-pending/20 bg-status-pending-bg text-status-pending border-b px-4 py-2.5 text-center text-sm sm:px-8">
      Your agent sessions and sandboxes are paused — you&apos;re out of prepaid
      credits.{' '}
      <Link
        to="/billing"
        className="font-semibold underline underline-offset-2"
      >
        Top up &amp; turn on auto-recharge
      </Link>{' '}
      to resume now and prevent future pauses.
    </div>
  )
}

export default function AppShell() {
  const { user } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  return (
    <div className="bg-background text-foreground min-h-screen font-sans">
      {/* Desktop top bar — a continuous line across the app; the brand sits in
          the column above the sidebar so its right + bottom borders line up. */}
      <header className="bg-sidebar fixed inset-x-0 top-0 z-30 hidden h-16 items-center border-b md:flex">
        <div className="flex h-full w-60 shrink-0 items-center border-r px-6">
          <Brand />
        </div>
      </header>

      {/* Desktop sidebar (below the top bar) */}
      <aside className="bg-sidebar fixed top-16 bottom-0 left-0 z-20 hidden w-60 flex-col border-r md:flex">
        <SidebarNav />
      </aside>

      {/* Mobile top bar */}
      <header className="bg-sidebar sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 md:hidden">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="bg-sidebar flex w-64 flex-col p-0"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <div className="flex h-14 shrink-0 items-center border-b px-4">
              <Brand />
            </div>
            <SidebarNav onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
        <Brand />
      </header>

      {/* Main content */}
      <div className="md:pt-16 md:pl-60">
        <HaltBanner />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-8">
          {/* Keyed by org + route: clears a page error on navigation AND
              remounts org-scoped pages on org switch so local draft/filter
              state can't bleed across orgs. */}
          <ErrorBoundary key={`${user?.orgId ?? ''}:${location.pathname}`}>
            <Suspense
              fallback={
                <div className="flex min-h-[60vh] items-center justify-center">
                  <Loader2 className="text-muted-foreground size-5 animate-spin" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
