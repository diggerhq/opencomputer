import type { ResultRow } from '@opencomputer/sdk/computer'

// A result's pull request, as the merge button reads it (work 118).

export function pullNumber(r: ResultRow): string | null {
  return r.type === 'pr' ? (/\/pull\/(\d+)/.exec(r.ref)?.[1] ?? null) : null
}

// The revert of a merge made here (work 118): its pull request, merged or left open.
export function revertOf(r: ResultRow): { number: number; merged: boolean } | null {
  const v = r.meta?.revert as { number?: unknown; merged?: unknown } | undefined
  return v && typeof v.number === 'number' ? { number: v.number, merged: v.merged === true } : null
}

// A check suite's conclusions that do not hold a merge back.
const CLEAN = new Set(['success', 'neutral', 'skipped'])

// Whether one click merges this pull request (work 118): it is open, not a
// draft, and its checks, if it has any, passed. One GitHub has said nothing
// about yet (no state) is taken as open. GitHub has the last word.
export function mergeable(r: ResultRow): boolean {
  const m = r.meta ?? {}
  if (r.type !== 'pr' || (r.state ?? 'open') !== 'open' || m.draft === true || m.pending) return false
  return typeof m.checks !== 'string' || CLEAN.has(m.checks)
}
