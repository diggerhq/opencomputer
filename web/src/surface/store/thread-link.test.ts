// @vitest-environment node
// A link names a thread the feed does not hold (spec 26.2): the store reads that
// one thread by id; one the server does not have is shown as not found, never
// the start box. The SDK client is stubbed: the store's side only.

import { describe, expect, it, vi } from 'vitest'
import type { FeedFrame, PlaceRow, Row, SessionRow } from '@opencomputer/sdk/computer'
import type { Host, Location } from '../host'
import { NOWHERE } from '../host'

const reads: string[] = []
let answer: (path: string) => Promise<unknown> = () => Promise.resolve({ rows: [] })

vi.mock('@opencomputer/sdk/computer', async (actual) => {
  const sdk = await actual<typeof import('@opencomputer/sdk/computer')>()
  const signal = <T,>(v: T) => ({ get: () => v, subscribe: () => () => {} })
  return {
    ...sdk,
    createClient: () => ({
      ready: Promise.resolve(),
      status: { get: () => 'online', subscribe: (cb: (s: string) => void) => (cb('online'), () => {}) },
      pending: () => signal([]),
      failures: { subscribe: () => () => {} },
      feed: () => ({
        subscribe: (cb: (f: FeedFrame) => void) => {
          cb({ protocol: 1, org: 'o', subject: 'usr_me', from: null, to: '1', more: false, rows: [], gone: [], version: 1 })
          return () => {}
        },
      }),
      read: (path: string) => (reads.push(path), answer(path)),
      mutate: () => ({ settled: Promise.resolve() }),
      events: () => ({ subscribe: () => () => {} }),
      deltas: () => ({ subscribe: () => () => {} }),
      close: () => {},
    }),
  }
})

const { createSurface } = await import('./surface-store')
const { Refused, memoryStorage } = await import('@opencomputer/sdk/computer')

const SID = 'cs_0000000000000001'
const session = { kind: 'session', id: SID, version: 1, title: 'From before', status: 'idle', lastSeq: 0, lastText: null, lastTurn: null, lastAgentSeq: 0, asks: [], blocked: false, inbox: [], machine: '', owner: { kind: 'member', id: 'usr_me', name: 'Me' }, origin: {}, settings: { model: null, effort: null, mode: 'default', speed: null }, role: null } as unknown as SessionRow
const place = { kind: 'place', id: SID, version: 1, sessionId: SID, trackId: null, position: 1, doneAt: 1, earlierAt: 1, keep: false, attention: null, readySeq: null } as unknown as PlaceRow

function open(at: Location) {
  let loc = at
  const host = {
    platform: 'web',
    principal: { kind: 'member', subject: 'usr_me', org: 'o' },
    api: { fetch: () => Promise.reject(new Error('stubbed')) },
    connect: () => ({}),
    notify: () => {},
    badge: () => {},
    openExternal: () => {},
    onOpen: () => {},
    location: { get: () => loc, set: (l: Location) => void (loc = l), onChange: () => () => {} },
  } as unknown as Host
  const s = createSurface({ host, storage: memoryStorage(), visible: () => true })
  return { s, loc: () => loc }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('a link to a thread the feed does not hold', () => {
  it('reads that thread by id and opens it', async () => {
    reads.length = 0
    answer = () => Promise.resolve({ rows: [session, place] as Row[] })
    const { s, loc } = open({ ...NOWHERE, thread: SID })
    await settle()
    await settle()
    expect(reads).toEqual([`/work/threads/${SID}`])
    expect(s.thread(SID)?.title).toBe('From before')
    expect(loc().thread).toBe(SID)
    expect(s.get().missing[SID]).toBeUndefined()
    s.close()
  })

  it('shows not found for a session the server does not have, not the start box', async () => {
    reads.length = 0
    answer = () => Promise.reject(new Refused('session_not_found', 'No such session.'))
    const { s, loc } = open({ ...NOWHERE, thread: SID })
    await settle()
    await settle()
    expect(reads).toEqual([`/work/threads/${SID}`])
    expect(s.get().missing[SID]).toBe(true)
    expect(loc()).toEqual({ ...NOWHERE, thread: SID })
    s.close()
  })

  it('says it could not open a thread whose read failed otherwise, and Try again reads it', async () => {
    reads.length = 0
    answer = () => Promise.reject(new Refused('forbidden', ''))
    const { s, loc } = open({ ...NOWHERE, thread: SID })
    await settle()
    await settle()
    expect(s.get().unopened[SID]).toBe(true)
    expect(s.get().missing[SID]).toBeUndefined()
    expect(loc()).toEqual({ ...NOWHERE, thread: SID })
    answer = () => Promise.resolve({ rows: [session, place] as Row[] })
    s.retryThread(SID)
    await settle()
    await settle()
    expect(s.get().unopened[SID]).toBeUndefined()
    expect(s.thread(SID)?.title).toBe('From before')
    s.close()
  })
})
