import { useContext, type ReactNode } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  Loader2,
} from 'lucide-react'
import { ApiError } from '@/api/errors'
import { EmptyState } from '@/components/empty-state'
import { Panel } from '@/components/panel'
import { AuthContext } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { AgentMarkdown } from '../AgentMarkdown'
import { StatusDot } from '../computer-sessions/parts'
import { timeAgo } from '../computer-sessions/transcript'
import {
  getHistory,
  getItem,
  useOrg,
  workKeys,
  type Item,
  type Revision,
} from './api'
import {
  OPEN_POLL_MS,
  personName,
  presentBody,
  pullLabel,
  pullStateWord,
  resolveAgainst,
} from './board'
import {
  AttentionMark,
  Avatar,
  PullDot,
  SectionTitle,
  Tag,
  UnpublishedMark,
  WarningMark,
} from './parts'

// One item (ux-spec 5): its working doc at reading width, and beside it the
// details the API composes and the doc's history. No chat, no diff.

export default function ItemPage() {
  const auth = useContext(AuthContext)
  if (auth?.user && !auth.user.computerEnabled)
    return <Navigate to="/" replace />
  return <ItemView />
}

export function ItemView() {
  const org = useOrg()
  const number = Number(useParams().number)
  const valid = Number.isInteger(number) && number > 0
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'history' ? 'history' : 'details'
  const item = useQuery({
    queryKey: workKeys.item(org, number),
    queryFn: () => getItem(number),
    enabled: valid,
    refetchInterval: OPEN_POLL_MS,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 2,
  })

  if (!valid || item.isError) {
    const missing =
      !valid || (item.error instanceof ApiError && item.error.status === 404)
    return (
      <div>
        <Breadcrumb number={valid ? number : null} />
        <Panel>
          <EmptyState
            icon={FileText}
            title={missing ? 'No such item' : 'Could not load this item'}
            description={
              missing
                ? 'It may have been renamed, or tracked work is not available here yet.'
                : 'Try loading this page again.'
            }
            action={
              <Link
                to="/computer/work"
                className="text-sm underline underline-offset-4"
              >
                Back to the board
              </Link>
            }
          />
        </Panel>
      </div>
    )
  }
  if (item.isPending) {
    return (
      <div role="status" className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  const it = item.data.item
  return (
    <div>
      <Breadcrumb number={it.number} />
      <ItemHeader item={it} />
      <div className="mt-6 flex flex-col gap-8 lg:flex-row lg:items-start">
        <article className="min-w-0 flex-1">
          <div className="max-w-[72ch]">
            <AgentMarkdown resolveUrl={(u) => resolveAgainst(u, it.url)}>
              {presentBody(item.data.body)}
            </AgentMarkdown>
          </div>
        </article>
        <aside className="lg:sticky lg:top-8 lg:w-80 lg:shrink-0">
          <div
            role="tablist"
            aria-label="About this item"
            className="mb-4 flex gap-4 border-b text-sm"
          >
            {(['details', 'history'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() =>
                  setParams(
                    (p) => {
                      const next = new URLSearchParams(p)
                      if (t === 'history') next.set('tab', t)
                      else next.delete('tab')
                      return next
                    },
                    { replace: true },
                  )
                }
                className={cn(
                  'text-muted-foreground -mb-px border-b-2 border-transparent pb-2 transition-colors',
                  tab === t && 'border-foreground text-foreground',
                )}
              >
                {t === 'details' ? 'Details' : 'History'}
              </button>
            ))}
          </div>
          {tab === 'details' ? (
            <Details item={it} />
          ) : (
            <HistoryList number={it.number} />
          )}
        </aside>
      </div>
    </div>
  )
}

function Breadcrumb({ number }: { number: number | null }) {
  return (
    <nav aria-label="Breadcrumb" className="text-muted-foreground mb-3 text-xs">
      <Link to="/computer/work" className="hover:text-foreground">
        Board
      </Link>
      {number !== null ? (
        <>
          <span className="mx-1.5">/</span>
          <span className="tabular-nums">{number}</span>
        </>
      ) : null}
    </nav>
  )
}

function ItemHeader({ item }: { item: Item }) {
  const closed = item.stage === 'closed'
  return (
    <header className="border-b pb-5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">
          <span className="text-muted-foreground mr-2 font-normal tabular-nums">
            {item.number}
          </span>
          {item.title}
        </h1>
        <div className="flex items-center gap-2">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            View on GitHub
            <ExternalLink className="size-3" aria-hidden />
          </a>
          {/* Close and Reopen arrive here with build step 5. */}
        </div>
      </div>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 font-medium',
            closed
              ? 'text-muted-foreground'
              : item.readyToClose
                ? 'text-foreground'
                : 'text-status-running border-status-running/40',
          )}
        >
          {closed ? 'Closed' : item.readyToClose ? 'Ready to close' : 'Open'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          {item.owner ? (
            <>
              <Avatar person={item.owner} />
              {personName(item.owner)}
            </>
          ) : (
            'no owner'
          )}
        </span>
        {item.author ? <span>started by {personName(item.author)}</span> : null}
        {closed ? (
          <span title={item.closedAt ?? undefined}>
            {item.closedBy ? `closed by ${item.closedBy}` : 'closed'}
            {item.closedAt ? ` · ${timeAgo(item.closedAt)}` : null}
          </span>
        ) : (
          <span title={item.updatedAt}>changed {timeAgo(item.updatedAt)}</span>
        )}
        {!closed ? <AttentionMark item={item} /> : null}
        <WarningMark warnings={item.warnings} />
        {item.unpublished ? <UnpublishedMark /> : null}
      </div>
    </header>
  )
}

function Details({ item }: { item: Item }) {
  const people = peopleOf(item)
  return (
    <div className="space-y-6 text-sm">
      {item.warnings.length ? (
        <Section title="Problems in the doc">
          <ul className="text-status-pending space-y-1 text-xs">
            {item.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Tags">
        {item.tags.length ? (
          <div className="flex flex-wrap gap-1">
            {item.tags.map((t) => (
              <Link
                key={t}
                to={`/computer/work?tab=everyone&tag=${encodeURIComponent(t)}`}
                title={`Show items tagged ${t}`}
              >
                <Tag tag={t} />
              </Link>
            ))}
          </div>
        ) : (
          <None>No tags</None>
        )}
      </Section>
      <Section title={`Sessions${count(item.sessions.length)}`}>
        {item.sessions.length ? (
          <ul className="space-y-2">
            {item.sessions.map((s) => (
              <li key={s.id} className="flex items-start gap-2">
                {s.status ? (
                  <span className="mt-1.5">
                    <StatusDot status={s.status} />
                  </span>
                ) : null}
                <div className="min-w-0">
                  <Link
                    to={`/computer/sessions/${s.id}`}
                    className="hover:text-foreground block truncate underline-offset-4 hover:underline"
                  >
                    {s.title || 'Untitled session'}
                  </Link>
                  <p className="text-muted-foreground text-xs">
                    {[s.ownerName, s.status].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <None>No session has worked on it yet</None>
        )}
      </Section>
      <Section title={`Pull requests${count(item.pullRequests.length)}`}>
        {item.pullRequests.length ? (
          <ul className="space-y-2">
            {item.pullRequests.map((pr) => (
              <li key={pr.url} className="flex items-start gap-2">
                <span className="mt-2">
                  <PullDot state={pr.state} />
                </span>
                <div className="min-w-0">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate underline-offset-4 hover:underline"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {pullLabel(pr)}
                    </span>{' '}
                    {pr.title}
                  </a>
                  <p className="text-muted-foreground text-xs">
                    {pullStateWord(pr.state)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <None>None linked</None>
        )}
      </Section>
      <Section title="People">
        <ul className="space-y-1.5">
          {people.map(({ name, role }) => (
            <li key={`${role}-${name}`} className="flex items-center gap-2">
              <Avatar person={{ name, email: name, id: null }} />
              <span className="min-w-0 truncate">{name}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {role}
              </span>
            </li>
          ))}
        </ul>
        {!people.length ? <None>Nobody yet</None> : null}
      </Section>
    </div>
  )
}

/** The people the item names, each once with the role it names them in. */
function peopleOf(item: Item): { name: string; role: string }[] {
  const out: { name: string; role: string }[] = []
  const add = (name: string | null | undefined, role: string) => {
    if (!name || out.some((p) => p.name === name)) return
    out.push({ name, role })
  }
  add(item.owner && personName(item.owner), 'owner')
  add(item.author && personName(item.author), 'author')
  for (const s of item.sessions) add(s.ownerName, 'session')
  return out
}

function HistoryList({ number }: { number: number }) {
  const org = useOrg()
  const history = useInfiniteQuery({
    queryKey: workKeys.history(org, number),
    queryFn: ({ pageParam }) => getHistory(number, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  if (history.isPending) {
    return (
      <Loader2
        className="text-muted-foreground size-4 animate-spin"
        aria-label="Loading"
      />
    )
  }
  if (history.isError) {
    return <None>Could not load the history.</None>
  }
  const revisions = history.data.pages.flatMap((p) => p.revisions)
  if (!revisions.length) return <None>No changes yet</None>
  return (
    <div>
      <ol className="relative space-y-4 border-l pl-4">
        {revisions.map((r) => (
          <RevisionRow key={r.sha} revision={r} />
        ))}
      </ol>
      {history.hasNextPage ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-4 text-xs underline underline-offset-4"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Older changes'}
        </button>
      ) : null}
    </div>
  )
}

function RevisionRow({ revision: r }: { revision: Revision }) {
  return (
    <li className="relative text-sm">
      <span
        aria-hidden
        className="bg-background absolute top-1.5 -left-[21px] size-2.5 rounded-full border"
      />
      <p className="leading-5">{r.summary}</p>
      <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
        <span>{r.authorName}</span>
        <span title={r.at}>{timeAgo(r.at)}</span>
        {r.sessionId ? (
          <Link
            to={`/computer/sessions/${r.sessionId}`}
            className="hover:text-foreground underline underline-offset-4"
          >
            session
          </Link>
        ) : null}
        <a
          href={r.url}
          target="_blank"
          rel="noreferrer"
          title="This change on GitHub"
          className="hover:text-foreground inline-flex items-center gap-0.5 font-mono"
        >
          <GitCommitHorizontal className="size-3" aria-hidden />
          {r.sha.slice(0, 7)}
        </a>
      </p>
    </li>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  )
}

function None({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>
}

const count = (n: number) => (n ? ` · ${n}` : '')
