import type { SessionUsage, TurnUsage } from '@/api/schemas'

export type UsageLike = SessionUsage | TurnUsage | null | undefined

function asRecord(value: UsageLike): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value : null
}

export function hasUsage(usage: UsageLike): boolean {
  const record = asRecord(usage)
  return record !== null && Object.keys(record).length > 0
}

export function usageCostUsd(usage: UsageLike): number | null {
  const record = asRecord(usage)
  if (!record) return null
  const value = record.total_cost_usd
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function usageTokens(usage: UsageLike): number | null {
  const record = asRecord(usage)
  if (!record) return null
  const value = record.tokens
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export function usageActiveSeconds(usage: UsageLike): number | null {
  const record = asRecord(usage)
  if (!record) return null
  const value = record.active_seconds
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export function usageIsIncomplete(usage: UsageLike): boolean {
  return asRecord(usage)?.complete === false
}

export function usageAttribution(
  usage: UsageLike,
): 'exact' | 'best_effort' | null {
  const record = asRecord(usage)
  if (!record) return null
  return record.attribution === 'exact' || record.attribution === 'best_effort'
    ? record.attribution
    : null
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export function formatUsageTokens(usage: UsageLike): string {
  const value = usageTokens(usage)
  if (value === null) return 'Unknown'
  return `${usageIsIncomplete(usage) ? '≥' : ''}${value.toLocaleString()}`
}

export function formatUsageCost(usage: UsageLike): string {
  const value = usageCostUsd(usage)
  if (value === null) return 'Unknown'
  return `${usageIsIncomplete(usage) ? '≥' : ''}${formatUsd(value)}`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  const minuteRemainder = minutes % 60
  return `${hours}h ${String(minuteRemainder).padStart(2, '0')}m`
}

export function formatUsageDuration(usage: UsageLike): string {
  const seconds = usageActiveSeconds(usage)
  return seconds === null ? 'Unknown' : formatDuration(seconds)
}

export function usageDisclosure(usage: UsageLike): string | null {
  const record = asRecord(usage)
  if (!record) return null
  const notes: string[] = []
  if (record.complete === false) {
    const missing = record.unreported_turns
    notes.push(
      typeof missing === 'number' && missing > 0
        ? `Lower bound · ${missing} turn${missing === 1 ? '' : 's'} did not report usage`
        : 'Lower-bound usage',
    )
  }
  if (record.attribution === 'best_effort') {
    notes.push('Best-effort session attribution')
  }
  return notes.length > 0 ? notes.join(' · ') : null
}
