import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  Check,
  CircleHelp,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getEvents, sessionKeys, type Session } from '../computer-sessions-api'
import { AnswerDock } from './AnswerDock'
import { Item } from './conversation'
import { useMemberEmails } from './members'
import { StatusDot } from './parts'
import { sessionLine, sessionTitle } from './state'
import {
  TRIAGE_NEEDS,
  useTriage,
  type TriageEntry,
  type TriageKind,
} from './triage'
import { buildTranscript, timeAgo } from './transcript'

// Triage (work-tracking ux-spec 3): one ask at a time,
// answer, next. The ask on screen is `?ask=<id>`; nothing replaces it while
// it is shown.

const WORKING_ROWS = 5
// How long the line saying what was just sent stays.
const SENT_MS = 5_000

/** What was just sent, and where: shown over the next ask for a moment. */
type Sent = { said: string; title: string }

export default function Triage() {
  const qc = useQueryClient()
  const { needs, aside, working, loaded } = useTriage()
  const [params, setParams] = useSearchParams()
  const want = params.get('ask')
  // Text typed for each ask, kept when moving between rows.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // Asks answered from here: they leave the list before the next poll says so.
  const [done, setDone] = useState<ReadonlySet<string>>(new Set())
  const open = needs.filter((e) => !done.has(e.ref))
  const [sent, setSent] = useState<Sent | null>(null)
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(null), SENT_MS)
    return () => clearTimeout(t)
  }, [sent])

  // The ask on screen, kept once its row is gone so the card does not vanish.
  const live = [...needs, ...aside].find((e) => e.ref === want) ?? null
  const [shown, setShown] = useState<TriageEntry | null>(null)
  if (live && live !== shown) setShown(live)
  const entry = live ?? (shown?.ref === want ? shown : null)
  const gone = !live && !!entry && !done.has(entry.ref)

  const go = (ref: string | null, replace = false) =>
    setParams(ref ? { ask: ref } : {}, { replace })
  const next = (after: string) =>
    open.find((e) => e.ref !== after && !done.has(e.ref))?.ref ?? null

  // Nothing (or an unknown ask) selected: open the oldest that needs you.
  const first = open[0]?.ref ?? null
  useEffect(() => {
    if (!loaded || entry) return
    if (first || want) go(first, true)
    // `go` changes every render; this follows the data only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, entry, first, want])

  const answered = (e: TriageEntry, said: string) => {
    setDone((d) => new Set(d).add(e.ref))
    setDrafts((d) => {
      const rest = { ...d }
      delete rest[e.ref]
      return rest
    })
    setSent({ said, title: sessionTitle(e.session) })
    go(next(e.ref))
  }
  const refetch = () =>
    qc.refetchQueries({ queryKey: sessionKeys.list(TRIAGE_NEEDS) })

  return (
    <div className="flex h-full">
      <aside className="border-border hidden w-80 shrink-0 flex-col overflow-y-auto border-r md:flex">
        <Section
          label="Needs you"
          count={loaded ? open.length : undefined}
          primary
        >
          {loaded && !open.length ? (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              Nothing waits on you.
            </p>
          ) : null}
          {open.map((e) => (
            <AskRow
              key={e.ref}
              entry={e}
              current={e.ref === entry?.ref}
              onClick={() => go(e.ref)}
            />
          ))}
        </Section>
        {aside.length ? (
          <Section label="Set aside" count={aside.length}>
            {aside.map((e) => (
              <AskRow
                key={e.ref}
                entry={e}
                quiet
                current={e.ref === entry?.ref}
                onClick={() => go(e.ref)}
              />
            ))}
          </Section>
        ) : null}
        <Section
          label="Agents working"
          count={loaded ? working.length : undefined}
        >
          {working.slice(0, WORKING_ROWS).map((s) => (
            <WorkingRow key={s.id} session={s} />
          ))}
          {working.length > WORKING_ROWS ? (
            <Link
              to="/computer/sessions"
              className="text-muted-foreground hover:text-foreground block px-3 py-1 text-xs"
            >
              {working.length - WORKING_ROWS} more
            </Link>
          ) : null}
        </Section>
      </aside>
      <div className="min-w-0 flex-1">
        {entry ? (
          <AskView
            key={entry.ref}
            entry={entry}
            gone={gone}
            sent={sent}
            draft={drafts[entry.ref] ?? ''}
            setDraft={(text) => setDrafts((d) => ({ ...d, [entry.ref]: text }))}
            onAnswered={(said) => answered(entry, said)}
            onAside={async () => {
              await refetch()
              go(next(entry.ref))
            }}
            onBack={() => void refetch()}
            onNext={() => go(next(entry.ref))}
          />
        ) : loaded ? (
          <AllClear
            sent={sent}
            working={working.length}
            aside={aside.length}
            onAside={() => go(aside[0]?.ref ?? null)}
          />
        ) : null}
      </div>
    </div>
  )
}

function Section({
  label,
  count,
  primary,
  children,
}: {
  label: string
  count?: number
  /** "Needs you": the one heading in the foreground, its count in amber. */
  primary?: boolean
  children: ReactNode
}) {
  return (
    <section className="border-border border-b px-2 pt-4 pb-3 last:border-b-0">
      <h2
        className={cn(
          'flex h-8 items-center gap-2 px-3',
          primary
            ? 'text-sm font-medium'
            : 'text-muted-foreground text-xs leading-5 font-medium',
        )}
      >
        {label}
        {count !== undefined ? (
          <span
            className={cn(
              'text-xs font-normal tabular-nums',
              primary && count
                ? 'font-medium text-amber-600 dark:text-amber-500'
                : 'text-muted-foreground',
            )}
          >
            {count}
          </span>
        ) : null}
      </h2>
      <div className="space-y-px">{children}</div>
    </section>
  )
}

const KIND: Record<
  TriageKind,
  { icon: ComponentType<{ className?: string }>; label: string }
> = {
  approval: { icon: ShieldCheck, label: 'Approval' },
  question: { icon: CircleHelp, label: 'Question' },
  secret: { icon: KeyRound, label: 'Secret' },
  reply: { icon: MessageSquareText, label: 'Reply' },
}

function AskRow({
  entry,
  current,
  quiet,
  onClick,
}: {
  entry: TriageEntry
  current: boolean
  /** Set aside: outside the loop, so muted. */
  quiet?: boolean
  onClick: () => void
}) {
  const { icon: Icon, label } = KIND[entry.kind]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'hover:bg-muted/60 grid w-full grid-cols-[16px_1fr_auto] gap-x-2.5 rounded-md px-3 py-2 text-left',
        current && 'bg-muted hover:bg-muted',
      )}
    >
      <span
        className={cn(
          'text-muted-foreground flex h-5 items-center',
          quiet && 'opacity-70',
        )}
        title={label}
      >
        <Icon className="size-3.5" aria-label={label} />
      </span>
      <span
        className={cn(
          'truncate text-sm leading-5',
          quiet && 'text-muted-foreground',
        )}
      >
        {entry.line}
      </span>
      <span className="text-muted-foreground text-xs leading-5 tabular-nums">
        {timeAgo(entry.at)}
      </span>
      <span
        className={cn(
          'text-muted-foreground col-start-2 col-end-4 truncate text-xs leading-4',
          quiet && 'opacity-80',
        )}
      >
        {sessionTitle(entry.session)}
      </span>
    </button>
  )
}

function WorkingRow({ session }: { session: Session }) {
  const line = sessionLine(session)
  return (
    <Link
      to={`/computer/sessions/${session.id}`}
      className="hover:bg-muted/60 grid grid-cols-[16px_1fr] gap-x-2.5 rounded-md px-3 py-2"
    >
      <span className="flex h-5 items-center justify-center">
        <StatusDot status={session.status} />
      </span>
      <span className="text-muted-foreground truncate text-sm leading-5">
        {sessionTitle(session)}
      </span>
      {line ? (
        <span className="text-muted-foreground/80 col-start-2 truncate text-xs leading-4">
          {line}
        </span>
      ) : null}
    </Link>
  )
}

function SentLine({ sent }: { sent: Sent }) {
  return (
    <p
      role="status"
      className="text-muted-foreground animate-in fade-in flex min-w-0 items-center gap-1.5 text-xs"
    >
      <Check className="text-status-running size-3.5 shrink-0" aria-hidden />
      <span className="text-foreground shrink-0">{sent.said}</span>
      <span aria-hidden>·</span>
      <span className="truncate">{sent.title}</span>
    </p>
  )
}

function AllClear({
  sent,
  working,
  aside,
  onAside,
}: {
  sent: Sent | null
  working: number
  aside: number
  onAside: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 pb-16 text-center">
      <div className="mb-2 flex h-5 justify-center">
        {sent ? <SentLine sent={sent} /> : null}
      </div>
      <h1 className="text-xl leading-7 font-semibold tracking-tight">
        All clear
      </h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        {working
          ? `${working} ${working === 1 ? 'agent is' : 'agents are'} working. The next one that needs you appears here.`
          : 'Nothing waits on you.'}
      </p>
      {aside ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onAside}>
          {aside} set aside
        </Button>
      ) : null}
    </div>
  )
}

function AskView({
  entry,
  gone,
  draft,
  setDraft,
  sent,
  onAnswered,
  onAside,
  onBack,
  onNext,
}: {
  entry: TriageEntry
  gone: boolean
  draft: string
  setDraft: (text: string) => void
  sent: Sent | null
  onAnswered: (said: string) => void
  onAside: () => Promise<void>
  onBack: () => void
  onNext: () => void
}) {
  const s = entry.session
  return (
    <div className="mx-auto flex h-full w-full max-w-[47rem] flex-col px-6 pt-6 pb-6">
      <header className="shrink-0">
        <div className="flex h-5 items-center gap-4 text-xs">
          <p className="text-muted-foreground flex min-w-0 items-center gap-1.5">
            <Link
              to={`/computer/sessions/${s.id}`}
              className="hover:text-foreground truncate"
            >
              {sessionTitle(s)}
            </Link>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">
              {timeAgo(entry.at)} ago
            </span>
          </p>
          <div className="ml-auto flex min-w-0 shrink-0 justify-end">
            {sent ? (
              <SentLine sent={sent} />
            ) : (
              <Link
                to={`/computer/sessions/${s.id}`}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                Open the session
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </div>
        </div>
        <h1 className="mt-1 line-clamp-2 text-xl leading-7 font-semibold tracking-tight">
          {entry.line}
        </h1>
      </header>

      <Conversation session={s} turnId={entry.ask?.turnId ?? null} />

      <div className="shrink-0 pt-4">
        <AnswerDock
          entry={entry}
          gone={gone}
          draft={draft}
          setDraft={setDraft}
          onAnswered={onAnswered}
          onAside={onAside}
          onBack={onBack}
          onNext={onNext}
        />
      </div>
    </div>
  )
}

const TAIL_TURNS = 3

// The excerpt, unframed: a link to the earlier messages, then the last turns,
// with a rule where the asking turn starts. It sits on the dock: short
// excerpts are pushed to the bottom, long ones open scrolled to the end.
function Conversation({
  session,
  turnId,
}: {
  session: Session
  turnId: string | null
}) {
  const page = useQuery({
    queryKey: sessionKeys.events(session.id, { tailTurns: TAIL_TURNS }),
    queryFn: () => getEvents(session.id, { tailTurns: TAIL_TURNS }),
    refetchInterval: 10_000,
  })
  const emails = useMemberEmails()
  const events = page.data?.events
  const [before, after] = useMemo(() => {
    const all = events ?? []
    const at = turnId ? all.findIndex((e) => e.turnId === turnId) : -1
    if (at <= 0) return [buildTranscript(all), []]
    return [buildTranscript(all.slice(0, at)), buildTranscript(all.slice(at))]
  }, [events, turnId])
  const earlier = page.data?.earlierTurns?.length ?? 0

  // Kept scrolled to the end while it grows or the window changes, unless
  // the person has scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    pinned.current = true
  }, [before.length, after.length])
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const pin = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(pin)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])

  const items = (list: typeof before) =>
    list.map((item, i) => (
      <Item
        key={item.key}
        item={item}
        emails={emails}
        leads={i === 0 || list[i - 1].kind === 'user'}
      />
    ))

  return (
    <section
      aria-label="Conversation"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
      }}
      className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_24px)] px-2"
    >
      <div className="flex min-h-full flex-col justify-end gap-5 pt-6 pb-1">
        {earlier ? (
          <Link
            to={`/computer/sessions/${session.id}`}
            className="text-muted-foreground hover:text-foreground self-center text-xs"
          >
            {earlier} earlier {earlier === 1 ? 'message' : 'messages'}
          </Link>
        ) : null}
        {items(before)}
        {after.length ? (
          <div className="text-muted-foreground/80 flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" />
            where it stopped
            <span className="bg-border h-px flex-1" />
          </div>
        ) : null}
        {items(after)}
      </div>
    </section>
  )
}
