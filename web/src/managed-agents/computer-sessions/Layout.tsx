import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  Archive,
  CalendarClock,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  SquareTerminal,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { logout } from '@/api/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/error-boundary'
import { cn } from '@/lib/utils'
import {
  listSessions,
  sessionKeys,
  type ListSessionsQuery,
  type Session,
} from '../computer-sessions-api'
import { OriginMark, StatusDot } from './parts'
import {
  isUnread,
  NEEDS_YOU,
  sessionLine,
  sessionTitle,
  useSeen,
  WORKING,
} from './state'
import { timeAgo } from './transcript'

// The computer's own full-screen view (work 107): a flat icon rail, the
// sessions sidebar, and the open session or the new-session home.

export default function ComputerSessionsLayout() {
  const searchRef = useRef<HTMLInputElement>(null)
  return (
    <div className="bg-background text-foreground flex h-dvh overflow-hidden">
      <Rail onSearch={() => searchRef.current?.focus()} />
      <SessionsSidebar searchRef={searchRef} />
      <main className="min-w-0 flex-1">
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="text-muted-foreground size-5 animate-spin" />
              </div>
            }
          >
            <Outlet />
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
  children,
}: {
  to: string
  label: string
  end?: boolean
  children: ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors',
          isActive && 'bg-sidebar-accent text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  )
}

function Rail({ onSearch }: { onSearch: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const activeOrg = user?.orgs?.find((o) => o.isActive)
  return (
    <nav className="bg-sidebar border-sidebar-border flex w-14 shrink-0 flex-col items-center gap-1 border-r py-3">
      <Link
        to="/computer/sessions"
        title="Computer"
        className="bg-foreground text-background mb-3 flex size-8 items-center justify-center rounded-lg"
      >
        <SquareTerminal className="size-4" aria-hidden />
      </Link>
      <RailLink to="/computer/sessions" label="Sessions">
        <MessagesSquare className="size-4" aria-hidden />
      </RailLink>
      <button
        type="button"
        title="Search sessions"
        aria-label="Search sessions"
        onClick={onSearch}
        className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors"
      >
        <Search className="size-4" aria-hidden />
      </button>
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
          <DropdownMenuItem onClick={() => void navigate('/computer')}>
            <LayoutDashboard className="size-4 opacity-60" aria-hidden />
            Dashboard
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigate('/settings')}>
            <Settings className="size-4 opacity-60" aria-hidden />
            Settings & members
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigate('/api-keys')}>
            <KeyRound className="size-4 opacity-60" aria-hidden />
            API keys
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigate('/billing')}>
            <CreditCard className="size-4 opacity-60" aria-hidden />
            Billing
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

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function SessionsSidebar({
  searchRef,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>
}) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const q = useDebounced(query.trim(), 250)

  const needs = useQuery({
    queryKey: sessionKeys.list(NEEDS_YOU),
    queryFn: () => listSessions(NEEDS_YOU),
    refetchInterval: 5_000,
    enabled: !q && !archived,
  })
  const working = useQuery({
    queryKey: sessionKeys.list(WORKING),
    queryFn: () => listSessions(WORKING),
    refetchInterval: 5_000,
    enabled: !q && !archived,
  })
  // Recent is everything not waiting or working; searching or the archive
  // shows one flat list instead.
  const recentQuery: ListSessionsQuery = q
    ? { q, archived: archived ? 'true' : 'false', limit: 30 }
    : archived
      ? { archived: 'true', limit: 30 }
      : { status: 'idle,suspended', limit: 30 }
  const recent = useInfiniteQuery({
    queryKey: sessionKeys.list(recentQuery),
    queryFn: ({ pageParam }) =>
      listSessions({ ...recentQuery, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  })
  const recentRows = recent.data?.pages.flatMap((p) => p.sessions) ?? []

  // Infinite scroll: load the next page when the list's end comes into view.
  const endRef = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = recent
  useEffect(() => {
    const el = endRef.current
    if (!el || !hasNextPage) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage)
        void fetchNextPage()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const flat = !!q || archived
  return (
    <aside className="bg-sidebar border-sidebar-border flex w-72 shrink-0 flex-col border-r">
      <div className="space-y-2 p-3">
        <Button asChild variant="outline" className="w-full justify-start">
          <Link to="/computer/sessions">
            <Plus aria-hidden />
            New session
          </Link>
        </Button>
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search sessions"
            className="border-input placeholder:text-muted-foreground focus-visible:border-ring/60 h-8 w-full rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!flat ? (
          <>
            <Group label="Needs you" rows={needs.data?.sessions} />
            <Group label="Working" rows={working.data?.sessions} />
          </>
        ) : null}
        <Group
          label={q ? 'Results' : archived ? 'Archived' : 'Recent'}
          rows={recentRows}
          loading={recent.isPending}
          empty={
            q
              ? 'No sessions match.'
              : archived
                ? 'Nothing archived.'
                : 'No sessions yet.'
          }
        />
        <div ref={endRef} />
        {isFetchingNextPage ? (
          <Loader2 className="text-muted-foreground mx-auto my-2 size-4 animate-spin" />
        ) : null}
      </div>
      <div className="border-sidebar-border border-t p-2">
        <button
          type="button"
          onClick={() => setArchived((a) => !a)}
          className={cn(
            'text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-2 py-1 text-xs',
            archived && 'text-foreground',
          )}
        >
          <Archive className="size-3.5" aria-hidden />
          {archived ? 'Back to sessions' : 'Archived'}
        </button>
      </div>
    </aside>
  )
}

function Group({
  label,
  rows,
  loading,
  empty,
}: {
  label: string
  rows: Session[] | undefined
  loading?: boolean
  empty?: string
}) {
  if (!rows?.length && !empty) return null
  return (
    <section className="mb-3">
      <h3 className="text-muted-foreground px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide uppercase">
        {label}
        {rows?.length && !empty ? (
          <span className="ml-1.5 tabular-nums">{rows.length}</span>
        ) : null}
      </h3>
      {rows?.length ? (
        rows.map((s) => <SessionRow key={s.id} session={s} />)
      ) : loading ? null : (
        <p className="text-muted-foreground px-2 py-1 text-xs">{empty}</p>
      )}
    </section>
  )
}

function SessionRow({ session: s }: { session: Session }) {
  const { id: openId } = useParams()
  const seen = useSeen()
  const open = openId === s.id
  const unread = !open && isUnread(s, seen)
  const line = sessionLine(s)
  return (
    <Link
      to={`/computer/sessions/${s.id}`}
      className={cn(
        'hover:bg-sidebar-accent block rounded-md px-2 py-1.5 transition-colors',
        open && 'bg-sidebar-accent',
      )}
    >
      <div className="flex items-center gap-1.5">
        <StatusDot status={s.status} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            unread && 'font-semibold',
          )}
        >
          {sessionTitle(s)}
        </span>
        <OriginMark
          origin={s.origin}
          className="text-muted-foreground/70 shrink-0"
        />
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          {timeAgo(s.lastActiveAt ?? s.createdAt)}
        </span>
        {unread ? (
          <span
            className="bg-primary size-1.5 shrink-0 rounded-full"
            aria-label="Unread"
          />
        ) : null}
      </div>
      {line ? (
        <p
          className={cn(
            'text-muted-foreground mt-0.5 truncate pl-3 text-xs',
            s.status === 'waiting' && 'text-amber-600 dark:text-amber-400',
          )}
        >
          {line}
        </p>
      ) : null}
    </Link>
  )
}
