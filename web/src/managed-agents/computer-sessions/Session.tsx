import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Loader2,
  Lock,
  Square,
} from 'lucide-react'
import { ApiError } from '@/api/client'
import { ChatTextarea } from '@/components/chat-textarea'
import { SlackMark } from '@/components/slack-mark'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  getEvents,
  getSession,
  interruptSession,
  sendTurn,
  sessionKeys,
  updateSession,
  updateSessionAccess,
  type AccessInput,
  type IfBusy,
  type Session,
  type SessionEvent,
  type SessionSettings,
} from '../computer-sessions-api'
import { explainAccessError, withPerson } from './access'
import { AccessPicker } from './AccessPicker'
import { Item } from './conversation'
import { useMemberEmails, useMyMemberId, useOrgPeople } from './members'
import { SessionWork } from '../work/SessionWork'
import { AskCard, SettingsPickers, StatusDot } from './parts'
import {
  isBusy,
  markSeen,
  sessionTitle,
  statusLabel,
  useCapabilities,
} from './state'
import { buildTranscript, mergeEvents } from './transcript'

// Events that change what the session row says (status, asks, title).
const SESSION_EVENTS = /^(session\.|turn\.|ask\.|runtime\.)/

// Loads the last turns, then follows the journal by long-polling
// `GET /events?after&waitMs`. Cookie logins cannot mint a WebSocket ticket yet.
function useSessionEvents(id: string, onSessionEvent: () => void) {
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const notify = useRef(onSessionEvent)
  useEffect(() => {
    notify.current = onSessionEvent
  })

  // The page is keyed by session, so this runs once per session.
  useEffect(() => {
    const ctl = new AbortController()
    let cursor: number | undefined
    const run = async () => {
      while (!ctl.signal.aborted) {
        try {
          const page =
            cursor === undefined
              ? await getEvents(id, { tailTurns: 20 }, ctl.signal)
              : await getEvents(
                  id,
                  { after: cursor, limit: 500, waitMs: 25_000 },
                  ctl.signal,
                )
          if (ctl.signal.aborted) return
          cursor =
            page.hasMore && page.events.length
              ? page.events[page.events.length - 1].seq
              : page.lastSeq
          if (page.events.length) {
            setEvents((have) => mergeEvents(have, page.events))
            if (page.events.some((e) => SESSION_EVENTS.test(e.type)))
              notify.current()
          }
          setLoaded(true)
        } catch (e) {
          if (ctl.signal.aborted) return
          // The journal moved to a new epoch: start over from its tail.
          if (e instanceof ApiError && e.status === 409) {
            cursor = undefined
            setEvents([])
            continue
          }
          // Gone, or not shared with the caller: nothing to follow.
          if (e instanceof ApiError && e.status === 404) {
            setLoaded(true)
            return
          }
          await new Promise((r) => setTimeout(r, 3_000))
        }
      }
    }
    void run()
    return () => ctl.abort()
  }, [id])

  return { events, loaded }
}

export default function ComputerSession() {
  const { id = '' } = useParams()
  // Getting into a session starts its page over, events and all.
  const [entered, setEntered] = useState(0)
  return (
    <SessionPage
      key={`${id}:${entered}`}
      id={id}
      onEntered={() => setEntered((n) => n + 1)}
    />
  )
}

function SessionPage({ id, onEntered }: { id: string; onEntered: () => void }) {
  const qc = useQueryClient()
  const session = useQuery({
    queryKey: sessionKeys.one(id),
    queryFn: () => getSession(id),
    refetchInterval: 15_000,
  })
  const { events, loaded } = useSessionEvents(id, () => {
    void qc.invalidateQueries({ queryKey: sessionKeys.all })
  })
  const items = useMemo(() => buildTranscript(events), [events])
  const s = session.data
  const emails = useMemberEmails()

  // Reading the session marks it read up to what was shown.
  const lastSeq = events[events.length - 1]?.seq
  useEffect(() => {
    if (lastSeq !== undefined) markSeen(id, lastSeq)
    else if (s) markSeen(id, s.lastSeq)
  }, [id, lastSeq, s])

  // Stick to the bottom while the reader is there.
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items.length, events.length, s?.asks.length])

  // Gone, or not shared with the caller: the API doesn't say which (CTO-37).
  if (session.error instanceof ApiError && session.error.status === 404) {
    return <NotFound id={id} onEntered={onEntered} />
  }

  const openAsks = s?.asks.filter((a) => a.status === 'open') ?? []
  return (
    <div className="flex h-full flex-col">
      <Header id={id} />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
          {!loaded ? (
            <Loader2 className="text-muted-foreground mx-auto size-5 animate-spin" />
          ) : items.length === 0 ? (
            <p className="text-muted-foreground text-center text-sm">
              Nothing here yet.
            </p>
          ) : (
            items.map((item, i) => (
              <Item
                key={item.key}
                item={item}
                emails={emails}
                // A reply opens with who is speaking: the first agent item after a person's message.
                leads={i === 0 || items[i - 1].kind === 'user'}
              />
            ))
          )}
          {s && isBusy(s.status) && !openAsks.length ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {s.status === 'starting' ? 'Starting the computer…' : 'Working…'}
            </p>
          ) : null}
          {s
            ? openAsks.map((ask) => (
                <AskCard key={ask.id} ask={ask} session={s} />
              ))
            : null}
        </div>
      </div>
      <Composer id={id} />
    </div>
  )
}

function useUpdateAccess(id: string) {
  const qc = useQueryClient()
  const people = useOrgPeople()
  const nameOf = (pid: string) => {
    const p = people?.find((x) => x.ids.includes(pid))
    return p ? p.name || p.email : undefined
  }
  return useMutation({
    mutationFn: (access: AccessInput) => updateSessionAccess(id, access),
    onSuccess: (r) => {
      if (r.session) qc.setQueryData(sessionKeys.one(id), r.session)
      void qc.invalidateQueries({ queryKey: sessionKeys.all })
    },
    onError: (e) =>
      notifyError(
        'Could not change who has access',
        explainAccessError(e, nameOf),
      ),
  })
}

// Who can see and drive the session. The owner, the people it is shared with
// and org admins change it (`canManageAccess`); anyone else only sees it.
function SessionAccess({ session: s }: { session: Session }) {
  const me = useMyMemberId()
  const update = useUpdateAccess(s.id)
  if (!s.access) return null
  const isOwner = !!me && s.owner?.id === me
  return (
    <AccessPicker
      value={s.access}
      isOwner={isOwner}
      ownerIds={s.owner?.id ? [s.owner.id] : []}
      onSave={(next) => update.mutateAsync(next)}
      pending={update.isPending}
      disabled={!s.canManageAccess}
      className="shrink-0 disabled:opacity-100"
    />
  )
}

// A session that isn't there for the caller. The API answers the same for one
// that doesn't exist and one not shared with them, so nothing leaks. An org
// admin may still change who has access by id, without seeing it (Q4): the
// current access is hidden until a change answers with it, and including
// themselves lets them in.
function NotFound({ id, onEntered }: { id: string; onEntered: () => void }) {
  const me = useMyMemberId()
  const people = useOrgPeople()
  const update = useUpdateAccess(id)
  const [known, setKnown] = useState<AccessInput | null>(null)
  const admin = !!me && !!people?.find((p) => p.ids.includes(me))?.admin
  const change = async (next: AccessInput) => {
    const r = await update.mutateAsync(next)
    if (r.session) onEntered()
    else if (r.access) setKnown(r.access)
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm">
      {admin ? (
        <Lock className="text-muted-foreground size-5" aria-hidden />
      ) : null}
      <p className={admin ? 'font-medium' : 'text-muted-foreground'}>
        This session does not exist or is not shared with you.
      </p>
      {admin ? (
        <>
          <p className="text-muted-foreground max-w-sm">
            As an admin you can change who has access to it without seeing it.
            To open it, include yourself: you would drive it with its owner's
            secrets and subscription.
          </p>
          <div className="flex items-center gap-2">
            <AccessPicker
              value={known ?? { mode: 'owner' }}
              unknown={!known}
              isOwner={false}
              onSave={change}
              pending={update.isPending}
            />
            {known && me && known.mode !== 'org' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() =>
                  void change(withPerson(known, me)).catch(() => {})
                }
              >
                Add me
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <Link to="/computer/sessions" className="text-primary hover:underline">
        Start a new session
      </Link>
    </div>
  )
}

function Header({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: s } = useQuery({
    queryKey: sessionKeys.one(id),
    queryFn: () => getSession(id),
  })
  const archive = useMutation({
    mutationFn: (archived: boolean) => updateSession(id, { archived }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sessionKeys.all }),
    onError: (e) => notifyError('Could not update the session', e),
  })
  const slackUrl = s?.origin.slack?.url
  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-sm font-medium">
          {s ? sessionTitle(s) : ''}
        </h1>
        {s ? (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <StatusDot status={s.status} />
            {statusLabel(s.status)}
          </span>
        ) : null}
        {s?.owner?.name ? (
          <span className="text-muted-foreground hidden truncate text-xs md:inline">
            · {s.owner.name}
          </span>
        ) : null}
        <SessionWork id={id} />
      </div>
      {s ? <SessionAccess session={s} /> : null}
      {slackUrl ? (
        <Button asChild size="sm" variant="ghost">
          <a href={slackUrl} target="_blank" rel="noreferrer">
            <SlackMark className="size-3.5" />
            Open in Slack
          </a>
        </Button>
      ) : null}
      {s ? (
        <Button
          size="icon-sm"
          variant="ghost"
          title={s.archived ? 'Unarchive' : 'Archive'}
          aria-label={s.archived ? 'Unarchive' : 'Archive'}
          disabled={archive.isPending}
          onClick={() => archive.mutate(!s.archived)}
        >
          {s.archived ? <ArchiveRestore /> : <Archive />}
        </Button>
      ) : null}
    </header>
  )
}

function Composer({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: s } = useQuery({
    queryKey: sessionKeys.one(id),
    queryFn: () => getSession(id),
  })
  const { data: caps } = useCapabilities()
  const [input, setInput] = useState('')
  const [ifBusy, setIfBusy] = useState<IfBusy>('steer')
  const busy = !!s && isBusy(s.status)
  const canSteer = caps?.features.steer !== false
  const send = useMutation({
    mutationFn: () =>
      sendTurn(id, input.trim(), busy && canSteer ? ifBusy : 'queue'),
    onSuccess: () => {
      setInput('')
      void qc.invalidateQueries({ queryKey: sessionKeys.all })
    },
    onError: (e) => notifyError('Could not send', e),
  })
  const stop = useMutation({
    mutationFn: () => interruptSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sessionKeys.all }),
    onError: (e) => notifyError('Could not stop', e),
  })
  const settings = useMutation({
    mutationFn: (next: SessionSettings) => updateSession(id, next),
    onSuccess: (session) => qc.setQueryData(sessionKeys.one(id), session),
    onError: (e) => notifyError('Could not change the settings', e),
  })
  const submit = () => {
    if (input.trim() && !send.isPending) send.mutate()
  }
  const slack = s?.origin.type === 'slack'

  return (
    <div className="shrink-0 px-6 pb-5">
      <div className="bg-card focus-within:border-ring/60 mx-auto max-w-3xl rounded-xl border shadow-sm transition-colors">
        <ChatTextarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSend={submit}
          placeholder={
            busy
              ? ifBusy === 'steer'
                ? 'Steer: tell Computer what to change now'
                : 'Queue a message for when this turn ends'
              : 'Reply to Computer'
          }
          className="min-h-11 resize-none border-0 bg-transparent px-4 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          {s && !slack ? (
            <SettingsPickers
              value={{
                model: s.settings.model ?? undefined,
                effort: s.settings.effort ?? undefined,
                mode: s.settings.mode ?? undefined,
              }}
              onChange={(next) => settings.mutate(next)}
              disabled={settings.isPending}
            />
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1.5">
            {busy && canSteer ? (
              <div className="bg-muted flex rounded-md p-0.5 text-xs">
                {(['steer', 'queue'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setIfBusy(m)}
                    className={cn(
                      'rounded px-2 py-0.5 capitalize',
                      ifBusy === m
                        ? 'bg-background text-foreground shadow-xs'
                        : 'text-muted-foreground',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            ) : null}
            {busy ? (
              <Button
                size="icon"
                variant="outline"
                className="rounded-full"
                aria-label="Stop"
                title="Stop"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
              >
                <Square className="size-3 fill-current" aria-hidden />
              </Button>
            ) : null}
            <Button
              size="icon"
              className="rounded-full"
              aria-label="Send"
              disabled={!input.trim() || send.isPending}
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
