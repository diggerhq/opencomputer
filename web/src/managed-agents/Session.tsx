import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Bot, Clock3, Loader2, TerminalSquare } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  getManagedAgentSession,
  getManagedAgentSessionEvents,
  getManagedProject,
} from './api'
import { AgentMarkdown } from './AgentMarkdown'

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

export default function ManagedSessionDetail() {
  const { projectId = '', sessionId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<'conversation' | 'events'>(
    'conversation',
  )
  const project = useQuery({
    queryKey: ['managed-project', projectId],
    queryFn: () => getManagedProject(projectId),
    enabled: Boolean(projectId),
  })
  const session = useQuery({
    queryKey: ['managed-agent-session', sessionId],
    queryFn: () => getManagedAgentSession(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: 5_000,
  })
  const events = useQuery({
    queryKey: ['managed-agent-session-events', sessionId],
    queryFn: () => getManagedAgentSessionEvents(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: 2_000,
  })

  if (project.isLoading || session.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  const agent = project.data?.project.agents.find(
    (candidate) => candidate.id === session.data?.agentId,
  )
  if (!project.data || !session.data || !agent) {
    return (
      <Panel>
        <EmptyState
          icon={TerminalSquare}
          title="Session not found"
          description="This session is not available in this project."
          action={
            <Button asChild variant="outline">
              <Link to={`/projects/${encodeURIComponent(projectId)}/sessions`}>
                Back to sessions
              </Link>
            </Button>
          }
        />
      </Panel>
    )
  }

  const replies = (events.data ?? []).filter(
    (event) => event.type === 'message.completed',
  )
  const sessionPath = `/projects/${encodeURIComponent(projectId)}/sessions`

  return (
    <div className="space-y-5">
      <PageHeader
        title="Session"
        description={session.data.id}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link
              to={{ pathname: sessionPath, search: searchParams.toString() }}
            >
              <ArrowLeft /> Sessions
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel className="p-4">
          <p className="text-muted-foreground text-xs">Status</p>
          <div className="mt-2">
            <StatusBadge status={session.data.status} />
          </div>
        </Panel>
        <Panel className="p-4">
          <p className="text-muted-foreground text-xs">Agent</p>
          <p className="mt-2 text-sm font-medium">{agent.name}</p>
        </Panel>
        <Panel className="p-4">
          <p className="text-muted-foreground text-xs">Source</p>
          <p className="mt-2 text-sm font-medium capitalize">
            {session.data.source}
          </p>
        </Panel>
        <Panel className="p-4">
          <p className="text-muted-foreground text-xs">Updated</p>
          <p className="mt-2 text-sm font-medium">
            {formatDate(session.data.updatedAt)}
          </p>
        </Panel>
      </div>

      <div
        role="tablist"
        aria-label="Session detail"
        className="flex w-fit items-center gap-1 rounded-lg border p-1"
      >
        <Button
          role="tab"
          aria-selected={activeTab === 'conversation'}
          variant={activeTab === 'conversation' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveTab('conversation')}
        >
          Conversation
        </Button>
        <Button
          role="tab"
          aria-selected={activeTab === 'events'}
          variant={activeTab === 'events' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveTab('events')}
        >
          Events
          <span className="text-[10px] opacity-70">
            {events.data?.length ?? 0}
          </span>
        </Button>
      </div>

      {activeTab === 'conversation' ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Conversation</PanelTitle>
              <PanelDescription className="mt-1">
                Durable turn history for this session.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-8 px-6 py-7">
            {session.data.turns.length === 0 ? (
              <p className="text-muted-foreground text-sm">No turns yet.</p>
            ) : (
              session.data.turns.map((turn) => {
                const response = replies.find(
                  (event) => event.turnId === turn.id,
                )
                return (
                  <div key={turn.id} className="space-y-6">
                    <div>
                      <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                        You
                      </p>
                      <p className="bg-muted ml-auto max-w-2xl rounded-xl rounded-br-sm px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap">
                        {turn.input}
                      </p>
                    </div>
                    <div className="max-w-3xl">
                      <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider uppercase">
                        <Bot className="size-3" /> Agent
                      </p>
                      {response && typeof response.data.text === 'string' ? (
                        <AgentMarkdown>{response.data.text}</AgentMarkdown>
                      ) : (
                        <p className="text-muted-foreground text-sm">
                          {turn.status === 'completed'
                            ? 'No completed response recorded.'
                            : `Turn ${turn.status.replace(/_/g, ' ')}.`}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </PanelContent>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Durable log</PanelTitle>
              <PanelDescription className="mt-1">
                Runtime events persisted for inspection and debugging.
              </PanelDescription>
            </div>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Clock3 className="size-3.5" /> {events.data?.length ?? 0} events
            </span>
          </PanelHeader>
          <div className="divide-y font-mono text-xs">
            {(events.data ?? []).map((event) => (
              <div
                key={event.id ?? event.seq}
                className="grid gap-2 px-5 py-3 md:grid-cols-[5rem_12rem_1fr]"
              >
                <span className="text-muted-foreground">#{event.seq}</span>
                <span>{event.type}</span>
                <pre className="overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              </div>
            ))}
            {!events.isLoading && (events.data ?? []).length === 0 ? (
              <p className="text-muted-foreground px-5 py-4">
                No events recorded.
              </p>
            ) : null}
          </div>
        </Panel>
      )}
    </div>
  )
}
