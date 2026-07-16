import { Fragment, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  Clock,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  RotateCw,
  X,
} from 'lucide-react'
import {
  ApiError,
  authorizeManagedSlack,
  deployFromGithub,
  getAgent,
  getAgentDeployment,
  getAgentDeploymentLogs,
  getManagedSlackConnection,
  type AgentDeployment,
  type AgentDeploymentLog,
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
import { notifyError } from '@/lib/errors'
import { managedSlackNotice } from '@/lib/managed-slack-notice'
import { cn } from '@/lib/utils'

const PHASES = [
  {
    label: 'Prepare',
    states: [
      'accepted',
      'queued',
      'fetching',
      'validating',
      'installing',
      'source',
      'install',
    ],
  },
  { label: 'Build', states: ['building', 'uploading', 'build', 'artifact'] },
  { label: 'Deploy', states: ['deploying', 'verifying', 'deploy', 'verify'] },
] as const
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

function failedPhase(deployment: AgentDeployment): string | undefined {
  const phase = deployment.error?.phase?.toLowerCase()
  if (phase) return phase
  const errorClass = deployment.error_class?.toLowerCase() ?? ''
  return PHASES.find(({ states, label }) =>
    [...states, label.toLowerCase()].some((state) =>
      errorClass.includes(state),
    ),
  )?.label.toLowerCase()
}

function phaseIndex(deployment: AgentDeployment): number {
  if (deployment.state === 'ready') return PHASES.length
  const state =
    deployment.state === 'failed'
      ? failedPhase(deployment)
      : deployment.phase.toLowerCase()
  return PHASES.findIndex(
    ({ label, states }) =>
      label.toLowerCase() === state || states.some((item) => item === state),
  )
}

function DeploymentPhases({ deployment }: { deployment: AgentDeployment }) {
  const current = phaseIndex(deployment)
  const failed = deployment.state === 'failed'
  const terminalWithoutPhase = failed && current < 0
  const allDone = deployment.state === 'ready'
  const activeLabel = PHASES[current]?.label
  const liveAnnouncement = allDone
    ? 'All deployment phases complete.'
    : terminalWithoutPhase
      ? 'The deployment failed before a phase was recorded.'
      : activeLabel
        ? `${activeLabel} ${failed ? 'failed' : deployment.terminal ? 'ended' : 'in progress'}.`
        : 'Waiting for deployment to start.'

  return (
    <div className="shrink-0">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </span>
      <ol
        className="flex flex-wrap items-center gap-y-1.5 sm:justify-end"
        aria-label="Deployment phases"
      >
        {PHASES.map((phase, index) => {
          const done = allDone || (current >= 0 && index < current)
          const active = !allDone && !deployment.terminal && index === current
          const terminalPhase =
            !allDone && deployment.terminal && index === current
          const phaseFailed = terminalPhase && failed
          const Icon = phaseFailed
            ? CircleAlert
            : done
              ? Check
              : active
                ? Loader2
                : Circle
          return (
            <li
              key={phase.label}
              className="flex items-center"
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] font-medium',
                  phaseFailed
                    ? 'text-status-error'
                    : done || active
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'size-3',
                    phaseFailed && 'text-status-error',
                    done && 'text-status-running',
                    active && 'text-status-pending',
                    active &&
                      !failed &&
                      'animate-spin motion-reduce:animate-none',
                  )}
                  aria-hidden
                />
                {phase.label}
                {phaseFailed ? (
                  <span className="sr-only">, failed</span>
                ) : active ? (
                  <span className="sr-only">, in progress</span>
                ) : done ? (
                  <span className="sr-only">, complete</span>
                ) : terminalPhase ? (
                  <span className="sr-only">, ended here</span>
                ) : (
                  <span className="sr-only">, pending</span>
                )}
              </span>
              {index < PHASES.length - 1 ? (
                <span className="bg-border mx-2 h-px w-3" aria-hidden="true" />
              ) : null}
            </li>
          )
        })}
      </ol>
      {terminalWithoutPhase ? (
        <p className="text-status-error mt-1.5 flex items-center gap-1 text-[11px] sm:justify-end">
          <CircleAlert className="size-3.5" aria-hidden />
          Phase unavailable
        </p>
      ) : null}
    </div>
  )
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

function DeploymentLog({
  logs,
  terminal,
}: {
  logs: AgentDeploymentLog[]
  terminal: boolean
}) {
  if (!logs.length) {
    return (
      <div className="text-code-muted bg-code flex min-h-52 items-center justify-center rounded-md px-4 py-8 font-mono text-xs">
        {terminal
          ? 'No build output was recorded.'
          : 'Waiting for build output…'}
      </div>
    )
  }

  return (
    <div
      className="bg-code text-code-foreground max-h-[32rem] overflow-auto rounded-md py-3 font-mono text-xs"
      aria-label="Build and deploy log"
    >
      {logs.map((entry, index) => {
        const phaseChanged =
          index === 0 || entry.phase !== logs[index - 1]?.phase
        return (
          <Fragment key={entry.seq}>
            {phaseChanged ? (
              <div className="text-code-muted border-code-border mt-2 border-y px-4 py-1.5 first:mt-0">
                {entry.phase}
              </div>
            ) : null}
            <div className="grid grid-cols-[3rem_4.5rem_minmax(0,1fr)] gap-2 px-4 py-0.5">
              <span className="text-code-muted text-right select-none">
                {entry.seq}
              </span>
              <span
                className={cn(
                  'select-none',
                  entry.stream === 'stderr'
                    ? 'text-red-300'
                    : 'text-code-muted',
                )}
              >
                {entry.stream}
              </span>
              <span className="min-w-0 break-words whitespace-pre-wrap">
                {entry.chunk}
              </span>
            </div>
          </Fragment>
        )
      })}
    </div>
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
  const logQueryKey = ['agent-deployment-logs', agentId, deploymentId] as const
  const logsQuery = useQuery({
    queryKey: logQueryKey,
    queryFn: async () => {
      const previous = queryClient.getQueryData<{
        data: AgentDeploymentLog[]
        cursor: string | null
      }>(logQueryKey)
      const data = previous?.data ? [...previous.data] : []
      const seen = new Set(data.map((entry) => entry.cursor))
      let cursor = previous?.cursor ?? null
      let hasMore = false
      do {
        const page = await getAgentDeploymentLogs(agentId, deploymentId, {
          after: cursor ?? undefined,
          limit: 500,
        })
        for (const entry of page.data) {
          if (!seen.has(entry.cursor)) {
            seen.add(entry.cursor)
            data.push(entry)
          }
        }
        const nextCursor = page.next_cursor
        hasMore = page.has_more && !!nextCursor && nextCursor !== cursor
        if (nextCursor) cursor = nextCursor
      } while (hasMore)
      return { data, cursor }
    },
    enabled: !!agentId && !!deploymentId,
    refetchInterval: deploymentQuery.data?.terminal ? false : 1500,
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
    onSuccess: ({ authorize_url }) => {
      window.location.assign(authorize_url)
    },
    onError: (error) =>
      notifyError("Couldn't start the Slack connection.", error),
  })

  const terminal = deploymentQuery.data?.terminal ?? false
  const refetchLogs = logsQuery.refetch
  useEffect(() => {
    if (terminal) void refetchLogs()
    // One final durable read when the deployment terminalizes.
  }, [terminal, refetchLogs])

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
  const oauthResult = searchParams.get('slack')
  const connectedAgentId = searchParams.get('connected_agent')
  const managedWorkspace =
    managedSlack?.workspace?.name ?? managedSlack?.workspace?.id
  const slackNotice = managedSlackNotice(
    oauthResult,
    managedWorkspace,
    agent?.name ?? 'this agent',
  )
  const connectedAgentHref =
    oauthResult === 'workspace_already_connected' &&
    connectedAgentId?.startsWith('agt_')
      ? `/agents/${encodeURIComponent(connectedAgentId)}`
      : null
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
  // Keep routine ready/running pages focused on first use. Redeploy is the
  // recovery action here; ordinary source management remains on the agent.
  const canDeployLatest =
    stage === 'failed' && deployment.allowed_actions.includes('deploy_latest')
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
                  disabled={authorizeManagedSlackMutation.isPending}
                  onClick={() => authorizeManagedSlackMutation.mutate()}
                >
                  {slackPresentation.label}
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
          <OutcomeDetail deployment={deployment} />
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
