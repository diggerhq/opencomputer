import { describe, expect, it } from 'vitest'
import type { ApiEvent } from '@opencomputer/sdk/computer'
import { buildTranscript, type Item } from './transcript'

// The settled pattern: a running turn lists its work where it happened; an
// ended turn folds everything before its last message into one line.

let seq = 0
const ev = (type: string, turnId: string, data: Record<string, unknown> = {}): ApiEvent =>
  ({ id: `ev${++seq}`, seq, type, turnId, sessionId: 'cs_1', createdAt: new Date(seq * 1000).toISOString(), data, actor: null })

type Work = Extract<Item, { kind: 'work' }>
const works = (items: Item[]) => items.filter((i): i is Work => i.kind === 'work')

describe('work', () => {
  const running = () => [
    ev('message.received', 't1', { input: 'Fix it' }),
    ev('turn.started', 't1'),
    ev('reasoning.completed', 't1', { text: 'Read the handler first.', durationMs: 1200 }),
    ev('tool.started', 't1', { callId: 'c1', title: 'Read a file' }),
    ev('tool.completed', 't1', { callId: 'c1' }),
    ev('message.completed', 't1', { text: 'Found it.' }),
    ev('tool.started', 't1', { callId: 'c2', title: 'Edit a file' }),
  ]

  it('a running turn lists its work in place, its messages between', () => {
    const items = buildTranscript(running())
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent', 'work'])
    expect(works(items).map((w) => [w.settled, w.entries.map((en) => en.kind)])).toEqual([
      [false, ['thinking', 'step']],
      [false, ['step']],
    ])
  })

  it('an ended turn folds thinking, steps and passing messages into one line before its answer', () => {
    const items = buildTranscript([...running(), ev('message.completed', 't1', { text: 'Fixed.' }), ev('turn.completed', 't1')])
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent'])
    const [w] = works(items)
    expect(w.settled).toBe(true)
    expect(w.entries.map((en) => [en.kind, en.kind === 'step' ? en.status : en.text])).toEqual([
      ['thinking', 'Read the handler first.'],
      ['step', 'done'],
      ['text', 'Found it.'],
      ['step', 'done'],
    ])
    // From turn.started to the answer.
    expect(w.ms).toBe(6000)
    expect(items[2]).toMatchObject({ kind: 'agent', text: 'Fixed.' })
  })

  it('what the agent said before it asked stays beside the ask', () => {
    const items = buildTranscript([
      ...running(),
      ev('message.completed', 't1', { text: 'I need to push.' }),
      ev('ask.opened', 't1', { ask: { id: 'a1', kind: 'question' } }),
      ev('tool.started', 't1', { callId: 'c3', title: 'Push' }),
      ev('message.completed', 't1', { text: 'Pushed.' }),
      ev('turn.completed', 't1'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent', 'ask', 'work', 'agent'])
    expect(items[2]).toMatchObject({ text: 'I need to push.' })
  })

  it('a turn with only an answer has no work line', () => {
    const items = buildTranscript([ev('message.received', 't9', { input: 'Hi' }), ev('message.completed', 't9', { text: 'Hello.' }), ev('turn.completed', 't9')])
    expect(items.map((i) => i.kind)).toEqual(['user', 'agent'])
  })

  it('the next turn starts its own', () => {
    const items = buildTranscript([...running(), ev('turn.cancelled', 't1'), ev('tool.started', 't2', { callId: 'c3', title: 'Run tests' })])
    expect(works(items).map((w) => w.settled)).toEqual([true, false])
  })

  it('a subagent’s thinking is not shown', () => {
    const items = buildTranscript([
      ev('reasoning.completed', 't1', { blockId: 'b2', text: 'inner', parentCallId: 'c1', durationMs: 10, redacted: false }),
    ])
    expect(items).toEqual([])
  })
})

describe('notes', () => {
  it('a compaction is a muted line', () => {
    const items = buildTranscript([ev('session.compacted', 't1', { beforeTokens: 1000, afterTokens: null, auto: true })])
    expect(items).toMatchObject([{ kind: 'line', text: 'Context compacted', tone: 'muted' }])
  })
})

describe('subagents', () => {
  const sa = (status: string, more: Record<string, unknown> = {}) => ({
    id: 'sa_1', sessionId: 'cs_1', turnId: 't1', callId: 'c1', name: 'Find the callers', agentType: 'Explore', background: false,
    status, activity: null, toolCalls: 0, tokens: 0, createdAt: '', endedAt: null, durationMs: null, result: null, resultTruncated: false, error: null, stoppedBy: null,
    ...more,
  })
  const launched = () => [
    ev('message.received', 't1', { input: 'Who calls it?' }),
    ev('turn.started', 't1'),
    ev('tool.started', 't1', { callId: 'c1', title: 'Task: Find the callers' }),
    ev('subagent.started', 't1', { subagent: sa('running') }),
    ev('tool.started', 't1', { callId: 'c2', parentCallId: 'c1', subagentId: 'sa_1', title: 'Grep handler' }),
    ev('tool.completed', 't1', { callId: 'c2', parentCallId: 'c1', subagentId: 'sa_1' }),
    ev('tool.started', 't1', { callId: 'c3', parentCallId: 'c1', subagentId: 'sa_1', title: 'Read a file' }),
  ]
  type Sub = Extract<Item, { kind: 'subagent' }>
  const subOf = (items: Item[]) => items.find((i): i is Sub => i.kind === 'subagent')!

  it('a running subagent is its own item, with its steps and what it is doing now', () => {
    const items = buildTranscript(launched())
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'subagent'])
    const s = subOf(items)
    expect(s.steps.map((x) => [x.title, x.status])).toEqual([['Grep handler', 'done'], ['Read a file', 'running']])
    expect(s.activity).toBe('Read a file')
    expect(s.sub.toolCalls).toBe(2)
    // Its steps are not the turn's.
    expect(works(items)[0].entries).toHaveLength(1)
  })

  it('an ended subagent keeps its place, takes its final state and stops showing activity', () => {
    const items = buildTranscript([
      ...launched(),
      ev('subagent.ended', 't1', { subagent: sa('completed', { toolCalls: 5, tokens: 1200, durationMs: 4000, result: 'Two callers.' }) }),
      ev('tool.completed', 't1', { callId: 'c1' }),
      ev('message.completed', 't1', { text: 'Two callers.' }),
      ev('turn.completed', 't1'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'subagent', 'agent'])
    const s = subOf(items)
    expect([s.sub.status, s.sub.toolCalls, s.sub.result, s.activity]).toEqual(['completed', 5, 'Two callers.', null])
    expect(s.steps.every((x) => x.status === 'done')).toBe(true)
  })
})
