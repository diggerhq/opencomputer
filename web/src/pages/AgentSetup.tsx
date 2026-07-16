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
import { deploymentStage } from '@/lib/deployment-slack-cta'
import { notifyError } from '@/lib/errors'
import { managedSlackNotice } from '@/lib/managed-slack-notice'
import { cn } from '@/lib/utils'

function setupStage(input: {
  hasDeployment: boolean
  state?: string
  terminal?: boolean
  loadFailed: boolean
}): AgentSetupStage {
  if (!input.hasDeployment) return 'ready'
  if (input.loadFailed) return 'failed'
  if (!input.state) return 'preparing'
  const stage = deploymentStage(input.state, input.terminal ?? false)
  return stage === 'running' ? 'preparing' : stage
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
  const connectedAgentQuery = useQuery({
    queryKey: ['agent', sameOwnerConnectedAgentId],
    queryFn: () => getAgent(sameOwnerConnectedAgentId!),
    enabled: !!sameOwnerConnectedAgentId,
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
  const stage = setupStage({
    hasDeployment: !!deploymentId,
    state: deployment?.state,
    terminal: deployment?.terminal,
    loadFailed: deploymentQuery.isError,
  })
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
  })
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
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Agent setup
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            Set up {agent.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
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
        <PanelContent className="px-6 py-7 sm:px-8 sm:py-9">
          <div className="max-w-2xl">
            <div
              className={cn(
                'mb-5 flex size-10 items-center justify-center rounded-md',
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
            <h2 className="text-2xl font-semibold tracking-tight">
              {presentation.title}
            </h2>
            <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed">
              {presentation.description}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {presentation.action === 'open' && managedSlack?.open_url ? (
                <Button size="lg" className="h-10 px-5" asChild>
                  <a
                    href={managedSlack.open_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Slack
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              ) : presentation.action === 'connect' ||
                presentation.action === 'reconnect' ||
                presentation.action === 'connecting' ? (
                <Button
                  size="lg"
                  className="h-10 px-5"
                  disabled={authorizeManagedSlackMutation.isPending}
                  onClick={() => authorizeManagedSlackMutation.mutate()}
                >
                  {authorizeManagedSlackMutation.isPending ? (
                    <Loader2
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : null}
                  {presentation.label}
                </Button>
              ) : stage === 'failed' && deploymentHref ? (
                <Button size="lg" className="h-10 px-5" asChild>
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
              {presentation.action === 'connect' && presentation.disclosure ? (
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
              <div className="mt-4 flex items-center gap-2 text-xs">
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
              <p className="text-muted-foreground mt-4 text-xs">
                {presentation.status}
              </p>
            ) : null}
          </div>
        </PanelContent>
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
      ) : (
        <div className="bg-panel flex items-center gap-3 rounded-lg border px-4 py-3">
          <CheckCircle2
            className="text-status-running size-5 shrink-0"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Agent ready</p>
            <p className="text-muted-foreground text-xs">
              Your manually configured agent is ready to use.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
