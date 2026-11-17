import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../computer-sessions-api'
import { buildTranscript, formatDuration, mergeEvents } from './transcript'

let seq = 0
const ev = (
  type: string,
  data: Record<string, unknown> = {},
): SessionEvent => ({
  id: `ev_${++seq}`,
  seq,
  createdAt: new Date(Date.UTC(2026, 10, 17, 12, 0, seq)).toISOString(),
  turnId: 'tn_1',
  actor:
    type === 'message.received' ? { name: 'Igor', via: 'dashboard' } : null,
  type,
  data,
})

describe('buildTranscript', () => {
  it('folds tool calls between messages into one work step', () => {
    const items = buildTranscript([
      ev('message.received', { input: 'Fix the test' }),
      ev('tool.started', { callId: 'a', title: 'Read x', toolName: 'Read' }),
      ev('tool.completed', { callId: 'a', title: 'Read x', toolName: 'Read' }),
      ev('tool.started', { callId: 'b', title: 'npm test', toolName: 'Bash' }),
      ev('tool.failed', { callId: 'b', title: 'npm test', toolName: 'Bash' }),
      ev('message.completed', { parentCallId: null, text: 'Fixed.' }),
      ev('turn.completed', {}),
      ev('usage.recorded', {}),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent'])
    const work = items[1]
    expect(work.kind === 'work' && work.tools.map((t) => t.status)).toEqual([
      'done',
      'failed',
    ])
    expect(work.kind === 'work' && work.open).toBe(false)
  })

  it('keeps a subagent message inside the work and updates a closed ask', () => {
    const ask = { id: 'ak_1', status: 'open' }
    const items = buildTranscript([
      ev('message.completed', { parentCallId: 'call_1', text: 'sub' }),
      ev('ask.opened', { ask }),
      ev('ask.closed', { ask: { ...ask, status: 'answered' } }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['work', 'ask'])
    expect(items[1].kind === 'ask' && items[1].ask.status).toBe('answered')
  })
})

describe('mergeEvents', () => {
  it('appends in order and drops repeats', () => {
    const a = [ev('other'), ev('other')]
    const b = ev('other')
    expect(mergeEvents(a, [a[1], b]).map((e) => e.seq)).toEqual([
      a[0].seq,
      a[1].seq,
      b.seq,
    ])
  })
})

describe('formatDuration', () => {
  it('reads like a person would say it', () => {
    expect(formatDuration(400)).toBe('1s')
    expect(formatDuration(72_000)).toBe('1m 12s')
    expect(formatDuration(3_600_000)).toBe('1h')
  })
})
