import type { ReactNode } from 'react'
import { Panel } from '@/components/panel'
import { cn } from '@/lib/utils'

export function MetricCard({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <Panel className={cn('px-5 py-4', className)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground mt-1.5 font-mono text-3xl leading-none font-semibold tabular-nums">
        {value}
      </div>
      {hint ? (
        <div className="text-muted-foreground mt-1.5 text-xs">{hint}</div>
      ) : null}
    </Panel>
  )
}
