import { describe, expect, it } from 'vitest'
import {
  managedSlackNotice,
  managedSlackOAuthPending,
} from '@/lib/managed-slack-notice'

describe('managed Slack OAuth settlement', () => {
  it('polls only while a successful callback is still converging', () => {
    expect(managedSlackOAuthPending('connected', undefined, null)).toBe(true)
    expect(managedSlackOAuthPending('connected', 'active', null)).toBe(true)
    expect(
      managedSlackOAuthPending('connected', 'active', '2026-07-17T10:00:00Z'),
    ).toBe(false)

    for (const status of ['disconnected', 'error', 'revoked'] as const) {
      expect(managedSlackOAuthPending('connected', status, null)).toBe(false)
    }
  })

  it('explains a terminal non-active callback result', () => {
    expect(
      managedSlackNotice('connected', 'Acme', 'Support triage', null, 'error'),
    ).toEqual({
      title: "Slack couldn't finish connecting",
      description: 'Reconnect Slack and try again.',
      destructive: true,
    })
  })
})
