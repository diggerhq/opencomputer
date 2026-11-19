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
  sessionStatusWord,
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

// The doc's own type: AgentMarkdown's chat sizes, set for reading at length.
// Section headings get room above them; task lists draw their own boxes and
// mute what is done (the boxes are styled in index.css, .work-doc).
const DOC = cn(
  'work-doc max-w-[42rem]',
  '[&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:leading-6',
  '[&_h3]:mt-6 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:leading-6',
  '[&_.contains-task-list]:mb-3 [&_.contains-task-list]:space-y-1 [&_.contains-task-list]:last:mb-0',
  '[&_.task-list-item]:relative [&_.task-list-item]:pl-6',
  '[&_.task-list-item:has(>input:checked)]:text-muted-foreground',
)

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
    const status = item.error instanceof ApiError ? item.error.status : null
    // The server's 404 for a number it does not track; any other 404 means
    // the routes are not there yet, as on the board.
    const noItem =
      !valid ||
      (status === 404 &&
        item.error instanceof ApiError &&
        item.error.type === 'item_not_found')
    const { title, description } = noItem
      ? {
          title: valid ? `No item ${number}` : 'No such item',
          description:
            'Nothing tracked has this number. It may have been removed from the working docs.',
        }
      : status === 404
        ? {
            title: 'The board is not available yet',
            description: 'Tracked work is coming to this organization soon.',
          }
        : {
            title: 'Could not load this item',
            description: 'Try loading this page again.',
          }
    return (
      <div>
        <Breadcrumb number={valid ? number : null} />
        <Panel>
          <EmptyState
            icon={FileText}
            title={title}
            description={description}
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
      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-0">
        <article className="min-w-0 lg:pr-12">
          <div className={DOC}>
            <AgentMarkdown resolveUrl={(u) => resolveAgainst(u, it.url)}>
              {presentBody(item.data.body)}
            </AgentMarkdown>
          </div>
        </article>
        <aside className="lg:border-l lg:pl-8">
          <div className="lg:sticky lg:top-8">
            <div
              role="tablist"
              aria-label="About this item"
              className="mb-5 flex gap-5 border-b text-sm"
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
                    'text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent pb-2 leading-6 transition-colors',
                    tab === t &&
                      'border-foreground text-foreground font-medium',
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
          </div>
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
  // Null when not known yet: then no time is shown.
  const when = closed ? (item.closedAt ?? item.updatedAt) : item.updatedAt
  return (
    <header className="border-b pb-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <h1 className="min-w-0 flex-1 text-xl leading-8 font-semibold tracking-tight text-pretty">
          <span className="text-muted-foreground mr-2.5 font-normal tabular-nums">
            {item.number}
          </span>
          {item.title}
        </h1>
        <div className="flex h-8 items-center gap-2">
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
      {/* The row is pulled 20px left and clipped, so a dot that wraps to the
          start of a line falls outside and is never seen. */}
      <div className="text-muted-foreground mt-2 overflow-hidden text-xs">
        <div className="-ml-5 flex flex-wrap items-center gap-y-1.5">
          <span
            className={cn(
              'mr-3 ml-5 inline-flex h-5 items-center rounded-full border px-2 font-medium',
              closed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {closed ? 'Closed' : item.readyToClose ? 'Ready to close' : 'Open'}
          </span>
          <Dotted>
            <span className="inline-flex items-center gap-1.5">
              {item.owner ? (
                <>
                  <Avatar person={item.owner} />
                  <span className="text-foreground">
                    {personName(item.owner)}
                  </span>
                </>
              ) : (
                'no owner'
              )}
            </span>
            {item.author ? (
              <span>started by {personName(item.author)}</span>
            ) : null}
            {closed ? (
              <span>
                {item.closedBy ? `closed by ${item.closedBy}` : 'closed'}
              </span>
            ) : null}
            {when ? (
              <span title={when} className="tabular-nums">
                {closed ? timeAgo(when) : `changed ${timeAgo(when)}`}
              </span>
            ) : null}
            {!closed && item.attention ? <AttentionMark item={item} /> : null}
            {item.warnings.length ? (
              <span className="inline-flex items-center gap-1">
                <WarningMark warnings={item.warnings} />
                <span className="text-status-pending">
                  {item.warnings.length === 1
                    ? 'a problem in the doc'
                    : `${item.warnings.length} problems in the doc`}
                </span>
              </span>
            ) : null}
            {item.unpublished ? <UnpublishedMark /> : null}
          </Dotted>
        </div>
      </div>
    </header>
  )
}

/** Inline facts with a quiet dot between them; only the first may shrink. */
function Dotted({ children }: { children: ReactNode[] }) {
  const parts = children.filter(Boolean)
  return parts.map((part, i) => (
    <span
      key={i}
      className={cn(
        'inline-flex items-center',
        i === 0 ? 'min-w-0' : 'shrink-0',
      )}
    >
      {i > 0 ? (
        <span
          aria-hidden
          className="text-muted-foreground/50 inline-block w-5 text-center"
        >
          ·
        </span>
      ) : null}
      {part}
    </span>
  ))
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
          <ul className="space-y-2.5">
            {item.sessions.map((s) => (
              <li key={s.id} className="flex items-start gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <StatusDot status={s.status} />
                </span>
                <div className="min-w-0">
                  <Link
                    to={`/computer/sessions/${s.id}`}
                    className="block truncate leading-5 underline-offset-4 hover:underline"
                  >
                    {s.title || 'Untitled session'}
                  </Link>
                  <p className="text-muted-foreground text-xs leading-4">
                    {[s.ownerName, sessionStatusWord(s.status)]
                      .filter(Boolean)
                      .join(' · ')}
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
          <ul className="space-y-2.5">
            {item.pullRequests.map((pr) => (
              <li key={pr.url} className="flex items-start gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <PullDot state={pr.state} />
                </span>
                <div className="min-w-0">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate leading-5 underline-offset-4 hover:underline"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {pullLabel(pr)}
                    </span>{' '}
                    {pr.title}
                  </a>
                  <p className="text-muted-foreground text-xs leading-4">
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
        <ul className="space-y-2">
          {people.map(({ name, role }) => (
            <li key={`${role}-${name}`} className="flex items-center gap-2">
              <Avatar person={{ name, email: name, id: null }} />
              <span className="min-w-0 truncate leading-5">{name}</span>
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
      <ol>
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

// A timeline: a dot centred on the summary's first line, and a rule from
// each dot to the next that stops short of both.
function RevisionRow({ revision: r }: { revision: Revision }) {
  return (
    <li className="group/rev relative pb-5 pl-5 text-sm last:pb-0">
      <span
        aria-hidden
        className="bg-border absolute top-[18px] -bottom-0.5 left-[3.5px] w-px group-last/rev:hidden dark:bg-white/10"
      />
      <span
        aria-hidden
        className="border-muted-foreground/60 bg-background absolute top-1.5 left-0 size-2 rounded-full border-[1.5px]"
      />
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 leading-5 text-pretty">{r.summary}</p>
        <span
          title={r.at}
          className="text-muted-foreground shrink-0 text-xs leading-5 tabular-nums"
        >
          {timeAgo(r.at)}
        </span>
      </div>
      <p className="text-muted-foreground mt-0.5 flex min-w-0 items-center text-xs leading-5 whitespace-nowrap">
        <Dotted>
          <span className="block truncate">{r.authorName}</span>
          {r.sessionId ? (
            <Link
              to={`/computer/sessions/${r.sessionId}`}
              className="hover:text-foreground underline-offset-4 hover:underline"
            >
              session
            </Link>
          ) : null}
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            title="This change on GitHub"
            className="hover:text-foreground inline-flex items-center gap-1 font-mono text-[11px]"
          >
            <GitCommitHorizontal className="size-3" aria-hidden />
            {r.sha.slice(0, 7)}
          </a>
        </Dotted>
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
