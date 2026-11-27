import type { ResultRow } from '@opencomputer/sdk/computer'
import { revertOf, underWay } from '../store/pulls'

// A result's title and one-line detail, as the panes write them.

export function resultTitle(r: ResultRow): string {
  if (r.title) return r.title
  const pr = r.type === 'pr' ? /\/pull\/(\d+)/.exec(r.ref) : null
  return pr ? `PR #${pr[1]}` : (r.ref.split('/').pop() ?? r.ref)
}

// "open · checks passed", "+11,486 −493", "running".
export function resultDetail(r: ResultRow): string {
  const m = r.meta ?? {}
  if (typeof m.detail === 'string') return m.detail
  const going = underWay(r)
  if (going) return going === 'merge' ? 'merging…' : 'reverting…'
  const parts: string[] = []
  if (r.state) parts.push(r.state)
  const revert = revertOf(r)
  if (revert) parts.push(revert.merged ? 'reverted' : `revert #${revert.number} open`)
  if (r.type === 'pr' && typeof r.pull?.checks === 'string')
    parts.push(`checks ${r.pull.checks}`)
  if (typeof m.additions === 'number' && typeof m.deletions === 'number')
    parts.push(
      `+${m.additions.toLocaleString()} −${m.deletions.toLocaleString()}`,
    )
  return parts.join(' · ')
}
