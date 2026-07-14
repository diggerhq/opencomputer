import { Fragment, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
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
} from 'lucide-react'
import {
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
import { cn } from '@/lib/utils'

const PHASES = [
  { label: 'Source', states: ['fetching', 'validating'] },
  { label: 'Install', states: ['installing'] },
  { label: 'Build', states: ['building'] },
  { label: 'Artifact', states: ['uploading'] },
  { label: 'Deploy', states: ['deploying'] },
  { label: 'Verify', states: ['verifying'] },
] as const

function errorMessage(deployment: AgentDeployment): string | undefined {
  if (deployment.error?.message) return deployment.error.message
  return undefined
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
  const queued =
    deployment.state === 'accepted' || deployment.state === 'queued'
  const terminalWithoutPhase = failed && current < 0
  const allDone = deployment.state === 'ready'

  return (
    <div>
      {queued ? (
        <p className="text-status-pending mb-4 flex items-center gap-1.5 text-sm font-medium">
          <Clock className="size-4" aria-hidden />
          Queued
          <span className="text-muted-foreground font-normal">
            Waiting for the build worker.
          </span>
        </p>
      ) : null}
      <ol
        className="grid grid-cols-3 gap-y-4 sm:grid-cols-6"
        aria-label="Deployment phases"
      >
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
                index === 3 && 'before:hidden sm:before:block',
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

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
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

function formatBytes(value: number | undefined): string {
  if (value === undefined) return 'Not available'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function Outcome({ deployment }: { deployment: AgentDeployment }) {
  if (deployment.state === 'ready') {
    return (
      <Alert className="bg-status-running-bg text-status-running border-status-running/25">
        <Check className="size-4" />
        <AlertTitle>Deployment ready</AlertTitle>
        <AlertDescription className="text-status-running">
          {deployment.revision?.number
            ? `Revision #${deployment.revision.number} is ready to run.`
            : 'The agent passed verification and is ready to run.'}
        </AlertDescription>
      </Alert>
    )
  }

  if (deployment.state === 'failed') {
    return (
      <Alert variant="destructive">
        <CircleAlert className="size-4" />
        <AlertTitle>
          {deployment.live_touched
            ? 'Live deployment could not be verified'
            : 'Deployment failed'}
        </AlertTitle>
        <AlertDescription>
          {errorMessage(deployment) ??
            (deployment.live_touched
              ? 'The live Worker may have changed. Check the persisted log before starting new work.'
              : 'The live agent was not changed. Check the persisted log and fix the repository before deploying again.')}
        </AlertDescription>
      </Alert>
    )
  }

  if (
    deployment.state === 'canceled' ||
    deployment.state === 'superseded' ||
    deployment.state === 'skipped'
  ) {
    return (
      <Alert>
        <AlertTitle>
          {deployment.state === 'skipped'
            ? 'No changes to deploy'
            : deployment.state === 'canceled'
              ? 'Deployment canceled'
              : 'Deployment superseded'}
        </AlertTitle>
        <AlertDescription>
          {deployment.state === 'skipped'
            ? 'The built result matches the active revision, so the live agent was left unchanged.'
            : 'This attempt ended without producing a new revision.'}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert>
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      <AlertTitle>Deployment in progress</AlertTitle>
      <AlertDescription>
        This page polls the durable deployment record and build log.
      </AlertDescription>
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

function Metadata({ deployment }: { deployment: AgentDeployment }) {
  const build = deployment.build
  const items = [
    [
      'Root',
      build?.root ?? deployment.source_relation?.path ?? 'Repository root',
    ],
    ['Node', build?.node ?? 'Not recorded'],
    ['npm', build?.npm ?? 'Not recorded'],
    [
      'Lockfile',
      build?.lockfile_version !== undefined
        ? `version ${build.lockfile_version}`
        : 'Not recorded',
    ],
    ['Builder', build?.builder ?? 'Not recorded'],
    ['Snapshot', build?.snapshot ?? 'Not recorded'],
    ['Artifact', build?.artifact_digest ?? 'Not available'],
    ['Artifact size', formatBytes(build?.artifact_bytes)],
    [
      'Source',
      build?.source_files !== undefined && build.source_bytes !== undefined
        ? `${build.source_files.toLocaleString()} files · ${formatBytes(build.source_bytes)}`
        : 'Not recorded',
    ],
    ['Infrastructure attempts', String(build?.attempts ?? 1)],
    ['Flue entrypoint', deployment.configuration?.entrypoint ?? 'Not recorded'],
    ['Model', deployment.configuration?.model ?? 'Not recorded'],
  ]
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <dd className="mt-1 truncate font-mono text-sm" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export default function AgentDeployment() {
  const { agentId = '', deploymentId = '' } = useParams()
  const queryClient = useQueryClient()
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
          <Link to={`/agents/${agentId}`}>
            <ArrowLeft className="size-4" />
            Back to agent
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
  const repo = deployment.source_relation?.repo?.full_name ?? undefined
  const root = deployment.source_relation?.path ?? undefined
  const ref =
    deployment.source_relation?.ref ??
    deployment.source_relation?.production_ref ??
    deployment.ref ??
    undefined
  const sha = deployment.source_relation?.sha ?? deployment.sha ?? undefined
  const commitUrl = deployment.source_relation?.commit_url ?? undefined
  const trigger =
    deployment.actor?.kind === 'ci'
      ? 'GitHub push'
      : deployment.actor?.kind === 'agent'
        ? 'Agent'
        : deployment.input_type === 'github'
          ? 'Dashboard import'
          : 'Dashboard'
  const canViewCommit =
    deployment.allowed_actions.includes('view_commit') && !!commitUrl
  const canOpenAgent = deployment.allowed_actions.includes('open_agent')
  const canStartSession = deployment.allowed_actions.includes('start_session')

  return (
    <div className="space-y-5">
      <div>
        <Link
          to={`/agents/${agentId}`}
          className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="size-4" />
          {agent?.name ? `Back to ${agent.name}` : 'Back to agent'}
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

      <Outcome deployment={deployment} />

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Progress</PanelTitle>
            <PanelDescription className="mt-1" aria-live="polite">
              Current state: {deployment.state.replace(/_/g, ' ')}
            </PanelDescription>
          </div>
          {!terminal ? (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Clock className="size-3.5" />
              {formatDuration(deployment)}
            </span>
          ) : null}
        </PanelHeader>
        <PanelContent>
          <DeploymentPhases deployment={deployment} />
        </PanelContent>
      </Panel>

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

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Build metadata</PanelTitle>
          </PanelHeader>
          <PanelContent>
            <Metadata deployment={deployment} />
          </PanelContent>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Source and result</PanelTitle>
          </PanelHeader>
          <PanelContent>
            <dl className="grid gap-y-4">
              {[
                ['Repository', repo ?? 'Not recorded'],
                ['Root', root || 'Repository root'],
                ['Branch', ref ?? 'Not recorded'],
                ['Commit', sha ?? 'Not recorded'],
                ['Trigger', trigger],
                ['Accepted', formatDate(deployment.created_at)],
                ['Started', formatDate(deployment.started_at)],
                ['Finished', formatDate(deployment.finished_at)],
                ['Duration', formatDuration(deployment)],
                [
                  'Revision',
                  deployment.revision?.number
                    ? `#${deployment.revision.number}${deployment.active ? ' · Active' : ''}`
                    : 'None',
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3"
                >
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd
                    className="truncate font-mono text-xs sm:text-right"
                    title={value}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </PanelContent>
        </Panel>
      </div>
    </div>
  )
}
