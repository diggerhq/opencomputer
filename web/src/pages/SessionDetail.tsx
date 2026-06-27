import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Send, Wrench } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getSession,
  getSessionEvents,
  sendMessage,
  cancelSession,
  archiveSession,
  type SessionEvent,
} from '@/api/client'
import { SessionEventSchema } from '@/api/schemas'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/form'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SessionWebhooks } from '@/components/session-webhooks'
import { MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

// body is unknown (inline JSON ≤32KB); pull the common shapes defensively.
function bodyText(ev: SessionEvent): string | null {
  const b = ev.body
  if (
    b &&
    typeof b === 'object' &&
    typeof (b as Record<string, unknown>).text === 'string'
  ) {
    return (b as Record<string, string>).text
  }
  return null
}
function toolSummary(ev: SessionEvent): string {
  const b = (ev.body ?? {}) as Record<string, unknown>
  const tool = typeof b.tool === 'string' ? b.tool : 'tool'
  const input = typeof b.input === 'string' ? b.input : ''
  return input ? `${tool} · ${input}` : tool
}
function humanizeType(t: string): string {
  return t.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

const LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'Conversation' },
] as const
type LevelFilter = (typeof LEVELS)[number]['value']

export default function SessionDetail() {
  const { sessionId = '' } = useParams()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [level, setLevel] = useState<LevelFilter>('all')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [liveEvents, setLiveEvents] = useState<SessionEvent[]>([])
  const [streamOk, setStreamOk] = useState(false)

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSession(sessionId),
    refetchInterval: 5000,
  })
  // Initial history, plus a polling fallback while the live stream is down.
  const { data: eventData } = useQuery({
    queryKey: ['session-events', sessionId],
    queryFn: () => getSessionEvents(sessionId),
    refetchInterval: streamOk ? false : 5000,
  })

  // Live events over SSE through the dashboard proxy (the proxy injects auth;
  // EventSource can't set headers). It replays history then streams live, and
  // auto-reconnects with Last-Event-ID. Skipped under the preview mock (no
  // backend) — the query renders there.
  useEffect(() => {
    if (!sessionId || import.meta.env.VITE_PREVIEW === '1') return
    const es = new EventSource(
      `/api/dashboard/v3/sessions/${sessionId}/events?stream=sse`,
      { withCredentials: true },
    )
    es.onopen = () => setStreamOk(true)
    es.onmessage = (e) => {
      let raw: unknown
      try {
        raw = JSON.parse(e.data as string)
      } catch {
        return
      }
      const parsed = SessionEventSchema.safeParse(raw)
      if (!parsed.success) return
      const ev = parsed.data
      setLiveEvents((prev) =>
        prev.some((x) => x.id === ev.id) ? prev : [...prev, ev],
      )
    }
    es.onerror = () => setStreamOk(false) // EventSource retries on its own
    return () => es.close()
  }, [sessionId])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
    void queryClient.invalidateQueries({
      queryKey: ['session-events', sessionId],
    })
  }

  const steerMutation = useMutation({
    mutationFn: () => sendMessage(sessionId, draft.trim()),
    onSuccess: () => {
      setDraft('')
      invalidate()
    },
    onError: (e) => notifyError("Couldn't send the message.", e),
  })
  const cancelMutation = useMutation({
    mutationFn: () => cancelSession(sessionId),
    onSettled: invalidate,
    onError: (e) => notifyError("Couldn't cancel the session.", e),
  })
  const archiveMutation = useMutation({
    mutationFn: () => archiveSession(sessionId),
    onSettled: invalidate,
    onError: (e) => notifyError("Couldn't archive the session.", e),
  })

  // History (query) ∪ this session's live SSE events, deduped by id, by seq.
  const allEvents = useMemo(() => {
    const byId = new Map<string, SessionEvent>()
    for (const e of eventData ?? []) byId.set(e.id, e)
    for (const e of liveEvents) {
      if (e.session && e.session !== sessionId) continue
      byId.set(e.id, e)
    }
    return [...byId.values()].sort((a, b) => a.seq - b.seq)
  }, [eventData, liveEvents, sessionId])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  const status = session?.status ?? 'unknown'
  const archived = status === 'archived'
  const canSteer = !archived
  const canCancel = status === 'running' || status === 'awaiting_input'

  const events =
    level === 'user' ? allEvents.filter((e) => e.level === 'user') : allEvents

  return (
    <div className="max-w-4xl">
      <Link
        to="/sessions"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="size-4" />
        Sessions
      </Link>

      {/* Header */}
      <Panel className="mb-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2.5">
              <code className="text-foreground font-mono text-sm">
                {sessionId}
              </code>
              <StatusBadge status={status} />
            </div>
            <p className="text-muted-foreground text-xs">
              {session?.head ?? 0} events · created{' '}
              {session?.created_at
                ? new Date(session.created_at).toLocaleString()
                : '—'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canCancel ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmCancel(true)}
              >
                Cancel run
              </Button>
            ) : null}
            {!archived ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-status-error"
                onClick={() => archiveMutation.mutate()}
                disabled={archiveMutation.isPending}
              >
                Archive
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* Event stream */}
      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Events</h2>
            {streamOk ? (
              <span className="text-status-running flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
                <span className="bg-status-running size-1.5 rounded-full" />
                Live
              </span>
            ) : null}
          </div>
          <div className="flex gap-1">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                onClick={() => setLevel(l.value)}
                className={cn(
                  'rounded-sm px-2 py-1 text-xs transition-colors',
                  level === l.value
                    ? 'bg-secondary text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {events.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No events yet"
            description="Events from the agent's turns will stream in here."
          />
        ) : (
          <ul className="divide-y">
            {events.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
          </ul>
        )}

        {/* Steer */}
        <div className="border-t p-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (draft.trim() && canSteer) steerMutation.mutate()
            }}
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                canSteer
                  ? 'Send a message to steer the session…'
                  : 'Session archived'
              }
              disabled={!canSteer}
              className="min-h-10 flex-1"
              rows={1}
            />
            <Button
              type="submit"
              disabled={!draft.trim() || !canSteer || steerMutation.isPending}
            >
              <Send className="size-4" />
              Send
            </Button>
          </form>
        </div>
      </Panel>

      <SessionWebhooks sessionId={sessionId} />

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        description="The current turn stops. You can steer the session again afterward."
        confirmLabel="Cancel run"
        destructive
        pending={cancelMutation.isPending}
        onConfirm={() =>
          cancelMutation.mutate(undefined, {
            onSuccess: () => setConfirmCancel(false),
          })
        }
      />
    </div>
  )
}

function EventRow({ ev }: { ev: SessionEvent }) {
  const text = bodyText(ev)

  // Conversation messages — the signal.
  if (ev.type === 'user.message' || ev.type === 'agent.message') {
    const isUser = ev.type === 'user.message'
    return (
      <li className="px-4 py-3">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-foreground text-xs font-semibold">
            {ev.actor?.display ?? (isUser ? 'You' : 'Agent')}
          </span>
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            #{ev.seq}
          </span>
        </div>
        <p className="text-foreground/90 text-sm whitespace-pre-wrap">{text}</p>
      </li>
    )
  }

  // Tool calls — compact mono.
  if (ev.type === 'tool.call') {
    return (
      <li className="text-muted-foreground flex items-center gap-2 px-4 py-1.5 font-mono text-xs">
        <Wrench className="size-3.5 shrink-0 opacity-60" />
        <span className="truncate">{toolSummary(ev)}</span>
      </li>
    )
  }

  // Errors.
  if (ev.type.startsWith('error')) {
    return (
      <li className="bg-status-error-bg/40 text-status-error px-4 py-2 text-xs">
        {text ?? humanizeType(ev.type)}
      </li>
    )
  }

  // Turn markers + everything else — quiet context line.
  return (
    <li className="text-muted-foreground flex items-center gap-2 px-4 py-1.5 text-xs">
      <span className="bg-border h-px w-4 shrink-0" />
      {humanizeType(ev.type)}
      {ev.type === 'turn.completed' &&
      ev.body &&
      typeof (ev.body as Record<string, unknown>).yield_reason === 'string'
        ? ` · ${humanizeType(String((ev.body as Record<string, unknown>).yield_reason))}`
        : ''}
    </li>
  )
}
