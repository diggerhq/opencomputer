import { describe, expect, it } from 'vitest'
import {
  collectManagedAgentEventPages,
  displayManagedAgentName,
  managedAgentModelRoute,
  managedAgentRenderDebug,
  nextAgentEventDeadline,
} from './api'

describe('collectManagedAgentEventPages', () => {
  it('follows event cursors until the API returns an empty page', async () => {
    const cursors: number[] = []
    const pages = new Map([
      [0, [{ seq: 1 }, { seq: 500 }]],
      [500, [{ seq: 501 }]],
      [501, []],
    ])

    const events = await collectManagedAgentEventPages((after) => {
      cursors.push(after)
      return Promise.resolve(
        (pages.get(after) ?? []).map(({ seq }) => ({
          seq,
          type: 'message.delta',
          data: { text: String(seq) },
        })),
      )
    })

    expect(cursors).toEqual([0, 500, 501])
    expect(events.map(({ seq }) => seq)).toEqual([1, 500, 501])
  })
})

describe('nextAgentEventDeadline', () => {
  it('refreshes the inactivity deadline only when progress arrives', () => {
    expect(nextAgentEventDeadline(10_000, 3_000, 0, 9_000)).toBe(10_000)
    expect(nextAgentEventDeadline(10_000, 3_000, 1, 9_000)).toBe(12_000)
  })
})

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

describe('managedAgentModelRoute', () => {
  it('parses Codex BYOK route attribution', () => {
    const event = {
      id: 'event-2',
      seq: 2,
      timestamp: '2026-08-24T00:00:00.000Z',
      sessionId: 'session-1',
      turnId: 'turn-1',
      type: 'model.route_resolved',
      data: {
        requested: { provider: 'openai', model: 'gpt-5.6-sol' },
        effective: { provider: 'openai', model: 'gpt-5.6-sol' },
        runtime: 'codex',
        access: {
          type: 'external_subscription',
          connectionId: 'mac_1',
          connectionKind: 'codex_subscription',
        },
        openComputerModelChargeUsd: 0,
      },
    }

    expect(managedAgentModelRoute(event)).toMatchObject({
      access: {
        type: 'external_subscription',
        connectionKind: 'codex_subscription',
      },
      openComputerModelChargeUsd: 0,
    })
    expect(
      managedAgentModelRoute({ ...event, type: 'agent.rendered' }),
    ).toBeUndefined()
  })
})
