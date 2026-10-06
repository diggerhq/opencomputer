import { describe, expect, it } from 'vitest'
import { mergeManagedAgentEvents } from './use-live-session-events'
import type { ManagedAgentEvent } from './events'

const ev = (seq: number): ManagedAgentEvent => ({
  seq,
  type: 'message.delta',
  data: { text: String(seq) },
})

describe('mergeManagedAgentEvents', () => {
  it('appends new events in seq order and drops duplicates', () => {
    const base = [ev(1), ev(2), ev(3)]
    expect(
      mergeManagedAgentEvents(base, [ev(2), ev(5), ev(4)]).map((e) => e.seq),
    ).toEqual([1, 2, 3, 4, 5])
  })

  it('returns the base array untouched when nothing is new', () => {
    const base = [ev(1), ev(2)]
    expect(mergeManagedAgentEvents(base, [ev(1)])).toBe(base)
    expect(mergeManagedAgentEvents(base, [])).toBe(base)
  })

  it('returns the live list when there is no history yet', () => {
    const live = [ev(7)]
    expect(mergeManagedAgentEvents([], live)).toBe(live)
  })
})
