import { Suspense, useEffect, useState } from 'react'
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutGrid,
  Rocket,
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
  CircleAlert,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { logout } from '@/api/client'
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
import { AgentSecurityAlertBanner } from '@/components/agent-security-alert'
import { cn } from '@/lib/utils'
import { managedAgentsExperimentEnabled } from '@/managed-agents/feature'
import { useCreditState } from '@/hooks/useCreditState'
import {
  BASE_GRANT_CENTS,
  PLAN_OFFERS,
  billingOnrampV2Enabled,
  formatUsd,
  trackUpsellClicked,
  trackUpsellShown,
  upgradeHref,
} from '@/lib/billing-onramp'
import { getManagedProject } from '@/managed-agents/api'
import {
  projectEnvironmentSearch,
  type ProjectEnvironment,
} from '@/managed-agents/project-context'
import { managedAgentsNav, type NavGroup } from './app-shell-nav'

type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  preview?: boolean
}
type LegacyNavGroup = Omit<NavGroup, 'items'> & { items: NavItem[] }

// Two planes, subtly separated: the durable-agent plane and the raw-compute
// (sandbox) plane, plus account/org. Groups render with spacing + a small muted
// label rather than hard dividers.
const LEGACY_NAV: LegacyNavGroup[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
      { to: '/getting-started', label: 'Getting started', icon: Rocket },
    ],
  },
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

function projectIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/projects\/([^/]+)(?:\/|$)/)
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

function ManagedProjectContext({
  projectName,
  environment,
  onChange,
}: {
  projectName?: string
  environment: ProjectEnvironment
  onChange: (environment: ProjectEnvironment) => void
}) {
  if (!projectName) {
    return (
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-sm">
        <span className="text-muted-foreground/50">/</span>
        <span>Loading project…</span>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-sm">
      <span className="text-muted-foreground/50">/</span>
      <label className="border-border bg-background flex h-8 shrink-0 items-center rounded-md border px-2">
        <span className="sr-only">Project environment</span>
        <select
          aria-label="Project environment"
          value={environment}
          onChange={(event) =>
            onChange(event.target.value as ProjectEnvironment)
          }
          className="max-w-[min(70vw,28rem)] bg-transparent text-sm font-medium outline-none"
        >
          {(['development', 'production'] as const).map((candidate) => (
            <option key={candidate} value={candidate}>
              {projectName} ({candidate})
            </option>
          ))}
        </select>
      </label>
    </div>
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

function ManagedProfileMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const goTo = (path: string) => {
    void navigate(path)
    onNavigate?.()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open profile menu"
          className="hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors"
        >
          <span className="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium">
            {user?.email?.charAt(0).toUpperCase() || '?'}
          </span>
          <span className="text-foreground min-w-0 flex-1 truncate text-xs">
            {user?.email}
          </span>
          <ChevronsUpDown
            className="text-muted-foreground/50 size-3.5 shrink-0"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-52"
      >
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => goTo('/api-keys')}>
          <KeyRound className="size-4 opacity-60" aria-hidden />
          API Keys
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => goTo('/billing')}>
          <CreditCard className="size-4 opacity-60" aria-hidden />
          Billing
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => goTo('/settings')}>
          <Settings className="size-4 opacity-60" aria-hidden />
          Settings
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
  )
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const projectId = projectIdFromPath(location.pathname)
  const nav = managedAgentsExperimentEnabled
    ? managedAgentsNav({
        projectId,
        durableSessionsEnabled: user?.durableSessionsEnabled ?? false,
        infrastructureEnabled: user?.infrastructureEnabled ?? false,
      })
    : LEGACY_NAV
  const activeCollapsibleGroup = nav.find(
    (group) =>
      group.collapsible &&
      group.label &&
      group.items.some(
        (item) =>
          location.pathname === item.to ||
          (item.to !== '/' && location.pathname.startsWith(`${item.to}/`)),
      ),
  )?.label
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(activeCollapsibleGroup ? [activeCollapsibleGroup] : []),
  )
  const expandedGroups = new Set(openGroups)
  if (activeCollapsibleGroup) expandedGroups.add(activeCollapsibleGroup)
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(user?.orgs?.length ?? 0) > 1 ? (
        <div className="border-b px-3 py-3">
          <OrgSwitcher />
        </div>
      ) : null}

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {nav.map((group, gi) => (
          <div key={group.label ?? gi} className="space-y-0.5">
            {group.label && group.collapsible ? (
              <button
                type="button"
                onClick={() => {
                  setOpenGroups((current) => {
                    const next = new Set(current)
                    if (next.has(group.label!)) next.delete(group.label!)
                    else next.add(group.label!)
                    return next
                  })
                  if (group.landingTo) void navigate(group.landingTo)
                }}
                className="text-muted-foreground/70 hover:text-foreground flex w-full items-center gap-1 px-3 pb-1 text-left text-[10px] font-medium tracking-wider uppercase transition-colors"
                aria-expanded={expandedGroups.has(group.label)}
              >
                <ChevronRight
                  className={cn(
                    'size-3 transition-transform',
                    expandedGroups.has(group.label) && 'rotate-90',
                  )}
                />
                {group.label}
              </button>
            ) : group.label ? (
              <div className="text-muted-foreground/55 px-3 pb-1 text-[10px] font-medium tracking-wider uppercase">
                {group.label}
              </div>
            ) : null}
            {(!group.collapsible || expandedGroups.has(group.label ?? '')) &&
              group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={
                    projectId && item.to.startsWith('/projects/')
                      ? { pathname: item.to, search: location.search }
                      : item.to
                  }
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

      <SidebarCreditMeter onNavigate={onNavigate} />

      <div className="border-t p-3">
        {managedAgentsExperimentEnabled ? (
          <ManagedProfileMenu onNavigate={onNavigate} />
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium">
              {user?.email?.charAt(0).toUpperCase() || '?'}
            </span>
            <span className="text-foreground min-w-0 flex-1 truncate text-xs">
              {user?.email}
            </span>
            {user?.capabilities?.signOut !== false ? (
              <button
                onClick={() => void logout()}
                aria-label="Sign out"
                title="Sign out"
                className="text-muted-foreground/40 hover:text-foreground flex size-7 shrink-0 items-center justify-center transition-colors"
              >
                <LogOut className="size-4" strokeWidth={1.5} aria-hidden />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

// Always-visible balance for prepaid orgs that haven't subscribed yet, so the
// first "you should pay" moment isn't the hard stop. Paid plans and legacy
// orgs (404 on /billing/autumn) render nothing.
function SidebarCreditMeter({ onNavigate }: { onNavigate?: () => void }) {
  const { usagePlan, creditsRemainingCents, isLow, isHalted } = useCreditState()
  const visible =
    billingOnrampV2Enabled &&
    usagePlan === 'base' &&
    creditsRemainingCents !== undefined
  useEffect(() => {
    if (visible)
      trackUpsellShown({
        surface: 'sidebar_meter',
        plan: 'pro',
        usagePlan,
        creditsRemainingCents,
      })
    // Fire once per mount; balance changes shouldn't re-count an impression.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])
  if (!visible) return null
  const grant = Math.max(BASE_GRANT_CENTS, creditsRemainingCents)
  const pct = Math.max(0, Math.min(100, (creditsRemainingCents / grant) * 100))
  return (
    <div className="border-t px-3 py-3">
      <div className="text-muted-foreground flex items-center justify-between font-mono text-[11px]">
        <span>Free credits</span>
        <span
          className={cn(
            isHalted && 'text-destructive',
            isLow && 'text-amber-600',
          )}
        >
          {formatUsd(creditsRemainingCents)} left
        </span>
      </div>
      <div className="bg-secondary mt-1.5 h-1 overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full',
            isHalted ? 'bg-destructive' : isLow ? 'bg-amber-500' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <Link
        to={upgradeHref('pro')}
        onClick={() => {
          trackUpsellClicked({
            surface: 'sidebar_meter',
            plan: 'pro',
            usagePlan,
            creditsRemainingCents,
          })
          onNavigate?.()
        }}
        className="text-foreground mt-2 block text-xs font-medium underline-offset-2 hover:underline"
      >
        Upgrade to Pro — ${PLAN_OFFERS.pro.creditsUsd}/mo of credits for $
        {PLAN_OFFERS.pro.priceUsd}
      </Link>
    </div>
  )
}

// Org-wide credit notice. Prepaid (autumn) orgs that exhaust credits get halted
// (sandboxes hibernate); show a banner everywhere except Billing so users know
// why things paused and where to resolve it. Below the low-credit threshold the
// banner is an amber nudge instead. Legacy orgs 404 on /billing/autumn → no
// data → no banner.
function HaltBanner() {
  const location = useLocation()
  const { isHalted, isLow, usagePlan, creditsRemainingCents, upgradePlan } =
    useCreditState()
  const onBilling = location.pathname.startsWith('/billing')
  const state = isHalted ? 'halted' : isLow ? 'low' : null
  useEffect(() => {
    if (state && !onBilling)
      trackUpsellShown({
        surface: state === 'halted' ? 'halt_banner' : 'low_credit_banner',
        plan: upgradePlan,
        usagePlan,
        creditsRemainingCents,
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, onBilling])
  if (!state || onBilling) return null
  const offer = PLAN_OFFERS[upgradePlan]
  const planName = upgradePlan === 'pro' ? 'Pro' : 'Max'
  const click = () =>
    trackUpsellClicked({
      surface: state === 'halted' ? 'halt_banner' : 'low_credit_banner',
      plan: upgradePlan,
      usagePlan,
      creditsRemainingCents,
    })
  if (state === 'low') {
    return (
      <div className="flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-center text-sm font-medium text-amber-700 sm:px-8 dark:text-amber-400">
        <CircleAlert className="size-4 shrink-0" />
        <span>
          {formatUsd(creditsRemainingCents ?? 0)} of credits left — sessions
          pause at $0.{' '}
          <Link
            to={upgradeHref(upgradePlan)}
            onClick={click}
            className="font-semibold underline underline-offset-2"
          >
            Upgrade to {planName}
          </Link>{' '}
          for ${offer.creditsUsd}/mo of credits at ${offer.priceUsd}/mo.
        </span>
      </div>
    )
  }
  return (
    <div className="border-destructive/40 bg-status-error-bg text-destructive flex items-center justify-center gap-2 border-b px-4 py-2.5 text-center text-sm font-medium sm:px-8">
      <CircleAlert className="size-4 shrink-0" />
      <span>
        Your agent sessions and sandboxes are paused — you&apos;re out of
        prepaid credits.{' '}
        {billingOnrampV2Enabled ? (
          <>
            <Link
              to={upgradeHref(upgradePlan)}
              onClick={click}
              className="font-semibold underline underline-offset-2"
            >
              Upgrade to {planName} (${offer.priceUsd}/mo, ${offer.creditsUsd}{' '}
              credits)
            </Link>{' '}
            or{' '}
            <Link to="/billing" className="underline underline-offset-2">
              top up
            </Link>{' '}
            to resume.
          </>
        ) : (
          <>
            <Link
              to="/billing"
              className="font-semibold underline underline-offset-2"
            >
              Top up &amp; turn on auto-recharge
            </Link>{' '}
            to resume.
          </>
        )}
      </span>
    </div>
  )
}

export default function AppShell() {
  const { user } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const projectId = managedAgentsExperimentEnabled
    ? projectIdFromPath(location.pathname)
    : undefined
  const project = useQuery({
    queryKey: ['managed-project', projectId],
    queryFn: () => getManagedProject(projectId!),
    enabled: Boolean(projectId),
  })
  const environment: ProjectEnvironment =
    new URLSearchParams(location.search).get('environment') === 'production'
      ? 'production'
      : 'development'
  function changeProjectEnvironment(nextEnvironment: ProjectEnvironment) {
    void navigate(
      {
        pathname: location.pathname,
        search: projectEnvironmentSearch(location.search, nextEnvironment),
      },
      { replace: true },
    )
  }

  return (
    <div className="bg-background text-foreground min-h-screen font-sans">
      {/* Desktop top bar — a continuous line across the app; the brand sits in
          the column above the sidebar so its right + bottom borders line up. */}
      <header className="bg-sidebar fixed inset-x-0 top-0 z-30 hidden h-16 items-center border-b md:flex">
        <div className="flex h-full w-60 shrink-0 items-center border-r px-6">
          <Brand />
        </div>
        {projectId ? (
          <div className="flex min-w-0 items-center px-6">
            <ManagedProjectContext
              projectName={project.data?.project.name}
              environment={environment}
              onChange={changeProjectEnvironment}
            />
          </div>
        ) : null}
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
        {projectId ? (
          <ManagedProjectContext
            projectName={project.data?.project.name}
            environment={environment}
            onChange={changeProjectEnvironment}
          />
        ) : null}
      </header>

      {/* Main content */}
      <div className="md:pt-16 md:pl-60">
        <div className="sticky top-14 z-20 md:top-16">
          <HaltBanner />
          <AgentSecurityAlertBanner />
        </div>
        <main
          className={cn(
            'mx-auto px-4 py-6 sm:px-8',
            location.pathname.startsWith('/managed-agents/') ||
              location.pathname.startsWith('/projects/')
              ? 'max-w-[1600px]'
              : 'max-w-7xl',
          )}
        >
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
