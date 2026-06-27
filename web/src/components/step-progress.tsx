import { Fragment } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Horizontal stepper for a known multi-step backend job. Nodes fill left → right:
// steps before `current` are done (✓), `current` is active (spinner), the rest are
// pending. The connector leading into each reached node fills with the accent. A
// single status line below names the active step (full label), so long step names
// don't crowd the nodes. `current === steps.length` reads fully done.
export function StepProgress({
  steps,
  current,
}: {
  steps: string[]
  current: number
}) {
  const allDone = current >= steps.length
  return (
    <div className="space-y-4">
      <div className="flex items-center">
        {steps.map((label, i) => {
          const done = i < current
          const active = i === current
          return (
            <Fragment key={label}>
              {i > 0 ? (
                <span
                  className={cn(
                    'h-px flex-1 transition-colors duration-300',
                    i <= current ? 'bg-primary' : 'bg-border',
                  )}
                />
              ) : null}
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors duration-300',
                  done || active
                    ? 'border-primary text-primary'
                    : 'border-border text-muted-foreground/50',
                )}
              >
                {done ? (
                  <Check className="size-3.5" />
                ) : active ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  i + 1
                )}
              </span>
            </Fragment>
          )
        })}
      </div>
      <div className="flex items-center gap-2 text-sm">
        {allDone ? (
          <Check className="text-primary size-4 shrink-0" />
        ) : (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        )}
        <span className="text-foreground">
          {allDone ? 'Done' : steps[current]}
        </span>
      </div>
    </div>
  )
}
