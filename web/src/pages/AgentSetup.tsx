import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Loader2,
  MessageSquare,
  X,
} from 'lucide-react'
import {
  authorizeManagedSlack,
  getAgent,
  getAgentDeployment,
  getManagedSlackConnection,
  getSession,
  getSessionEvents,
  getSessions,
  type SessionEvent,
} from '@/api/client'
import {
  DeploymentLog,
  DeploymentPhases,
} from '@/components/deployment-progress'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { MessageBubble } from '@/components/session-conversation'
import { ManagedSlackWorkspaceClaims } from '@/components/managed-slack-workspace-claims'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentDeploymentLogs } from '@/hooks/use-agent-deployment-logs'
import {
  agentSetupPresentation,
  type AgentSetupStage,
} from '@/lib/agent-setup-presentation'
import { agentDeploymentOutcome } from '@/lib/agent-deployment-outcome'
import {
  agentCanStartNewSession,
  agentDeploymentDisplayStatus,
} from '@/lib/agent-deployment-status'
import { deploymentStage } from '@/lib/deployment-slack-cta'
import { notifyError } from '@/lib/errors'
import { managedSlackNotice } from '@/lib/managed-slack-notice'
import { useManagedSlackConnections } from '@/lib/managed-slack-connections'
import { latestManagedSlackSession } from '@/lib/managed-slack-session'
import {
  bodyText,
  isTerminalSessionStatus,
  isTurnInput,
} from '@/lib/session-turns'
import { cn } from '@/lib/utils'

function setupStage(input: {
  hasDeployment: boolean
  state?: string
  terminal?: boolean
  loadFailed: boolean
  agentReady: boolean
  agentDeploymentState?: string
}): AgentSetupStage {
  if (!input.hasDeployment) {
    if (input.agentReady) return 'ready'
    if (
      [
        'failed',
        'canceled',
        'superseded',
        'skipped',
        'unverified',
        'not_deployed',
      ].includes(input.agentDeploymentState ?? '')
    ) {
      return 'failed'
    }
    return 'preparing'
  }
  if (input.loadFailed) return 'failed'
  if (!input.state) return 'preparing'
  const stage = deploymentStage(input.state, input.terminal ?? false)
  return stage === 'running' ? 'preparing' : stage
}

function previewText(text: string | null, max = 360): string | null {
  if (!text || text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

function conversationSettled(events: SessionEvent[] | undefined): boolean {
  return !!events?.some(
    (event) =>
      event.type === 'agent.message' ||
      event.type.toLowerCase().includes('error'),
  )
}

export default function AgentSetup() {
  const { agentId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [logsOpen, setLogsOpen] = useState(false)
  const deploymentId = searchParams.get('deployment') ?? ''
  const oauthResult = searchParams.get('slack')
  const connectedAgentId = searchParams.get('connected_agent')
  const sameOwnerConnectedAgentId =
    oauthResult === 'workspace_already_connected' &&
    connectedAgentId &&
    /^agt_[0-9a-f]{24}$/.test(connectedAgentId)
      ? connectedAgentId
      : null

  const agentQuery = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
    refetchInterval: (query) =>
      !deploymentId &&
      query.state.data &&
      !agentCanStartNewSession(query.state.data)
        ? 1500
        : false,
  })
  const deploymentQuery = useQuery({
    queryKey: ['agent-deployment', agentId, deploymentId],
    queryFn: () => getAgentDeployment(agentId, deploymentId),
    enabled: !!agentId && !!deploymentId,
    refetchInterval: (query) => (query.state.data?.terminal ? false : 1500),
  })
  const managedSlackQuery = useQuery({
    queryKey: ['slack', 'managed', agentId],
    queryFn: () => getManagedSlackConnection(agentId),
    enabled: !!agentId,
    refetchInterval: (query) =>
      oauthResult === 'connected' && query.state.data?.status !== 'active'
        ? 1000
        : false,
    refetchOnWindowFocus: 'always',
  })
  const managedSlackConnectionsQuery = useManagedSlackConnections(!!agentId)
  const connectedAgentQuery = useQuery({
    queryKey: ['agent', sameOwnerConnectedAgentId],
    queryFn: () => getAgent(sameOwnerConnectedAgentId!),
    enabled: !!sameOwnerConnectedAgentId,
  })
  const stage = setupStage({
    hasDeployment: !!deploymentId,
    state: deploymentQuery.data?.state,
    terminal: deploymentQuery.data?.terminal,
    loadFailed: deploymentQuery.isError,
    agentReady: agentQuery.data
      ? agentCanStartNewSession(agentQuery.data)
      : false,
    agentDeploymentState: agentQuery.data
      ? agentDeploymentDisplayStatus(agentQuery.data)
      : undefined,
  })
  const activationReady =
    stage === 'ready' && managedSlackQuery.data?.status === 'active'
  const activationConnectedAt = managedSlackQuery.data?.connected_at ?? null
  const activationSessionsQuery = useQuery({
    queryKey: [
      'agent-setup',
      'managed-slack-sessions',
      agentId,
      activationConnectedAt,
    ],
    queryFn: () =>
      getSessions({
        agent: agentId,
        after: activationConnectedAt ?? undefined,
        limit: 100,
      }),
    enabled: !!agentId && activationReady,
    refetchInterval: (query) =>
      latestManagedSlackSession(query.state.data ?? [], activationConnectedAt)
        ? false
        : 1500,
    refetchOnWindowFocus: 'always',
  })
  const activationSession = latestManagedSlackSession(
    activationSessionsQuery.data ?? [],
    activationConnectedAt,
  )
  const activationEventsQuery = useQuery({
    queryKey: ['session-events', activationSession?.id],
    queryFn: () => getSessionEvents(activationSession!.id),
    enabled: !!activationSession,
    refetchInterval: (query) =>
      conversationSettled(query.state.data) ? false : 1000,
    refetchOnWindowFocus: 'always',
  })
  const activationEvents = activationEventsQuery.data ?? []
  const activationInput = activationEvents.find(isTurnInput)
  const activationReply = activationEvents.find(
    (event) => event.type === 'agent.message',
  )
  const activationError = activationEvents.find((event) =>
    event.type.toLowerCase().includes('error'),
  )
  const activationSessionQuery = useQuery({
    queryKey: ['session', activationSession?.id],
    queryFn: () => getSession(activationSession!.id),
    enabled: !!activationSession,
    refetchInterval: (query) =>
      conversationSettled(activationEvents) ||
      isTerminalSessionStatus(query.state.data?.status)
        ? false
        : 1500,
    refetchOnWindowFocus: 'always',
  })
  const logsQuery = useAgentDeploymentLogs({
    agentId,
    deploymentId,
    enabled: logsOpen,
    terminal: deploymentQuery.data?.terminal ?? false,
  })
  const authorizeManagedSlackMutation = useMutation({
    mutationFn: () => authorizeManagedSlack(agentId, deploymentId || undefined),
    onSuccess: (result) => {
      if ('authorize_url' in result) {
        window.location.assign(result.authorize_url)
        return
      }
      queryClient.setQueryData(['slack', 'managed', agentId], result)
    },
    onError: (error) =>
      notifyError("Couldn't start the Slack connection.", error),
  })

  if (agentQuery.isLoading || (deploymentId && deploymentQuery.isLoading)) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <Skeleton className="h-16 w-72 max-w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (agentQuery.isError || !agentQuery.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <Alert variant="destructive">
          <AlertTitle>Agent setup could not be loaded</AlertTitle>
          <AlertDescription>
            {agentQuery.error instanceof Error
              ? agentQuery.error.message
              : 'Check that the agent exists and belongs to your account.'}
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild>
          <Link to="/agents">Back to agents</Link>
        </Button>
      </div>
    )
  }

  const agent = agentQuery.data
  const deployment = deploymentQuery.data
  const managedSlack = managedSlackQuery.data
  const managedSlackStatus = managedSlackQuery.isSuccess
    ? (managedSlack?.status ?? null)
    : undefined
  const presentation = agentSetupPresentation({
    agentName: agent.name,
    stage,
    managedStatus: managedSlackStatus,
    openUrl: managedSlack?.open_url,
    connecting: authorizeManagedSlackMutation.isPending,
    activated: !!activationSession,
  })
  const hasOtherManagedSlackConnections =
    managedSlackConnectionsQuery.data?.some(
      (connection) => connection.agent.id !== agentId,
    ) ?? false
  const checkingManagedSlackConnections =
    presentation.action === 'connect' && managedSlackConnectionsQuery.isLoading
  const managedWorkspace =
    managedSlack?.workspace?.name ?? managedSlack?.workspace?.id
  const waitingForConnectedState =
    oauthResult === 'connected' && managedSlack?.status !== 'active'
  const waitingForConnectedAgent =
    !!sameOwnerConnectedAgentId && connectedAgentQuery.isLoading
  const slackNotice =
    waitingForConnectedState || waitingForConnectedAgent
      ? null
      : managedSlackNotice(
          oauthResult,
          managedWorkspace,
          agent.name,
          connectedAgentQuery.data?.name,
        )
  const connectedAgentHref =
    connectedAgentQuery.data && sameOwnerConnectedAgentId
      ? `/agents/${encodeURIComponent(sameOwnerConnectedAgentId)}`
      : null
  const dismissSlackNotice = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('slack')
    next.delete('connected_agent')
    setSearchParams(next, { replace: true })
  }
  const deploymentHref = deploymentId
    ? `/agents/${agentId}/deployments/${deploymentId}`
    : null
  const deploymentOutcome = deployment
    ? agentDeploymentOutcome(deployment)
    : null

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            Set up {agent.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            Deploy the agent, connect Slack, and start the first conversation.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            <StatusBadge
              status={
                stage === 'preparing' ? (deployment?.state ?? 'pending') : stage
              }
              label={
                stage === 'ready'
                  ? 'Agent ready'
                  : stage === 'failed'
                    ? 'Deployment failed'
                    : 'Agent preparing'
              }
            />
            <StatusBadge
              status={managedSlackStatus === 'active' ? 'active' : 'stopped'}
              label={
                managedSlackStatus === 'active'
                  ? 'Slack connected'
                  : 'Slack not connected'
              }
            />
          </div>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/agents/${agentId}`}>Finish later</Link>
        </Button>
      </header>

      {slackNotice ? (
        <Alert variant={slackNotice.destructive ? 'destructive' : 'default'}>
          <AlertTitle>{slackNotice.title}</AlertTitle>
          {slackNotice.description || connectedAgentHref ? (
            <AlertDescription>
              {slackNotice.description}{' '}
              {connectedAgentHref ? (
                <Link to={connectedAgentHref}>Open connected agent</Link>
              ) : null}
            </AlertDescription>
          ) : null}
          <AlertAction>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss Slack notice"
              onClick={dismissSlackNotice}
            >
              <X aria-hidden />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <Panel>
        <PanelContent className="px-5 py-5 sm:px-6 sm:py-6">
          <div className="flex max-w-2xl items-start gap-3">
            <div
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-md',
                stage === 'failed'
                  ? 'bg-status-error-bg text-status-error'
                  : presentation.action === 'open'
                    ? 'bg-status-running-bg text-status-running'
                    : 'bg-muted text-foreground',
              )}
            >
              {stage === 'failed' ? (
                <CircleAlert className="size-5" aria-hidden />
              ) : presentation.action === 'open' ? (
                <CheckCircle2 className="size-5" aria-hidden />
              ) : (
                <MessageSquare className="size-5" aria-hidden />
              )}
            </div>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {presentation.announcement}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold tracking-tight">
                {presentation.title}
              </h2>
              <p className="text-muted-foreground mt-1.5 max-w-xl text-sm leading-relaxed">
                {presentation.description}
              </p>

              {presentation.action === 'connect' ? (
                <ManagedSlackWorkspaceClaims
                  currentAgentId={agentId}
                  currentAgentName={agent.name}
                  query={managedSlackConnectionsQuery}
                  className="mt-4"
                />
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {presentation.action === 'open' && managedSlack?.open_url ? (
                  <>
                    <Button asChild>
                      <a
                        href={managedSlack.open_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {presentation.label}
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                    {activationSession ? (
                      <Button variant="outline" asChild>
                        <Link to={`/agents/${agentId}`}>View agent</Link>
                      </Button>
                    ) : null}
                  </>
                ) : presentation.action === 'connect' ||
                  presentation.action === 'reconnect' ||
                  presentation.action === 'connecting' ? (
                  <Button
                    disabled={
                      authorizeManagedSlackMutation.isPending ||
                      checkingManagedSlackConnections
                    }
                    onClick={() => authorizeManagedSlackMutation.mutate()}
                  >
                    {authorizeManagedSlackMutation.isPending ||
                    checkingManagedSlackConnections ? (
                      <Loader2
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                    ) : null}
                    {checkingManagedSlackConnections
                      ? 'Checking Slack…'
                      : presentation.action === 'connect' &&
                          hasOtherManagedSlackConnections
                        ? 'Connect another workspace'
                        : presentation.label}
                  </Button>
                ) : stage === 'failed' && deploymentHref ? (
                  <Button asChild>
                    <Link to={deploymentHref}>
                      Review deployment
                      <ChevronRight className="size-4" />
                    </Link>
                  </Button>
                ) : managedSlackStatus === 'active' && stage === 'preparing' ? (
                  <span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
                    <Loader2
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                    Finishing deployment…
                  </span>
                ) : null}
                {presentation.action === 'connect' &&
                presentation.disclosure ? (
                  <div className="max-w-sm text-xs leading-relaxed">
                    <span className="text-muted-foreground">
                      Anyone in this workspace who can message the app can use
                      this agent.{' '}
                    </span>
                    <Link
                      to={`/agents/${agentId}?connect=slack`}
                      className="text-foreground underline underline-offset-4"
                    >
                      Use your own Slack app
                    </Link>
                  </div>
                ) : null}
              </div>

              {managedSlackQuery.isError && stage !== 'failed' ? (
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <span className="text-status-error">
                    Slack status is unavailable.
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void managedSlackQuery.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : presentation.status ? (
                <p className="text-muted-foreground mt-3 text-xs">
                  {presentation.status}
                </p>
              ) : null}
            </div>
          </div>
        </PanelContent>
        {activationReady ? (
          <div
            className="border-t px-5 py-4 sm:px-6"
            aria-live="polite"
            aria-atomic="false"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">
                  First Slack conversation
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  This page follows the same durable session shown elsewhere in
                  OpenComputer.
                </p>
              </div>
              {activationSession ? (
                <StatusBadge
                  status={
                    activationSessionQuery.data?.status ??
                    activationSession.status
                  }
                />
              ) : null}
            </div>

            {activationSessionsQuery.isError ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-status-error">
                  We couldn&apos;t check for your Slack message.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void activationSessionsQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : !activationSession ? (
              <div className="mt-4 flex items-start gap-3" role="status">
                <Loader2
                  className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                <div>
                  <p className="text-sm font-medium">
                    Waiting for your first Slack message
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Send a message to OpenComputer in Slack. The session and
                    reply will appear here automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                {activationEventsQuery.isError ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-status-error">
                      The session was created, but its messages could not be
                      loaded.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void activationEventsQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : activationEventsQuery.isLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-4/5" />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activationInput ? (
                      <MessageBubble
                        label="You"
                        text={
                          previewText(bodyText(activationInput)) ??
                          'Message received'
                        }
                      />
                    ) : null}
                    {activationReply ? (
                      <MessageBubble
                        label="Agent"
                        text={
                          previewText(bodyText(activationReply)) ??
                          'Reply available in the full session'
                        }
                      />
                    ) : activationError ? (
                      <div className="bg-status-error-bg/40 text-status-error rounded-md px-3 py-2 text-xs">
                        {bodyText(activationError) ??
                          'The first turn needs attention. Open the session for details.'}
                      </div>
                    ) : (
                      <div
                        className="text-muted-foreground flex items-center gap-2 text-xs"
                        role="status"
                      >
                        <Loader2
                          className="size-3.5 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                        Agent is replying…
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/sessions/${activationSession.id}`}>
                      Open session
                      <ChevronRight className="size-4" />
                    </Link>
                  </Button>
                  <Button size="sm" variant="ghost" asChild>
                    <Link to={`/agents/${agentId}/sessions`}>
                      All agent sessions
                    </Link>
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Panel>

      {deployment ? (
        <Panel>
          <PanelHeader className="flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <PanelTitle>
                {stage === 'preparing'
                  ? 'Preparing your agent'
                  : stage === 'ready'
                    ? 'Agent deployed'
                    : 'Deployment failed'}
              </PanelTitle>
              <PanelDescription className="mt-1">
                {stage === 'preparing'
                  ? 'Build and deployment continue in the background.'
                  : deploymentOutcome?.description}
              </PanelDescription>
            </div>
            <DeploymentPhases deployment={deployment} />
          </PanelHeader>
          <PanelContent className="space-y-4">
            {stage === 'failed' && deploymentOutcome ? (
              <Alert variant="destructive">
                <AlertTitle>{deploymentOutcome.title}</AlertTitle>
                <AlertDescription>
                  {deploymentOutcome.description}
                </AlertDescription>
              </Alert>
            ) : null}

            <details
              className="group rounded-md border"
              onToggle={(event) => setLogsOpen(event.currentTarget.open)}
            >
              <summary className="hover:bg-muted focus-visible:ring-ring/50 flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  className="text-muted-foreground size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                  aria-hidden
                />
                Build and deploy logs
              </summary>
              <div className="border-t p-3">
                {logsQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Logs could not be loaded</AlertTitle>
                    <AlertDescription>
                      The deployment record is still available. Retry this
                      durable log read.
                    </AlertDescription>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void logsQuery.refetch()}
                      >
                        Retry logs
                      </Button>
                    </div>
                  </Alert>
                ) : logsQuery.isLoading ? (
                  <Skeleton className="h-52 w-full" />
                ) : (
                  <DeploymentLog
                    logs={logsQuery.data?.data ?? []}
                    terminal={deployment.terminal}
                  />
                )}
              </div>
            </details>

            <div className="flex justify-end">
              <Button variant="ghost" size="sm" asChild>
                <Link to={deploymentHref!}>
                  View deployment details
                  <ChevronRight className="size-4" />
                </Link>
              </Button>
            </div>
          </PanelContent>
        </Panel>
      ) : deploymentQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Deployment status could not be loaded</AlertTitle>
          <AlertDescription>
            {deploymentQuery.error instanceof Error
              ? deploymentQuery.error.message
              : 'Open the agent to review its current deployment.'}
          </AlertDescription>
          {deploymentHref ? (
            <div className="mt-2">
              <Button variant="outline" size="sm" asChild>
                <Link to={deploymentHref}>Open deployment</Link>
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : stage === 'ready' ? (
        <div className="bg-panel flex items-center gap-3 rounded-lg border px-4 py-3">
          <CheckCircle2
            className="text-status-running size-5 shrink-0"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Agent ready</p>
            <p className="text-muted-foreground text-xs">
              Your agent is ready to use.
            </p>
          </div>
        </div>
      ) : stage === 'preparing' ? (
        <div className="bg-panel flex items-center gap-3 rounded-lg border px-4 py-3">
          <Loader2
            className="text-status-pending size-5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Preparing your agent</p>
            <p className="text-muted-foreground text-xs">
              Setup is following the latest deployment in the background.
            </p>
          </div>
        </div>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>The latest deployment needs attention</AlertTitle>
          <AlertDescription>
            Open the agent to review its deployment history and recovery
            actions.
          </AlertDescription>
          <div className="mt-2">
            <Button variant="outline" size="sm" asChild>
              <Link to={`/agents/${agentId}/deployments`}>
                Open deployments
              </Link>
            </Button>
          </div>
        </Alert>
      )}
    </div>
  )
}
