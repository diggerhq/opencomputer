import {
  CircleCheck,
  CircleAlert,
  CircleSlash,
  Moon,
  Clock,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'running' | 'stopped' | 'hibernated' | 'error' | 'pending'

// Full class strings (not constructed) so Tailwind's scanner keeps them.
const TONE_CLASS: Record<Tone, string> = {
  running: 'bg-status-running-bg text-status-running',
  stopped: 'bg-status-stopped-bg text-status-stopped',
  hibernated: 'bg-status-hibernated-bg text-status-hibernated',
  error: 'bg-status-error-bg text-status-error',
  pending: 'bg-status-pending-bg text-status-pending',
}

type Meta = { tone: Tone; label: string; icon: LucideIcon }

// Raw API status strings -> lifecycle tone + label + non-color (icon) cue.
const STATUS: Record<string, Meta> = {
  running: { tone: 'running', label: 'Running', icon: CircleCheck },
  ready: { tone: 'running', label: 'Ready', icon: CircleCheck },
  stopped: { tone: 'stopped', label: 'Stopped', icon: CircleSlash },
  hibernated: { tone: 'hibernated', label: 'Hibernated', icon: Moon },
  pending: { tone: 'pending', label: 'Pending', icon: Clock },
  error: { tone: 'error', label: 'Error', icon: CircleAlert },
  failed: { tone: 'error', label: 'Failed', icon: CircleAlert },
}

function titleCase(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown'
}

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string
  label?: string
  className?: string
}) {
  const key = status?.toLowerCase?.() ?? ''
  const meta: Meta = STATUS[key] ?? {
    tone: 'stopped',
    label: titleCase(status),
    icon: CircleSlash,
  }
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label ?? meta.label}
    </span>
  )
}
