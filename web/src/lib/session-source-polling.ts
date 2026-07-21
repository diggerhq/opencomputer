import type { Session, SessionSource } from '@/api/client'

const ACTIVE_SOURCE_STATUSES = new Set(['pending', 'materializing'])
const LIVE_SESSION_STATUSES = new Set([
  'queued',
  'running',
  'awaiting_input',
  'idle',
])

export function isFlueSession(
  session: Pick<Session, 'agent_snapshot'> | undefined,
): boolean {
  return session?.agent_snapshot?.runtime === 'flue'
}

export function canSessionChangeFlueSources(
  session: Pick<Session, 'status' | 'agent_snapshot'> | undefined,
): boolean {
  if (!session || !isFlueSession(session)) return false
  return LIVE_SESSION_STATUSES.has(session.status)
}

/**
 * Empty sessions keep a slow watch for the first lazy Flue checkout. Active
 * materialization polls quickly. Terminal sources return to the slow watch so
 * a later turn adding another source still appears. React Query pauses these
 * intervals while the page is backgrounded.
 */
export function sessionSourcesRefetchInterval(
  sources: SessionSource[] | undefined,
): number {
  if (sources?.some((source) => ACTIVE_SOURCE_STATUSES.has(source.status)))
    return 1_500
  return 5_000
}
