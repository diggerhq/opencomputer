import { useContext, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { FileText, Loader2, Search, SquareKanban, X } from 'lucide-react'
import { ApiError } from '@/api/errors'
import { EmptyState } from '@/components/empty-state'
import { Panel } from '@/components/panel'
import { Switch } from '@/components/ui/switch'
import { AuthContext } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { timeAgo } from '../computer-sessions/transcript'
import {
  getClosedItems,
  getOpenItems,
  useOrg,
  workKeys,
  type Item,
  type OpenItemsPoll,
} from './api'
import {
  closedShown,
  indexIsOld,
  OPEN_POLL_MS,
  inProgress,
  matches,
  plural,
  readyToClose,
  repositoryName,
  staleDays,
  type Filters,
  type Tab,
} from './board'
import {
  AttentionMark,
  Avatar,
  PullChip,
  Tag,
  UnpublishedMark,
  WarningMark,
} from './parts'
import { WorkRepositorySetting } from './RepositorySetting'

// The board (ux-spec 4): tracked items in three columns, Mine or Everyone.
// Read-only for now; Close and Reopen arrive with build step 5.

export default function BoardPage() {
  const auth = useContext(AuthContext)
  if (auth?.user && !auth.user.computerEnabled)
    return <Navigate to="/" replace />
  return <Board />
}

function useOpenItems() {
  const qc = useQueryClient()
  const key = workKeys.open(useOrg())
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const prev = qc.getQueryData<OpenItemsPoll>(key)
      const next = await getOpenItems(prev?.etag ?? null)
      if (next) return next
      if (prev) return prev
      // A 304 with nothing cached cannot happen (no ETag was sent); ask again.
      return (await getOpenItems(null))!
    },
    refetchInterval: OPEN_POLL_MS,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 2,
  })
}

export function Board() {
  const org = useOrg()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'everyone' ? 'everyone' : 'mine'
  const filters: Filters = {
    tab,
    q: params.get('q') ?? '',
    tag: params.get('tag'),
  }
  const showOlder = params.get('older') === '1'
  const setParam = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (v) next.set(k, v)
        else next.delete(k)
        return next
      },
      { replace: true },
    )

  const open = useOpenItems()
  const repository = open.data?.page.repository ?? null
  const closed = useInfiniteQuery({
    queryKey: workKeys.closed(org),
    queryFn: ({ pageParam }) => getClosedItems(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: repository !== null,
  })

  if (open.isPending) {
    return (
      <div role="status" className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }
  if (open.isError) {
    const missing = open.error instanceof ApiError && open.error.status === 404
    return (
      <BoardFrame>
        <Panel>
          <EmptyState
            icon={SquareKanban}
            title={
              missing
                ? 'The board is not available yet'
                : 'Could not load the board'
            }
            description={
              missing
                ? 'Tracked work is coming to this organization soon.'
                : 'Try loading this page again.'
            }
          />
        </Panel>
      </BoardFrame>
    )
  }

  const page = open.data.page
  if (!page.repository) {
    return (
      <BoardFrame>
        <Panel>
          <EmptyState
            icon={FileText}
            title="Nothing is tracked yet"
            description={<WhatIsAnItem />}
          />
        </Panel>
        <div className="mt-8">
          <WorkRepositorySetting />
        </div>
      </BoardFrame>
    )
  }

  const closedItems = closed.data?.pages.flatMap((p) => p.items) ?? []
  const all = [...page.items, ...closedItems]
  const shown = all.filter((i) => matches(i, filters))
  const progress = inProgress(shown)
  const ready = readyToClose(shown)
  const done = closedShown(shown, showOlder)
  const needYou = progress.filter(
    (i) => i.attention?.state === 'needs_you',
  ).length
  const filtering = !!filters.q.trim() || !!filters.tag
  const mineEmpty =
    tab === 'mine' &&
    !filtering &&
    !all.some((i) => i.mine) &&
    all.length > 0 &&
    !closed.isPending
  const nothing = all.length === 0 && !page.building && !closed.isPending

  return (
    <BoardFrame
      tab={tab}
      onTab={(t) => setParam('tab', t === 'mine' ? null : t)}
      q={filters.q}
      onQ={(q) => setParam('q', q || null)}
      tag={filters.tag}
      onClearTag={() => setParam('tag', null)}
      status={
        <IndexStatus
          repository={repositoryName(page.repository)}
          problem={page.repository.problem ?? null}
          building={page.building}
          asOf={page.asOf}
        />
      }
    >
      {nothing ? (
        <Panel>
          <EmptyState
            icon={FileText}
            title="Nothing is tracked yet"
            description={<WhatIsAnItem />}
          />
        </Panel>
      ) : mineEmpty ? (
        <Panel>
          <EmptyState
            icon={SquareKanban}
            title="You own no items"
            description={
              <>
                Items without an owner, and other people&apos;s, are on{' '}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-4"
                  onClick={() => setParam('tab', 'everyone')}
                >
                  Everyone
                </button>
                .
              </>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-x-6 gap-y-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Column
            title="In progress"
            count={progress.length}
            note={needYou ? `${needYou} need you` : null}
            wide
          >
            {progress.map((i) => (
              <Card key={i.number} item={i} onTag={(t) => setParam('tag', t)} />
            ))}
            {page.building && !progress.length ? (
              <p className="text-muted-foreground text-xs">
                Reading the working docs…
              </p>
            ) : null}
          </Column>
          <Column
            title="Ready to close"
            count={ready.length}
            note="nothing left in the doc"
          >
            {ready.map((i) => (
              <Card key={i.number} item={i} onTag={(t) => setParam('tag', t)}>
                {/* Close arrives in build step 5. */}
              </Card>
            ))}
          </Column>
          <Column
            title="Closed"
            count={done.length}
            note={showOlder ? 'all' : 'last 7 days'}
            footer={
              <div className="space-y-3">
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Switch
                    id="work-show-older"
                    checked={showOlder}
                    onCheckedChange={(on) => setParam('older', on ? '1' : null)}
                  />
                  <label htmlFor="work-show-older">Show older</label>
                </div>
                {showOlder && closed.hasNextPage ? (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
                    disabled={closed.isFetchingNextPage}
                    onClick={() => void closed.fetchNextPage()}
                  >
                    {closed.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </button>
                ) : null}
              </div>
            }
          >
            {done.map((i) => (
              <Card key={i.number} item={i} onTag={(t) => setParam('tag', t)} />
            ))}
          </Column>
        </div>
      )}
    </BoardFrame>
  )
}

function WhatIsAnItem() {
  return (
    <>
      An item is a working doc an agent keeps about work that outlives one
      sitting: what it is, where it stands, and what is left. Any session can be
      tracked: say &ldquo;track this&rdquo; in it, and the item shows up here.
    </>
  )
}

function BoardFrame({
  tab,
  onTab,
  q,
  onQ,
  tag,
  onClearTag,
  status,
  children,
}: {
  tab?: Tab
  onTab?: (t: Tab) => void
  q?: string
  onQ?: (q: string) => void
  tag?: string | null
  onClearTag?: () => void
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="text-xl font-semibold tracking-tight">Board</h1>
        {tab && onTab ? (
          <div
            role="tablist"
            aria-label="Whose items"
            className="bg-muted flex rounded-md p-0.5"
          >
            {(['mine', 'everyone'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => onTab(t)}
                className={cn(
                  'text-muted-foreground rounded px-3 py-1 text-sm transition-colors',
                  tab === t && 'bg-background text-foreground shadow-xs',
                )}
              >
                {t === 'mine' ? 'Mine' : 'Everyone'}
              </button>
            ))}
          </div>
        ) : null}
        {onQ ? (
          <div className="relative w-full sm:w-64">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
              aria-hidden
            />
            <input
              value={q}
              onChange={(e) => onQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && onQ('')}
              placeholder="Filter by title or state"
              aria-label="Filter by title or state"
              className="border-input placeholder:text-muted-foreground focus-visible:border-ring/60 h-8 w-full rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none"
            />
          </div>
        ) : null}
        {tag && onClearTag ? (
          <button
            type="button"
            onClick={onClearTag}
            className="bg-foreground text-background inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
            aria-label={`Clear the tag filter ${tag}`}
          >
            {tag}
            <X className="size-3" aria-hidden />
          </button>
        ) : null}
        <div className="flex-1" />
        {status}
      </header>
      {children}
    </div>
  )
}

/** Which repository the board reads, and how fresh what it shows is. */
function IndexStatus({
  repository,
  problem,
  building,
  asOf,
}: {
  repository: string
  problem: string | null
  building: boolean
  asOf: string | null
}) {
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
      {problem ? (
        <>
          <span className="text-status-error">
            Cannot read {repository}: {problem}.
          </span>
          <Link
            to="/computer#work-repository"
            className="hover:text-foreground underline underline-offset-4"
          >
            Settings
          </Link>
        </>
      ) : building ? (
        <span role="status" className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Reading {repository}…
        </span>
      ) : indexIsOld(asOf) ? (
        <span title={asOf ?? undefined}>As of {timeAgo(asOf)} ago</span>
      ) : null}
    </p>
  )
}

function Column({
  title,
  count,
  note,
  wide,
  footer,
  children,
}: {
  title: string
  count: number
  note: string | null
  wide?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-3 flex items-baseline gap-1.5 text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground tabular-nums">{count}</span>
        {note ? (
          <span className="text-muted-foreground text-xs">· {note}</span>
        ) : null}
      </h2>
      <div className={cn('grid items-start gap-3', wide && 'xl:grid-cols-2')}>
        {children}
      </div>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </section>
  )
}

export function Card({
  item,
  onTag,
  children,
}: {
  item: Item
  onTag: (tag: string) => void
  // The card's action (Close, Reopen), from build step 5.
  children?: ReactNode
}) {
  const stale = staleDays(item)
  const closed = item.stage === 'closed'
  return (
    <article
      className={cn(
        'bg-panel hover:border-foreground/20 relative rounded-lg border p-3.5 transition-colors',
        stale !== null && 'bg-muted/40 border-dashed opacity-75',
      )}
    >
      <h3 className="flex items-start gap-1.5 text-sm leading-5 font-medium">
        <span className="text-muted-foreground font-normal tabular-nums">
          {item.number}
        </span>
        <Link
          to={`/computer/work/${item.number}`}
          className={cn(
            'min-w-0 flex-1 after:absolute after:inset-0 after:rounded-lg',
            closed && 'text-muted-foreground',
          )}
        >
          {item.title}
        </Link>
        <WarningMark warnings={item.warnings} />
      </h3>
      {item.stateLine ? (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
          {item.stateLine}
        </p>
      ) : null}
      {item.tags.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((t) => (
            <Tag key={t} tag={t} onClick={() => onTag(t)} />
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
        {item.owner ? <Avatar person={item.owner} /> : null}
        {item.pullRequests.map((pr) => (
          <PullChip key={pr.url} pr={pr} />
        ))}
        {item.sessions.length ? (
          <span>{plural(item.sessions.length, 'session')}</span>
        ) : null}
        <span className="ml-auto tabular-nums" title={item.updatedAt}>
          {stale !== null
            ? `no change in ${stale} days`
            : timeAgo(
                closed ? (item.closedAt ?? item.updatedAt) : item.updatedAt,
              )}
        </span>
      </div>
      {item.unpublished ? <UnpublishedMark className="mt-2" /> : null}
      {closed || item.attention || children ? (
        <div className="mt-2.5 flex min-h-5 items-center gap-2 border-t border-dashed pt-2.5">
          {closed ? (
            <span className="text-muted-foreground text-xs">
              {item.closedBy ? `Closed by ${item.closedBy}` : 'Closed'}
            </span>
          ) : (
            <AttentionMark item={item} />
          )}
          <div className="relative z-10 ml-auto">{children}</div>
        </div>
      ) : null}
    </article>
  )
}
