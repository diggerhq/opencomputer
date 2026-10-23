import { Link } from 'react-router-dom'
import { PALETTE } from './palette'
import { cellPhase, type CellState, type SwarmCounts } from './useSwarmRun'

// The mission-control panels that sit under the map: a metric strip, a findings
// feed, and the per-cell dispatch list. Everything here is derived from the cell
// states the page already polls — no extra fetching — and drawn in the map's
// dark terminal palette so the whole run reads as one board.

// A cell's status word + color, shared by the feed and the dispatch list.
function cellStatus(state: CellState): { label: string; color: string } {
  const phase = cellPhase(state)
  if (phase === 'starting') return { label: 'starting', color: PALETTE.ink }
  if (phase === 'running') return { label: 'running', color: PALETTE.orange }
  if (phase === 'queued') return { label: 'queued', color: PALETTE.grey }
  if (phase === 'failed') return { label: 'failed', color: PALETTE.red }
  const d = state.finding?.disposition
  if (d === 'exposed') return { label: 'exposed', color: PALETTE.red }
  if (d === 'needs-review') return { label: 'review', color: PALETTE.amber }
  return { label: 'ok', color: PALETTE.green }
}

function Panel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-white/10"
      style={{ background: PALETTE.bg }}
    >
      <div
        className="border-b border-white/10 px-4 py-2 font-mono text-[11px] font-bold tracking-wider"
        style={{ color: PALETTE.orange }}
      >
        {title}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

// The top metric strip: the run's numbers at a glance, each in its verdict color.
export function StatBar({
  states,
  counts,
}: {
  states: CellState[]
  counts: SwarmCounts
}) {
  const fixPrs = states.filter((s) => s.finding?.pullRequest).length
  const items: { label: string; value: number; color: string }[] = [
    { label: 'CELLS', value: states.length, color: PALETTE.text },
    { label: 'LIVE', value: counts.pending, color: PALETTE.orange },
    { label: 'EXPOSED', value: counts.exposed, color: PALETTE.red },
    { label: 'NOT EXP', value: counts['not-exposed'], color: PALETTE.green },
    { label: 'REVIEW', value: counts['needs-review'], color: PALETTE.amber },
    { label: 'FAILED', value: counts.failed, color: PALETTE.grey },
    { label: 'FIX PRs', value: fixPrs, color: PALETTE.purple },
  ]
  return (
    <div
      className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border border-white/10 px-4 py-3"
      style={{ background: PALETTE.bg }}
    >
      {items.map((it) => (
        <div key={it.label} className="font-mono">
          <div className="text-[10px] tracking-wider" style={{ color: PALETTE.ink }}>
            {it.label}
          </div>
          <div className="text-xl font-bold" style={{ color: it.color }}>
            {it.value}
          </div>
        </div>
      ))}
    </div>
  )
}

// The findings feed: the reportable cells — exposed, needs-review, or carrying a
// fix PR — ranked most-actionable first. No timestamps, because a finding
// document doesn't carry one; this is the ranked list, not a time-ordered log.
export function FindingsPanel({
  states,
  projectId,
}: {
  states: CellState[]
  projectId: string
}) {
  const rank: Record<string, number> = { exposed: 0, 'needs-review': 1 }
  const reportable = states
    .filter(
      (s) =>
        s.finding &&
        (s.finding.disposition === 'exposed' ||
          s.finding.disposition === 'needs-review' ||
          Boolean(s.finding.pullRequest)),
    )
    .sort(
      (a, b) =>
        (rank[a.finding?.disposition ?? ''] ?? 2) -
        (rank[b.finding?.disposition ?? ''] ?? 2),
    )
  return (
    <Panel title="FINDINGS FEED">
      {reportable.length === 0 ? (
        <p
          className="px-4 py-6 font-mono text-xs"
          style={{ color: PALETTE.ink }}
        >
          No findings yet.
        </p>
      ) : (
        <ul className="max-h-80 divide-y divide-white/5 overflow-y-auto">
          {reportable.map((s) => {
            const status = cellStatus(s)
            return (
              <li key={s.cell.cveId} className="px-4 py-2.5 font-mono text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="font-bold uppercase tracking-wide"
                    style={{ color: status.color }}
                  >
                    {status.label}
                  </span>
                  {s.finding?.pullRequest ? (
                    <a
                      href={s.finding.pullRequest}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                      style={{ color: PALETTE.purple }}
                    >
                      fix PR
                    </a>
                  ) : null}
                </div>
                <div className="mt-1" style={{ color: PALETTE.text }}>
                  {s.cell.cveId}
                </div>
                {s.sessionId ? (
                  <Link
                    to={`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(s.sessionId)}`}
                    className="mt-1 inline-block hover:underline"
                    style={{ color: PALETTE.ink }}
                  >
                    open session →
                  </Link>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// The dispatch list: every cell and its live status, running ones first. This is
// the "who is doing what" column of the board.
export function CellDispatchPanel({
  states,
  projectId,
}: {
  states: CellState[]
  projectId: string
}) {
  const order: Record<string, number> = {
    running: 0,
    queued: 1,
    exposed: 2,
    review: 3,
    failed: 4,
    ok: 5,
  }
  const rows = states
    .map((s, i) => ({ s, i, status: cellStatus(s) }))
    .sort((a, b) => (order[a.status.label] ?? 9) - (order[b.status.label] ?? 9))
  return (
    <Panel title="CELL DISPATCH">
      <ul className="max-h-80 divide-y divide-white/5 overflow-y-auto">
        {rows.map(({ s, i, status }) => {
          const label = `cell-${String(i + 1).padStart(2, '0')}`
          const inner = (
            <div className="flex items-center gap-3 px-4 py-2 font-mono text-xs">
              <span style={{ color: PALETTE.ink }}>{label}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: PALETTE.text }}>
                {s.cell.cveId}
              </span>
              <span
                className="shrink-0 font-bold uppercase tracking-wide"
                style={{ color: status.color }}
              >
                {status.label}
              </span>
            </div>
          )
          return (
            <li key={s.cell.cveId}>
              {s.sessionId ? (
                <Link
                  to={`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(s.sessionId)}`}
                  className="block hover:bg-white/5"
                >
                  {inner}
                </Link>
              ) : (
                inner
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
