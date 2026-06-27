import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** A raised surface — the dashboard's card primitive (replaces .glass-card). */
export function Panel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'bg-panel text-card-foreground rounded-lg border',
        className,
      )}
      {...props}
    />
  )
}

export function PanelHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b px-5 py-4',
        className,
      )}
      {...props}
    />
  )
}

export function PanelTitle({
  className,
  children,
  ...props
}: ComponentProps<'h2'>) {
  return (
    <h2 className={cn('text-sm font-semibold', className)} {...props}>
      {children}
    </h2>
  )
}

export function PanelDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p className={cn('text-muted-foreground text-sm', className)} {...props} />
  )
}

export function PanelContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

export function PanelFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t px-5 py-3', className)}
      {...props}
    />
  )
}
