import type { Session } from '@/api/client'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Managed Slack ingress records its origin on the ordinary durable session.
 * Keep onboarding discovery on that public session truth instead of inventing
 * a second activation state machine in the dashboard.
 */
export function isManagedSlackSession(
  session: Session,
  connectedAt?: string | null,
): boolean {
  const slack = record(record(session.metadata).slack)
  if (slack.mode !== 'managed') return false

  if (!connectedAt) return true
  const connectedTime = Date.parse(connectedAt)
  const sessionTime = Date.parse(session.created_at)
  return (
    Number.isFinite(connectedTime) &&
    Number.isFinite(sessionTime) &&
    sessionTime >= connectedTime
  )
}

export function latestManagedSlackSession(
  sessions: Session[],
  connectedAt?: string | null,
): Session | undefined {
  return sessions
    .filter((session) => isManagedSlackSession(session, connectedAt))
    .sort(
      (a, b) =>
        Date.parse(b.created_at) - Date.parse(a.created_at) ||
        b.id.localeCompare(a.id),
    )[0]
}
