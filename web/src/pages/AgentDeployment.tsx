import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Clock,
  ExternalLink,
  GitCommitHorizontal,
  RotateCw,
  X,
} from 'lucide-react'
import {
  ApiError,
  authorizeManagedSlack,
  deployFromGithub,
  getAgent,
  getAgentDeployment,
  getDeploymentSource,
  getManagedSlackConnection,
  unlinkDeploymentSource,
  type AgentDeployment,
} from '@/api/client'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DeploymentLog,
  DeploymentPhases,
} from '@/components/deployment-progress'
import { SourceProfileChangedRecovery } from '@/components/source-profile-changed-recovery'
import { ManagedSlackWorkspaceClaims } from '@/components/managed-slack-workspace-claims'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { agentDeploymentOutcome } from '@/lib/agent-deployment-outcome'
import {
  deploymentSlackPresentation,
  deploymentStage,
} from '@/lib/deployment-slack-cta'
import { notifyError, notifySuccess } from '@/lib/errors'
import { managedSlackNotice } from '@/lib/managed-slack-notice'
import { useManagedSlackConnections } from '@/lib/managed-slack-connections'
import { cn } from '@/lib/utils'
import { useAgentDeploymentLogs } from '@/hooks/use-agent-deployment-logs'

const DEPLOY_COMMAND_STORAGE = 'oc.flue-deploy-latest-command.v1'

type DeployCommand = { fingerprint: string; key: string }

function newCommandKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `deploy-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function stableCommandKey(
  fingerprint: string,
  storageKey: string,
  memory: { current: DeployCommand | null },
): string {
  if (memory.current?.fingerprint === fingerprint) return memory.current.key

  try {
    const stored = window.sessionStorage.getItem(storageKey)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<DeployCommand>
      if (parsed.fingerprint === fingerprint && parsed.key) {
        memory.current = { fingerprint, key: parsed.key }
        return parsed.key
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  const key = newCommandKey()
  memory.current = { fingerprint, key }
  try {
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({ fingerprint, key }),
    )
  } catch {
    // The in-memory key still makes repeated submits stable for this page load.
  }
  return key
}

function formatDuration(deployment: AgentDeployment): string {
  if (deployment.timing.total_ms != null) {
    return formatMilliseconds(deployment.timing.total_ms)
  }
  const start = new Date(
    deployment.started_at ?? deployment.created_at,
  ).getTime()
  const end = deployment.finished_at
    ? new Date(deployment.finished_at).getTime()
    : deployment.terminal
      ? new Date(deployment.updated_at).getTime()
      : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return 'Not available'
  return formatMilliseconds(end - start)
}

function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function OutcomeDetail({ deployment }: { deployment: AgentDeployment }) {
  const outcome = agentDeploymentOutcome(deployment)

  if (outcome.kind === 'success' || outcome.kind === 'progress') return null

  if (outcome.kind === 'error') {
    return (
      <Alert variant="destructive">
        <CircleAlert className="size-4" />
        <AlertTitle>{outcome.title}</AlertTitle>
        <AlertDescription>{outcome.description}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert>
      <AlertTitle>{outcome.title}</AlertTitle>
      <AlertDescription>{outcome.description}</AlertDescription>
    </Alert>
  )
}

export default function AgentDeployment() {
  const { agentId = '', deploymentId = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const deployCommand = useRef<DeployCommand | null>(null)
  const deployCommandStorage = `${DEPLOY_COMMAND_STORAGE}:${agentId}`
  const deploymentQuery = useQuery({
    queryKey: ['agent-deployment', agentId, deploymentId],
    queryFn: () => getAgentDeployment(agentId, deploymentId),
    enabled: !!agentId && !!deploymentId,
    refetchInterval: (query) => (query.state.data?.terminal ? false : 1500),
  })
  const { data: agent } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
  })
  const managedSlackQuery = useQuery({
    queryKey: ['slack', 'managed', agentId],
    queryFn: () => getManagedSlackConnection(agentId),
    enabled: !!agentId,
    refetchOnWindowFocus: 'always',
  })
  const managedSlackConnectionsQuery = useManagedSlackConnections(!!agentId)
  const oauthResult = searchParams.get('slack')
  const connectedAgentId = searchParams.get('connected_agent')
  const sameOwnerConnectedAgentId =
    oauthResult === 'workspace_already_connected' &&
    connectedAgentId &&
    /^agt_[0-9a-f]{24}$/.test(connectedAgentId)
      ? connectedAgentId
      : null
  const connectedAgentQuery = useQuery({
    queryKey: ['agent', sameOwnerConnectedAgentId],
    queryFn: () => getAgent(sameOwnerConnectedAgentId!),
    enabled: !!sameOwnerConnectedAgentId,
  })
  const deploymentReportedSourceProfileChange =
    deploymentQuery.data?.error_class === 'source_profile_changed' ||
    deploymentQuery.data?.error?.class === 'source_profile_changed'
  const changedSourceQuery = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
    },
    enabled: !!agentId && deploymentReportedSourceProfileChange,
    refetchOnWindowFocus: 'always',
  })
  const logsQuery = useAgentDeploymentLogs({
    agentId,
    deploymentId,
    enabled: true,
    terminal: deploymentQuery.data?.terminal ?? false,
  })
  const deployLatestMutation = useMutation({
    mutationFn: (fingerprint: string) =>
      deployFromGithub(
        agentId,
        stableCommandKey(fingerprint, deployCommandStorage, deployCommand),
      ),
    onSuccess: ({ deployment }) => {
      deployCommand.current = null
      try {
        window.sessionStorage.removeItem(deployCommandStorage)
      } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }
      void queryClient.invalidateQueries({
        queryKey: ['agent-deployments', agentId],
      })
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void navigate(`/agents/${agentId}/deployments/${deployment.id}`)
    },
  })
  const authorizeManagedSlackMutation = useMutation({
    mutationFn: () => authorizeManagedSlack(agentId, deploymentId),
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
  const unlinkChangedSourceMutation = useMutation({
    mutationFn: () => unlinkDeploymentSource(agentId),
    onSuccess: () => {
      const source = changedSourceQuery.data
      void queryClient.invalidateQueries({
        queryKey: ['agent-deploy-source', agentId],
      })
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
      notifySuccess(
        'Repository source unlinked. Existing revisions are unchanged.',
      )
      if (source) {
        void navigate('/agents/new', {
          state: {
            repositoryImport: {
              repo: source.repo_id,
              path: source.path,
              productionRef: source.production_ref,
            },
          },
        })
      }
    },
    onError: (error) => notifyError("Couldn't unlink the repository.", error),
  })

  if (deploymentQuery.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    )
  }

  if (deploymentQuery.isError || !deploymentQuery.data) {
    return (
      <div className="space-y-5">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/agents/${agentId}/deployments`}>
            <ArrowLeft className="size-4" />
            Back to deployments
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>Deployment could not be loaded</AlertTitle>
          <AlertDescription>
            {deploymentQuery.error instanceof Error
              ? deploymentQuery.error.message
              : 'Check that the deployment exists and belongs to this agent.'}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const deployment = deploymentQuery.data
  const outcome = agentDeploymentOutcome(deployment)
  const managedSlack = managedSlackQuery.data
  const managedSlackStatus = managedSlackQuery.isSuccess
    ? (managedSlack?.status ?? null)
    : undefined
  const slackPresentation = deploymentSlackPresentation({
    deploymentState: deployment.state,
    deploymentTerminal: deployment.terminal,
    managedStatus: managedSlackStatus,
    openUrl: managedSlack?.open_url,
    connecting: authorizeManagedSlackMutation.isPending,
  })
  const stage = deploymentStage(deployment.state, deployment.terminal)
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
          agent?.name ?? 'this agent',
          connectedAgentQuery.data?.name,
        )
  const connectedAgentHref =
    connectedAgentQuery.data && sameOwnerConnectedAgentId
      ? `/agents/${encodeURIComponent(sameOwnerConnectedAgentId)}`
      : null
  const hasOtherManagedSlackConnections =
    managedSlackConnectionsQuery.data?.some(
      (connection) => connection.agent.id !== agentId,
    ) ?? false
  const checkingManagedSlackConnections =
    slackPresentation.action === 'connect' &&
    managedSlackConnectionsQuery.isLoading
  const dismissSlackNotice = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('slack')
    next.delete('connected_agent')
    setSearchParams(next, { replace: true })
  }
  const commitUrl = deployment.source_relation?.commit_url ?? undefined
  const canViewCommit =
    deployment.allowed_actions.includes('view_commit') && !!commitUrl
  const canOpenAgent = deployment.allowed_actions.includes('open_agent')
  const canStartSession =
    stage === 'ready' && deployment.allowed_actions.includes('start_session')
  const currentSourceProfileChanged =
    deploymentReportedSourceProfileChange &&
    changedSourceQuery.data?.status === 'source_profile_changed'
  // Keep routine ready/running pages focused on first use. Redeploy is the
  // recovery action here; ordinary source management remains on the agent.
  const canDeployLatest =
    stage === 'failed' &&
    !deploymentReportedSourceProfileChange &&
    deployment.allowed_actions.includes('deploy_latest')
  const deployLatestFingerprint = JSON.stringify({
    agent_id: agentId,
    repo_id: deployment.source_relation?.repo?.id ?? null,
    path: deployment.source_relation?.path ?? '',
    production_ref: deployment.source_relation?.production_ref ?? null,
  })
  const deployLatestConflict =
    deployLatestMutation.error instanceof ApiError &&
    deployLatestMutation.error.status === 409

  return (
    <div className="space-y-5">
      <div>
        <Link
          to={`/agents/${agentId}/deployments`}
          className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="size-4" />
          {agent?.name
            ? `Back to ${agent.name} deployments`
            : 'Back to deployments'}
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                Deployment
              </h1>
              <StatusBadge status={deployment.state} />
            </div>
            <p className="text-muted-foreground mt-1 font-mono text-xs">
              {deployment.id}
            </p>
          </div>
          <div className="flex max-w-xl flex-col gap-1.5 sm:items-end">
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {slackPresentation.announcement}
            </span>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {canViewCommit ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={commitUrl} target="_blank" rel="noreferrer">
                    <GitCommitHorizontal className="size-4" />
                    View commit
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              ) : null}
              {canOpenAgent ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/agents/${agentId}`}>Open agent</Link>
                </Button>
              ) : null}
              {canStartSession ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/agents/${agentId}/sessions`}>
                    Start session
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              ) : null}
              {canDeployLatest ? (
                <Button
                  size="sm"
                  variant={stage === 'failed' ? 'default' : 'outline'}
                  disabled={deployLatestMutation.isPending}
                  onClick={() =>
                    deployLatestMutation.mutate(deployLatestFingerprint)
                  }
                >
                  <RotateCw
                    className={cn(
                      'size-4',
                      deployLatestMutation.isPending &&
                        'animate-spin motion-reduce:animate-none',
                    )}
                  />
                  {deployLatestMutation.isPending
                    ? 'Starting deployment…'
                    : 'Deploy latest'}
                </Button>
              ) : null}
              {slackPresentation.action === 'open' && managedSlack?.open_url ? (
                <Button size="sm" asChild>
                  <a
                    href={managedSlack.open_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Slack
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              ) : slackPresentation.action === 'connect' ||
                slackPresentation.action === 'reconnect' ||
                slackPresentation.action === 'connecting' ? (
                <Button
                  size="sm"
                  disabled={
                    authorizeManagedSlackMutation.isPending ||
                    checkingManagedSlackConnections
                  }
                  onClick={() => authorizeManagedSlackMutation.mutate()}
                >
                  {checkingManagedSlackConnections
                    ? 'Checking Slack…'
                    : slackPresentation.action === 'connect' &&
                        hasOtherManagedSlackConnections
                      ? 'Connect another workspace'
                      : slackPresentation.label}
                </Button>
              ) : null}
            </div>
            {slackPresentation.disclosure ? (
              <p className="text-muted-foreground max-w-sm text-xs leading-relaxed sm:text-right">
                Anyone in this Slack workspace who can message the app can use
                this agent.
              </p>
            ) : managedSlackQuery.isError && stage !== 'failed' ? (
              <div className="flex items-center gap-2 text-xs">
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
            ) : null}
          </div>
        </div>
      </div>

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

      {slackPresentation.action === 'connect' && agent ? (
        <Panel>
          <PanelContent>
            <ManagedSlackWorkspaceClaims
              currentAgentId={agentId}
              currentAgentName={agent.name}
              query={managedSlackConnectionsQuery}
              className="border-t-0 pt-0"
            />
          </PanelContent>
        </Panel>
      ) : null}

      {deployLatestMutation.isError ? (
        <Alert variant="destructive">
          <CircleAlert className="size-4" />
          <AlertTitle>
            {deployLatestConflict
              ? 'Repository needs attention'
              : 'Deployment could not start'}
          </AlertTitle>
          <AlertDescription>
            {deployLatestMutation.error instanceof Error
              ? deployLatestMutation.error.message
              : 'No new deployment was started. Retry when the repository is available.'}
          </AlertDescription>
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader className="flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <PanelTitle>Deployment log</PanelTitle>
            <PanelDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span
                className={cn(outcome.kind === 'error' && 'text-status-error')}
              >
                {outcome.title}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="size-3" aria-hidden />
                {formatDuration(deployment)}
                {!deployment.terminal ? ' elapsed' : ''}
              </span>
              {deployment.log_truncated ? (
                <span className="text-status-pending">Output truncated</span>
              ) : null}
            </PanelDescription>
          </div>
          <div className="space-y-1.5 sm:text-right">
            <DeploymentPhases deployment={deployment} />
            {slackPresentation.status ? (
              <p className="text-muted-foreground text-xs">
                {slackPresentation.status}
              </p>
            ) : null}
          </div>
        </PanelHeader>
        <PanelContent className="space-y-3">
          {currentSourceProfileChanged && changedSourceQuery.data ? (
            <SourceProfileChangedRecovery
              source={changedSourceQuery.data}
              pending={unlinkChangedSourceMutation.isPending}
              onUnlink={() => unlinkChangedSourceMutation.mutate()}
            />
          ) : deploymentReportedSourceProfileChange &&
            changedSourceQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <OutcomeDetail deployment={deployment} />
          )}
          {logsQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Log could not be loaded</AlertTitle>
              <AlertDescription>
                The deployment record is still available. Retry this durable log
                read.
              </AlertDescription>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void logsQuery.refetch()}
                >
                  Retry log
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
        </PanelContent>
      </Panel>
    </div>
  )
}
