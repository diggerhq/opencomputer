import { Link } from 'react-router-dom'
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
  cellDocumentId,
  type CveDisposition,
  type ReportCell,
  type SwarmRunReport,
} from './catalog'
import { cellPhase, type CellState, type SwarmCounts } from './useSwarmRun'

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

// The grid view of a run: one tile per cell plus the rolled-up report once every
// cell has settled. The parent runs the swarm poll (useSwarmRun) and hands the
// computed states down, so switching between the grid and the map view does not
// restart polling.
export function SwarmGrid({
  projectId,
  runId,
  states,
  counts,
  settled,
  report,
}: {
  projectId: string
  runId: string
  states: CellState[]
  counts: SwarmCounts
  settled: boolean
  report: SwarmRunReport | null
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {settled ? (
          <span className="text-muted-foreground">
            {states.length} cell{states.length === 1 ? '' : 's'} complete
          </span>
        ) : (
          <span className="text-muted-foreground inline-flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" />
            {counts.pending} of {states.length} still running
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

      {report ? <RunReportCard report={report} projectId={projectId} /> : null}
    </div>
  )
}

// The run's report: shown once every cell has settled. It is the swarm's
// artifact — the actionable verdicts rolled up and ranked. Tier 1 computes it
// from the cell findings the grid already holds; a later reducer agent can
// replace this with a written narrative over the same persisted document.
export function RunReportCard({
  report,
  projectId,
}: {
  report: SwarmRunReport
  // When set, each row links to its cell's session — the way back into what the
  // agent actually did, which matters most for a failed cell.
  projectId?: string
}) {
  const actionable = report.cells.filter(
    (c) => c.disposition !== 'not-exposed',
  )
  return (
    <div className="mt-2 rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">Run report</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {report.counts.total} cells ·{' '}
            {report.counts.exposed} exposed · {report.counts.needsReview} to
            review · {report.counts.failed} failed · {report.counts.fixPrs} fix
            {report.counts.fixPrs === 1 ? ' PR' : ' PRs'}
          </p>
        </div>
        <span className="text-muted-foreground text-xs">
          {new Date(report.generatedAt).toLocaleString()}
        </span>
      </div>

      {actionable.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-sm">
          Nothing exposed. Every CVE checked was not reachable in its
          repository.
        </p>
      ) : (
        <ul className="divide-y">
          {actionable.map((c) => (
            <ReportRow key={c.cveId} cell={c} projectId={projectId} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ReportRow({
  cell,
  projectId,
}: {
  cell: ReportCell
  projectId?: string
}) {
  const meta =
    cell.disposition === 'failed'
      ? { label: 'Failed', className: 'text-muted-foreground border-border' }
      : DISPOSITION_META[cell.disposition]
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className={cn(
          'mt-0.5 inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium',
          meta.className,
        )}
      >
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs">{cell.cveId}</div>
        {cell.reasoning ? (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
            {cell.reasoning}
          </p>
        ) : null}
        {projectId && cell.sessionId ? (
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(cell.sessionId)}`}
            className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-xs hover:underline"
          >
            <ArrowUpRight className="size-3" />
            Open session
          </Link>
        ) : null}
      </div>
      {cell.pullRequest ? (
        <a
          href={cell.pullRequest}
          target="_blank"
          rel="noreferrer"
          className="text-status-running mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs hover:underline"
        >
          <ExternalLink className="size-3" />
          Fix PR
        </a>
      ) : null}
    </li>
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
  const repoCount = state.cell.repositories.length
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs">{state.cell.cveId}</div>
          {repoCount > 0 ? (
            <div className="text-muted-foreground mt-0.5 text-xs">
              {repoCount} repo{repoCount === 1 ? '' : 's'} as evidence
            </div>
          ) : null}
        </div>
        <CellBadge state={state} phase={phase} />
      </div>
      {state.finding?.reasoning ? (
        <p className="text-muted-foreground mt-2 line-clamp-3 text-xs leading-5">
          {state.finding.reasoning}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-3">
        {state.sessionId ? (
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(state.sessionId)}`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
          >
            <ArrowUpRight className="size-3" />
            Open session
          </Link>
        ) : null}
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
  const label =
    phase === 'running' ? 'Running' : phase === 'starting' ? 'Starting…' : 'Queued'
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      <Loader2 className="size-3 animate-spin" />
      {label}
    </span>
  )
}
