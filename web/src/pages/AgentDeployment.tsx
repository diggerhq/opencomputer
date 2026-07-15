import { Fragment, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
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
} from 'lucide-react'
import {
  ApiError,
  deployFromGithub,
  getAgent,
  getAgentDeployment,
  getAgentDeploymentLogs,
  type AgentDeployment,
  type AgentDeploymentLog,
} from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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

  return (
    <div>
      <ol className="grid grid-cols-3" aria-label="Deployment phases">
        {PHASES.map((phase, index) => {
          const done = allDone || (current >= 0 && index < current)
          const active = !allDone && index === current
          const phaseFailed = active && failed
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
              className={cn(
                'relative flex flex-col items-center gap-2 text-center',
                index > 0 &&
                  "before:bg-border before:absolute before:top-3.5 before:right-1/2 before:h-px before:w-full before:-translate-x-3.5 before:content-['']",
              )}
            >
              <span
                className={cn(
                  'bg-panel relative z-10 flex size-7 items-center justify-center rounded-full border',
                  phaseFailed
                    ? 'border-status-error text-status-error'
                    : done || active
                      ? 'border-status-running text-status-running'
                      : 'text-muted-foreground border-border',
                )}
              >
                <Icon
                  className={cn(
                    'size-3.5',
                    active &&
                      !failed &&
                      'animate-spin motion-reduce:animate-none',
                  )}
                  aria-hidden
                />
              </span>
              <span
                className={cn(
                  'text-xs',
                  active || done ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {phase.label}
                {active ? (
                  <span className="sr-only">
                    {phaseFailed ? ', failed' : ', in progress'}
                  </span>
                ) : done ? (
                  <span className="sr-only">, complete</span>
                ) : (
                  <span className="sr-only">, pending</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
      {terminalWithoutPhase ? (
        <p className="text-status-error mt-4 flex items-center gap-1.5 text-xs">
          <CircleAlert className="size-3.5" aria-hidden />
          The deployment failed before a phase was recorded.
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

function Outcome({ deployment }: { deployment: AgentDeployment }) {
  const outcome = agentDeploymentOutcome(deployment)

  if (outcome.kind === 'success') {
    return (
      <Alert className="bg-status-running-bg text-status-running border-status-running/25">
        <Check className="size-4" />
        <AlertTitle>{outcome.title}</AlertTitle>
        <AlertDescription className="text-status-running">
          {outcome.description}
        </AlertDescription>
      </Alert>
    )
  }

  if (outcome.kind === 'error') {
    return (
      <Alert variant="destructive">
        <CircleAlert className="size-4" />
        <AlertTitle>{outcome.title}</AlertTitle>
        <AlertDescription>{outcome.description}</AlertDescription>
      </Alert>
    )
  }

  if (outcome.kind === 'info') {
    return (
      <Alert>
        <AlertTitle>{outcome.title}</AlertTitle>
        <AlertDescription>{outcome.description}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert>
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
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
  const commitUrl = deployment.source_relation?.commit_url ?? undefined
  const canViewCommit =
    deployment.allowed_actions.includes('view_commit') && !!commitUrl
  const canOpenAgent = deployment.allowed_actions.includes('open_agent')
  const canStartSession = deployment.allowed_actions.includes('start_session')
  const canDeployLatest = deployment.allowed_actions.includes('deploy_latest')
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
          <div className="flex flex-wrap gap-2">
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
            {canDeployLatest ? (
              <Button
                size="sm"
                variant={canStartSession ? 'outline' : 'default'}
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
            {canStartSession ? (
              <Button size="sm" asChild>
                <Link to={`/agents/${agentId}/sessions`}>
                  Start session
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

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

      <Outcome deployment={deployment} />

      {!terminal ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Progress</PanelTitle>
              <PanelDescription className="mt-1" aria-live="polite">
                {PHASES[phaseIndex(deployment)]?.label ?? 'Waiting to start'}
              </PanelDescription>
            </div>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Clock className="size-3.5" />
              {formatDuration(deployment)}
            </span>
          </PanelHeader>
          <PanelContent>
            <DeploymentPhases deployment={deployment} />
          </PanelContent>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Build and deploy log</PanelTitle>
            <PanelDescription className="mt-1">
              Persisted output from source, install, build, and deployment.
            </PanelDescription>
          </div>
          {deployment.log_truncated ? (
            <span className="text-status-pending text-xs">
              Output truncated
            </span>
          ) : null}
        </PanelHeader>
        <PanelContent>
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
