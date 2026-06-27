import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ApiHint, type ApiRef } from '@/components/api-hint'

export function PageHeader({
  title,
  description,
  actions,
  api,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  api?: ApiRef
  className?: string
}) {
  return (
    <div
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="space-y-1">
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
        {api ? <ApiHint {...api} /> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
