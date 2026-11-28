import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import { mergeable, pullAt, pullNumber, refusalOf } from '../store/pulls'
import { MergeButton } from './MergeButton'
import { ResultIcon } from './ResultIcon'
import { pullState, resultTitle } from './result-text'
import { Tip } from './Tip'

// A link in a message to a pull request that is one of the reader's results
// (work 118): the result itself, in the line, with its state as it is now and
// not as it was when the message was written. Where it can merge, Merge is at
// its end, always: a button that appears only on hover is not found, and one
// laid over the line hides what follows. Any other link is the plain link. Of several threads' results for one pull request, the open
// thread's own.
export function PullLink({ href, plain }: { href: string | undefined; plain: ReactElement }) {
  const surface = useSurface()
  const r = useS((s) => (href ? pullAt(s.rows.result, href, s.loc.thread ?? undefined) : undefined))
  const why = useS((s) => (r ? refusalOf(r, s.unmerged) : null))
  if (!r) return plain
  const n = pullNumber(r)
  const state = pullState(r, why !== null)
  const merge = mergeable(r)
  const chip = (
    <Button
      variant="secondary"
      size="xs"
      className={cn('max-w-full min-w-0 font-normal', merge && 'rounded-r-none')}
      onClick={() => surface.openResult(r)}
    >
      <ResultIcon result={r} />
      <span className="max-w-[32ch] truncate">{resultTitle(r)}</span>
      {n && <span className="text-muted-foreground tabular-nums">#{n}</span>}
      {state && (
        <small className={cn('text-muted-foreground text-xs', why && 'text-status-pending')}>
          {state}
        </small>
      )}
    </Button>
  )
  return (
    <span data-pull-link className="inline-flex max-w-full align-middle">
      {why ? <Tip label={`Not merged: ${why}`}>{chip}</Tip> : chip}
      <MergeButton result={r} className="border-background rounded-l-none border-l" />
    </span>
  )
}
