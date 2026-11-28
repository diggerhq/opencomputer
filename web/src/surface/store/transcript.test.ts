import { describe, expect, it } from 'vitest'
import type { ApiEvent } from '@opencomputer/sdk/computer'
import { buildTranscript, unsent, type Item } from './transcript'

// The settled pattern: a running turn shows one work line and its latest
// message; an ended turn folds everything before its last message into one line.

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

  it('a running turn keeps its latest message in view', () => {
    const items = buildTranscript(running().slice(0, -1))
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent'])
    expect(items[2]).toMatchObject({ text: 'Found it.' })
  })

  it('a running turn keeps its latest message in view while the agent works on', () => {
    const items = buildTranscript(running())
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent'])
    expect(items[2]).toMatchObject({ text: 'Found it.' })
    const [w] = works(items)
    expect(w.settled).toBe(false)
    expect(w.entries.map((en) => en.kind)).toEqual(['thinking', 'step', 'step'])
  })

  it('a new message takes its predecessor’s place, which folds into the work', () => {
    const items = buildTranscript([...running(), ev('message.completed', 't1', { text: 'Editing now.' })])
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'agent'])
    expect(items[2]).toMatchObject({ text: 'Editing now.' })
    expect(works(items)[0].entries.map((en) => en.kind)).toEqual(['thinking', 'step', 'text', 'step'])
  })

  it('the reply being written is the answer from its first token, and keeps its key when complete', () => {
    const base = running().slice(0, 5)
    const open = { turnId: 't1', blockId: 'b9', type: 'text', text: 'The cause' }
    const streaming = buildTranscript(base, undefined, open)
    expect(streaming.map((i) => i.kind)).toEqual(['user', 'work', 'agent'])
    expect(streaming[2]).toMatchObject({ key: 'b9', text: 'The cause', streaming: true })
    const done = buildTranscript([...base, ev('message.completed', 't1', { blockId: 'b9', text: 'The cause is X.' })], undefined, null)
    expect(done[2]).toMatchObject({ key: 'b9', text: 'The cause is X.' })
    expect(done[2]).not.toHaveProperty('streaming', true)
    // The work line keeps its key too.
    expect(done[1].key).toBe(streaming[1].key)
  })

  it('a running turn reserves its work line from the start; an ended turn without work drops it', () => {
    const started = [ev('message.received', 't8', { input: 'Hi' }), ev('turn.started', 't8')]
    expect(buildTranscript(started).map((i) => i.kind)).toEqual(['user', 'work'])
    const ended = buildTranscript([...started, ev('message.completed', 't8', { text: 'Hello.' }), ev('turn.completed', 't8')])
    expect(ended.map((i) => i.kind)).toEqual(['user', 'agent'])
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

  it('a message steered into the running turn keeps its own key', () => {
    const items = buildTranscript([
      ev('message.received', 't1', { input: 'Fix it' }),
      ev('message.received', 't1', { input: 'Use pnpm', delivery: 'steered', messageId: 'tn_2' }),
    ])
    expect(items.map((i) => i.key)).toEqual(['t1', 'tn_2'])
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

// Files on a person's message (work 126): what the event says, kept as is; a
// message of files alone is still a message; one still being sent shows its uploads.
describe('attachments', () => {
  const files = [{ id: 'at_1', name: 'shot.png', mimetype: 'image/png', bytes: 10 }]

  it('are on the user item, by the same array', () => {
    const events = [ev('message.received', 't1', { input: 'look', attachments: files })]
    const [item] = buildTranscript(events)
    expect(item).toMatchObject({ kind: 'user', text: 'look' })
    expect((item as Extract<Item, { kind: 'user' }>).attachments).toBe(files)
  })

  it('make a message without text', () => {
    const items = buildTranscript([ev('message.received', 't1', { input: '', attachments: files })])
    expect(items).toMatchObject([{ kind: 'user', text: '', attachments: files }])
    expect(buildTranscript([ev('message.received', 't2', { input: '' })])).toEqual([])
  })

  it('show how far their uploads are while the message is pending', () => {
    const pending = [{ key: 'k', kind: 'turn' as const, sessionId: 'cs_1', turnId: 'tn_9', input: 'x', attachments: ['at_1', 'at_lost'], at: 0 }]
    const held = [{ id: 'at_1', sessionId: 'cs_1', name: 'shot.png', mimetype: 'image/png', bytes: 10, state: 'uploading' as const, progress: 0.5 }]
    const [item] = unsent([], pending, [], 'cs_1', held)
    expect(item).toMatchObject({
      kind: 'user',
      state: 'sending',
      attachments: [
        { id: 'at_1', name: 'shot.png', progress: 0.5, upload: 'uploading' },
        { id: 'at_lost', name: 'file' },
      ],
    })
  })
})

// The person's messages the agent has not read yet (work 134).
describe('delivery', () => {
  type User = Extract<Item, { kind: 'user' }>
  const users = (items: Item[]) => items.filter((i): i is User => i.kind === 'user')
  const start = () => [ev('message.received', 't1', { input: 'Fix it' }), ev('turn.started', 't1')]
  const steer = (input: string, turnId = 't1') => ev('message.received', turnId, { input, delivery: 'steered' })

  it('a steer waits last, behind the step running longest', () => {
    const items = buildTranscript([
      ...start(),
      ev('tool.started', 't1', { callId: 'c1', title: 'Run tests' }),
      ev('tool.started', 't1', { callId: 'c2', title: 'Read a file' }),
      steer('Use pnpm'),
      ev('message.completed', 't1', { text: 'Looking.' }),
    ])
    const last = items[items.length - 1]
    expect(last).toMatchObject({ kind: 'user', text: 'Use pnpm', state: 'waiting', behind: { title: 'Run tests' } })
  })

  it('a steer with no step running waits on nothing', () => {
    const items = buildTranscript([...start(), steer('Use pnpm')])
    expect(items[items.length - 1]).toMatchObject({ state: 'waiting' })
    expect(items[items.length - 1]).not.toHaveProperty('behind')
  })

  it('a steer is drawn where the agent read it, and the next step starts a new work line', () => {
    const s = steer('Use pnpm')
    const before = [...start(), ev('tool.started', 't1', { callId: 'c1', title: 'Run tests' }), s, ev('tool.completed', 't1', { callId: 'c1' })]
    const read = ev('turn.steered', 't1', { messageSeq: s.seq })
    const items = buildTranscript([...before, read, ev('tool.started', 't1', { callId: 'c2', title: 'Install' })])
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'user', 'work'])
    expect(users(items)[1]).toMatchObject({ text: 'Use pnpm', at: read.createdAt })
    expect(users(items)[1]).not.toHaveProperty('state')
  })

  it('of two steers, the one read moves and the other still waits, in order', () => {
    const a = steer('First')
    const items = buildTranscript([...start(), a, steer('Second'), ev('turn.steered', 't1', { messageSeq: a.seq })])
    expect(users(items).map((u) => [u.text, u.state])).toEqual([
      ['Fix it', undefined],
      ['First', undefined],
      ['Second', 'waiting'],
    ])
  })

  it('a steer to a turn that has ended is drawn in place', () => {
    const items = buildTranscript([...start(), ev('turn.completed', 't1'), steer('Late')])
    expect(users(items)[1]).toMatchObject({ text: 'Late' })
    expect(users(items)[1]).not.toHaveProperty('state')
  })

  it('steers not taken are read when their own turn ends, not another', () => {
    const waiting = (end: string) =>
      buildTranscript([...start(), steer('Use pnpm'), ev('message.received', 't2', { input: 'Other', delivery: 'queued' }), ev(end, 't2')])
    expect(users(waiting('turn.completed')).find((u) => u.text === 'Use pnpm')).toMatchObject({ state: 'waiting' })
    for (const end of ['turn.completed', 'turn.failed']) {
      const items = buildTranscript([...start(), steer('Use pnpm'), ev(end, 't1')])
      expect(users(items)[1]).not.toHaveProperty('state')
    }
  })

  it('a stopped turn says Stopped, then the steers it did not take', () => {
    const items = buildTranscript([...start(), steer('Use pnpm'), ev('turn.cancelled', 't1')])
    expect(items.slice(-2).map((i) => (i.kind === 'line' ? i.text : i.kind))).toEqual(['Stopped', 'user'])
  })

  it('a queued message is read when its own turn starts, or comes before Stopped when withdrawn', () => {
    const queued = ev('message.received', 't2', { input: 'Next', delivery: 'queued' })
    expect(buildTranscript([...start(), queued]).slice(-1)[0]).toMatchObject({ text: 'Next', state: 'next' })
    const started = buildTranscript([...start(), queued, ev('turn.completed', 't1'), ev('turn.started', 't2')])
    expect(users(started)[1]).not.toHaveProperty('state')
    const withdrawn = buildTranscript([...start(), queued, ev('turn.cancelled', 't2')])
    expect(withdrawn.slice(-2).map((i) => (i.kind === 'line' ? i.text : i.kind))).toEqual(['user', 'Stopped'])
  })

  it('a turn.steered for an unknown message changes nothing; a track agent’s note never waits', () => {
    const items = buildTranscript([...start(), steer('Use pnpm'), ev('turn.steered', 't1', { messageSeq: 999 })])
    expect(items[items.length - 1]).toMatchObject({ state: 'waiting' })
    const note = { ...steer('From the track'), actor: { id: 'agent', name: null, via: 'agent', client: null } } as ApiEvent
    expect(buildTranscript([...start(), note]).slice(-1)[0]).toMatchObject({ kind: 'line', text: 'From the track' })
  })
})

// A conversation is read from its end (work 139), so the events may start
// anywhere. What they build is the end of what the whole log builds: only the
// item at the cut may differ, and the events before it add items above.
describe('a log read from its end', () => {
  const sa = (id: string, status: string) => ({ id, sessionId: 'cs_1', turnId: 'w2', callId: 'k2', name: 'Find', agentType: 'Explore', background: false, status, activity: null, toolCalls: 0, tokens: 0 })
  const log = (): ApiEvent[] => [
    ev('message.received', 'w1', { input: 'Why is it slow?', messageId: 'm1' }),
    ev('turn.started', 'w1'),
    ev('reasoning.completed', 'w1', { text: 'Look at CI.' }),
    ev('tool.started', 'w1', { callId: 'k1', title: 'Read ci.yml' }),
    ev('tool.completed', 'w1', { callId: 'k1' }),
    ev('message.completed', 'w1', { text: 'Looking.', blockId: 'b1' }),
    ev('message.received', 'w1', { input: 'Check the cache too', delivery: 'steered', messageId: 'm2' }),
    ev('turn.steered', 'w1', { messageSeq: seq }),
    ev('tool.started', 'w1', { callId: 'k1b', title: 'Read cache' }),
    ev('tool.failed', 'w1', { callId: 'k1b' }),
    ev('message.completed', 'w1', { text: 'The cache never hits.', blockId: 'b2' }),
    ev('turn.completed', 'w1'),
    ev('session.compacted', ''),
    ev('message.received', 'w2', { input: 'Who calls it?', messageId: 'm3' }),
    ev('turn.started', 'w2'),
    ev('tool.started', 'w2', { callId: 'k2', title: 'Task: Find' }),
    ev('subagent.started', 'w2', { subagent: sa('sa_9', 'running') }),
    ev('tool.started', 'w2', { callId: 'k3', parentCallId: 'k2', subagentId: 'sa_9', title: 'Grep' }),
    ev('tool.completed', 'w2', { callId: 'k3', parentCallId: 'k2', subagentId: 'sa_9' }),
    ev('subagent.ended', 'w2', { subagent: sa('sa_9', 'completed') }),
    ev('tool.completed', 'w2', { callId: 'k2' }),
    ev('message.completed', 'w2', { text: 'May I push?', blockId: 'b3' }),
    ev('ask.opened', 'w2', { ask: { id: 'a9', kind: 'question' } }),
    ev('ask.closed', 'w2', { ask: { id: 'a9', kind: 'question', answer: 'yes' } }),
    ev('tool.started', 'w2', { callId: 'k4', title: 'Push' }),
    ev('tool.completed', 'w2', { callId: 'k4' }),
    ev('message.completed', 'w2', { text: 'Pushed.', blockId: 'b4' }),
    ev('turn.completed', 'w2'),
    ev('message.received', 'w3', { input: 'And the nightly?', messageId: 'm4' }),
    ev('turn.started', 'w3'),
    ev('tool.started', 'w3', { callId: 'k5', title: 'Run it' }),
    ev('turn.cancelled', 'w3'),
    ev('message.received', 'w4', { input: 'Again', delivery: 'queued', messageId: 'm5' }),
    ev('turn.started', 'w4'),
    ev('tool.started', 'w4', { callId: 'k6', title: 'Run it again' }),
    ev('tool.completed', 'w4', { callId: 'k6' }),
    ev('message.completed', 'w4', { text: 'Still going.', blockId: 'b5' }),
    ev('tool.started', 'w4', { callId: 'k7', title: 'Wait' }),
  ]
  const keys = (items: Item[]) => items.map((i) => i.key)

  it('cut at any event, it builds the end of the whole conversation', () => {
    const all = log()
    // Whole, and stopped at each event: a conversation is read while it runs too.
    for (let end = 1; end <= all.length; end++) {
      const whole = keys(buildTranscript(all.slice(0, end)))
      for (let cut = 0; cut < end; cut++) {
        const tail = keys(buildTranscript(all.slice(cut, end))).slice(1)
        expect(tail, `events ${cut} to ${end}`).toEqual(tail.length ? whole.slice(-tail.length) : [])
      }
    }
  })

  it('a subagent or an ask whose start is before the cut waits for it', () => {
    const all = log()
    const from = (type: string) => buildTranscript(all.slice(all.findIndex((e) => e.type === type)))
    expect(from('subagent.ended').some((i) => i.kind === 'subagent')).toBe(false)
    expect(from('ask.closed').some((i) => i.kind === 'ask')).toBe(false)
  })
})
