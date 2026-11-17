import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  Square,
  X,
  User,
} from 'lucide-react'
import { ApiError, getOrgMembers } from '@/api/client'
import type { OrgMember } from '@/api/schemas'
import { ChatTextarea } from '@/components/chat-textarea'
import { SlackMark } from '@/components/slack-mark'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { AgentMarkdown } from '../AgentMarkdown'
import {
  getEvents,
  getSession,
  interruptSession,
  sendTurn,
  sessionKeys,
  updateSession,
  type IfBusy,
  type SessionEvent,
  type SessionSettings,
} from '../computer-sessions-api'
import { AskCard, OpenComputerMark, SettingsPickers, StatusDot } from './parts'
import {
  askTitle,
  isBusy,
  markSeen,
  sessionTitle,
  statusLabel,
  useCapabilities,
} from './state'
import {
  buildTranscript,
  formatDuration,
  mergeEvents,
  type TranscriptItem,
} from './transcript'

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
  return <SessionPage key={id} id={id} />
}

function SessionPage({ id }: { id: string }) {
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

  if (session.error instanceof ApiError && session.error.status === 404) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
        <p>This session does not exist or is not shared with you.</p>
        <Link to="/computer/sessions" className="text-primary hover:underline">
          Start a new session
        </Link>
      </div>
    )
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
      </div>
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

// Members' emails by member id (`usr_…`). The computer derives that id from the
// user id: the WorkOS id when there is one, else a hash (`memberId` in managed-agents).
async function memberEmails(
  members: OrgMember[],
): Promise<Map<string, string>> {
  const emails = new Map<string, string>()
  for (const m of members) {
    const workos = /^user_(\w+)$/.exec(m.workosUserId ?? '')
    if (workos) emails.set(`usr_${workos[1].toLowerCase()}`, m.email)
    if (!m.id) continue
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.id)),
    )
    const hex = [...digest.slice(0, 13)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    emails.set(`usr_x${hex}`, m.email)
  }
  return emails
}

function useMemberEmails(): Map<string, string> | undefined {
  const { data: members } = useQuery({
    queryKey: ['org-members'],
    queryFn: getOrgMembers,
    staleTime: 5 * 60_000,
  })
  const { data } = useQuery({
    queryKey: ['org-members', 'emails', members],
    queryFn: () => memberEmails(members ?? []),
    enabled: !!members,
    staleTime: Infinity,
  })
  return data
}

// A person's avatar: initials of their name, or the first letter of their email.
function initials(author: string): string {
  if (author.includes('@')) return author[0].toUpperCase()
  const words = author.trim().split(/\s+/)
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

function Item({
  item,
  leads,
  emails,
}: {
  item: TranscriptItem
  leads: boolean
  emails: Map<string, string> | undefined
}) {
  switch (item.kind) {
    case 'user': {
      const email = item.authorId ? emails?.get(item.authorId) : undefined
      return (
        <div className="flex items-end justify-end gap-2">
          <div className="flex max-w-[85%] flex-col items-end gap-1">
            {item.author || email ? (
              <span className="text-muted-foreground text-xs">
                {item.author ?? email}
                {item.via && item.via !== 'dashboard' ? ` via ${item.via}` : ''}
              </span>
            ) : null}
            <div className="bg-secondary rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap">
              {item.text}
            </div>
          </div>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium">
                  {item.author || email ? (
                    initials(item.author ?? email ?? '')
                  ) : (
                    <User className="size-3.5" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">
                {item.author ?? email ?? 'Someone'}
                {email && item.author && email !== item.author ? (
                  <span className="block opacity-70">{email}</span>
                ) : null}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )
    }
    case 'agent':
      return (
        <div className="space-y-2">
          {leads ? <AgentByline /> : null}
          <AgentMarkdown>{item.text}</AgentMarkdown>
        </div>
      )
    case 'work':
      return (
        <div className="space-y-2">
          {leads ? <AgentByline /> : null}
          <WorkStep item={item} />
        </div>
      )
    case 'ask':
      // Open asks are answered at the end of the transcript.
      if (item.ask.status === 'open') return null
      return (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {item.ask.status === 'answered' ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <X className="size-3.5" aria-hidden />
          )}
          {askTitle(item.ask)} · {item.ask.status}
        </p>
      )
    case 'note':
      return (
        <p
          className={cn(
            'flex items-center gap-1.5 text-xs',
            item.tone === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {item.tone === 'error' ? (
            <CircleAlert className="size-3.5" aria-hidden />
          ) : null}
          {item.text}
        </p>
      )
  }
}

function WorkStep({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'work' }>
}) {
  const [open, setOpen] = useState(false)
  const ms =
    new Date(item.endedAt).getTime() - new Date(item.startedAt).getTime()
  const failed = item.tools.filter((t) => t.status === 'failed').length
  const label = item.open
    ? `Working · ${item.tools.length} ${item.tools.length === 1 ? 'step' : 'steps'}`
    : `Worked for ${formatDuration(ms)}`
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        {label}
        {failed ? (
          <span className="text-destructive">· {failed} failed</span>
        ) : null}
      </button>
      {open && item.tools.length ? (
        <ul className="border-border mt-1.5 ml-1.5 space-y-0.5 border-l pl-3">
          {item.tools.map((t) => (
            <li
              key={t.callId}
              className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs"
            >
              {t.status === 'running' ? (
                <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              ) : t.status === 'failed' ? (
                <X className="text-destructive size-3 shrink-0" aria-hidden />
              ) : (
                <Check className="size-3 shrink-0 opacity-60" aria-hidden />
              )}
              <span className="truncate">{t.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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

function AgentByline() {
  return (
    <div className="flex items-center gap-2 text-xs font-medium">
      <OpenComputerMark className="size-6" />
      Computer
    </div>
  )
}
