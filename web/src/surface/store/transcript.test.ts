import { describe, expect, it } from 'vitest'
import type { ApiEvent } from '@opencomputer/sdk/computer'
import { buildTranscript } from './transcript'

// The settled pattern: a running turn lists its steps where they happened; an
// ended turn folds all of them into one line, where its first step was.

let seq = 0
const ev = (type: string, turnId: string, data: Record<string, unknown> = {}): ApiEvent =>
  ({ id: `ev${++seq}`, seq, type, turnId, sessionId: 'cs_1', createdAt: new Date(seq * 1000).toISOString(), data, actor: null }) as unknown as ApiEvent

describe('steps', () => {
  const running = [
    ev('message.received', 't1', { input: 'Fix it' }),
    ev('tool.started', 't1', { callId: 'c1', title: 'Read a file' }),
    ev('tool.completed', 't1', { callId: 'c1' }),
    ev('message.completed', 't1', { text: 'Found it.' }),
    ev('tool.started', 't1', { callId: 'c2', title: 'Edit a file' }),
  ]

  it('a running turn lists its steps in place', () => {
    const items = buildTranscript(running)
    expect(items.map((i) => i.kind)).toEqual(['user', 'steps', 'agent', 'steps'])
    expect(items.every((i) => i.kind !== 'steps' || !i.settled)).toBe(true)
  })

  it('an ended turn folds every step into one line, none still running', () => {
    const items = buildTranscript([...running, ev('turn.completed', 't1')])
    expect(items.map((i) => i.kind)).toEqual(['user', 'steps', 'agent'])
    const steps = items[1] as Extract<(typeof items)[number], { kind: 'steps' }>
    expect(steps.settled).toBe(true)
    expect(steps.steps.map((s) => [s.title, s.status])).toEqual([
      ['Read a file', 'done'],
      ['Edit a file', 'done'],
    ])
  })

  it('the next turn starts its own', () => {
    const items = buildTranscript([...running, ev('turn.cancelled', 't1'), ev('tool.started', 't2', { callId: 'c3', title: 'Run tests' })])
    const groups = items.filter((i) => i.kind === 'steps')
    expect(groups.map((g) => g.settled)).toEqual([true, false])
  })
})
