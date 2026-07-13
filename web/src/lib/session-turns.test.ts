import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@/api/client'
import { groupIntoTurns } from './session-turns'

function event(
  seq: number,
  type: string,
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    id: `evt_${seq}_${type.replace(/\./g, '_')}`,
    seq,
    type,
    level: type.endsWith('message') ? 'user' : 'progress',
    body: {},
    ...overrides,
  }
}

describe('groupIntoTurns', () => {
  it('groups a normal brain-box turn by its explicit input bounds', () => {
    const timeline = groupIntoTurns([
      event(1, 'user.message', {
        source: 'client',
        body: { text: 'hello' },
        turn_id: null,
      }),
      event(2, 'turn.started', {
        turn_id: 'trn_brain',
        body: { input_from_seq: 1, input_to_seq: 1 },
      }),
      event(3, 'agent.message', {
        turn_id: 'trn_brain',
        body: { text: 'hi' },
      }),
      event(4, 'turn.completed', {
        turn_id: 'trn_brain',
        body: { yield_reason: 'completed' },
      }),
    ])

    expect(timeline.pending).toEqual([])
    expect(timeline.groups).toHaveLength(1)
    expect(timeline.groups[0]).toMatchObject({
      turnId: 'trn_brain',
      fromSeq: 1,
      toSeq: 1,
      state: 'completed',
      yieldReason: 'completed',
    })
    expect(timeline.groups[0]?.events.map((item) => item.seq)).toEqual([1, 3])
  })

  it('uses the platform turn id and neutral outcome for a new Flue turn', () => {
    const timeline = groupIntoTurns([
      event(1, 'user.message', {
        source: 'client',
        turn_id: 'trn_platform',
        body: { text: 'triage this' },
      }),
      event(2, 'turn.started', {
        turn_id: 'trn_platform',
        body: {
          turn_id: 'trn_platform',
          input_from_seq: 1,
          input_to_seq: 1,
        },
      }),
      event(3, 'agent.message', {
        turn_id: 'trn_platform',
        body: { text: 'done' },
      }),
      event(4, 'turn.completed', {
        turn_id: 'trn_platform',
        level: 'user',
        body: {
          turn_id: 'trn_platform',
          outcome: 'quiescent',
          result_event_id: 'evt_3_agent_message',
        },
      }),
    ])

    expect(timeline.pending).toEqual([])
    expect(timeline.groups[0]).toMatchObject({
      turnId: 'trn_platform',
      state: 'completed',
      yieldReason: 'quiescent',
    })
    expect(timeline.groups[0]).not.toHaveProperty('inferredBounds')
    expect(timeline.groups[0]?.events.map((item) => item.seq)).toEqual([1, 3])
  })

  it('repairs the production preview start that omitted input bounds', () => {
    const timeline = groupIntoTurns([
      event(1, 'user.message', {
        source: 'client',
        turn_id: null,
        body: { text: 'how are we doing' },
      }),
      event(2, 'turn.started', {
        turn_id: 'trn_flue_preview',
        body: { submission_id: 'sub_preview' },
      }),
      event(3, 'agent.message', {
        turn_id: 'trn_flue_preview',
        body: { text: 'all good' },
      }),
      event(4, 'turn.completed', {
        turn_id: 'trn_flue_preview',
        level: 'user',
        body: { outcome: 'quiescent' },
      }),
    ])

    expect(timeline.pending).toEqual([])
    expect(timeline.groups[0]).toMatchObject({
      turnId: 'trn_flue_preview',
      fromSeq: 1,
      toSeq: 1,
      inferredBounds: true,
      state: 'completed',
    })
    expect(timeline.groups[0]?.events.map((item) => item.seq)).toEqual([1, 3])
  })

  it('keeps a completion-only failure visible with its error', () => {
    const timeline = groupIntoTurns([
      event(7, 'turn.completed', {
        turn_id: 'trn_failed',
        level: 'user',
        body: {
          outcome: 'error',
          error: { code: 'admission_rejected', message: 'tenant rejected it' },
        },
      }),
    ])

    expect(timeline.groups).toEqual([
      expect.objectContaining({
        turnId: 'trn_failed',
        state: 'error',
        errorMessage: 'admission_rejected: tenant rejected it',
        events: [],
      }),
    ])
  })

  it('leaves a follow-up queued until a new turn claims it', () => {
    const timeline = groupIntoTurns([
      event(1, 'user.message', {
        source: 'client',
        turn_id: null,
        body: { text: 'first' },
      }),
      event(2, 'turn.started', {
        turn_id: 'trn_first',
        body: { input_from_seq: 1, input_to_seq: 1 },
      }),
      event(3, 'user.message', {
        source: 'client',
        turn_id: null,
        body: { text: 'second' },
      }),
    ])

    expect(timeline.groups[0]).toMatchObject({
      turnId: 'trn_first',
      state: 'running',
    })
    expect(timeline.pending.map((item) => item.seq)).toEqual([3])
  })

  it('shows a new accepted input as queued before turn.started exists', () => {
    const timeline = groupIntoTurns([
      event(1, 'user.message', {
        source: 'client',
        turn_id: 'trn_accepted',
        body: { text: 'start' },
      }),
    ])

    expect(timeline.pending).toEqual([])
    expect(timeline.groups[0]).toMatchObject({
      turnId: 'trn_accepted',
      state: 'queued',
    })
  })

  it('deduplicates history and SSE copies and cannot regress on arrival order', () => {
    const input = event(1, 'user.message', {
      source: 'client',
      turn_id: 'trn_ordered',
      body: { text: 'go' },
    })
    const started = event(2, 'turn.started', {
      turn_id: 'trn_ordered',
      body: { input_from_seq: 1, input_to_seq: 1 },
    })
    const answer = event(3, 'agent.message', {
      turn_id: 'trn_ordered',
      body: { text: 'done' },
    })
    const completed = event(4, 'turn.completed', {
      turn_id: 'trn_ordered',
      body: { outcome: 'quiescent' },
    })

    const timeline = groupIntoTurns([
      completed,
      answer,
      input,
      started,
      completed,
      answer,
    ])

    expect(timeline.groups).toHaveLength(1)
    expect(timeline.groups[0]?.state).toBe('completed')
    expect(timeline.groups[0]?.events.map((item) => item.id)).toEqual([
      input.id,
      answer.id,
    ])
  })

  it('never steals an input already owned by an explicit range', () => {
    const timeline = groupIntoTurns([
      event(1, 'user.message', {
        source: 'client',
        turn_id: null,
        body: { text: 'owned' },
      }),
      event(2, 'turn.started', {
        turn_id: 'trn_explicit',
        body: { input_from_seq: 1, input_to_seq: 1 },
      }),
      event(3, 'turn.started', {
        turn_id: 'trn_legacy',
        body: { submission_id: 'sub_later' },
      }),
    ])

    expect(
      timeline.groups.find((group) => group.turnId === 'trn_explicit')?.events,
    ).toHaveLength(1)
    expect(
      timeline.groups.find((group) => group.turnId === 'trn_legacy')?.events,
    ).toHaveLength(0)
  })
})
