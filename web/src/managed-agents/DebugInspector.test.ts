import { describe, expect, it } from 'vitest'
import { modelRouteForRender } from './DebugInspector'
import type { ManagedAgentEvent } from './api'

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
): ManagedAgentEvent {
  return { seq, type, data }
}

describe('modelRouteForRender', () => {
  it('associates a gateway resolution emitted immediately before its render', () => {
    const events = [
      event(1, 'turn.started', {}),
      event(2, 'model.route_resolved', {
        requested: {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4.6',
        },
        effective: { provider: 'connection', model: 'GLM-5.3' },
        runtime: 'opencode',
        access: {
          type: 'external_api_key',
          connectionKind: 'openai_compatible_api',
        },
        source: 'project_route',
        routeId: 'mr_1',
        routeRevision: 1,
        fallback: 'fail',
        openComputerModelChargeUsd: 0,
      }),
      event(3, 'agent.rendered', {}),
      event(4, 'turn.completed', {}),
    ]

    expect(modelRouteForRender(events, events[2]!)).toMatchObject({
      effective: { provider: 'connection', model: 'GLM-5.3' },
      source: 'project_route',
      routeRevision: 1,
    })
  })

  it('does not reuse a previous turn route for the next render', () => {
    const events = [
      event(1, 'model.route_resolved', {
        effective: { provider: 'connection', model: 'GLM-5.3' },
        runtime: 'opencode',
        access: { type: 'external_api_key' },
        openComputerModelChargeUsd: 0,
      }),
      event(2, 'agent.rendered', {}),
      event(3, 'agent.rendered', {}),
    ]

    expect(modelRouteForRender(events, events[2]!)).toBeUndefined()
  })
})
