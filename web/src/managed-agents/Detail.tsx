import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isDynamicToolUIPart, type DynamicToolUIPart, type UIMessage } from 'ai'
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Clipboard,
  GitCommitHorizontal,
  Loader2,
  Plus,
  Send,
  Square,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { ChatTextarea } from '@/components/chat-textarea'
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
import { cn } from '@/lib/utils'
import {
  displayManagedAgentName,
  getManagedAgentDeployment,
  getManagedAgentDeployments,
  getManagedAgentChannels,
  getManagedAgentSessionEvents,
  getManagedAgents,
  getManagedAgentSessions,
  type ManagedAgentEvent,
  type ManagedAgentSession,
  type ManagedAgentSummary,
  type ManagedProjectOverview,
} from './api'
import { ManagedAgentChatTransport } from './chat-transport'
import { DebugInspector } from './DebugInspector'
import { isNearScrollEnd } from './scroll-follow'
import { createStartCommand, starterCommands } from './onboarding'
import { projectContextSearch } from './project-context'
import { ManagedProjectSecrets } from './Secrets'
import { ManagedSlackWizard } from './SlackWizard'

type DetailTab =
  | 'playground'
  | 'deployments'
  | 'sessions'
  | 'channels'
  | 'schedules'
  | 'secrets'

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

function eventText(event: ManagedAgentEvent) {
  return typeof event.data.text === 'string' ? event.data.text : ''
}

function AgentMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              className="mt-6 mb-3 text-xl font-semibold first:mt-0"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className="mt-5 mb-2 text-lg font-semibold first:mt-0"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              className="mt-4 mb-2 text-base font-semibold first:mt-0"
              {...props}
            >
              {children}
            </h3>
          ),
          p: (props) => <p className="mb-3 last:mb-0" {...props} />,
          ul: (props) => (
            <ul
              className="mb-3 list-disc space-y-1 pl-5 last:mb-0"
              {...props}
            />
          ),
          ol: (props) => (
            <ol
              className="mb-3 list-decimal space-y-1 pl-5 last:mb-0"
              {...props}
            />
          ),
          li: (props) => <li className="pl-0.5" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="text-muted-foreground my-3 border-l-2 pl-4 italic"
              {...props}
            />
          ),
          a: ({ children, ...props }) => (
            <a
              className="underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
          code: (props) => (
            <code
              className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]"
              {...props}
            />
          ),
          pre: (props) => (
            <pre
              className="bg-muted my-3 overflow-x-auto rounded-md border p-3 text-xs leading-5 [&_code]:bg-transparent [&_code]:p-0"
              {...props}
            />
          ),
          hr: (props) => <hr className="my-5" {...props} />,
          table: (props) => (
            <div className="my-3 overflow-x-auto rounded-md border">
              <table
                className="w-full border-collapse text-left text-xs"
                {...props}
              />
            </div>
          ),
          th: (props) => (
            <th
              className="bg-muted border-b px-3 py-2 font-medium"
              {...props}
            />
          ),
          td: (props) => <td className="border-b px-3 py-2" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function historicalMessages(
  session: ManagedAgentSession | undefined,
  events: ManagedAgentEvent[],
): UIMessage[] {
  if (!session) return []
  const completedByTurn = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'message.completed' && event.turnId) {
      completedByTurn.set(event.turnId, eventText(event))
    }
  }
  return session.turns.flatMap((turn) => {
    const messages: UIMessage[] = [
      {
        id: `${turn.id}:user`,
        role: 'user',
        parts: [{ type: 'text', text: turn.input }],
      },
    ]
    const response = completedByTurn.get(turn.id)
    if (response) {
      messages.push({
        id: `${turn.id}:assistant`,
        role: 'assistant',
        parts: [{ type: 'text', text: response }],
      })
    }
    return messages
  })
}

function toolStatus(tool: DynamicToolUIPart) {
  if (tool.state === 'output-available') return 'Completed'
  if (tool.state === 'output-error') return 'Failed'
  return 'Running'
}

function MessageActivity({
  message,
  running,
}: {
  message: UIMessage
  running: boolean
}) {
  const reasoning = message.parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text)
    .join('')
  const tools = message.parts.filter(isDynamicToolUIPart)
  if (!reasoning && tools.length === 0) return null

  return (
    <details
      open={running}
      className="group bg-muted/30 text-muted-foreground mb-3 rounded-md border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs select-none [&::-webkit-details-marker]:hidden">
        {running ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Wrench className="size-3.5" aria-hidden />
        )}
        <span>{running ? 'Agent is working' : 'Activity'}</span>
        <span className="ml-auto text-[10px]">
          {tools.length > 0
            ? `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`
            : 'Reasoning'}
        </span>
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-2 border-t px-3 py-2.5">
        {reasoning ? (
          <p className="line-clamp-5 text-xs leading-5 whitespace-pre-wrap opacity-75">
            {reasoning}
          </p>
        ) : null}
        {tools.map((tool) => (
          <div
            key={tool.toolCallId}
            className="flex items-center gap-2 text-xs"
          >
            {toolStatus(tool) === 'Running' ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Wrench className="size-3" aria-hidden />
            )}
            <span className="font-mono">{tool.toolName}</span>
            {tool.title ? <span className="truncate">{tool.title}</span> : null}
            <span className="ml-auto">{toolStatus(tool)}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

function PlaygroundChat({
  agentId,
  session,
  events,
}: {
  agentId: string
  session?: ManagedAgentSession
  events: ManagedAgentEvent[]
}) {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [liveSessionId, setLiveSessionId] = useState(session?.id)
  const timelineRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const followOutputRef = useRef(true)
  const initializedScrollRef = useRef(false)
  const initialMessages = useMemo(
    () => historicalMessages(session, events),
    [events, session],
  )
  const transport = useMemo(
    () =>
      new ManagedAgentChatTransport(agentId, session?.id, (sessionId) => {
        setLiveSessionId(sessionId)
      }),
    [agentId, session?.id],
  )
  const debugEvents = useQuery({
    queryKey: ['managed-agent-session-events', liveSessionId],
    queryFn: () => getManagedAgentSessionEvents(liveSessionId!),
    enabled: Boolean(liveSessionId),
    refetchInterval: 1_000,
  })
  const { messages, sendMessage, status, stop, error } = useChat({
    id: session?.id ?? `new-${agentId}`,
    messages: initialMessages,
    transport,
    throttle: 30,
    onError: (chatError) => notifyError("Couldn't run this agent.", chatError),
    onFinish: () => {
      void queryClient.invalidateQueries({
        queryKey: ['managed-agent-sessions', agentId],
      })
      if (liveSessionId) {
        void queryClient.invalidateQueries({
          queryKey: ['managed-agent-session-events', liveSessionId],
        })
      }
    },
  })
  const running = status === 'submitted' || status === 'streaming'

  useLayoutEffect(() => {
    const timeline = timelineRef.current
    if (!timeline) return
    if (!initializedScrollRef.current || followOutputRef.current) {
      timeline.scrollTop = timeline.scrollHeight
      followOutputRef.current = true
    }
    initializedScrollRef.current = true
  }, [messages, status])

  const send = () => {
    const input = prompt.trim()
    if (!input || running) return
    followOutputRef.current = true
    setPrompt('')
    void sendMessage({ text: input })
    requestAnimationFrame(() =>
      composerRef.current?.querySelector('textarea')?.focus(),
    )
  }

  return (
    <div className="grid h-full min-h-0 min-w-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <p className="text-sm font-medium">
              {session?.turns[0]?.input || 'New playground session'}
            </p>
            <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
              {liveSessionId ?? 'A session is created when you send a message'}
            </p>
          </div>
          {running ? (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="bg-foreground size-1.5 animate-pulse rounded-full" />
              Agent is working
            </div>
          ) : null}
        </div>

        <div
          ref={timelineRef}
          onScroll={(event) => {
            followOutputRef.current = isNearScrollEnd(event.currentTarget)
          }}
          className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-6"
        >
          {messages.length === 0 ? (
            <div className="text-muted-foreground flex min-h-80 flex-col items-center justify-center text-center">
              <Bot className="mb-3 size-7" aria-hidden />
              <p className="text-foreground text-sm font-medium">
                Start a conversation
              </p>
              <p className="mt-1 max-w-sm text-sm">
                This runs the active deployment and keeps context across every
                message in this playground session.
              </p>
            </div>
          ) : (
            messages.map((message, index) => {
              const isLast = index === messages.length - 1
              const messageRunning =
                running && isLast && message.role === 'assistant'
              const text = message.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
              return (
                <div
                  key={message.id}
                  className={cn(
                    'max-w-3xl',
                    message.role === 'user' && 'ml-auto max-w-2xl',
                  )}
                >
                  <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                    {message.role === 'user' ? 'You' : 'Agent'}
                  </p>
                  {message.role === 'assistant' ? (
                    <MessageActivity
                      message={message}
                      running={messageRunning}
                    />
                  ) : null}
                  {text ? (
                    message.role === 'user' ? (
                      <div className="bg-muted rounded-xl rounded-br-sm px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap">
                        {text}
                      </div>
                    ) : (
                      <AgentMarkdown>{text}</AgentMarkdown>
                    )
                  ) : messageRunning ? (
                    <div className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin" />
                      Starting the agent…
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>

        <div className="bg-panel shrink-0 border-t p-4">
          {error ? (
            <p className="text-destructive mb-2 text-xs">{error.message}</p>
          ) : null}
          <div
            ref={composerRef}
            className="bg-background focus-within:border-ring/60 rounded-lg border p-2 transition-colors"
          >
            <ChatTextarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onSend={send}
              placeholder="Message this agent…"
              className="min-h-12 border-0 px-2 shadow-none focus-visible:border-transparent"
            />
            <div className="flex items-center justify-between gap-3 px-1 pt-1">
              <p className="text-muted-foreground text-[10px]">
                Enter to send · Shift + Enter for a new line
              </p>
              {running ? (
                <Button variant="outline" size="sm" onClick={() => void stop()}>
                  <Square className="fill-current" /> Stop
                </Button>
              ) : (
                <Button size="sm" disabled={!prompt.trim()} onClick={send}>
                  <Send /> Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <DebugInspector
        events={debugEvents.data ?? events}
        deploymentId={session?.deploymentId}
      />
    </div>
  )
}

export default function ManagedAgentDetail({
  agentId: agentIdOverride,
  project,
}: {
  agentId?: string
  project?: ManagedProjectOverview
} = {}) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const agentId = agentIdOverride ?? params.agentId ?? ''
  const [standaloneTab, setStandaloneTab] = useState<DetailTab>('playground')
  const [starterCopied, setStarterCopied] = useState(false)
  const routeTab = params.tab as DetailTab | undefined
  const projectTabs = new Set<DetailTab>([
    'playground',
    'deployments',
    'sessions',
    'channels',
    'schedules',
    'secrets',
  ])
  const activeTab = project
    ? routeTab && projectTabs.has(routeTab)
      ? routeTab
      : 'playground'
    : standaloneTab
  const environment =
    searchParams.get('environment') === 'production'
      ? 'production'
      : 'development'
  const [selectedPlaygroundId, setSelectedPlaygroundId] = useState<string>()
  const [newSessionKey, setNewSessionKey] = useState(() => crypto.randomUUID())

  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
  })
  const listedAgent = agents.data?.find((candidate) => candidate.id === agentId)
  const projectAgent = project?.project.agents.find(
    (candidate) => candidate.id === agentId,
  )
  const projectEnvironment = project?.project.environments.find(
    (candidate) =>
      candidate.name === environment &&
      (!candidate.agentId || candidate.agentId === agentId),
  )
  const agent: ManagedAgentSummary | undefined =
    projectAgent && project
      ? {
          id: projectAgent.id,
          name: projectAgent.name,
          activeAlias: environment,
          activeDeploymentId: projectEnvironment?.activeDeploymentId,
          deploymentCount: project.deployments.length,
          createdAt: project.project.createdAt,
          updatedAt: project.project.updatedAt,
        }
      : listedAgent
  const activeDeployment = useQuery({
    queryKey: ['managed-agent-deployment', agent?.activeDeploymentId],
    queryFn: () => getManagedAgentDeployment(agent!.activeDeploymentId!),
    enabled: Boolean(agent?.activeDeploymentId),
  })
  const deployments = useQuery({
    queryKey: ['managed-agent-deployments', agentId],
    queryFn: () => getManagedAgentDeployments(agentId),
    refetchInterval: project ? 1_500 : false,
  })
  const sessions = useQuery({
    queryKey: ['managed-agent-sessions', agentId],
    queryFn: () => getManagedAgentSessions(agentId),
    refetchInterval: 5_000,
  })
  const channels = useQuery({
    queryKey: ['managed-agent-channels'],
    queryFn: getManagedAgentChannels,
  })
  const selectedPlayground = sessions.data?.find(
    (session) => session.id === selectedPlaygroundId,
  )
  const selectedPlaygroundEvents = useQuery({
    queryKey: ['managed-agent-session-events', selectedPlaygroundId],
    queryFn: () => getManagedAgentSessionEvents(selectedPlaygroundId!),
    enabled: Boolean(selectedPlaygroundId),
  })

  const environmentSessions = (sessions.data ?? []).filter(
    (session) =>
      !projectEnvironment?.activeDeploymentId ||
      session.deploymentId === projectEnvironment.activeDeploymentId,
  )
  const playgroundSessions = environmentSessions.filter(
    (session) => session.source === 'playground',
  )
  const externalSessions = environmentSessions.filter(
    (session) => session.source !== 'playground',
  )
  const activeAliasChannels = (channels.data ?? []).filter(
    (channel) =>
      channel.agentId === agentId &&
      channel.alias === (activeDeployment.data?.alias ?? agent?.activeAlias) &&
      channel.status !== 'disconnected',
  )
  const activeAliasChannel = activeAliasChannels[0]
  const declaredChannels =
    activeDeployment.data?.projectDeployment?.resources.channels ?? []

  const sessionColumns: Column<ManagedAgentSession>[] = [
    {
      key: 'session',
      header: 'Session',
      cell: (session) => (
        <span className="font-mono text-xs">{session.id}</span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (session) => (
        <span className="text-muted-foreground text-xs capitalize">
          {session.source}
        </span>
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
              <Link to="/">Back to projects</Link>
            </Button>
          }
        />
      </Panel>
    )
  }

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'playground', label: project ? 'Debug playground' : 'Playground' },
    { id: 'deployments', label: 'Deployments' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'channels', label: 'Channels' },
    ...(project ? ([{ id: 'schedules', label: 'Schedules' }] as const) : []),
    ...(project ? ([{ id: 'secrets', label: 'Secrets' }] as const) : []),
  ]

  return (
    <div
      className={cn(
        activeTab === 'playground'
          ? 'flex h-[calc(100dvh-7rem)] min-h-0 flex-col gap-5 overflow-hidden'
          : 'space-y-5',
      )}
    >
      <PageHeader
        title={
          project?.project.name ??
          (agent ? displayManagedAgentName(agent) : 'Agent')
        }
        description={
          project
            ? `${project.project.agents.length} ${project.project.agents.length === 1 ? 'agent' : 'agents'} · development and production environments`
            : activeDeployment.data
              ? `Active deployment · ${activeDeployment.data.alias}`
              : 'Loading active deployment…'
        }
        actions={
          project ? undefined : (
            <Button asChild variant="outline" size="sm">
              <Link to="/">All projects</Link>
            </Button>
          )
        }
        className={activeTab === 'playground' ? 'mb-0 shrink-0' : undefined}
      />

      {project && activeTab === 'playground' ? (
        <div className="flex shrink-0 items-center gap-3">
          <label
            htmlFor="playground-agent"
            className="text-muted-foreground text-xs font-medium"
          >
            Agent
          </label>
          <select
            id="playground-agent"
            aria-label="Playground agent"
            value={agentId}
            onChange={(event) => {
              setSelectedPlaygroundId(undefined)
              setNewSessionKey(crypto.randomUUID())
              void navigate({
                pathname: location.pathname,
                search: projectContextSearch(
                  location.search,
                  event.target.value,
                  environment,
                ),
              })
            }}
            className="border-input bg-background h-9 min-w-52 rounded-md border px-3 text-sm outline-none"
          >
            {project.project.agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {displayManagedAgentName(candidate)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {!project ? (
        <div className="flex shrink-0 items-end justify-between gap-6 border-b">
          <nav className="flex gap-5" aria-label="Agent details">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStandaloneTab(tab.id)}
                className={cn(
                  '-mb-px border-b-2 px-0.5 pb-3 text-sm font-medium transition-colors',
                  activeTab === tab.id
                    ? 'border-foreground text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="text-muted-foreground hidden gap-5 pb-3 text-xs lg:flex">
            <span>{agent?.deploymentCount ?? 0} deployments</span>
            <span>
              {
                activeAliasChannels.filter(
                  (channel) => channel.status === 'connected',
                ).length
              }{' '}
              channels
            </span>
          </div>
        </div>
      ) : null}

      {activeTab === 'playground' &&
      project &&
      !projectEnvironment?.activeDeploymentId ? (
        <Panel>
          <EmptyState
            icon={Bot}
            title="Deploy the hello-world agent to use Debug playground"
            description={`Create the starter locally, then sync it directly to ${environment}.`}
            action={
              <div className="flex max-w-xl flex-col items-center gap-3">
                <pre className="bg-foreground text-background max-w-full overflow-x-auto rounded-md px-4 py-3 text-left text-xs leading-6">
                  <code>
                    {starterCommands(project.project.slug).join('\n')}
                  </code>
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(createStartCommand(project.project.slug))
                      .then(() => setStarterCopied(true))
                      .catch((error) =>
                        notifyError("Couldn't copy the command.", error),
                      )
                  }}
                >
                  {starterCopied ? <Check /> : <Clipboard />}
                  {starterCopied ? 'Copied' : 'Copy command'}
                </Button>
              </div>
            }
          />
        </Panel>
      ) : activeTab === 'playground' ? (
        <Panel className="min-h-0 flex-1 overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)] lg:grid-rows-1">
            <aside className="bg-muted/15 flex min-h-0 flex-col overflow-hidden border-b lg:border-r lg:border-b-0">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <p className="text-xs font-semibold tracking-wide uppercase">
                  Sessions
                </p>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="New playground session"
                  onClick={() => {
                    setSelectedPlaygroundId(undefined)
                    setNewSessionKey(crypto.randomUUID())
                  }}
                >
                  <Plus />
                </Button>
              </div>
              <div className="max-h-48 min-h-0 overflow-y-auto overscroll-contain p-2 lg:max-h-none lg:flex-1">
                {!selectedPlaygroundId ? (
                  <button
                    type="button"
                    className="bg-muted text-foreground mb-1 w-full rounded-md px-3 py-2 text-left"
                  >
                    <span className="block truncate text-xs font-medium">
                      New session
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[10px]">
                      Playground
                    </span>
                  </button>
                ) : null}
                {playgroundSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedPlaygroundId(session.id)}
                    className={cn(
                      'hover:bg-muted/70 mb-1 w-full rounded-md px-3 py-2 text-left transition-colors',
                      selectedPlaygroundId === session.id && 'bg-muted',
                    )}
                  >
                    <span className="block truncate text-xs font-medium">
                      {session.turns[0]?.input || 'Playground session'}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[10px]">
                      {session.turns.length}{' '}
                      {session.turns.length === 1 ? 'turn' : 'turns'} ·{' '}
                      {formatDate(session.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </aside>
            {selectedPlaygroundId && selectedPlaygroundEvents.isLoading ? (
              <div className="text-muted-foreground flex min-h-0 items-center justify-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading session…
              </div>
            ) : (
              <PlaygroundChat
                key={`${environment}:${selectedPlaygroundId ?? newSessionKey}`}
                agentId={project ? `${agentId}@${environment}` : agentId}
                session={selectedPlayground}
                events={selectedPlaygroundEvents.data ?? []}
              />
            )}
          </div>
        </Panel>
      ) : null}

      {activeTab === 'deployments' ? (
        <Panel className="overflow-hidden">
          <PanelHeader>
            <div>
              <PanelTitle>Deployments</PanelTitle>
              <PanelDescription className="mt-1">
                Immutable versions published from this agent's source.
              </PanelDescription>
            </div>
          </PanelHeader>
          {(deployments.data ?? []).length > 0 ? (
            <div className="divide-y">
              {(deployments.data ?? []).map((deployment) => (
                <div
                  key={deployment.id}
                  className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(14rem,1fr)_1fr_1fr_auto]"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <GitCommitHorizontal className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">
                        {deployment.id}
                      </p>
                      {deployment.id ===
                        projectEnvironment?.activeDeploymentId ||
                      (!project &&
                        deployment.id === agent?.activeDeploymentId) ? (
                        <span className="text-muted-foreground mt-1 block text-[10px] font-medium uppercase">
                          Active
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Alias</p>
                    <p className="mt-1 text-sm">{deployment.alias}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Created</p>
                    <p className="mt-1 text-sm">
                      {formatDate(deployment.createdAt)}
                    </p>
                  </div>
                  <StatusBadge
                    status={
                      deployment.id ===
                        projectEnvironment?.activeDeploymentId ||
                      (!project && deployment.id === agent?.activeDeploymentId)
                        ? 'active'
                        : 'inactive'
                    }
                  />
                </div>
              ))}
            </div>
          ) : (
            <PanelContent className="text-muted-foreground text-sm">
              {deployments.isLoading
                ? 'Loading deployments…'
                : 'No deployments found.'}
            </PanelContent>
          )}
        </Panel>
      ) : null}

      {activeTab === 'sessions' ? (
        <Panel className="overflow-hidden">
          <PanelHeader>
            <div>
              <PanelTitle>Sessions</PanelTitle>
              <PanelDescription className="mt-1">
                Sessions started through channels and the API. Playground
                sessions stay in the playground.
              </PanelDescription>
            </div>
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Clock3 className="size-3.5" /> Refreshes automatically
            </div>
          </PanelHeader>
          <ResourceTable
            columns={sessionColumns}
            rows={externalSessions}
            rowKey={(session) => session.id}
            loading={sessions.isLoading}
            onRowClick={(session) => {
              if (!project) return
              void navigate(
                `/projects/${encodeURIComponent(project.project.id)}/sessions/${encodeURIComponent(session.id)}?${searchParams.toString()}`,
              )
            }}
            empty={
              <EmptyState
                icon={TerminalSquare}
                title="No channel or API sessions yet"
                description="Sessions created outside the playground will appear here."
              />
            }
          />
        </Panel>
      ) : null}

      {activeTab === 'channels' ? (
        <Panel className="overflow-hidden">
          <PanelHeader>
            <div>
              <PanelTitle>Channels</PanelTitle>
              <PanelDescription className="mt-1">
                Messaging channels connected to this deployed agent.
              </PanelDescription>
            </div>
          </PanelHeader>
          {agent && activeDeployment.data ? (
            declaredChannels.length ? (
              declaredChannels.map((declaredChannel) => (
                <ManagedSlackWizard
                  key={declaredChannel.id}
                  agentId={agent.id}
                  alias={activeDeployment.data.alias}
                  agentName={displayManagedAgentName(agent)}
                  channelName={
                    declaredChannel.displayName ?? declaredChannel.id
                  }
                  connection={activeAliasChannels.find(
                    (channel) => channel.channelId === declaredChannel.id,
                  )}
                  channelId={declaredChannel.id}
                  destinations={Object.keys(declaredChannel.destinations)}
                />
              ))
            ) : (
              <ManagedSlackWizard
                agentId={agent.id}
                alias={activeDeployment.data.alias}
                agentName={displayManagedAgentName(agent)}
                connection={activeAliasChannel}
              />
            )
          ) : (
            <PanelContent className="text-muted-foreground text-sm">
              Loading channels…
            </PanelContent>
          )}
        </Panel>
      ) : null}

      {activeTab === 'schedules' && project ? (
        <ProjectResourcePanel
          title="Schedules"
          description="Functions in this project that run on a cron schedule."
          values={project.schedules}
        />
      ) : null}

      {activeTab === 'secrets' && project ? (
        <ManagedProjectSecrets
          projectId={project.project.id}
          agents={project.project.agents}
          environment={environment}
        />
      ) : null}
    </div>
  )
}

function ProjectResourcePanel({
  title,
  description,
  values,
}: {
  title: string
  description: string
  values: unknown[]
}) {
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>{title}</PanelTitle>
          <PanelDescription className="mt-1">{description}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent>
        {values.length ? (
          <pre className="bg-muted overflow-x-auto rounded-md border p-4 text-xs leading-5">
            {JSON.stringify(values.length === 1 ? values[0] : values, null, 2)}
          </pre>
        ) : (
          <p className="text-muted-foreground text-sm">Nothing here yet.</p>
        )}
      </PanelContent>
    </Panel>
  )
}
