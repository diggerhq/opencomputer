import { describe, expect, it } from 'vitest'
import type { Session } from '@/api/client'
import {
  isManagedSlackSession,
  latestManagedSlackSession,
} from '@/lib/managed-slack-session'

function session(
  id: string,
  createdAt: string,
  mode: 'managed' | 'byo' | null,
): Session {
  return {
    id,
    status: 'idle',
    created_at: createdAt,
    metadata: mode ? { slack: { mode } } : null,
  }
}

describe('managed Slack activation sessions', () => {
  it('uses the durable session origin and current connection boundary', () => {
    expect(
      isManagedSlackSession(
        session('ses_managed', '2026-07-17T10:00:01Z', 'managed'),
        '2026-07-17T10:00:00Z',
      ),
    ).toBe(true)
    expect(
      isManagedSlackSession(
        session('ses_old', '2026-07-17T09:59:59Z', 'managed'),
        '2026-07-17T10:00:00Z',
      ),
    ).toBe(false)
    expect(
      isManagedSlackSession(
        session('ses_byo', '2026-07-17T10:00:01Z', 'byo'),
        '2026-07-17T10:00:00Z',
      ),
    ).toBe(false)
  })

  it('finds the latest matching conversation without claiming dashboard sessions', () => {
    const sessions = [
      session('ses_dashboard', '2026-07-17T10:03:00Z', null),
      session('ses_first', '2026-07-17T10:01:00Z', 'managed'),
      session('ses_latest', '2026-07-17T10:02:00Z', 'managed'),
    ]

    expect(
      latestManagedSlackSession(sessions, '2026-07-17T10:00:00Z')?.id,
    ).toBe('ses_latest')
  })

  it('does not claim an older conversation without a connection boundary', () => {
    const prior = session(
      'ses_prior_connection',
      '2026-07-17T10:00:00Z',
      'managed',
    )

    expect(isManagedSlackSession(prior, null)).toBe(false)
    expect(latestManagedSlackSession([prior], null)).toBeUndefined()
  })
})
