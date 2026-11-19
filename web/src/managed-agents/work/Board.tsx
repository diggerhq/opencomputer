import { useContext, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  FileText,
  Loader2,
  MessagesSquare,
  Search,
  SquareKanban,
  X,
} from 'lucide-react'
import { ApiError } from '@/api/errors'
import { EmptyState } from '@/components/empty-state'
import { Panel } from '@/components/panel'
import { Switch } from '@/components/ui/switch'
import { AuthContext } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { timeAgo } from '../computer-sessions/transcript'
import { getClosedItems, useOrg, workKeys, type Item } from './api'
import {
  closedShown,
  indexIsOld,
  inProgress,
  matches,
  plural,
  readyToClose,
  repositoryName,
  repositoryProblem,
  staleDays,
  type Filters,
  type Tab,
} from './board'
import {
  AttentionMark,
  Avatar,
  PullDots,
  Tag,
  UnpublishedMark,
  WarningMark,
} from './parts'
import { useOpenItems } from './queries'
import { FirstRepository } from './RepositorySetting'

// The board (ux-spec 4): tracked items in three columns, Mine or Everyone.
// Read-only for now; Close and Reopen arrive with build step 5.

export default function BoardPage() {
  const auth = useContext(AuthContext)
  if (auth?.user && !auth.user.computerEnabled)
    return <Navigate to="/" replace />
  return <Board />
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
          <FirstRepository />
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
          problem={repositoryProblem(page.repository)}
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
        <div className="grid gap-4 lg:grid-cols-3">
          <Column
            title="In progress"
            count={progress.length}
            note={
              needYou ? `${needYou} need${needYou === 1 ? 's' : ''} you` : null
            }
            accent={needYou > 0}
            empty={page.building ? 'Reading the working docs…' : undefined}
          >
            {progress.map((i) => (
              <Card key={i.number} item={i} onTag={(t) => setParam('tag', t)} />
            ))}
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
      <header className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-3">
        <h1 className="mr-1 text-xl leading-8 font-semibold tracking-tight">
          Board
        </h1>
        {tab && onTab ? (
          <div
            role="tablist"
            aria-label="Whose items"
            className="bg-muted flex h-8 items-center rounded-md p-0.5"
          >
            {(['mine', 'everyone'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => onTab(t)}
                className={cn(
                  'text-muted-foreground hover:text-foreground h-7 rounded-[5px] px-3 text-sm transition-colors',
                  tab === t && 'bg-panel text-foreground shadow-xs',
                )}
              >
                {t === 'mine' ? 'Mine' : 'Everyone'}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">{status}</div>
        {tag && onClearTag ? (
          <button
            type="button"
            onClick={onClearTag}
            className="bg-foreground text-background inline-flex h-6 items-center gap-1 rounded-sm pr-1.5 pl-2 text-xs"
            aria-label={`Clear the tag filter ${tag}`}
          >
            {tag}
            <X className="size-3" aria-hidden />
          </button>
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
              className="border-input bg-panel placeholder:text-muted-foreground focus-visible:border-ring/60 h-8 w-full rounded-md border pr-2 pl-8 text-sm outline-none"
            />
          </div>
        ) : null}
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
            Cannot read {repository}. {problem}
          </span>
          <Link
            to="/settings#work-repository"
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
      ) : (
        <>
          {/* Quiet: where the board reads from, and the way to change it. */}
          <Link
            to="/settings#work-repository"
            title="Change the working docs repository"
            className="hover:text-foreground"
          >
            {repository}
          </Link>
          {indexIsOld(asOf) ? (
            <span title={asOf ?? undefined}>· As of {timeAgo(asOf)} ago</span>
          ) : null}
        </>
      )}
    </p>
  )
}

/** A stage: a tinted lane with its header inside, one stack of cards. */
function Column({
  title,
  count,
  note,
  accent,
  empty = 'None',
  footer,
  children,
}: {
  title: string
  count: number
  note: string | null
  // The note is the amber "N need you".
  accent?: boolean
  // What an empty lane says.
  empty?: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="bg-muted/60 flex min-w-0 flex-col rounded-xl p-2 dark:bg-black/15"
    >
      <h2 className="flex h-9 items-center gap-2 px-[13px] pb-1 text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground tabular-nums">{count}</span>
        {note ? (
          <span
            className={cn(
              'ml-auto truncate text-xs',
              accent
                ? 'font-medium text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground',
            )}
          >
            {note}
          </span>
        ) : null}
      </h2>
      <div className="flex flex-col gap-2">{children}</div>
      {count === 0 ? (
        <p className="text-muted-foreground px-[13px] py-2 text-xs">{empty}</p>
      ) : null}
      {footer ? <div className="px-[13px] pt-3 pb-1">{footer}</div> : null}
    </section>
  )
}

// A card has one anatomy whatever it carries (WORK_WEB_NOTES "Visual pass"):
// an identity line, the title and state, and an activity line. Every line box
// is 20px, so cards differ only by whole lines.
const MAX_TAGS = 2

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
  const shownTags = item.tags.slice(0, MAX_TAGS)
  const moreTags = item.tags.slice(MAX_TAGS)
  const sessions = item.sessions.length
  // When it last changed, or closed; unknown yet shows nothing.
  const when = closed ? (item.closedAt ?? item.updatedAt) : item.updatedAt
  return (
    <article
      className={cn(
        'group/card relative rounded-lg border p-3 transition-colors',
        stale !== null
          ? 'border-foreground/15 hover:border-foreground/30 border-dashed bg-transparent'
          : 'bg-panel hover:border-foreground/20 shadow-[0_1px_1px_0_rgb(20_19_17/0.03)]',
      )}
    >
      <div className="text-muted-foreground flex h-5 items-center gap-1.5 text-xs">
        <span className="mr-0.5 font-medium tabular-nums">{item.number}</span>
        {shownTags.map((t) => (
          <Tag key={t} tag={t} onClick={() => onTag(t)} />
        ))}
        {moreTags.length ? (
          <span
            className="relative z-10 shrink-0 text-[11px] tabular-nums"
            title={moreTags.join(', ')}
          >
            +{moreTags.length}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">
          <WarningMark warnings={item.warnings} quiet />
          {item.unpublished ? <UnpublishedMark quiet /> : null}
          {item.owner ? <Avatar person={item.owner} /> : null}
        </span>
      </div>
      <h3
        className={cn(
          'mt-2 line-clamp-2 text-sm leading-5 font-medium text-pretty',
          (closed || stale !== null) && 'text-muted-foreground',
        )}
      >
        <Link
          to={`/computer/work/${item.number}`}
          className="after:absolute after:inset-0 after:rounded-lg"
        >
          {item.title}
        </Link>
      </h3>
      {item.stateLine ? (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5 text-pretty">
          {item.stateLine}
        </p>
      ) : null}
      <div className="text-muted-foreground mt-3 flex h-5 items-center gap-3 text-xs">
        <div className="flex min-w-0 flex-1 items-center">
          {closed ? (
            <span className="truncate">
              {item.closedBy ? `Closed by ${item.closedBy}` : 'Closed'}
            </span>
          ) : (
            <AttentionMark item={item} />
          )}
        </div>
        {children ? <div className="relative z-10">{children}</div> : null}
        <PullDots prs={item.pullRequests} />
        {sessions ? (
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            title={plural(sessions, 'session')}
          >
            <MessagesSquare className="size-3.5" aria-hidden />
            {sessions}
            <span className="sr-only">
              {sessions === 1 ? ' session' : ' sessions'}
            </span>
          </span>
        ) : null}
        {stale !== null || when ? (
          <span className="shrink-0 tabular-nums" title={when ?? undefined}>
            {stale !== null ? `no change in ${stale} days` : timeAgo(when)}
          </span>
        ) : null}
      </div>
    </article>
  )
}
