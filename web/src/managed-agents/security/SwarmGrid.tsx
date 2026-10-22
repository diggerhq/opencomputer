import { useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowUpRight,
  ExternalLink,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react'
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
//
// A cell can fail two ways: the whole session stops (status failed/cancelled),
// or — the common one — the session stays `idle` while its last turn is
// `failed` (a single-turn cell whose final generation errored). So we read the
// last turn's status, not just the session's.
type SessionProgress = {
  status: string
  lastTurnStatus?: string
}

type CellState = {
  cell: SwarmCell
  sessionId: string
  progress?: SessionProgress
  finding: CellFinding | null
}

function sessionFailed(progress: SessionProgress | undefined): boolean {
  if (!progress) return false
  if (progress.status === 'failed' || progress.status === 'cancelled')
    return true
  const turn = progress.lastTurnStatus
  return turn === 'failed' || turn === 'errored' || turn === 'cancelled'
}

// Settled = we will never poll it again: the verdict is saved, or it failed.
function cellSettled(state: CellState): boolean {
  return Boolean(state.finding) || sessionFailed(state.progress)
}

function cellPhase(state: CellState): 'done' | 'failed' | 'running' | 'queued' {
  if (state.finding) return 'done'
  if (sessionFailed(state.progress)) return 'failed'
  const status = state.progress?.status
  if (status === 'running' || status === 'idle') return 'running'
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
  // Both polls stop the moment every cell has settled (verdict saved, or
  // failed). We recompute that each render and park it in a ref the two
  // refetchInterval closures read, so neither needs the other's query data.
  const allSettledRef = useRef(false)

  // The run's live sessions, fetched by the ids the launch returned so each tile
  // can show whether its worker is queued, running, stopped, or failed.
  const sessions = useQuery({
    queryKey: ['swarm-sessions', projectId, runId],
    queryFn: async () => {
      const entries = await Promise.all(
        cells.map(async ({ sessionId }) => {
          const session = await getManagedAgentSession(sessionId)
          const turns = session.turns
          const lastTurnStatus =
            turns.length > 0 ? turns[turns.length - 1].status : undefined
          return [sessionId, { status: session.status, lastTurnStatus }] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, SessionProgress>
    },
    refetchInterval: () => (allSettledRef.current ? false : 3_000),
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
    refetchInterval: () => (allSettledRef.current ? false : 4_000),
  })

  const progressBySession = useMemo(
    () => sessions.data ?? {},
    [sessions.data],
  )

  const states: CellState[] = cells.map(({ cell, sessionId }) => ({
    cell,
    sessionId,
    progress: progressBySession[sessionId],
    finding: findings.data?.[cellDocumentId(runId, cell)] ?? null,
  }))

  allSettledRef.current = states.every(cellSettled)

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

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {states.map((state) => (
          <CellTile
            key={cellDocumentId(runId, state.cell)}
            state={state}
            projectId={projectId}
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

function CellTile({
  state,
  projectId,
}: {
  state: CellState
  projectId: string
}) {
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
      <div className="mt-2 flex items-center gap-3">
        <Link
          to={`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(state.sessionId)}`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
        >
          <ArrowUpRight className="size-3" />
          Open session
        </Link>
        {state.finding?.pullRequest ? (
          <a
            href={state.finding.pullRequest}
            target="_blank"
            rel="noreferrer"
            className="text-status-running inline-flex items-center gap-1 text-xs hover:underline"
          >
            <ExternalLink className="size-3" />
            Fix pull request
          </a>
        ) : null}
      </div>
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
        Failed
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
