// @vitest-environment happy-dom
// The browser's host: a login that expires while the page is open sends the
// person to log in again, once, whatever request found it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { urlLink, webHost } from './host-web'
import { NOWHERE } from './host'

afterEach(() => vi.unstubAllGlobals())

const host = (signedOut: () => void) =>
  webHost({
    principal: { org: 'o', subject: 'usr_me' },
    api: '/api',
    base: '/computer/work',
    signedOut,
  })

describe('webHost', () => {
  it('sends the person to log in on a 401, once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))),
    )
    const signedOut = vi.fn()
    const h = host(signedOut)
    const reply = await h.api.fetch('/feed')
    expect(reply.status).toBe(401)
    await h.api.fetch('/sessions/cs_1/turns', { method: 'POST' })
    expect(signedOut).toHaveBeenCalledOnce()
  })

  it('leaves other replies to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 402 }))),
    )
    const signedOut = vi.fn()
    const reply = await host(signedOut).api.fetch('/sessions')
    expect(reply.status).toBe(402)
    expect(signedOut).not.toHaveBeenCalled()
  })
})

describe('urlLink', () => {
  it("is this origin's address of a thread or track, without the tab's other parameters", () => {
    const link = urlLink('/computer/work')
    expect(link({ ...NOWHERE, thread: 'cs_1' })).toBe(`${location.origin}/computer/work/t/cs_1`)
    expect(link({ ...NOWHERE, track: 'trk_1', result: 'res_1' })).toBe(`${location.origin}/computer/work/k/trk_1?r=res_1`)
  })
})
