import { Bot, Cloud, type LucideIcon } from 'lucide-react'
import { runtimeLabel } from '@/lib/runtimes'
import { cn } from '@/lib/utils'

// Runtime is a category, not a health state — so it gets a quiet, neutral pill (not a
// status tone). `flue` (the CF-native durable path) carries a subtle accent + a distinct
// icon so it reads apart from the brain-box runtimes (claude/codex/pi) at a glance.
const ICON: Record<string, LucideIcon> = {
  flue: Cloud,
}

export function RuntimeBadge({
  runtime,
  className,
}: {
  runtime: string | null | undefined
  className?: string
}) {
  if (!runtime) return <span className="text-muted-foreground text-sm">—</span>
  const Icon = ICON[runtime] ?? Bot
  const isFlue = runtime === 'flue'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
        isFlue
          ? 'bg-status-running-bg text-status-running'
          : 'bg-secondary text-secondary-foreground',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {runtimeLabel(runtime)}
    </span>
  )
}
