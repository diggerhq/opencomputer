// @vitest-environment node
// Merging a thread's pull request in one click (work 118): what the store
// sends, what it says when GitHub refuses, and the line in the conversation.
// The SDK client is stubbed: the store's side only.

import { describe, expect, it, vi } from 'vitest'
import type { Failure, FeedFrame, OpRow, Pending, ResultRow, Row } from '@opencomputer/sdk/computer'
import type { Host } from '../host'
import { NOWHERE } from '../host'
import { mergeable, revertOf } from './pulls'
import { opLines } from './transcript'
import { resultDetail } from '../ui/result-text'

let fail: (f: Failure) => void = () => {}
let feedRows: Row[] = []
const sent: [string, unknown][] = []

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
      mutate: (name: string, args: unknown) => (sent.push([name, args]), { settled: Promise.resolve() }),
      events: () => ({ subscribe: () => () => {} }),
      deltas: () => ({ subscribe: () => () => {} }),
      close: () => {},
    }),
  }
})

const { createSurface } = await import('./surface-store')
const { memoryStorage } = await import('@opencomputer/sdk/computer')

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const HEAD = 'a'.repeat(40)
const pr = (over: Partial<ResultRow> = {}): ResultRow =>
  ({ kind: 'result', id: 'res_1', version: 1, sessionId: 'cs_1', type: 'pr', ref: 'https://github.com/o/r/pull/7', title: 'Fix', state: 'open', meta: { checks: 'success', head: HEAD }, ...over }) as ResultRow

async function open(rows: Row[]) {
  feedRows = rows
  sent.length = 0
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
  const s = createSurface({ host, storage: memoryStorage(), visible: () => true, wake: () => () => {} })
  await settle()
  return s
}

describe('whether one click merges it', () => {
  it('an open pull request whose checks passed, or that has none', () => {
    expect(mergeable(pr())).toBe(true)
    expect(mergeable(pr({ meta: null }))).toBe(true)
    expect(mergeable(pr({ state: null, meta: null }))).toBe(true)
    expect(mergeable(pr({ meta: { checks: 'neutral' } }))).toBe(true)
  })

  it('not a draft, one with failing or running checks, one merged or closed, or one being merged', () => {
    expect(mergeable(pr({ meta: { draft: true } }))).toBe(false)
    expect(mergeable(pr({ meta: { checks: 'failure' } }))).toBe(false)
    expect(mergeable(pr({ meta: { checks: 'pending' } }))).toBe(false)
    expect(mergeable(pr({ state: 'merged' }))).toBe(false)
    expect(mergeable(pr({ state: 'closed' }))).toBe(false)
    expect(mergeable(pr({ meta: { pending: 'merge' } }))).toBe(false)
    expect(mergeable(pr({ type: 'preview' }))).toBe(false)
  })
})

describe('merge', () => {
  it('sends the head the person saw, and the toast offers Undo, which is the revert', async () => {
    const s = await open([pr()])
    s.merge('res_1')
    expect(sent).toEqual([['result.merge', { resultId: 'res_1', head: HEAD }]])
    await settle()
    const t = s.get().toasts.slice(-1)[0]
    expect(t.text).toBe('Merged #7')
    expect(t.undo).toBeTypeOf('function')
    s.close()
  })

  it('sends nothing for a pull request that cannot merge', async () => {
    const s = await open([pr({ meta: { checks: 'failure' } })])
    s.merge('res_1')
    s.revert('res_1')
    expect(sent).toEqual([])
    s.close()
  })

  it("a refusal says why in words, on the toast and beside the pull request, until the next try", async () => {
    const s = await open([pr()])
    const entry = { key: 'k1', kind: 'mutation', name: 'result.merge', args: { resultId: 'res_1' }, at: 0 } as unknown as Pending
    fail({ entry, code: 'refused', reason: 'conflicts' })
    expect(s.get().toasts.slice(-1)[0]?.text).toBe('Not merged: it conflicts with its base branch')
    expect(s.get().unmerged).toEqual({ res_1: 'it conflicts with its base branch' })
    fail({ entry, code: 'refused', reason: 'blocked', detail: { message: 'Required status check "ci" is expected.' } })
    expect(s.get().unmerged.res_1).toBe('GitHub said “Required status check "ci" is expected”')
    s.merge('res_1')
    expect(s.get().unmerged).toEqual({})
    s.close()
  })

  it('undo of a merge line reverts on GitHub; of anything else it is the undo mutation', async () => {
    const op = { kind: 'op', id: 'op_1', version: 2, name: 'result.merge', by: 'user:usr_me', args: { resultId: 'res_1', number: 7 }, at: 0 } as unknown as Row
    const s = await open([pr({ state: 'merged' }), op])
    s.undo('op_1')
    s.undo('op_2')
    expect(sent).toEqual([['result.revert', { resultId: 'res_1' }], ['undo', { opId: 'op_2' }]])
    s.close()
  })
})

describe('the line in the conversation', () => {
  const names = { track: () => 'T', thread: () => 'A thread', me: 'user:usr_me' }
  const op = (over: Partial<OpRow>): OpRow =>
    ({ kind: 'op', id: 'op_1', version: 1, name: 'result.merge', by: 'user:usr_me', sessionId: 'cs_1', trackId: null, at: 0, undoneBy: null, inverse: null, args: { resultId: 'res_1', number: 7, base: 'main', method: 'squash', branchDeleted: true }, ...over }) as OpRow

  it('says who merged, where and how, with Undo until it is reverted', () => {
    expect(opLines([op({})], { sessionId: 'cs_1' }, names)).toMatchObject([{ kind: 'line', text: 'You merged #7 into **main** · squashed · branch deleted', undo: 'op_1' }])
    expect(opLines([op({ by: 'user:usr_b', args: { number: 7, base: 'main', method: 'merge', branchDeleted: false } })], { sessionId: 'cs_1' }, names)[0]).toMatchObject({ text: 'A teammate merged #7 into **main**' })
    const lines = opLines([op({ undoneBy: 'op_2' }), op({ id: 'op_2', name: 'result.revert', args: { resultId: 'res_1', number: 8 } })], { sessionId: 'cs_1' }, names)
    expect(lines).toMatchObject([{ undone: true }, { text: 'You reverted it with #8' }])
    expect(lines[0]).not.toHaveProperty('undo', 'op_1')
    expect(opLines([op({})], { sessionId: 'cs_2' }, names)).toEqual([])
  })

  it('the pull request says a merge under way, and its revert', () => {
    expect(resultDetail(pr({ meta: { pending: 'merge' } }))).toContain('merging…')
    expect(revertOf(pr({ state: 'merged', meta: { revert: { number: 8, merged: false } } }))).toEqual({ number: 8, merged: false })
    expect(resultDetail(pr({ state: 'merged', meta: { revert: { number: 8, merged: false } } }))).toContain('revert #8 open')
    expect(resultDetail(pr({ state: 'merged', meta: { revert: { number: 8, merged: true } } }))).toContain('reverted')
  })
})
