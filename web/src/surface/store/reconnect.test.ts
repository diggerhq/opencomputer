// @vitest-environment node
// The network comes back (the browser is online again, or the tab is shown):
// an offline client reconnects now, not at the end of its backoff (up to 60 s).
// The SDK client is stubbed: the store's side only.

import { describe, expect, it, vi } from 'vitest'
import type { ClientOptions, FeedFrame } from '@opencomputer/sdk/computer'
import type { Host } from '../host'
import { NOWHERE } from '../host'

let options: ClientOptions
let status = 'offline'

vi.mock('@opencomputer/sdk/computer', async (actual) => {
  const sdk = await actual<typeof import('@opencomputer/sdk/computer')>()
  const signal = <T,>(v: T) => ({ get: () => v, subscribe: () => () => {} })
  return {
    ...sdk,
    createClient: (o: ClientOptions) => {
      options = o
      return {
        ready: Promise.resolve(),
        status: { get: () => status, subscribe: () => () => {} },
        pending: () => signal([]),
        failures: { subscribe: () => () => {} },
        feed: () => ({
          subscribe: (cb: (f: FeedFrame) => void) => {
            cb({ protocol: 1, org: 'o', subject: 'usr_me', from: null, to: '1', more: false, rows: [], gone: [], version: 1 })
            return () => {}
          },
        }),
        read: () => Promise.resolve({ rows: [] }),
        mutate: () => ({ settled: Promise.resolve() }),
        events: () => ({ subscribe: () => () => {} }),
        deltas: () => ({ subscribe: () => () => {} }),
        close: () => {},
      }
    },
  }
})

const { createSurface } = await import('./surface-store')
const { memoryStorage } = await import('@opencomputer/sdk/computer')

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function open() {
  let wake = () => {}
  const host = {
    platform: 'web',
    principal: { kind: 'member', subject: 'usr_me', org: 'o' },
    api: { fetch: () => Promise.reject(new Error('stubbed')) },
    connect: () => ({}),
    notify: () => {},
    badge: () => {},
    openExternal: () => {},
    onOpen: () => {},
    location: { get: () => NOWHERE, set: () => {}, onChange: () => () => {} },
  } as unknown as Host
  const s = createSurface({
    host,
    storage: memoryStorage(),
    visible: () => true,
    wake: (cb) => ((wake = cb), () => {}),
  })
  await settle()
  return { s, wake: () => wake() }
}

describe('when the network may be back', () => {
  it('an offline client stops waiting and reconnects now', async () => {
    status = 'offline'
    const { s, wake } = await open()
    const reconnect = vi.fn()
    options.setTimeout!(reconnect, 60_000)
    wake()
    expect(reconnect).toHaveBeenCalledOnce()
    // Run once, not again when its time comes.
    wake()
    expect(reconnect).toHaveBeenCalledOnce()
    s.close()
  })

  it('an online client is left alone', async () => {
    status = 'online'
    const { s, wake } = await open()
    const later = vi.fn()
    const h = options.setTimeout!(later, 60_000)
    wake()
    expect(later).not.toHaveBeenCalled()
    options.clearTimeout!(h)
    s.close()
  })

  it('a wait that was cancelled is not run', async () => {
    status = 'offline'
    const { s, wake } = await open()
    const cancelled = vi.fn()
    options.clearTimeout!(options.setTimeout!(cancelled, 60_000))
    wake()
    expect(cancelled).not.toHaveBeenCalled()
    s.close()
  })
})
