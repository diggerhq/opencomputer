// @vitest-environment node
// Files on a composer (work 126), at the level of the store: which session a
// composer's files are uploaded to, what a send carries, and what a refusal
// gives back. The SDK client is stubbed: the store's side only.

import { describe, expect, it, vi } from 'vitest'
import type { Failure, FeedFrame, Pending, PendingAttachment, Row } from '@opencomputer/sdk/computer'
import type { Host } from '../host'
import { NOWHERE } from '../host'

let fail: (f: Failure) => void = () => {}
let feedRows: Row[] = []
const calls: { name: string; args: unknown[] }[] = []
let attached = 0
let refuse: Error | null = null
// What the stubbed client holds at load, and how it tells of a change.
let held: PendingAttachment[] = []
let tell: (list: PendingAttachment[]) => void = () => {}
let capabilities: unknown = { models: [], modes: [], features: { steer: true } }

vi.mock('@opencomputer/sdk/computer', async (actual) => {
  const sdk = await actual<typeof import('@opencomputer/sdk/computer')>()
  const signal = <T,>(v: T) => ({ get: () => v, subscribe: () => () => {} })
  return {
    ...sdk,
    createClient: () => ({
      ready: Promise.resolve(),
      status: { get: () => 'online', subscribe: (cb: (s: string) => void) => (cb('online'), () => {}) },
      pending: () => signal([]),
      attachments: () => ({ get: () => held, subscribe: (cb: (l: PendingAttachment[]) => void) => ((tell = cb), () => {}) }),
      failures: { subscribe: (cb: (f: Failure) => void) => ((fail = cb), () => {}) },
      feed: () => ({
        subscribe: (cb: (f: FeedFrame) => void) => {
          cb({ protocol: 1, org: 'o', subject: 'usr_me', from: null, to: '1', more: false, rows: feedRows, gone: [], version: 1 })
          return () => {}
        },
      }),
      read: (path: string) => Promise.resolve(path === '/capabilities' ? { capabilities } : { rows: [] }),
      mutate: () => ({ settled: Promise.resolve() }),
      events: () => ({ subscribe: () => () => {} }),
      deltas: () => ({ subscribe: () => () => {} }),
      attach: (sessionId: string, file: Blob) => {
        calls.push({ name: 'attach', args: [sessionId, file] })
        if (refuse) throw refuse
        return { id: `at_${++attached}`, state: signal(null) }
      },
      removeAttachment: (id: string) => {
        calls.push({ name: 'removeAttachment', args: [id] })
        return Promise.resolve()
      },
      send: (sid: string, input: string, o: unknown) => {
        calls.push({ name: 'send', args: [sid, input, o] })
        return { turnId: 'tn_x', settled: Promise.resolve() }
      },
      createSession: (body: { id?: string }) => {
        calls.push({ name: 'createSession', args: [body] })
        return { id: body.id ?? 'cs_made', turnId: 'tn_y', settled: Promise.resolve() }
      },
      close: () => {},
    }),
  }
})

const { createSurface } = await import('./surface-store')
const { memoryStorage, Refused } = await import('@opencomputer/sdk/computer')

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const file = (name: string) => new File([new Uint8Array(4)], name, { type: 'text/plain' })

async function open(kept?: string) {
  calls.length = 0
  attached = 0
  refuse = null
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
  const s = createSurface({ host, storage: memoryStorage(), visible: () => true, wake: () => () => {}, kept: kept ? { get: () => kept, set: () => {} } : undefined })
  await settle()
  // What the stubbed client "holds": every id attached so far.
  const hold = () => s.store.setState({ attachments: calls.filter((c) => c.name === 'attach').map((_, i) => ({ id: `at_${i + 1}` })) as never })
  return { s, hold }
}

describe('attaching', () => {
  it("in a thread's composer uploads to that thread, and the send carries the ids", async () => {
    const { s, hold } = await open()
    s.attach('t:cs_1', [file('a.txt'), file('b.txt')])
    expect(calls.map((c) => [c.name, c.args[0]])).toEqual([
      ['attach', 'cs_1'],
      ['attach', 'cs_1'],
    ])
    expect(s.get().draftAttachments['t:cs_1']).toEqual(['at_1', 'at_2'])
    hold()
    s.send('cs_1', 'look', { draftKey: 't:cs_1' })
    expect(calls[calls.length - 1]).toEqual({ name: 'send', args: ['cs_1', 'look', { ifBusy: undefined, attachments: ['at_1', 'at_2'] }] })
    expect(s.get().draftAttachments['t:cs_1']).toBeUndefined()
    s.close()
  })

  it("in a track's composer uploads to the track's agent", async () => {
    feedRows = [{ kind: 'track', id: 'trk_1', version: 1, agentSession: 'cs_agent', name: 'T' } as unknown as Row]
    const { s } = await open()
    s.attach('k:trk_1', [file('a.txt')])
    expect([calls[0].name, calls[0].args[0]]).toEqual(['attach', 'cs_agent'])
    feedRows = []
    s.close()
  })

  it('in the start box makes the session id at the first file, and start creates that session (D8)', async () => {
    const { s, hold } = await open()
    expect(s.get().startSession).toBeNull()
    s.attach('new', [file('a.txt')])
    const sid = s.get().startSession
    expect(sid).toMatch(/^cs_/)
    expect([calls[0].name, calls[0].args[0]]).toEqual(['attach', sid])
    s.attach('new', [file('b.txt')])
    expect([calls[1].name, calls[1].args[0]]).toEqual(['attach', sid])
    hold()
    const made = s.start('build it', { open: false })
    expect(made).toBe(sid)
    expect(calls[calls.length - 1]).toMatchObject({ name: 'createSession', args: [{ id: sid, input: 'build it', attachments: ['at_1', 'at_2'] }] })
    expect(s.get().startSession).toBeNull()
    expect(s.get().draftAttachments.new).toBeUndefined()
    // The next start, without files, gets its own id from the client.
    expect(s.start('again', { open: false })).toBe('cs_made')
    s.close()
  })

  it('sends only the ids the client still holds, and none when none are held', async () => {
    const { s } = await open()
    s.attach('t:cs_1', [file('a.txt')])
    s.send('cs_1', 'x', { draftKey: 't:cs_1' })
    expect(calls[calls.length - 1]).toMatchObject({ name: 'send', args: ['cs_1', 'x', { attachments: undefined }] })
    s.close()
  })

  it('stops at ten per message and says so', async () => {
    const { s } = await open()
    s.attach('t:cs_1', Array.from({ length: 12 }, (_, i) => file(`${i}.txt`)))
    expect(calls.filter((c) => c.name === 'attach')).toHaveLength(10)
    expect(s.get().draftAttachments['t:cs_1']).toHaveLength(10)
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('A message can carry at most 10 files')
    s.close()
  })

  it("says that a file the client did not take was not attached, and keeps the others", async () => {
    const { s } = await open()
    refuse = new Refused('not_ready', 'the client is closing')
    s.attach('t:cs_1', [file('big.bin')])
    expect(s.get().draftAttachments['t:cs_1']).toBeUndefined()
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('big.bin was not attached: the client is closing')
    refuse = null
    s.attach('t:cs_1', [file('ok.txt')])
    expect(s.get().draftAttachments['t:cs_1']).toEqual(['at_1'])
    s.close()
  })

  it('removing a chip drops it from the draft and the client', async () => {
    const { s } = await open()
    s.attach('t:cs_1', [file('a.txt'), file('b.txt')])
    s.removeAttachment('t:cs_1', 'at_1')
    expect(s.get().draftAttachments['t:cs_1']).toEqual(['at_2'])
    expect(calls[calls.length - 1]).toEqual({ name: 'removeAttachment', args: ['at_1'] })
    s.close()
  })
})

describe('the bytes of a file', () => {
  it('are held for this page while the client holds the file, for its thumbnail', async () => {
    const { s } = await open()
    const a = file('a.txt')
    s.attach('t:cs_1', [a])
    expect(s.attachmentBlob('at_1')).toBe(a)
    expect(s.attachmentBlob('at_other')).toBeUndefined()
    tell([{ id: 'at_1' } as PendingAttachment])
    expect(s.attachmentBlob('at_1')).toBe(a)
    // Sent or removed: the client lets go, and so does the page.
    tell([])
    expect(s.attachmentBlob('at_1')).toBeUndefined()
    s.close()
  })
})

describe('after a reload', () => {
  it('drops the ids the client does not hold, and the start session with its last file', async () => {
    held = [{ id: 'at_kept', sessionId: 'cs_1', name: 'a.png', mimetype: 'image/png', bytes: 1, state: 'ready', progress: 1 }]
    const kept = JSON.stringify({ draftAttachments: { 't:cs_1': ['at_gone', 'at_kept'], 't:cs_2': ['at_gone'], new: ['at_other'] }, startSession: 'cs_start' })
    const { s } = await open(kept)
    expect(s.get().draftAttachments).toEqual({ 't:cs_1': ['at_kept'] })
    expect(s.get().startSession).toBeNull()
    expect(s.attachmentBlob('at_kept')).toBeUndefined()
    held = []
    s.close()
  })
})

describe('a deployment with no store for files', () => {
  it('attaches nothing once the capabilities say so', async () => {
    capabilities = { models: [], modes: [], features: { steer: true, attachments: false } }
    const { s } = await open()
    expect(s.get().canAttach).toBe(true)
    await s.capabilities()
    expect(s.get().canAttach).toBe(false)
    s.attach('t:cs_1', [file('a.txt')])
    expect(calls).toEqual([])
    expect(s.get().draftAttachments['t:cs_1']).toBeUndefined()
    s.close()
  })

  it('takes files from a server that does not say', async () => {
    capabilities = { models: [], modes: [], features: { steer: true } }
    const { s } = await open()
    await s.capabilities()
    expect(s.get().canAttach).toBe(true)
    s.close()
  })
})

describe('a refused message with files', () => {
  it('puts the files back in its composer with the text', async () => {
    const { s } = await open()
    const entry: Pending = { key: 'k1', kind: 'turn', sessionId: 'cs_1', turnId: 'tn_1', input: 'look', attachments: ['at_7'], at: 0 }
    fail({ entry, code: 'attachment_too_large', reason: '' })
    expect(s.get().drafts['t:cs_1']).toBe('look')
    expect(s.get().draftAttachments['t:cs_1']).toEqual(['at_7'])
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('Your message was not sent: a file is over the size limit')
    s.close()
  })

  it('puts back the files of a message the server refused for one of them, which the client has failed', async () => {
    const { s } = await open()
    const entry: Pending = { key: 'k3', kind: 'turn', sessionId: 'cs_1', turnId: 'tn_3', input: 'look', attachments: ['at_7', 'at_8'], at: 0 }
    fail({ entry, code: 'attachment_deleted', reason: 'attachment deleted', detail: { attachmentId: 'at_8' } })
    tell([
      { id: 'at_7', sessionId: 'cs_1', name: 'a.png', mimetype: 'image/png', bytes: 1, state: 'ready', progress: 1 },
      { id: 'at_8', sessionId: 'cs_1', name: 'b.png', mimetype: 'image/png', bytes: 1, state: 'failed', progress: 0, error: { code: 'attachment_deleted', reason: 'the file expired before it was sent: attach it again' } },
    ])
    expect(s.get().drafts['t:cs_1']).toBe('look')
    expect(s.get().draftAttachments['t:cs_1']).toEqual(['at_7', 'at_8'])
    expect(s.get().attachments.find((a) => a.id === 'at_8')?.state).toBe('failed')
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('Your message was not sent: attachment deleted')
    s.close()
  })

  it('puts a start back in the start box, with its session id, so more files join it', async () => {
    const { s } = await open()
    const entry: Pending = { key: 'k2', kind: 'session', sessionId: 'cs_2', body: { id: 'cs_2', turnId: 'tn_2', input: 'build', attachments: ['at_8'] }, at: 0 }
    fail({ entry, code: 'attachment_not_ready', reason: '' })
    expect(s.get().drafts.new).toBe('build')
    expect(s.get().draftAttachments.new).toEqual(['at_8'])
    expect(s.get().startSession).toBe('cs_2')
    s.close()
  })
})
