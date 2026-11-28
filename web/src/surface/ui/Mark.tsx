import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { Mark } from '../store/views'

// The mark of spec section 3: dot (blocked), ring (ready), breathing dot
// (working). Only blocked is amber: it alone waits on the person. Working is
// quiet on purpose: a muted dot that fades slowly.
const MARK: Record<string, string> = {
  blocked: 'bg-status-pending',
  ready: 'shadow-[inset_0_0_0_2px_var(--muted-foreground)]',
  working:
    'bg-muted-foreground animate-breathe motion-reduce:animate-none motion-reduce:opacity-60',
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
  // Every working mark breathes in one phase, whenever it mounted: pin its
  // animation to the start of the document timeline.
  useLayoutEffect(() => {
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
