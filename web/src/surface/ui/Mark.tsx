import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { Mark } from '../store/views'

// PROTOTYPE (work 132): ?mark=spin|orbit|breathe picks the working mark.
const V =
  typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('mark') ?? 'spin'
    : 'spin'
const WORKING: Record<string, string> = {
  spin: 'border-[1.5px] border-muted-foreground border-t-transparent border-r-transparent animate-spin',
  orbit:
    'border-[1.5px] border-muted-foreground/25 border-t-muted-foreground/80 animate-[spin_1.6s_linear_infinite] motion-reduce:animate-none',
  breathe: 'bg-muted-foreground animate-breathe motion-reduce:animate-none motion-reduce:opacity-60',
}
const SYNC = V !== 'spin' || location.search.includes('sync')

// The mark of spec section 3: dot (blocked), ring (ready), spinner (working).
const MARK: Record<string, string> = {
  blocked: 'bg-status-pending',
  ready: 'shadow-[inset_0_0_0_2px_var(--status-pending)]',
  working: WORKING[V] ?? WORKING.spin,
}
export function Mk({
  mark,
  small,
  className,
}: {
  mark: Mark
  small?: boolean
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  // Every working mark shares one phase, whenever it mounted.
  useLayoutEffect(() => {
    if (!SYNC) return
    for (const a of ref.current?.getAnimations?.() ?? []) a.startTime = 0
  }, [mark])
  return (
    <span
      ref={ref}
      data-mark-dot={mark ?? ''}
      className={cn(
        'relative inline-block flex-none rounded-full',
        small ? 'size-[7px]' : 'size-[9px]',
        mark && MARK[mark],
        className,
      )}
    />
  )
}
