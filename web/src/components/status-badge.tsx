import {
  CircleCheck,
  CircleAlert,
  CircleSlash,
  Moon,
  Clock,
  Loader2,
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

type Meta = { tone: Tone; label: string; icon: LucideIcon; spin?: boolean }

// Raw API status strings -> lifecycle tone + label + non-color (icon) cue.
const STATUS: Record<string, Meta> = {
  running: { tone: 'running', label: 'Running', icon: CircleCheck },
  ready: { tone: 'running', label: 'Ready', icon: CircleCheck },
  active: { tone: 'running', label: 'Active', icon: CircleCheck },
  success: { tone: 'running', label: 'Success', icon: CircleCheck },
  stopped: { tone: 'stopped', label: 'Stopped', icon: CircleSlash },
  canceled: { tone: 'stopped', label: 'Canceled', icon: CircleSlash },
  unknown: { tone: 'stopped', label: 'Unknown', icon: CircleSlash },
  hibernated: { tone: 'hibernated', label: 'Hibernated', icon: Moon },
  paused: { tone: 'hibernated', label: 'Paused', icon: Moon },
  idle: { tone: 'hibernated', label: 'Idle', icon: Moon },
  archived: { tone: 'stopped', label: 'Archived', icon: CircleSlash },
  awaiting_input: { tone: 'pending', label: 'Awaiting input', icon: Clock },
  pending: { tone: 'pending', label: 'Pending', icon: Clock },
  queued: { tone: 'pending', label: 'Queued', icon: Clock },
  building: { tone: 'pending', label: 'Building', icon: Loader2, spin: true },
  processing: {
    tone: 'pending',
    label: 'Processing',
    icon: Loader2,
    spin: true,
  },
  starting: { tone: 'pending', label: 'Starting', icon: Loader2, spin: true },
  creating: { tone: 'pending', label: 'Creating', icon: Loader2, spin: true },
  deleting: { tone: 'pending', label: 'Deleting', icon: Loader2, spin: true },
  error: { tone: 'error', label: 'Error', icon: CircleAlert },
  failed: { tone: 'error', label: 'Failed', icon: CircleAlert },
  degraded: { tone: 'error', label: 'Degraded', icon: CircleAlert },
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
      <Icon
        className={cn('size-3.5', meta.spin && 'animate-spin')}
        aria-hidden
      />
      {label ?? meta.label}
    </span>
  )
}
