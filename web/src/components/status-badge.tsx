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
  not_deployed: {
    tone: 'stopped',
    label: 'Not deployed',
    icon: CircleSlash,
  },
  canceled: { tone: 'stopped', label: 'Canceled', icon: CircleSlash },
  unknown: { tone: 'stopped', label: 'Unknown', icon: CircleSlash },
  hibernated: { tone: 'hibernated', label: 'Hibernated', icon: Moon },
  paused: { tone: 'hibernated', label: 'Paused', icon: Moon },
  idle: { tone: 'hibernated', label: 'Idle', icon: Moon },
  archived: { tone: 'stopped', label: 'Archived', icon: CircleSlash },
  awaiting_input: { tone: 'pending', label: 'Awaiting input', icon: Clock },
  pending: { tone: 'pending', label: 'Pending', icon: Clock },
  queued: { tone: 'pending', label: 'Queued', icon: Clock },
  accepted: { tone: 'pending', label: 'Queued', icon: Clock },
  fetching: { tone: 'pending', label: 'Fetching', icon: Loader2, spin: true },
  validating: {
    tone: 'pending',
    label: 'Validating',
    icon: Loader2,
    spin: true,
  },
  installing: {
    tone: 'pending',
    label: 'Installing',
    icon: Loader2,
    spin: true,
  },
  building: { tone: 'pending', label: 'Building', icon: Loader2, spin: true },
  uploading: {
    tone: 'pending',
    label: 'Publishing artifact',
    icon: Loader2,
    spin: true,
  },
  deploying: {
    tone: 'pending',
    label: 'Deploying',
    icon: Loader2,
    spin: true,
  },
  verifying: {
    tone: 'pending',
    label: 'Verifying',
    icon: Loader2,
    spin: true,
  },
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
  unverified: { tone: 'error', label: 'Unverified', icon: CircleAlert },
  verified: { tone: 'running', label: 'Verified', icon: CircleCheck },
  superseded: { tone: 'stopped', label: 'Superseded', icon: CircleSlash },
  skipped: { tone: 'stopped', label: 'Skipped', icon: CircleSlash },
  degraded: { tone: 'error', label: 'Degraded', icon: CircleAlert },
  // Webhook delivery statuses
  delivered: { tone: 'running', label: 'Delivered', icon: CircleCheck },
  delivering: {
    tone: 'pending',
    label: 'Delivering',
    icon: Loader2,
    spin: true,
  },
  dead_letter: { tone: 'error', label: 'Dead letter', icon: CircleAlert },
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
        className={cn(
          'size-3.5',
          meta.spin && 'animate-spin motion-reduce:animate-none',
        )}
        aria-hidden
      />
      {label ?? meta.label}
    </span>
  )
}
