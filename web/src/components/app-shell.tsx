import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutGrid,
  Boxes,
  Layers,
  Package,
  KeyRound,
  CreditCard,
  Settings,
  LogOut,
  ChevronsUpDown,
  Check,
  Menu,
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
import { cn } from '@/lib/utils'

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
  { to: '/sessions', label: 'Sessions', icon: Boxes },
  { to: '/checkpoints', label: 'Checkpoints', icon: Layers },
  { to: '/templates', label: 'Templates', icon: Package },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/billing', label: 'Billing', icon: CreditCard },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="bg-foreground text-background flex size-8 items-center justify-center rounded-md font-mono text-xs font-bold">
        oc
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-sm font-semibold tracking-tight">
          OpenComputer
        </span>
        <span className="text-muted-foreground mt-0.5 font-mono text-[10px] tracking-wide">
          Console
        </span>
      </span>
    </Link>
  )
}

function OrgSwitcher() {
  const { user, switchOrg } = useAuth()
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
            onClick={() => !org.isActive && switchOrg(org.id)}
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

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4">
        <Brand />
      </div>

      {(user?.orgs?.length ?? 0) > 1 ? (
        <div className="border-b px-3 py-3">
          <OrgSwitcher />
        </div>
      ) : null}

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )
            }
          >
            <item.icon className="size-[18px] shrink-0" aria-hidden />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t p-3">
        <div className="mb-2 flex items-center gap-2.5 px-1">
          <span className="bg-secondary flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
            {user?.email?.charAt(0).toUpperCase() || '?'}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {user?.email}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground w-full justify-start"
          onClick={() => logout()}
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </Button>
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
      Your sandboxes are paused — you&apos;re out of prepaid credits.{' '}
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
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="bg-background text-foreground min-h-screen font-sans">
      {/* Desktop sidebar */}
      <aside className="bg-sidebar fixed inset-y-0 left-0 z-30 hidden w-60 border-r md:block">
        <SidebarBody />
      </aside>

      {/* Mobile top bar */}
      <header className="bg-sidebar sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 md:hidden">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="bg-sidebar w-64 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarBody onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
        <Brand />
      </header>

      {/* Main content */}
      <div className="md:pl-60">
        <HaltBanner />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
