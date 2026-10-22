import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getManagedAgentSession,
  getManagedMemoryDocument,
} from '../api'
import {
  cellDocumentId,
  parseCellFinding,
  SECURITY_FINDINGS_RESOURCE,
  type CellFinding,
  type CveDisposition,
  type LaunchedCell,
  type SwarmCell,
} from './catalog'

// A cell is settled when its worker has either saved a verdict or its session
// has stopped without one. We poll both the run's sessions (for liveness) and
// each cell's findings document (for the verdict) until every cell settles.
type CellState = {
  cell: SwarmCell
  sessionStatus?: string
  finding: CellFinding | null
}

function isSessionSettled(status: string | undefined): boolean {
  return status === 'ended' || status === 'failed' || status === 'cancelled'
}

function cellPhase(state: CellState): 'done' | 'failed' | 'running' | 'queued' {
  if (state.finding) return 'done'
  if (isSessionSettled(state.sessionStatus)) return 'failed'
  if (state.sessionStatus === 'running' || state.sessionStatus === 'idle')
    return 'running'
  return 'queued'
}

const DISPOSITION_META: Record<
  CveDisposition,
  { label: string; icon: typeof ShieldAlert; className: string }
> = {
  exposed: {
    label: 'Exposed',
    icon: ShieldAlert,
    className: 'text-destructive border-destructive/40 bg-destructive/10',
  },
  'not-exposed': {
    label: 'Not exposed',
    icon: ShieldCheck,
    className: 'text-status-running border-status-running/40 bg-status-running/10',
  },
  'needs-review': {
    label: 'Needs review',
    icon: ShieldQuestion,
    className: 'text-amber-600 border-amber-500/40 bg-amber-500/10',
  },
}

export function SwarmGrid({
  projectId,
  runId,
  cells,
}: {
  projectId: string
  runId: string
  cells: readonly LaunchedCell[]
}) {
  // The run's live sessions, fetched by the ids the launch returned so each tile
  // can show whether its worker is queued, running, or stopped.
  const sessions = useQuery({
    queryKey: ['swarm-sessions', projectId, runId],
    queryFn: async () => {
      const entries = await Promise.all(
        cells.map(async ({ sessionId }) => {
          const session = await getManagedAgentSession(sessionId)
          return [sessionId, session.status] as const
        }),
      )
      return Object.fromEntries(entries)
    },
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return 3_000
      const allSettled = cells.every(({ sessionId }) =>
        isSessionSettled(data[sessionId]),
      )
      return allSettled ? false : 3_000
    },
  })

  // Each cell's findings document. These are created up front by the launch, so
  // they always exist; the worker replaces the empty placeholder when it saves.
  const findings = useQuery({
    queryKey: ['swarm-findings', projectId, runId],
    queryFn: async () => {
      const entries = await Promise.all(
        cells.map(async ({ cell }) => {
          const read = await getManagedMemoryDocument({
            projectId,
            resource: SECURITY_FINDINGS_RESOURCE,
            environment: 'default',
            id: cellDocumentId(runId, cell),
          })
          return [
            cellDocumentId(runId, cell),
            parseCellFinding(read.document.text),
          ] as const
        }),
      )
      return Object.fromEntries(entries)
    },
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return 4_000
      const allFound = cells.every(
        ({ cell }) => data[cellDocumentId(runId, cell)],
      )
      return allFound ? false : 4_000
    },
  })

  const statusBySession = useMemo(
    () => sessions.data ?? {},
    [sessions.data],
  )

  const states: CellState[] = cells.map(({ cell, sessionId }) => ({
    cell,
    sessionStatus: statusBySession[sessionId],
    finding: findings.data?.[cellDocumentId(runId, cell)] ?? null,
  }))

  const counts = states.reduce(
    (acc, state) => {
      const phase = cellPhase(state)
      if (phase === 'done' && state.finding)
        acc[state.finding.disposition] += 1
      else if (phase === 'failed') acc.failed += 1
      else acc.pending += 1
      return acc
    },
    { exposed: 0, 'not-exposed': 0, 'needs-review': 0, failed: 0, pending: 0 },
  )
  const settled = counts.pending === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {settled ? (
          <span className="text-muted-foreground">
            {cells.length} cell{cells.length === 1 ? '' : 's'} complete
          </span>
        ) : (
          <span className="text-muted-foreground inline-flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" />
            {counts.pending} of {cells.length} still running
          </span>
        )}
        <SummaryPill label="Exposed" count={counts.exposed} tone="exposed" />
        <SummaryPill
          label="Not exposed"
          count={counts['not-exposed']}
          tone="not-exposed"
        />
        <SummaryPill
          label="Needs review"
          count={counts['needs-review']}
          tone="needs-review"
        />
        {counts.failed > 0 ? (
          <SummaryPill label="Failed" count={counts.failed} tone="failed" />
        ) : null}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {states.map((state) => (
          <CellTile
            key={cellDocumentId(runId, state.cell)}
            state={state}
          />
        ))}
      </div>
    </div>
  )
}

function SummaryPill({
  label,
  count,
  tone,
}: {
  label: string
  count: number
  tone: CveDisposition | 'failed'
}) {
  const className =
    tone === 'failed'
      ? 'text-muted-foreground border-border bg-muted'
      : DISPOSITION_META[tone].className
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
    >
      {count} {label}
    </span>
  )
}

function CellTile({ state }: { state: CellState }) {
  const phase = cellPhase(state)
  const [owner, name] = state.cell.repository.split('/')
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs">
            <span className="text-muted-foreground">{owner}/</span>
            {name}
          </div>
          <div className="text-muted-foreground mt-0.5 font-mono text-xs">
            {state.cell.cveId}
          </div>
        </div>
        <CellBadge state={state} phase={phase} />
      </div>
      {state.finding?.reasoning ? (
        <p className="text-muted-foreground mt-2 line-clamp-3 text-xs leading-5">
          {state.finding.reasoning}
        </p>
      ) : null}
      {state.finding?.pullRequest ? (
        <a
          href={state.finding.pullRequest}
          target="_blank"
          rel="noreferrer"
          className="text-status-running mt-2 inline-flex items-center gap-1 text-xs hover:underline"
        >
          <ExternalLink className="size-3" />
          Fix pull request
        </a>
      ) : null}
    </div>
  )
}

function CellBadge({
  state,
  phase,
}: {
  state: CellState
  phase: ReturnType<typeof cellPhase>
}) {
  if (phase === 'done' && state.finding) {
    const meta = DISPOSITION_META[state.finding.disposition]
    const Icon = meta.icon
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
          meta.className,
        )}
      >
        <Icon className="size-3" />
        {meta.label}
      </span>
    )
  }
  if (phase === 'failed') {
    return (
      <span className="text-muted-foreground border-border inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs">
        Stopped
      </span>
    )
  }
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      <Loader2 className="size-3 animate-spin" />
      {phase === 'running' ? 'Running' : 'Queued'}
    </span>
  )
}
