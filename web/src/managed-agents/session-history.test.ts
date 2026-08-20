import { describe, expect, it } from 'vitest'
import type { ManagedAgentDeployment, ManagedAgentSession } from './api'
import {
  playgroundSessionIdFromSearch,
  playgroundSessionSearch,
  sessionsForEnvironment,
} from './session-history'

function deployment(
  id: string,
  alias: string,
  agentId = 'reviewer',
): ManagedAgentDeployment {
  return {
    id,
    agentId,
    alias,
    channels: [],
    connections: [],
    createdAt: '2026-08-15T00:00:00.000Z',
  }
}

function session(id: string, deploymentId: string): ManagedAgentSession {
  return {
    id,
    agentId: 'reviewer',
    deploymentId,
    status: 'idle',
    source: 'playground',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    turns: [],
  }
}

describe('sessionsForEnvironment', () => {
  it('keeps sessions from historical deployments in the selected environment', () => {
    const sessions = [
      session('old-development', 'dev-1'),
      session('active-development', 'dev-2'),
      session('production', 'prod-1'),
    ]

    expect(
      sessionsForEnvironment(
        sessions,
        [
          deployment('dev-1', 'development'),
          deployment('dev-2', 'development'),
          deployment('prod-1', 'production'),
        ],
        'reviewer',
        'development',
      ).map(({ id }) => id),
    ).toEqual(['old-development', 'active-development'])
  })

  it('does not include another agent deployment', () => {
    expect(
      sessionsForEnvironment(
        [session('other', 'other-dev')],
        [deployment('other-dev', 'development', 'other-agent')],
        'reviewer',
        'development',
      ),
    ).toEqual([])
  })
})

describe('playground session URL state', () => {
  it('round trips a selected session without losing project context', () => {
    const search = playgroundSessionSearch(
      '?agent=reviewer&environment=production',
      'session-1',
    )

    expect(search).toBe(
      '?agent=reviewer&environment=production&session=session-1',
    )
    expect(playgroundSessionIdFromSearch(search)).toBe('session-1')
  })

  it('clears only the session when starting a new draft', () => {
    expect(playgroundSessionSearch('?agent=reviewer&session=session-1')).toBe(
      '?agent=reviewer',
    )
  })
})
