import { cn } from '@/lib/utils'
import type { Mark } from '../store/views'

// The mark of spec section 3: dot (blocked), ring (ready), spinner (working).
const MARK: Record<string, string> = {
  blocked: 'bg-status-pending',
  ready: 'shadow-[inset_0_0_0_2px_var(--status-pending)]',
  working:
    'border-[1.5px] border-muted-foreground border-t-transparent border-r-transparent animate-spin',
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
  return (
    <span
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
