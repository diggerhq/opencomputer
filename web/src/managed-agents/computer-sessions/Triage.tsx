import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Loader2 } from 'lucide-react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  bringBack,
  getEvents,
  sendTurn,
  sessionKeys,
  setAside,
  type Session,
} from '../computer-sessions-api'
import { Item } from './conversation'
import { useMemberEmails } from './members'
import { AskCard, StatusDot } from './parts'
import { sessionLine, sessionTitle, useCapabilities } from './state'
import { TRIAGE_NEEDS, useTriage, type TriageEntry } from './triage'
import { buildTranscript, timeAgo } from './transcript'

// Triage (work-tracking ux-spec 3): one ask at a time, answer, next. The ask
// on screen is `?ask=<id>`; nothing replaces it while it is shown.

const WORKING_ROWS = 5
// Asks the agent put as a dialog, answered with AskCard's buttons.
const DIALOGS = new Set(['approval', 'question', 'secret'])

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

  const answered = (ref: string) => {
    setDone((d) => new Set(d).add(ref))
    setDrafts((d) => {
      const rest = { ...d }
      delete rest[ref]
      return rest
    })
    go(next(ref))
  }
  const refetch = () =>
    qc.refetchQueries({ queryKey: sessionKeys.list(TRIAGE_NEEDS) })

  return (
    <div className="flex h-full">
      <aside className="border-border hidden w-80 shrink-0 flex-col overflow-y-auto border-r md:flex">
        <Section label="Needs you" count={loaded ? open.length : undefined}>
          {loaded && !open.length ? (
            <p className="text-muted-foreground px-3 py-1 text-sm">
              Nothing right now.
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
            draft={drafts[entry.ref] ?? ''}
            setDraft={(text) => setDrafts((d) => ({ ...d, [entry.ref]: text }))}
            onAnswered={() => answered(entry.ref)}
            onAside={async () => {
              await refetch()
              go(next(entry.ref))
            }}
            onBack={() => void refetch()}
            onNext={() => go(next(entry.ref))}
          />
        ) : loaded ? (
          <AllClear
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
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="border-border space-y-0.5 border-b px-2 py-4 last:border-b-0">
      <h2 className="flex items-baseline gap-2 px-3 pb-1.5 text-sm font-medium">
        {label}
        {count !== undefined ? (
          <span className="text-muted-foreground text-xs font-normal">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  )
}

function AskRow({
  entry,
  current,
  onClick,
}: {
  entry: TriageEntry
  current: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'hover:bg-muted/60 flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-left',
        current && 'bg-muted',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{entry.line}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {sessionTitle(entry.session)}
        </span>
      </span>
      <span className="text-muted-foreground shrink-0 pt-0.5 text-xs">
        {timeAgo(entry.at)}
      </span>
    </button>
  )
}

function WorkingRow({ session }: { session: Session }) {
  const line = sessionLine(session)
  return (
    <Link
      to={`/computer/sessions/${session.id}`}
      className="hover:bg-muted/60 flex items-start gap-2 rounded-md px-3 py-1.5"
    >
      <StatusDot status={session.status} className="mt-1.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{sessionTitle(session)}</span>
        {line ? (
          <span className="text-muted-foreground block truncate text-xs">
            {line}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

function AllClear({
  working,
  aside,
  onAside,
}: {
  working: number
  aside: number
  onAside: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">All clear</h1>
      {aside ? (
        <Button variant="outline" size="sm" onClick={onAside}>
          {aside} set aside
        </Button>
      ) : working ? (
        <p className="text-muted-foreground max-w-sm text-sm">
          {working} {working === 1 ? 'agent is' : 'agents are'} working. The
          next one that needs you appears here.
        </p>
      ) : null}
    </div>
  )
}

function AskView({
  entry,
  gone,
  draft,
  setDraft,
  onAnswered,
  onAside,
  onBack,
  onNext,
}: {
  entry: TriageEntry
  gone: boolean
  draft: string
  setDraft: (text: string) => void
  onAnswered: () => void
  onAside: () => Promise<void>
  onBack: () => void
  onNext: () => void
}) {
  const { session: s, ask } = entry
  const { data: caps } = useCapabilities()
  // Focus in the box when the ask appears.
  const answer = useRef<HTMLDivElement>(null)
  useEffect(() => answer.current?.querySelector('textarea')?.focus(), [])

  // A reply is the answer: steering closes the open asks with the message
  // (turns, "Open asks close as declined; the message is the answer"). Once
  // the ask is gone, the text goes as an ordinary message.
  const send = useMutation({
    mutationFn: (text: string) =>
      sendTurn(
        s.id,
        text,
        !gone && caps?.features.steer !== false ? 'steer' : 'queue',
      ),
    onSuccess: () => (gone ? setDraft('') : onAnswered()),
  })
  const aside = useMutation({
    mutationFn: () =>
      entry.aside ? bringBack(s.id) : setAside(s.id, entry.ref),
    onSuccess: () => (entry.aside ? onBack() : onAside()),
    onError: (e) =>
      notifyError(
        entry.aside ? 'Could not bring it back' : 'Could not set it aside',
        e,
      ),
  })
  const submit = () => {
    if (draft.trim() && !send.isPending) send.mutate(draft.trim())
  }
  const dialog = !gone && DIALOGS.has(ask.kind)

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-6 pt-8 pb-5">
      <header className="shrink-0 space-y-1 pb-4">
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate">{sessionTitle(s)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{timeAgo(entry.at)} ago</span>
        </p>
        <h1 className="text-xl font-semibold tracking-tight">{entry.line}</h1>
      </header>

      <Conversation session={s} turnId={ask.turnId} />

      <div ref={answer} className="shrink-0 space-y-2 pt-4">
        {gone ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              This was answered elsewhere.
            </span>
            <Button size="sm" onClick={onNext}>
              Next
            </Button>
          </div>
        ) : dialog ? (
          <AskCard ask={ask} session={s} hideTitle onAnswered={onAnswered} />
        ) : null}
        <div className="bg-card focus-within:border-ring/60 rounded-xl border shadow-sm transition-colors">
          <ChatTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onSend={submit}
            placeholder={gone ? 'Message the agent' : 'Reply'}
            aria-label="Reply"
            className="min-h-11 resize-none border-0 bg-transparent px-4 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
            {send.isError ? (
              <p
                role="alert"
                className="text-destructive mr-auto flex items-center gap-2 px-2 text-xs"
              >
                Not sent
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={submit}
                >
                  Retry
                </button>
              </p>
            ) : null}
            {gone ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={aside.isPending}
                onClick={() => aside.mutate()}
              >
                {entry.aside ? 'Bring back' : 'Set aside'}
              </Button>
            )}
            <Button
              size="icon"
              className="rounded-full"
              aria-label="Send"
              disabled={!draft.trim() || send.isPending}
              onClick={submit}
            >
              {send.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <ArrowUp aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const TAIL_TURNS = 3

// The excerpt: a link to the earlier messages, then the last turns, with a
// rule where the asking turn starts.
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

  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [before.length, after.length])

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
      className="flex min-h-0 flex-1 flex-col rounded-xl border"
    >
      <div className="border-border flex h-10 shrink-0 items-center justify-between gap-3 border-b px-4 text-xs">
        <span className="font-medium">Conversation</span>
        <Link
          to={`/computer/sessions/${session.id}`}
          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          Open the session
        </Link>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-5 px-5 py-4">
          {earlier ? (
            <Link
              to={`/computer/sessions/${session.id}`}
              className="text-muted-foreground hover:text-foreground block text-center text-xs"
            >
              {earlier} earlier {earlier === 1 ? 'message' : 'messages'}
            </Link>
          ) : null}
          {items(before)}
          {after.length ? (
            <div className="text-muted-foreground flex items-center gap-3 text-xs">
              <span className="bg-border h-px flex-1" />
              where it stopped
              <span className="bg-border h-px flex-1" />
            </div>
          ) : null}
          {items(after)}
        </div>
      </div>
    </section>
  )
}
