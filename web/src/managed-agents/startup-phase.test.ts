import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { ManagedAgentEvent } from './api'
import {
  initialStartupPhase,
  messageStartupPhase,
  nextStartupPhase,
  STARTUP_PHASE_PART_TYPE,
  startupPhaseHint,
  startupPhaseLabel,
  type StartupPhase,
} from './startup-phase'

function event(
  type: ManagedAgentEvent['type'],
  data: Record<string, unknown> = {},
): ManagedAgentEvent {
  return { seq: 1, type, data }
}

function walk(start: StartupPhase, events: ManagedAgentEvent[]) {
  return events.reduce(nextStartupPhase, start)
}

describe('startup phase', () => {
  it('starts at session creation for a new chat and at the model for a continued one', () => {
    expect(initialStartupPhase(false)).toBe('session')
    expect(initialStartupPhase(true)).toBe('model')
  })

  it('treats a fresh microvm boot as runtime startup until the runtime connects', () => {
    const phases: StartupPhase[] = []
    let phase = initialStartupPhase(false)
    for (const next of [
      event('session.created'),
      event('session.status_changed', { from: 'new', to: 'connecting' }),
      event('runtime.connected'),
      event('turn.queued'),
      event('turn.started'),
    ]) {
      phase = nextStartupPhase(phase, next)
      phases.push(phase)
    }
    expect(phases).toEqual(['runtime', 'runtime', 'model', 'model', 'model'])
  })

  it('shows runtime startup when a suspended session wakes, then returns to the model', () => {
    expect(walk('model', [event('runtime.resumed')])).toBe('runtime')
    expect(
      walk('model', [event('runtime.resumed'), event('runtime.connected')]),
    ).toBe('model')
  })

  it('keeps a warm continued session on the model phase', () => {
    expect(
      walk('model', [
        event('turn.queued'),
        event('turn.started'),
        event('session.status_changed', { from: 'idle', to: 'running' }),
      ]),
    ).toBe('model')
  })

  it('only explains one-time cost for the runtime phase', () => {
    expect(startupPhaseLabel('runtime')).toContain('one-time')
    expect(startupPhaseHint('runtime')).toMatch(/later messages/i)
    expect(startupPhaseHint('model')).toBeUndefined()
    expect(startupPhaseHint('session')).toBeUndefined()
    expect(startupPhaseLabel(undefined)).toBe('Starting the agent…')
  })

  it('reads the latest phase part off a message and ignores malformed ones', () => {
    const message: UIMessage = {
      id: 'm',
      role: 'assistant',
      parts: [
        { type: STARTUP_PHASE_PART_TYPE, id: 'p', data: { phase: 'bogus' } },
        { type: STARTUP_PHASE_PART_TYPE, id: 'p', data: { phase: 'runtime' } },
      ],
    }
    expect(messageStartupPhase(message)).toBe('runtime')
    expect(
      messageStartupPhase({ id: 'm', role: 'assistant', parts: [] }),
    ).toBeUndefined()
  })
})
