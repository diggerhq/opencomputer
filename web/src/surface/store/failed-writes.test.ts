// @vitest-environment node
// A write the server refuses (R42): what was typed goes back in its box, and
// the toast says what happened in words, with a way on where there is one.
// The SDK client is stubbed: the store's side only.

import { describe, expect, it, vi } from 'vitest'
import type { Failure, FeedFrame, Pending, Row } from '@opencomputer/sdk/computer'
import type { Host } from '../host'
import { NOWHERE } from '../host'

let fail: (f: Failure) => void = () => {}
let feedRows: Row[] = []

vi.mock('@opencomputer/sdk/computer', async (actual) => {
  const sdk = await actual<typeof import('@opencomputer/sdk/computer')>()
  const signal = <T,>(v: T) => ({ get: () => v, subscribe: () => () => {} })
  return {
    ...sdk,
    createClient: () => ({
      ready: Promise.resolve(),
      status: { get: () => 'online', subscribe: (cb: (s: string) => void) => (cb('online'), () => {}) },
      pending: () => signal([]),
      failures: { subscribe: (cb: (f: Failure) => void) => ((fail = cb), () => {}) },
      feed: () => ({
        subscribe: (cb: (f: FeedFrame) => void) => {
          cb({ protocol: 1, org: 'o', subject: 'usr_me', from: null, to: '1', more: false, rows: feedRows, gone: [], version: 1 })
          return () => {}
        },
      }),
      read: () => Promise.resolve({ rows: [] }),
      mutate: () => ({ settled: Promise.resolve() }),
      events: () => ({ subscribe: () => () => {} }),
      deltas: () => ({ subscribe: () => () => {} }),
      close: () => {},
    }),
  }
})

const { createSurface } = await import('./surface-store')
const { memoryStorage } = await import('@opencomputer/sdk/computer')

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function open(billing?: string) {
  const opened: string[] = []
  const host = {
    platform: 'web',
    principal: { kind: 'member', subject: 'usr_me', org: 'o' },
    api: { fetch: () => Promise.reject(new Error('stubbed')) },
    connect: () => ({}),
    notify: () => {},
    badge: () => {},
    openExternal: (url: string) => void opened.push(url),
    onOpen: () => {},
    billing,
    location: { get: () => NOWHERE, set: () => {}, onChange: () => () => {} },
  } as unknown as Host
  const s = createSurface({ host, storage: memoryStorage(), visible: () => true, wake: () => () => {} })
  await settle()
  return { s, opened }
}

const turn = (sessionId: string, input: string): Pending => ({ key: 'k1', kind: 'turn', sessionId, turnId: 'tn_1', input, at: 0 })
const refused = (entry: Pending, code: string, reason = ''): Failure => ({ entry, code, reason })

describe('a refused message', () => {
  it("goes back in its thread's box", async () => {
    feedRows = []
    const { s } = await open()
    fail(refused(turn('cs_1', 'deploy it'), 'conflict', 'Not now.'))
    expect(s.get().drafts['t:cs_1']).toBe('deploy it')
    s.close()
  })

  it("goes back in its track's box when it was to the track's agent", async () => {
    feedRows = [{ kind: 'track', id: 'trk_1', version: 1, agentSession: 'cs_agent', name: 'T' } as unknown as Row]
    const { s } = await open()
    fail(refused(turn('cs_agent', 'next step'), 'conflict'))
    expect(s.get().drafts['k:trk_1']).toBe('next step')
    feedRows = []
    s.close()
  })

  it('goes back in the start box when it started a thread', async () => {
    feedRows = []
    const { s } = await open()
    const entry: Pending = { key: 'k2', kind: 'session', sessionId: 'cs_2', body: { id: 'cs_2', turnId: 'tn_2', input: 'build a thing' }, at: 0 }
    fail(refused(entry, 'insufficient_credits'))
    expect(s.get().drafts.new).toBe('build a thing')
    s.close()
  })

  it('does not overwrite what was typed there meanwhile', async () => {
    feedRows = []
    const { s } = await open()
    s.setDraft('t:cs_1', 'something new')
    fail(refused(turn('cs_1', 'deploy it'), 'conflict'))
    expect(s.get().drafts['t:cs_1']).toBe('something new')
    s.close()
  })
})

describe('the toast of a refusal', () => {
  it("says the server's reason when there is one", async () => {
    const { s } = await open()
    fail(refused(turn('cs_1', 'x'), 'conflict', 'The session is busy.'))
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('Your message was not sent: The session is busy.')
    s.close()
  })

  it('says a known code in words, not the code', async () => {
    const { s } = await open()
    fail(refused(turn('cs_1', 'x'), 'computer_unavailable'))
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('Your message was not sent: your computer is not reachable right now')
    fail(refused(turn('cs_1', 'x'), 'session_not_found'))
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('Your message was not sent: this thread no longer exists')
    s.close()
  })

  it('offers Add credits when out of credits, and it opens billing', async () => {
    const { s, opened } = await open('/billing')
    fail(refused(turn('cs_1', 'x'), 'insufficient_credits'))
    const t = s.get().toasts.slice(-1)[0]
    expect(t.text).toBe('Your message was not sent: you are out of credits')
    expect(t.action?.label).toBe('Add credits')
    t.action!.run()
    expect(opened).toEqual(['/billing'])
    s.close()
  })

  it('offers no link where the host has no billing page', async () => {
    const { s } = await open()
    fail(refused(turn('cs_1', 'x'), 'http_402'))
    expect(s.get().toasts.slice(-1)[0]?.action).toBeUndefined()
    s.close()
  })
})
