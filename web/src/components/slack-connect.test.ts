import { describe, expect, it } from 'vitest'
import { managedSlackNotice } from '@/lib/managed-slack-notice'
import { managedSlackDisconnectCopy } from '@/lib/managed-slack-connections'

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
      description:
        'This workspace sends messages to Docs writer. Move it below to connect it to Support triage.',
    })
  })

  it('does not suggest an inaccessible agent for a cross-owner conflict', () => {
    expect(
      managedSlackNotice('workspace_already_connected', null, 'Support triage'),
    ).toMatchObject({
      description:
        'Connect a different workspace or use your own Slack app for this agent.',
    })
  })

  it('states the impact before moving a workspace between agents', () => {
    expect(
      managedSlackDisconnectCopy(
        {
          mode: 'managed',
          status: 'active',
          workspace: { id: 'T1', name: 'Acme' },
          app: { id: 'A1', handle: 'OpenComputer' },
          connected_at: '2026-07-16T18:00:00Z',
          agent: {
            id: 'agt_bbbbbbbbbbbbbbbbbbbbbbbb',
            name: 'Docs writer',
          },
        },
        'Support triage',
      ),
    ).toEqual({
      title: 'Disconnect Acme from Docs writer?',
      description:
        'New Slack messages from Acme will stop going to Docs writer. The agent and its existing sessions stay available, and the OpenComputer app stays installed. After disconnecting, connect Slack again and select this workspace for Support triage.',
    })
  })

  it('states the temporary unassigned state for a guided move', () => {
    expect(
      managedSlackDisconnectCopy(
        {
          mode: 'managed',
          status: 'active',
          workspace: { id: 'T1', name: 'Acme' },
          app: { id: 'A1', handle: 'OpenComputer' },
          connected_at: '2026-07-16T18:00:00Z',
          agent: {
            id: 'agt_bbbbbbbbbbbbbbbbbbbbbbbb',
            name: 'Docs writer',
          },
        },
        'Support triage',
        true,
      ),
    ).toEqual({
      title: 'Move Acme to Support triage?',
      description:
        'OpenComputer will disconnect Acme from Docs writer, then open Slack so you can authorize it for Support triage. If you stop before authorization completes, the app stays installed but does not send messages to an agent.',
    })
  })
})
