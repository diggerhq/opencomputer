import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Send,
  Wrench,
  CircleAlert,
  Brain,
  CheckCircle2,
  XCircle,
  Sparkles,
} from 'lucide-react'
import { GuidedTour, type GuideStep } from '@/components/guided-tour'
import { notifyError } from '@/lib/errors'
import { useHalted } from '@/hooks/useHalted'
import {
  getSession,
  getSessionSources,
  getSessionEvents,
  sendMessage,
  cancelSession,
  archiveSession,
  ApiError,
  type SessionEvent,
  type SessionSource,
} from '@/api/client'
import { SessionEventSchema } from '@/api/schemas'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { ChatTextarea } from '@/components/chat-textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { RuntimeBadge } from '@/components/runtime-badge'
import { MetricCard } from '@/components/metric-card'
import { SessionTurns } from '@/components/session-turns'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SessionWebhooks } from '@/components/session-webhooks'
import { ApiHint } from '@/components/api-hint'
import { MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GithubMark } from '@/components/github-mark'
import { formatSpend, usageTokens } from '@/lib/usage'
import {
  MessageBubble,
  TurnConversation,
} from '@/components/session-conversation'
import {
  bodyText,
  groupIntoTurns,
  isOutOfCredits,
  isTurnInput,
} from '@/lib/session-turns'
import { sessionSourcesRefetchInterval } from '@/lib/session-source-polling'

function toolSummary(ev: SessionEvent): string {
  const b = (ev.body ?? {}) as Record<string, unknown>
  const tool = typeof b.tool === 'string' ? b.tool : 'tool'
  const input = typeof b.input === 'string' ? b.input : ''
  return input ? `${tool} · ${input}` : tool
}
// A tool RESULT — brain-box emits `exec.completed`, the flue tailer emits `tool.result`;
// both land here so flue + brain-box render identically.
function isToolResult(ev: SessionEvent): boolean {
  return ev.type === 'exec.completed' || ev.type === 'tool.result'
}
function toolResult(ev: SessionEvent): { text: string; isError: boolean } {
  const b = (ev.body ?? {}) as Record<string, unknown>
  const tool = typeof b.tool === 'string' ? b.tool : 'tool'
  const isError = b.is_error === true || b.error != null
  const summary =
    (typeof b.summary === 'string' && b.summary) ||
    (typeof b.output === 'string' && b.output) ||
    (typeof b.text === 'string' && b.text) ||
    ''
  const dur = typeof b.duration_ms === 'number' ? ` · ${b.duration_ms}ms` : ''
  return {
    text: summary ? `${tool} → ${summary}${dur}` : `${tool} →${dur}`,
    isError,
  }
}
// The body spilled to blob storage (event > 32KB) — surface an affordance instead of
// rendering an empty bubble.
function truncationNote(ev: SessionEvent): string | null {
  if (!ev.body_truncated && !ev.content_ref) return null
  const kb = ev.body_bytes ? ` (${Math.round(ev.body_bytes / 1024)} KB)` : ''
  return `Output too large to inline${kb} — stored in blob`
}
function humanizeType(t: string): string {
  return t.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function turnCompletionLabel(ev: SessionEvent): string | null {
  if (ev.type !== 'turn.completed' || !ev.body) return null
  const body = ev.body as Record<string, unknown>
  if (typeof body.outcome === 'string') return humanizeType(body.outcome)
  if (typeof body.yield_reason === 'string') {
    return humanizeType(body.yield_reason)
  }
  return null
}

interface TurnStartInfo {
  from: number | null
  to: number | null
  preview: string | null
}

const LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'Conversation' },
] as const
type LevelFilter = (typeof LEVELS)[number]['value']

export default function SessionDetail() {
  const { sessionId = '' } = useParams()
  const queryClient = useQueryClient()
  const halted = useHalted() // top-level: must run before any early return (Rules of Hooks)
  const [draft, setDraft] = useState('')
  const [level, setLevel] = useState<LevelFilter>('user')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [liveStream, setLiveStream] = useState<{
    sessionId: string
    events: SessionEvent[]
    connected: boolean
  }>(() => ({ sessionId, events: [], connected: false }))
  const streamOk = liveStream.sessionId === sessionId && liveStream.connected

  // Guided first-run overlay: the chip launch passes { guide: 'agent' } via nav
  // state; the "How it works" button reopens it any time. Anchors point at the
  // real regions below (header / event stream / composer).
  const location = useLocation()
  const headerRef = useRef<HTMLDivElement>(null)
  const eventsRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const [guideOpen, setGuideOpen] = useState(
    () => (location.state as { guide?: string } | null)?.guide === 'agent',
  )
  const guideSteps: GuideStep[] = useMemo(
    () => [
      {
        target: headerRef,
        title: 'This session came from two API calls',
        body: 'Clicking the example created a managed agent, then started a session on it — the dashboard just called the public API on your behalf.',
        api: 'POST /v3/agents · POST /v3/sessions',
        code: [
          {
            label: 'SDK',
            code: `import { OpenComputer } from "@opencomputer/sdk";
const oc = new OpenComputer({ apiKey: process.env.OPENCOMPUTER_API_KEY });

const agent = await oc.agents.create({
  runtime: "claude",
  model: "anthropic/claude-opus-4-8",
  credential: "managed",
});

const session = await oc.sessions.create({
  agent: agent.id,
  input: "Give me a quick tour of this sandbox.",
});`,
          },
          {
            label: 'CLI',
            code: `oc agent create my-agent \\
  --runtime claude --model anthropic/claude-opus-4-8 --credential managed

oc session create --agent my-agent \\
  --input "Give me a quick tour of this sandbox."`,
          },
          {
            label: 'API',
            code: `# 1. Create a managed agent
curl -X POST https://api.opencomputer.dev/v3/agents \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"runtime":"claude","model":"anthropic/claude-opus-4-8","credential":"managed"}'

# 2. Start a session on that agent
curl -X POST https://api.opencomputer.dev/v3/sessions \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent":"agt_...","input":"Give me a quick tour of this sandbox."}'`,
          },
        ],
        docs: 'https://docs.opencomputer.dev/agent-sessions/quickstart',
      },
      {
        target: eventsRef,
        title: "This is the session's live event log",
        body: 'Every turn the agent takes streams here over SSE — the same feed you consume in code, no polling.',
        api: 'GET /v3/sessions/:id/events',
        code: [
          {
            label: 'SDK',
            code: `// session is the handle returned by oc.sessions.create()
for await (const event of session.events()) {
  console.log(event.type, event.body);
}`,
          },
          { label: 'CLI', code: `oc session logs $SESSION_ID` },
          {
            label: 'API',
            code: `curl -N https://api.opencomputer.dev/v3/sessions/$SESSION_ID/events?stream=sse \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY"
# server-sent events stream: one event per line`,
          },
        ],
        docs: 'https://docs.opencomputer.dev/agent-sessions/sessions',
      },
      {
        target: composerRef,
        title: 'Steer it from here',
        body: 'Sending a message posts more input to the same session — the agent picks it up on its next turn.',
        api: 'POST /v3/sessions/:id/messages',
        code: [
          {
            label: 'SDK',
            code: `await session.steer("Also add a dark mode toggle.");`,
          },
          {
            label: 'CLI',
            code: `oc session steer $SESSION_ID "Also add a dark mode toggle."`,
          },
          {
            label: 'API',
            code: `curl -X POST https://api.opencomputer.dev/v3/sessions/$SESSION_ID/messages \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Also add a dark mode toggle."}'`,
          },
        ],
        docs: 'https://docs.opencomputer.dev/agent-sessions/messaging',
      },
    ],
    [],
  )

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
  const sourcesQuery = useQuery({
    queryKey: ['session-sources', sessionId],
    queryFn: () => getSessionSources(sessionId),
    staleTime: 15_000,
    refetchInterval: (query) => sessionSourcesRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
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
    es.onopen = () =>
      setLiveStream((prev) => ({
        sessionId,
        events: prev.sessionId === sessionId ? prev.events : [],
        connected: true,
      }))
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
      setLiveStream((prev) => {
        const events = prev.sessionId === sessionId ? prev.events : []
        return {
          sessionId,
          connected: prev.sessionId === sessionId && prev.connected,
          // Cap the in-memory live buffer (older events remain in query history).
          events: events.some((x) => x.id === ev.id)
            ? events
            : [...events, ev].slice(-2000),
        }
      })
    }
    es.onerror = () =>
      setLiveStream((prev) =>
        prev.sessionId === sessionId ? { ...prev, connected: false } : prev,
      ) // EventSource retries on its own
    return () => es.close()
  }, [sessionId])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
    void queryClient.invalidateQueries({
      queryKey: ['session-events', sessionId],
    })
  }

  const steerMutation = useMutation({
    mutationFn: () => sendMessage(sessionId, draft.trim(), crypto.randomUUID()),
    onSuccess: () => {
      setDraft('')
      invalidate()
    },
    onError: (e) => {
      // Race/stale-state fallback: if the server refused on credits, refresh the halt
      // state so the banner + composer gating appear at once (don't wait for the poll).
      if (e instanceof ApiError && e.type === 'insufficient_credits') {
        void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
      }
      notifyError("Couldn't send the message.", e)
    },
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
    const liveEvents =
      liveStream.sessionId === sessionId ? liveStream.events : []
    const byId = new Map<string, SessionEvent>()
    for (const e of eventData ?? []) byId.set(e.id, e)
    for (const e of liveEvents) {
      if (e.session && e.session !== sessionId) continue
      byId.set(e.id, e)
    }
    const sorted = [...byId.values()].sort((a, b) => a.seq - b.seq)
    // Collapse the safety-net twin: the runtime emits a turn's final assistant text as
    // BOTH agent.message@progress (streamed) and agent.message@user (the answer), so it
    // would render twice in the "all" view. Drop the @progress copy when an identical-text
    // @user message exists in the same turn.
    const userAnswers = new Set(
      sorted
        .filter((e) => e.type === 'agent.message' && e.level === 'user')
        .map((e) => `${e.turn_id ?? ''} ${bodyText(e) ?? ''}`),
    )
    return sorted.filter(
      (e) =>
        !(
          e.type === 'agent.message' &&
          e.level === 'progress' &&
          bodyText(e) &&
          userAnswers.has(`${e.turn_id ?? ''} ${bodyText(e) ?? ''}`)
        ),
    )
  }, [eventData, liveStream, sessionId])

  // Group the (unfiltered) stream by turn: turn.started is level:progress, so it
  // must be read from allEvents, never the level==='user' filter.
  const grouped = useMemo(() => groupIntoTurns(allEvents), [allEvents])
  // Inputs whose neutral turn has not crossed the durable start boundary.
  const pendingSeqs = useMemo(
    () =>
      new Set([
        ...grouped.pending.map((event) => event.seq),
        ...grouped.groups
          .filter((group) => group.state === 'queued')
          .flatMap((group) =>
            group.events.filter(isTurnInput).map((event) => event.seq),
          ),
      ]),
    [grouped],
  )
  // Per-turn seq range + input preview, so the All log's turn.started row is
  // self-describing instead of a bare orphan marker.
  const turnStartInfo = useMemo(() => {
    const m = new Map<string, TurnStartInfo>()
    for (const g of grouped.groups) {
      const firstInput = g.events.find(isTurnInput)
      const raw = firstInput ? bodyText(firstInput) : null
      const preview =
        raw && raw.length > 40 ? `${raw.slice(0, 40)}…` : (raw ?? null)
      m.set(g.turnId, { from: g.fromSeq, to: g.toSeq, preview })
    }
    return m
  }, [grouped])

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

  const isEmpty =
    level === 'user'
      ? grouped.groups.length === 0 && grouped.pending.length === 0
      : allEvents.length === 0

  return (
    <div className="max-w-4xl">
      <GuidedTour
        steps={guideSteps}
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
      />
      <Link
        to="/sessions"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="size-4" />
        Sessions
      </Link>

      {/* Header */}
      <Panel ref={headerRef} className="mb-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <code className="text-foreground font-mono text-sm">
                {sessionId}
              </code>
              <StatusBadge status={status} />
              {session?.agent_snapshot?.runtime ? (
                <RuntimeBadge runtime={session.agent_snapshot.runtime} />
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs">
              {session?.head ?? 0} events · created{' '}
              {session?.created_at
                ? new Date(session.created_at).toLocaleString()
                : '—'}
            </p>
            {session?.sandboxes?.brain || session?.sandboxes?.hands ? (
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
                <span>Sandboxes:</span>
                {session.sandboxes.brain ? (
                  <Link
                    to={`/sandboxes/${session.sandboxes.brain}`}
                    className="hover:text-foreground font-mono underline-offset-4 hover:underline"
                  >
                    brain
                  </Link>
                ) : null}
                {session.sandboxes.brain && session.sandboxes.hands ? (
                  <span>·</span>
                ) : null}
                {session.sandboxes.hands ? (
                  <Link
                    to={`/sandboxes/${session.sandboxes.hands}`}
                    className="hover:text-foreground font-mono underline-offset-4 hover:underline"
                  >
                    hands
                  </Link>
                ) : null}
              </p>
            ) : null}
            <ApiHint
              method="GET"
              path="/v3/sessions/:id"
              sdk="oc.sessions.get()"
              docs="https://docs.opencomputer.dev/agent-sessions/sessions"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setGuideOpen(true)}
            >
              <Sparkles className="size-3.5" />
              How it works
            </Button>
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

      <SessionSourcesPanel
        sources={sourcesQuery.data}
        loading={sourcesQuery.isLoading}
        error={sourcesQuery.isError}
        onRetry={() => void sourcesQuery.refetch()}
      />

      {/* Spend / usage — derived from the session's opaque usage object (no dedicated
          spend endpoint). Tokens shown only when the runtime reports them (flue meters
          at the gateway and reports none here). */}
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <MetricCard label="Spend" value={formatSpend(session?.usage)} />
        <MetricCard
          label="Tokens"
          value={usageTokens(session?.usage)?.toLocaleString() ?? '—'}
        />
        <MetricCard
          label="Events"
          value={(session?.head ?? 0).toLocaleString()}
        />
      </div>

      {/* Event stream */}
      <Panel ref={eventsRef} className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Events</h2>
            {streamOk ? (
              // mt-[3px] drops the label to optically sit with "Events"; the dot stays
              // line-centered with the "LIVE" text (values dialed in against the browser).
              <span className="text-status-running mt-[3px] flex items-center gap-1 text-[10px] leading-none font-medium tracking-wide uppercase">
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

        {isEmpty ? (
          <EmptyState
            icon={MessagesSquare}
            title="No events yet"
            description="Events from the agent's turns will stream in here."
          />
        ) : level === 'user' ? (
          <TurnConversation
            grouped={grouped}
            halted={halted}
            sessionStatus={status}
          />
        ) : (
          <ul className="divide-y">
            {allEvents.map((ev) => (
              <EventRow
                key={ev.id}
                ev={ev}
                pending={pendingSeqs}
                bounds={turnStartInfo}
              />
            ))}
          </ul>
        )}

        {/* Steer */}
        <div className="border-t p-3">
          {halted && !archived && (
            <div className="text-destructive mb-2 flex items-center gap-1.5 text-xs">
              <CircleAlert className="size-3.5 shrink-0" />
              <span>
                Out of credits —{' '}
                <Link
                  to="/billing"
                  className="font-medium underline underline-offset-2"
                >
                  top up to resume
                </Link>
                .
              </span>
            </div>
          )}
          <form
            ref={composerRef}
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (draft.trim() && canSteer && !halted) steerMutation.mutate()
            }}
          >
            <ChatTextarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onSend={() => {
                if (
                  draft.trim() &&
                  canSteer &&
                  !halted &&
                  !steerMutation.isPending
                ) {
                  steerMutation.mutate()
                }
              }}
              placeholder={
                halted
                  ? 'Out of credits — top up to resume'
                  : canSteer
                    ? 'Send a message to steer the session…'
                    : 'Session archived'
              }
              disabled={!canSteer || halted}
              className="min-h-10 flex-1"
            />
            <Button
              type="submit"
              title="Enter to send · Shift+Enter for newline"
              disabled={
                !draft.trim() || !canSteer || halted || steerMutation.isPending
              }
            >
              <Send className="size-4" />
              Send
            </Button>
          </form>
          {status === 'running' && !halted && !archived ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Agent is working — your message will run in the next turn.
            </p>
          ) : null}
        </div>
      </Panel>

      <SessionTurns
        sessionId={sessionId}
        active={
          status === 'running' ||
          status === 'awaiting_input' ||
          status === 'queued'
        }
      />

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

export function SessionSourcesPanel({
  sources,
  loading,
  error,
  onRetry,
}: {
  sources?: SessionSource[]
  loading: boolean
  error: boolean
  onRetry: () => void
}) {
  if (!loading && !error && !sources?.length) return null
  return (
    <Panel className="mb-4 min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GithubMark className="size-3.5" /> Working sources
        </h2>
        <span className="text-muted-foreground text-xs">
          {sources?.length ?? 0}{' '}
          {sources?.length === 1 ? 'repository' : 'repositories'}
        </span>
      </div>
      {loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            Couldn’t load working sources.
          </span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className="divide-y">
          {sources?.map((source) => {
            const observedDiffers =
              source.resolved_sha && source.resolved_sha !== source.sha
            return (
              <li
                key={source.name}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,auto)]"
              >
                <div className="min-w-48 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    title={source.full_name ?? source.repo_id ?? source.name}
                  >
                    {source.full_name ?? source.repo_id ?? source.name}
                  </p>
                  <p
                    className="text-muted-foreground mt-0.5 truncate font-mono"
                    title={`Pinned commit ${source.sha}`}
                  >
                    {source.requested_ref ? `${source.requested_ref} · ` : ''}
                    {source.sha.slice(0, 8)}
                  </p>
                  {observedDiffers ? (
                    <p
                      className="text-status-error mt-0.5 font-mono text-[11px]"
                      title={`Observed commit ${source.resolved_sha}`}
                    >
                      observed {source.resolved_sha?.slice(0, 8)}
                    </p>
                  ) : null}
                </div>
                <StatusBadge status={source.status} />
                <code
                  className="text-muted-foreground col-span-2 min-w-0 truncate sm:col-span-1 sm:max-w-52"
                  title={source.path}
                >
                  {source.path}
                </code>
                {source.error_message ? (
                  <p className="text-status-error col-span-2 w-full sm:col-span-3">
                    {source.error_message}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function EventRow({
  ev,
  pending,
  bounds,
}: {
  ev: SessionEvent
  pending: Set<number>
  bounds: Map<string, TurnStartInfo>
}) {
  const text = bodyText(ev)
  const trunc = truncationNote(ev)
  const completion = turnCompletionLabel(ev)

  // Reasoning — muted, set apart from the answer. (flue tailer + brain-box both emit this.)
  if (ev.type === 'agent.thinking') {
    if (!text && !trunc) return null
    return (
      <li className="text-muted-foreground flex gap-2 px-4 py-2 text-xs italic">
        <Brain className="mt-0.5 size-3.5 shrink-0 opacity-60" />
        <span className="whitespace-pre-wrap">{text ?? trunc}</span>
      </li>
    )
  }

  // Conversation messages — the signal.
  if (ev.type === 'user.message' || ev.type === 'agent.message') {
    const isUser = ev.type === 'user.message'
    return (
      <li className="px-4 py-3">
        <MessageBubble
          label={ev.actor?.display ?? (isUser ? 'You' : 'Agent')}
          text={text ?? trunc}
          seq={ev.seq}
          // Input typed while a turn was running but not yet claimed by a turn.
          meta={
            isUser && pending.has(ev.seq) ? (
              <span className="text-muted-foreground text-[10px]">
                · queued
              </span>
            ) : undefined
          }
          outOfCredits={isOutOfCredits(ev)}
        />
      </li>
    )
  }

  // Turn started — de-orphaned: self-describing with its seq range + input preview.
  if (ev.type === 'turn.started') {
    const info = bounds.get(ev.turn_id ?? '')
    const range =
      info && info.from != null
        ? ` · running #${info.from}${info.to != null && info.to > info.from ? `–#${info.to}` : ''}`
        : ''
    const preview = info?.preview ? ` : "${info.preview}"` : ''
    return (
      <li className="text-muted-foreground flex items-center gap-2 px-4 py-1.5 text-xs">
        <span className="bg-border h-px w-4 shrink-0" />
        {`Turn started${range}${preview}`}
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

  // Tool results — `exec.completed` (brain-box) or `tool.result` (flue). Error results
  // get the error tone; success stays quiet. Body-spill falls back to the truncation note.
  if (isToolResult(ev)) {
    const { text: rtext, isError } = toolResult(ev)
    const Icon = isError ? XCircle : CheckCircle2
    return (
      <li
        className={cn(
          'flex items-center gap-2 px-4 py-1.5 font-mono text-xs',
          isError ? 'text-status-error' : 'text-muted-foreground',
        )}
      >
        <Icon className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{trunc ?? rtext}</span>
      </li>
    )
  }

  // Failures — turn.failed + any error* event.
  if (ev.type === 'turn.failed' || ev.type.startsWith('error')) {
    const reason =
      typeof (ev.body as Record<string, unknown> | null | undefined)
        ?.yield_reason === 'string'
        ? String((ev.body as Record<string, unknown>).yield_reason)
        : null
    return (
      <li className="bg-status-error-bg/40 text-status-error flex items-center gap-2 px-4 py-2 text-xs">
        <CircleAlert className="size-3.5 shrink-0" />
        <span>{text ?? reason ?? humanizeType(ev.type)}</span>
      </li>
    )
  }

  // Turn markers + everything else — quiet context line.
  return (
    <li className="text-muted-foreground flex items-center gap-2 px-4 py-1.5 text-xs">
      <span className="bg-border h-px w-4 shrink-0" />
      {humanizeType(ev.type)}
      {completion ? ` · ${completion}` : ''}
    </li>
  )
}
