import { describe, expect, it } from 'vitest'
import {
  agentCanStartNewSession,
  agentDeploymentDisplayStatus,
} from './agent-deployment-status'

const baseAgent = {
  runtime: 'flue',
  revision: 2,
  active_revision_id: 'rev_123',
  flue: {
    agent_name: 'support',
    live: {
      status: 'verified',
    },
  },
}

describe('agent deployment display status', () => {
  it('does not present a live-touching unverified deployment as ready', () => {
    expect(
      agentDeploymentDisplayStatus({
        ...baseAgent,
        deployment_status: {
          deployment_id: 'dep_123',
          state: 'ready',
          result: 'created',
          error_class: null,
          live_touched: true,
          live_status: 'unverified',
          updated_at: '2026-07-14T20:00:00.000Z',
        },
      }),
    ).toBe('unverified')
  })

  it('uses the live updating state rather than the artifact-uploading phase', () => {
    expect(
      agentDeploymentDisplayStatus({
        ...baseAgent,
        deployment_status: {
          deployment_id: 'dep_123',
          state: 'ready',
          result: 'created',
          error_class: null,
          live_touched: true,
          live_status: 'updating',
          updated_at: '2026-07-14T20:00:00.000Z',
        },
      }),
    ).toBe('updating')
  })

  it('keeps a terminal failure visible even when an older live revision exists', () => {
    expect(
      agentDeploymentDisplayStatus({
        ...baseAgent,
        deployment_status: {
          deployment_id: 'dep_124',
          state: 'failed',
          result: 'failed',
          error_class: 'build_failed',
          live_touched: false,
          live_status: 'verified',
          updated_at: '2026-07-14T20:00:00.000Z',
        },
      }),
    ).toBe('failed')
  })

  it('uses the live pointer when deployment status is unavailable', () => {
    expect(
      agentDeploymentDisplayStatus({
        ...baseAgent,
        deployment_status: undefined,
        flue: {
          agent_name: 'support',
          live: { status: 'unverified' },
        },
      }),
    ).toBe('unverified')
  })

  it('labels an agent without a deployment or revision explicitly', () => {
    expect(
      agentDeploymentDisplayStatus({
        runtime: 'flue',
        revision: 0,
        active_revision_id: null,
        deployment_status: undefined,
        flue: { agent_name: 'support', live: null },
      }),
    ).toBe('not_deployed')
  })
})

describe('agent session admission', () => {
  it('admits an active legacy Flue agent only from the server proof', () => {
    const legacy = {
      ...baseAgent,
      flue: { agent_name: 'support', live: null },
      deployment_status: {
        deployment_id: 'dep_legacy',
        state: 'ready',
        result: 'created',
        error_class: null,
        live_touched: false,
        live_status: null,
        legacy_live_compatible: true,
        updated_at: '2026-07-14T20:00:00.000Z',
      },
    }

    expect(agentCanStartNewSession(legacy)).toBe(true)
    expect(agentDeploymentDisplayStatus(legacy)).not.toBe('verified')
  })

  it('does not let the compatibility proof replace an active revision', () => {
    expect(
      agentCanStartNewSession({
        runtime: 'flue',
        revision: 0,
        active_revision_id: null,
        deployment_status: {
          deployment_id: null,
          state: 'not_deployed',
          result: null,
          error_class: null,
          live_touched: false,
          live_status: null,
          legacy_live_compatible: true,
          updated_at: null,
        },
        flue: { agent_name: 'support', live: null },
      }),
    ).toBe(false)
  })

  it('keeps verified Flue and active built-in agents startable', () => {
    expect(agentCanStartNewSession(baseAgent)).toBe(true)
    expect(
      agentCanStartNewSession({
        runtime: 'claude',
        revision: 1,
        active_revision_id: 'rev_builtin',
        deployment_status: undefined,
        flue: null,
      }),
    ).toBe(true)
  })
})
