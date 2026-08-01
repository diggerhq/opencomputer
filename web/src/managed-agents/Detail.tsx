import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleDashed,
  Clock3,
  GitCommitHorizontal,
  Loader2,
  MessageSquareText,
  Send,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import {
  displayManagedAgentName,
  getManagedAgentDeployment,
  getManagedAgentSessionEvents,
  getManagedAgents,
  getManagedAgentSessions,
  runManagedAgent,
  type ManagedAgentEvent,
  type ManagedAgentSession,
} from './api'

type ToolActivity = {
  id: string
  name: string
  title?: string
  status: 'running' | 'completed' | 'failed'
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

function eventText(event: ManagedAgentEvent) {
  return typeof event.data.text === 'string' ? event.data.text : ''
}

function RunActivity({
  events,
  running,
}: {
  events: ManagedAgentEvent[]
  running: boolean
}) {
  const reasoning = events
    .filter((event) => event.type === 'reasoning.delta')
    .map(eventText)
    .join('')
  const tools = new Map<string, ToolActivity>()
  for (const event of events) {
    if (!event.type.startsWith('tool.')) continue
    const id =
      typeof event.data.callId === 'string'
        ? event.data.callId
        : `${event.type}:${event.seq}`
    const previous = tools.get(id)
    tools.set(id, {
      id,
      name:
        typeof event.data.tool === 'string'
          ? event.data.tool
          : (previous?.name ?? 'tool'),
      title:
        typeof event.data.title === 'string'
          ? event.data.title
          : previous?.title,
      status:
        event.type === 'tool.completed'
          ? 'completed'
          : event.type === 'tool.failed'
            ? 'failed'
            : 'running',
    })
  }
  const activity = [...tools.values()]
  if (!reasoning && activity.length === 0 && !running) return null

  return (
    <details
      key={running ? 'running' : 'settled'}
      open={running}
      className="group bg-muted/25 text-muted-foreground rounded-md border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs select-none [&::-webkit-details-marker]:hidden">
        {running ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <CircleDashed className="size-3.5" aria-hidden />
        )}
        <span>{running ? 'Agent activity' : 'Activity'}</span>
        <span className="ml-auto text-[10px]">
          {activity.length > 0
            ? `${activity.length} tool ${activity.length === 1 ? 'call' : 'calls'}`
            : 'Thinking'}
        </span>
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-2 border-t px-3 py-2.5">
        {reasoning ? (
          <p className="line-clamp-4 text-xs leading-5 whitespace-pre-wrap opacity-75">
            {reasoning}
          </p>
        ) : null}
        {activity.map((tool) => (
          <div
            key={tool.id}
            className="flex items-center gap-2 text-xs opacity-80"
          >
            {tool.status === 'running' ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Wrench className="size-3" aria-hidden />
            )}
            <span className="font-mono">{tool.name}</span>
            {tool.title ? <span className="truncate">{tool.title}</span> : null}
            <span className="ml-auto capitalize">{tool.status}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

export default function ManagedAgentDetail() {
  const { agentId = '' } = useParams()
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [events, setEvents] = useState<ManagedAgentEvent[]>([])
  const [expandedSessionId, setExpandedSessionId] = useState<string>()

  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
  })
  const agent = agents.data?.find((candidate) => candidate.id === agentId)
  const deployment = useQuery({
    queryKey: ['managed-agent-deployment', agent?.activeDeploymentId],
    queryFn: () => getManagedAgentDeployment(agent!.activeDeploymentId!),
    enabled: Boolean(agent?.activeDeploymentId),
  })
  const sessions = useQuery({
    queryKey: ['managed-agent-sessions', agentId],
    queryFn: () => getManagedAgentSessions(agentId),
    refetchInterval: 5_000,
  })
  const sessionEvents = useQuery({
    queryKey: ['managed-agent-session-events', expandedSessionId],
    queryFn: () => getManagedAgentSessionEvents(expandedSessionId!),
    enabled: Boolean(expandedSessionId),
  })
  const run = useMutation({
    mutationFn: (input: string) =>
      runManagedAgent(agentId, input, (event) => {
        setEvents((current) => {
          if (current.some((candidate) => candidate.seq === event.seq)) {
            return current
          }
          return [...current, event]
        })
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['managed-agent-sessions', agentId],
      })
    },
    onError: (error) => notifyError("Couldn't run this agent.", error),
  })

  const streamedText = useMemo(
    () =>
      events
        .filter((event) => event.type === 'message.delta')
        .map(eventText)
        .join(''),
    [events],
  )
  const completedText = [...events]
    .reverse()
    .find((event) => event.type === 'message.completed')
  const response = completedText ? eventText(completedText) : streamedText

  const sessionColumns: Column<ManagedAgentSession>[] = [
    {
      key: 'session',
      header: 'Session',
      cell: (session) => (
        <span className="font-mono text-xs">{session.id}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (session) => <StatusBadge status={session.status} />,
    },
    {
      key: 'turns',
      header: 'Turns',
      cell: (session) => (
        <span className="text-muted-foreground text-xs">
          {session.turns.length}
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      cell: (session) => (
        <time
          className="text-muted-foreground text-xs"
          dateTime={session.updatedAt}
        >
          {formatDate(session.updatedAt)}
        </time>
      ),
    },
  ]

  if (!agents.isLoading && !agent) {
    return (
      <Panel>
        <EmptyState
          icon={Bot}
          title="Agent not found"
          description="This agent is not available in your organization."
          action={
            <Button asChild variant="outline">
              <Link to="/">Back to agents</Link>
            </Button>
          }
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={agent ? displayManagedAgentName(agent) : 'Agent'}
        description={agent ? `Agent ID · ${agent.id}` : 'Loading agent…'}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/">
              <ArrowLeft />
              All agents
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Test the deployed agent</PanelTitle>
              <PanelDescription className="mt-1">
                Start a new cloud session and watch its response as it runs.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-4">
            <div className="bg-background rounded-lg border px-4 py-4">
              {response ? (
                <div className="space-y-3">
                  <RunActivity
                    events={events}
                    running={run.isPending && !response}
                  />
                  <div>
                    <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
                      Agent
                    </p>
                    <p className="text-sm leading-6 whitespace-pre-wrap">
                      {response}
                    </p>
                  </div>
                </div>
              ) : run.isPending || events.length > 0 ? (
                <RunActivity events={events} running={run.isPending} />
              ) : (
                <div className="text-muted-foreground flex min-h-28 flex-col items-center justify-center text-center">
                  <Bot className="mb-2 size-5" aria-hidden />
                  <p className="text-sm">
                    Send a message to start a fresh session.
                  </p>
                </div>
              )}
            </div>
            <label htmlFor="managed-agent-detail-prompt" className="sr-only">
              Message
            </label>
            <textarea
              id="managed-agent-detail-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && prompt.trim()) {
                  event.preventDefault()
                  setEvents([])
                  run.mutate(prompt.trim())
                }
              }}
              placeholder="Ask your agent to do something…"
              rows={3}
              disabled={run.isPending}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-3 disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">
                Enter to send · Shift + Enter for a new line
              </p>
              <Button
                disabled={!prompt.trim() || run.isPending}
                onClick={() => {
                  setEvents([])
                  run.mutate(prompt.trim())
                }}
              >
                {run.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Send />
                )}
                {run.isPending ? 'Running…' : 'Start session'}
              </Button>
            </div>
          </PanelContent>
        </Panel>

        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Agent details</PanelTitle>
              <PanelDescription className="mt-1">
                Current cloud deployment.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-5">
            <div>
              <p className="text-muted-foreground text-xs">Status</p>
              <div className="mt-1">
                <StatusBadge status="active" />
              </div>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Alias</p>
              <p className="mt-1 font-mono text-sm">
                {agent?.activeAlias ?? '—'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Last deployed</p>
              <p className="mt-1 text-sm">
                {deployment.data ? formatDate(deployment.data.createdAt) : '—'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Connections</p>
              <p className="mt-1 text-sm">
                {deployment.data?.connections.join(', ') || 'None'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Channels</p>
              <p className="mt-1 text-sm">
                {deployment.data?.channels.join(', ') || 'None'}
              </p>
            </div>
          </PanelContent>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Deployments and revisions</PanelTitle>
            <PanelDescription className="mt-1">
              The active immutable version, deployed from the checked-out agent
              source.
            </PanelDescription>
          </div>
          <span className="text-muted-foreground text-xs">
            {agent?.deploymentCount ?? 0} total
          </span>
        </PanelHeader>
        {deployment.data ? (
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
            <div className="flex items-start gap-2">
              <GitCommitHorizontal className="text-muted-foreground mt-0.5 size-4" />
              <div>
                <p className="text-xs font-medium">Active revision</p>
                <p className="text-muted-foreground mt-1 font-mono text-xs">
                  {deployment.data.id}
                </p>
              </div>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Alias</p>
              <p className="mt-1 text-sm">{deployment.data.alias}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Created</p>
              <p className="mt-1 text-sm">
                {formatDate(deployment.data.createdAt)}
              </p>
            </div>
          </div>
        ) : (
          <PanelContent className="text-muted-foreground text-sm">
            {deployment.isLoading
              ? 'Loading the active revision…'
              : 'Active revision details are unavailable.'}
          </PanelContent>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Sessions</PanelTitle>
            <PanelDescription className="mt-1">
              Cloud sessions are visible here. Lifecycle controls stay with the
              checked-out agent code.
            </PanelDescription>
          </div>
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Clock3 className="size-3.5" />
            Refreshes automatically
          </div>
        </PanelHeader>
        <ResourceTable
          columns={sessionColumns}
          rows={sessions.data ?? []}
          rowKey={(session) => session.id}
          loading={sessions.isLoading}
          onRowClick={(session) =>
            setExpandedSessionId((current) =>
              current === session.id ? undefined : session.id,
            )
          }
          renderSubRow={(session) => {
            if (expandedSessionId !== session.id) return null
            const replies = (sessionEvents.data ?? []).filter(
              (event) => event.type === 'message.completed',
            )
            return (
              <div className="bg-muted/20 space-y-3 border-y px-5 py-4">
                {session.turns.map((turn) => (
                  <div key={turn.id}>
                    <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
                      You · {turn.status}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{turn.input}</p>
                  </div>
                ))}
                {replies.map((event) => (
                  <div key={event.id ?? event.seq}>
                    <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
                      Agent
                    </p>
                    <p className="text-sm leading-6 whitespace-pre-wrap">
                      {eventText(event)}
                    </p>
                  </div>
                ))}
                {sessionEvents.isLoading ? (
                  <div className="text-muted-foreground flex items-center gap-2 text-xs">
                    <Loader2 className="size-3.5 animate-spin" />
                    Loading session events…
                  </div>
                ) : session.turns.length === 0 && replies.length === 0 ? (
                  <div className="text-muted-foreground flex items-center gap-2 text-xs">
                    <MessageSquareText className="size-3.5" />
                    This session has no visible messages yet.
                  </div>
                ) : null}
              </div>
            )
          }}
          empty={
            <EmptyState
              icon={TerminalSquare}
              title="No sessions yet"
              description="Start a session above to test this deployment."
            />
          }
        />
      </Panel>
    </div>
  )
}
