import { describe, expect, it } from 'vitest'
import { displayManagedAgentName, managedAgentRenderDebug } from './api'

describe('displayManagedAgentName', () => {
  it('hides UUID-shaped legacy names without hiding readable stable names', () => {
    expect(
      displayManagedAgentName({
        id: '8d25ba55-d9de-4345-bedd-92ac5a3f1485',
        name: '8d25ba55-d9de-4345-bedd-92ac5a3f1485',
      }),
    ).toBe('Untitled agent')
    expect(
      displayManagedAgentName({ id: 'email-triage', name: 'email-triage' }),
    ).toBe('email-triage')
    expect(
      displayManagedAgentName({ id: 'stable-id', name: 'Gentle Falcon' }),
    ).toBe('Gentle Falcon')
  })
})

describe('managedAgentRenderDebug', () => {
  it('parses reactive render snapshots and ignores unrelated events', () => {
    const event = {
      id: 'event-1',
      seq: 1,
      timestamp: '2026-08-10T00:00:00.000Z',
      sessionId: 'session-1',
      turnId: 'turn-1',
      type: 'agent.rendered',
      data: {
        renderId: 'render-1',
        responseId: 'response-1',
        providerTurn: 2,
        renderedAt: '2026-08-10T00:00:00.000Z',
        stateVersion: 3,
        instructions: 'Help the user.',
        instructionsHash: 'sha256:prompt',
        input: { source: 'user', text: 'Hello' },
        tools: [{ name: 'search', description: 'Search documentation' }],
        enabledTools: ['search'],
        requiredConnections: [],
        enabledMcpServers: [],
        enabledSubagents: [],
        model: { provider: 'openrouter', model: 'openai/gpt-5.2' },
      },
    }

    expect(managedAgentRenderDebug(event)).toMatchObject({
      renderId: 'render-1',
      instructions: 'Help the user.',
      enabledTools: ['search'],
    })
    expect(
      managedAgentRenderDebug({ ...event, type: 'runtime.log' }),
    ).toBeUndefined()
  })
})
