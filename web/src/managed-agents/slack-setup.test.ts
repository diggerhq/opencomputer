import { describe, expect, it } from 'vitest'
import type {
  ManagedAgentChannel,
  ManagedAgentDeployment,
  ManagedProjectOverview,
  ManagedSlackSetup,
} from './api'
import {
  describeSlackSetup,
  describeSlackVerification,
  newSlackSetupRequestKey,
  slackAuthorizationHref,
  slackReturnFromSearch,
  slackSlotsForEnvironment,
  withoutSlackReturn,
} from './slack-setup'

const project: ManagedProjectOverview['project'] = {
  id: 'prj_1',
  slug: 'slack-coder',
  name: 'slack-coder',
  environments: [
    {
      name: 'development',
      agentId: 'coder',
      activeDeploymentId: 'dep_coder',
      updatedAt: '2026-09-17T00:00:00.000Z',
    },
  ],
  agents: [
    { id: 'coder', name: 'Coder' },
    { id: 'reviewer', name: 'Reviewer' },
  ],
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
}

function deployment(
  agentId: string,
  reference?: Partial<NonNullable<ManagedAgentDeployment['projectDeployment']>>,
): ManagedAgentDeployment {
  return {
    id: `dep_${agentId}`,
    agentId,
    alias: 'development',
    channels: [],
    connections: [],
    createdAt: '2026-09-17T00:00:00.000Z',
    memory: [],
    projectDeployment: reference
      ? {
          id: 'pd_1',
          digest: 'digest',
          localAgentId: agentId,
          agents: [],
          resources: {
            channels: [],
            channelRegistrations: [],
            schedules: [],
            ...reference.resources,
          },
          ...reference,
        }
      : undefined,
  }
}

function connection(
  overrides: Partial<ManagedAgentChannel> = {},
): ManagedAgentChannel {
  return {
    id: 'channel_1',
    channel: 'slack',
    channelId: 'slack',
    agentId: 'coder',
    alias: 'development',
    status: 'connected',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    destinations: [],
    agents: [],
    ...overrides,
  }
}

function setup(overrides: Partial<ManagedSlackSetup> = {}): ManagedSlackSetup {
  return {
    id: 'setup_1',
    requestKey: 'key_0123456789abcdef',
    projectId: 'prj_1',
    agentId: 'coder',
    alias: 'development',
    channelId: 'slack',
    name: 'Patch',
    connectionId: 'channel_1',
    phase: 'prepared',
    actions: ['create', 'cancel'],
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
}

describe('slack setup slots', () => {
  it('offers a dedicated app for an agent whose deployment declares no channel', () => {
    const slots = slackSlotsForEnvironment({
      project,
      deployments: [deployment('coder', {})],
      channels: [],
      environment: 'development',
    })
    expect(slots).toEqual([
      expect.objectContaining({
        key: 'dedicated:coder',
        dedicated: true,
        agentId: 'coder',
        consumers: ['coder'],
      }),
    ])
    expect(slots[0]?.channelId).toBeUndefined()
  })

  it('lists the agents registered on a declared channel, mapped to account ids', () => {
    const reference = {
      localAgentId: 'coder',
      agents: [
        { localId: 'coder', agentId: 'coder' },
        { localId: 'reviewer', agentId: 'reviewer' },
      ],
      resources: {
        channels: [
          {
            id: 'team-slack',
            type: 'slack' as const,
            displayName: 'Engineering Slack',
            destinations: {
              'pull-request-reviews': { type: 'conversation' as const },
            },
          },
        ],
        channelRegistrations: [
          { agentId: 'coder', channelId: 'team-slack', triggers: ['mention'] },
          { agentId: 'reviewer', channelId: 'team-slack', triggers: [] },
        ],
        schedules: [],
      },
    }
    const slots = slackSlotsForEnvironment({
      project,
      deployments: [
        deployment('coder', reference),
        deployment('reviewer', { ...reference, localAgentId: 'reviewer' }),
      ],
      channels: [],
      environment: 'development',
    })
    expect(slots).toEqual([
      expect.objectContaining({
        key: 'channel:team-slack',
        channelId: 'team-slack',
        name: 'Engineering Slack',
        consumers: ['coder', 'reviewer'],
        agentId: 'coder',
        destinations: ['pull-request-reviews'],
      }),
    ])
  })

  it('keys an unconnected declared channel by the first registered agent in sorted order', () => {
    const resources = {
      channels: [
        { id: 'team-slack', type: 'slack' as const, destinations: {} },
      ],
      channelRegistrations: [
        { agentId: 'reviewer', channelId: 'team-slack', triggers: [] },
        { agentId: 'coder', channelId: 'team-slack', triggers: [] },
      ],
      schedules: [],
    }
    const agents = [
      { localId: 'coder', agentId: 'coder' },
      { localId: 'reviewer', agentId: 'reviewer' },
    ]
    const forward = slackSlotsForEnvironment({
      project,
      deployments: [
        deployment('coder', { agents, resources }),
        deployment('reviewer', { agents, resources, localAgentId: 'reviewer' }),
      ],
      channels: [],
      environment: 'development',
    })
    const reversed = slackSlotsForEnvironment({
      project,
      deployments: [
        deployment('reviewer', { agents, resources, localAgentId: 'reviewer' }),
        deployment('coder', { agents, resources }),
      ],
      channels: [],
      environment: 'development',
    })
    expect(forward[0]?.agentId).toBe('coder')
    expect(reversed[0]?.agentId).toBe('coder')
    expect(reversed[0]?.consumers).toEqual(['coder', 'reviewer'])
  })

  it('keys the slot by the agent that owns the existing connection and takes its consumers', () => {
    const slots = slackSlotsForEnvironment({
      project,
      deployments: [
        deployment('coder', {
          resources: {
            channels: [{ id: 'team-slack', type: 'slack', destinations: {} }],
            channelRegistrations: [],
            schedules: [],
          },
        }),
      ],
      channels: [
        connection({
          channelId: 'team-slack',
          agentId: 'reviewer',
          agents: ['reviewer', 'coder'],
        }),
        // Another environment's connection never matches.
        connection({
          id: 'channel_prod',
          channelId: 'team-slack',
          alias: 'production',
        }),
        // Neither does a disconnected one.
        connection({
          id: 'channel_old',
          channelId: 'team-slack',
          status: 'disconnected',
        }),
      ],
      environment: 'development',
    })
    expect(slots[0]).toEqual(
      expect.objectContaining({
        agentId: 'reviewer',
        // Consumers are shown in sorted order whatever the platform's order.
        consumers: ['coder', 'reviewer'],
      }),
    )
    expect(slots[0]?.connection?.id).toBe('channel_1')
  })
})

describe('return from Slack consent', () => {
  it('reads a known result and its setup id, ignoring anything else', () => {
    expect(
      slackReturnFromSearch(
        '?environment=development&slack=authorization_denied&setup=setup_1',
      ),
    ).toEqual({ result: 'authorization_denied', setupId: 'setup_1' })
    expect(slackReturnFromSearch('?slack=not_a_result')).toBeUndefined()
    expect(slackReturnFromSearch('?environment=development')).toBeUndefined()
  })

  it('removes only its own parameters', () => {
    expect(
      withoutSlackReturn('?environment=development&slack=connected&setup=s'),
    ).toBe('?environment=development')
    expect(withoutSlackReturn('?slack=connected')).toBe('')
  })
})

describe('setup copy', () => {
  it('generates request keys the platform accepts', () => {
    const key = newSlackSetupRequestKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(newSlackSetupRequestKey()).not.toBe(key)
  })

  it('sends the browser only to Slack consent pages', () => {
    const url =
      'https://slack.com/oauth/v2/authorize?client_id=1&scope=chat:write&state=s'
    expect(slackAuthorizationHref(url)).toBe(url)
    for (const wrong of [
      'http://slack.com/oauth/v2/authorize?state=s',
      'https://slack.com.evil.example/oauth/v2/authorize?state=s',
      'https://slack.com/oauth/authorize?state=s',
      'javascript:alert(1)',
    ]) {
      expect(() => slackAuthorizationHref(wrong)).toThrow()
    }
  })

  it('leads with the permitted next action for each phase', () => {
    expect(describeSlackSetup(undefined).primary).toEqual({
      action: 'create',
      label: 'Create Slack bot',
    })
    expect(
      describeSlackSetup(
        setup({
          error: {
            code: 'slack_configuration_token_expired',
            message: 'expired',
            recoverable: true,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
      ),
    ).toMatchObject({
      title: 'The configuration token expired',
      primary: { action: 'create', label: 'Try another token' },
    })
    expect(
      describeSlackSetup(
        setup({ phase: 'creation_uncertain', actions: ['manual', 'cancel'] }),
      ).primary,
    ).toBeUndefined()
    expect(
      describeSlackSetup(
        setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          actions: ['authorize', 'cancel'],
        }),
      ),
    ).toMatchObject({
      primary: { action: 'authorize', label: 'Authorize in Slack' },
    })
    expect(
      describeSlackSetup(
        setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          actions: ['authorize', 'cancel'],
          error: {
            code: 'slack_exchange_failed',
            message: 'exchange failed',
            recoverable: true,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
      ),
    ).toMatchObject({
      title: 'Slack did not confirm the installation',
      primary: { action: 'authorize', label: 'Authorize again' },
    })
    expect(
      describeSlackSetup(
        setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          actions: ['manual'],
          error: {
            code: 'slack_setup_superseded',
            message: 'superseded',
            recoverable: false,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
      ).primary,
    ).toEqual({ action: 'create', label: 'Create Slack bot' })
  })

  it('does not offer a retry for a rejected manifest, which needs a redeploy and a new setup', () => {
    const view = describeSlackSetup(
      setup({
        actions: ['cancel', 'manual'],
        error: {
          code: 'slack_manifest_rejected',
          message: 'Slack rejected the app manifest.',
          recoverable: false,
          pointer: '/oauth_config/scopes/bot',
          at: '2026-09-18T08:00:00.000Z',
        },
      }),
    )
    expect(view.title).toBe('Slack rejected the app manifest')
    expect(view.description).toContain('redeploy')
    expect(view.description).toContain('Cancel')
    expect(view.primary).toBeUndefined()
  })

  it('keeps the retry for a manifest rejection an older platform marks recoverable', () => {
    const view = describeSlackSetup(
      setup({
        actions: ['create', 'cancel'],
        error: {
          code: 'slack_manifest_rejected',
          message: 'Slack rejected the app manifest.',
          recoverable: true,
          at: '2026-09-18T08:00:00.000Z',
        },
      }),
    )
    expect(view.primary).toEqual({
      action: 'create',
      label: 'Try another token',
    })
    expect(view.description).toContain('redeploy')
    expect(view.description).not.toContain('Cancel')
  })

  it('treats a setup that lost its connection like a cancelled one, in any phase', () => {
    for (const phase of [
      'connected',
      'cancelled',
      'app_created',
      'prepared',
    ] as const) {
      const view = describeSlackSetup(
        setup({
          phase,
          actions: ['manual'],
          error: {
            code: 'slack_setup_superseded',
            message: 'superseded',
            recoverable: false,
            at: '2026-09-18T08:00:00.000Z',
          },
        }),
      )
      expect(view.title, phase).toBe('This setup no longer owns the connection')
      expect(view.primary, phase).toEqual({
        action: 'create',
        label: 'Create Slack bot',
      })
    }
  })

  it('shows the platform message on a cancelled setup and offers a fresh start', () => {
    const message =
      "This Slack setup was cancelled. The Slack app may still appear in your workspace's app list and can be removed there."
    expect(
      describeSlackSetup(
        setup({
          phase: 'cancelled',
          actions: [],
          error: {
            code: 'slack_setup_cancelled',
            message,
            recoverable: false,
            at: '2026-09-18T08:00:00.000Z',
          },
        }),
      ),
    ).toMatchObject({
      title: 'Setup cancelled',
      description: message,
      primary: { action: 'create', label: 'Create Slack bot' },
    })
  })

  it('separates connected credentials from the first received message', () => {
    expect(describeSlackVerification(connection(), 'Patch').state).toBe(
      'waiting',
    )
    expect(
      describeSlackVerification(
        connection({ verifiedAt: '2026-09-17T00:01:00.000Z' }),
        'Patch',
      ).state,
    ).toBe('verified')
    expect(
      describeSlackVerification(
        connection({ verificationError: 'signing_secret_mismatch' }),
        'Patch',
      ).state,
    ).toBe('rejected')
  })
})
