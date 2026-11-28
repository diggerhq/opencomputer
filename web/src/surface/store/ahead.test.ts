// @vitest-environment node
// Reading ahead (work 139, 7.4): when the feed arrives, the conversations of
// the threads with a mark are read, newest first, at most ten, one after
// another. The SDK client is stubbed: the store's side only.

import { describe, expect, it, vi } from 'vitest'
import type { EventsUpdate, FeedFrame, Row } from '@opencomputer/sdk/computer'
import type { Host } from '../host'
import { NOWHERE } from '../host'

const ME = 'usr_me'
const sid = (i: number) => `cs_${String(i).padStart(16, '0')}`
const rows: Row[] = []
for (let i = 0; i < 14; i++) {
  rows.push({
    kind: 'session',
    id: sid(i),
    version: 1,
    title: `Thread ${i}`,
    status: 'idle',
    owner: { id: ME },
    lastSeq: 1,
    lastText: null,
    lastTurn: null,
    lastAgentSeq: 0,
    asks: [],
    // Threads 12 and 13 have no mark.
    blocked: i < 12,
    inbox: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  } as unknown as Row)
  rows.push({ kind: 'place', id: sid(i), version: 1, sessionId: sid(i), trackId: null, position: i, doneAt: null, earlierAt: null, keep: false, attention: null, readySeq: null } as unknown as Row)
}

const asked: string[] = []
let inFlight = 0
let most = 0

vi.mock('@opencomputer/sdk/computer', async (actual) => {
  const sdk = await actual<typeof import('@opencomputer/sdk/computer')>()
  const signal = <T,>(v: T) => ({ get: () => v, subscribe: () => () => {} })
  return {
    ...sdk,
    createClient: () => ({
      ready: Promise.resolve(),
      status: { get: () => 'online', subscribe: (cb: (s: string) => void) => (cb('online'), () => {}) },
      pending: () => signal([]),
      attachments: () => signal([]),
      failures: { subscribe: () => () => {} },
      feed: () => ({
        subscribe: (cb: (f: FeedFrame) => void) => {
          cb({ protocol: 1, org: 'o', subject: ME, from: null, to: '1', more: false, rows, gone: [], version: 1 })
          return () => {}
        },
      }),
      read: () => Promise.resolve({ rows: [] }),
      mutate: () => ({ settled: Promise.resolve() }),
      events: () => ({ subscribe: () => () => {} }),
      deltas: () => ({ subscribe: () => () => {} }),
      earlier: () => Promise.resolve(),
      prefetch: async (id: string): Promise<EventsUpdate | null> => {
        asked.push(id)
        most = Math.max(most, ++inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return { events: [], reset: { seq: null }, hasEarlier: false }
      },
      close: () => {},
    }),
  }
})

const { createSurface } = await import('./surface-store')
const { memoryStorage } = await import('@opencomputer/sdk/computer')

describe('reading ahead', () => {
  it('reads the marked threads when the feed arrives: newest first, ten, one at a time', async () => {
    const host = {
      platform: 'web',
      principal: { kind: 'member', subject: ME, org: 'o' },
      api: { fetch: () => Promise.reject(new Error('stubbed')) },
      connect: () => ({}),
      notify: () => {},
      badge: () => {},
      openExternal: () => {},
      onOpen: () => {},
      location: { get: () => NOWHERE, set: () => {}, onChange: () => () => {} },
    } as unknown as Host
    const s = createSurface({ host, storage: memoryStorage(), visible: () => true, wake: () => () => {} })
    await vi.waitFor(() => expect(asked).toHaveLength(10))
    await new Promise((r) => setTimeout(r, 30))
    expect(asked).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map(sid))
    expect(most).toBe(1)
    // What was read is held, drawn the moment the thread opens.
    await vi.waitFor(() => expect(s.get().convos[sid(2)]?.loaded).toBe(true))
    // A thread already held is not read again.
    await s.ahead(sid(11))
    await s.ahead(sid(13))
    expect(asked).toHaveLength(11)
    expect(asked[10]).toBe(sid(13))
    s.close()
  })
})
