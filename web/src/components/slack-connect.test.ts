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

  it('names a same-owner agent in a workspace conflict', () => {
    expect(
      managedSlackNotice(
        'workspace_already_connected',
        null,
        'Support triage',
        'Docs writer',
      ),
    ).toMatchObject({
      description: 'This workspace sends messages to Docs writer.',
    })
  })

  it('does not suggest an inaccessible agent for a cross-owner conflict', () => {
    expect(
      managedSlackNotice('workspace_already_connected', null, 'Support triage'),
    ).toMatchObject({ description: 'Use your own Slack app for this agent.' })
  })
})
