import { describe, expect, it } from 'vitest'
import { managedSlackNotice } from '@/lib/managed-slack-notice'

describe('managed Slack OAuth notices', () => {
  it('uses the active connection data for a successful return', () => {
    expect(managedSlackNotice('connected', 'Acme', 'Support triage')).toEqual({
      title: 'Slack connected',
      description: 'OpenComputer will send messages in Acme to Support triage.',
    })
  })

  it('keeps provider failures actionable without exposing provider detail', () => {
    expect(
      managedSlackNotice('slack_upstream_unavailable', null, 'Support triage'),
    ).toEqual({
      title: "Slack couldn't complete the connection",
      description: 'Try again in a moment.',
      destructive: true,
    })
  })

  it('ignores unknown query values', () => {
    expect(
      managedSlackNotice('provider_message_here', null, 'Agent'),
    ).toBeNull()
  })
})
