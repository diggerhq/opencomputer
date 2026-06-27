import { Check, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// A small vertical checklist for a known multi-step backend job. Steps before
// `current` render done, `current` renders active (spinner), the rest pending.
// When `current === steps.length` everything reads done. `failedAt` marks the
// step that errored (it shows an ✕; earlier steps stay done, later stay pending).
export function StepProgress({
  steps,
  current,
  failedAt,
}: {
  steps: string[]
  current: number
  failedAt?: number
}) {
  return (
    <ol className="space-y-3">
      {steps.map((label, i) => {
        const failed = failedAt === i
        const done = failedAt == null ? i < current : i < failedAt
        const active = failedAt == null && i === current
        return (
          <li key={label} className="flex items-center gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center">
              {failed ? (
                <X className="text-status-error size-4" />
              ) : done ? (
                <Check className="text-status-running size-4" />
              ) : active ? (
                <Loader2 className="text-foreground size-4 animate-spin" />
              ) : (
                <span className="border-muted-foreground/30 size-2.5 rounded-full border" />
              )}
            </span>
            <span
              className={cn(
                'text-sm transition-colors',
                done || active || failed
                  ? 'text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
