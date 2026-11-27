import type { ResultRow } from '@opencomputer/sdk/computer'

// A result's pull request, as the merge button reads it (work 118): the
// platform's record of it (`pull`), never the agent's `meta`.

export function pullNumber(r: ResultRow): string | null {
  return r.type === 'pr' ? (/\/pull\/(\d+)/.exec(r.ref)?.[1] ?? null) : null
}

// As long as the server takes a begun merge or revert as under way.
const UNDER_WAY_MS = 2 * 60_000

// A merge or revert someone began and GitHub has not answered: whoever
// began it, everyone sees it, and nobody begins another.
export function underWay(r: ResultRow, now = Date.now()): 'merge' | 'revert' | null {
  const fresh = (i: { at: number } | undefined) => i !== undefined && now - i.at < UNDER_WAY_MS
  if (fresh(r.pull?.merging)) return 'merge'
  if (fresh(r.pull?.reverting)) return 'revert'
  return null
}

// The revert of a merge made here: its pull request, merged or left open
// (`why`, in GitHub's words).
export function revertOf(r: ResultRow): { number: number; merged: boolean; why: string | null } | null {
  const v = r.pull?.revert
  return v ? { number: v.number, merged: v.merged, why: v.why } : null
}

// A check suite's conclusions that do not hold a merge back.
const CLEAN = new Set(['success', 'neutral', 'skipped'])

// Whether one click merges this pull request: it is open, not a draft, and
// its checks, if it has any, passed. One GitHub has said nothing about yet
// (no state) is taken as open. GitHub has the last word.
export function mergeable(r: ResultRow, now = Date.now()): boolean {
  if (r.type !== 'pr' || (r.state ?? 'open') !== 'open' || r.pull?.draft === true || underWay(r, now)) return false
  const checks = r.pull?.checks
  return typeof checks !== 'string' || CLEAN.has(checks)
}

// Why a merge was refused, and the head it was refused at.
export type Refusal = { why: string; head: string | null }

// The refusal that still holds: the pull request is open and has not moved
// since. A new commit, or a merge made elsewhere, drops it.
export function refusalOf(r: ResultRow, refusals: Record<string, Refusal>): string | null {
  const f = refusals[r.id]
  return f && (r.state ?? 'open') === 'open' && f.head === (r.pull?.head ?? null) ? f.why : null
}
