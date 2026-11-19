import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOpenItems, putRepository } from './api'

const page = {
  repository: null,
  head: null,
  asOf: null,
  building: false,
  items: [],
}

afterEach(() => vi.unstubAllGlobals())

describe('open items poll', () => {
  it('sends the last ETag and keeps the answer on a 304', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { ETag: '"h1"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetch)

    const first = await getOpenItems(null)
    expect(first).toEqual({ etag: '"h1"', page })
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/managed-agents/computer/work/items?stage=open',
    )

    expect(await getOpenItems('"h1"')).toBeNull()
    const init = fetch.mock.calls[1][1] as RequestInit
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe(
      '"h1"',
    )
  })
})

describe('repository setting', () => {
  it('puts the choice with an idempotency key', async () => {
    const repository = {
      installationId: '1',
      owner: 'acme',
      name: 'knowledge',
      branch: 'main',
    }
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ repository }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetch)
    expect(await putRepository(repository)).toEqual(repository)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/managed-agents/computer/work/repository')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual(repository)
    expect(
      (init.headers as Record<string, string>)['Idempotency-Key'],
    ).toBeTruthy()
  })
})
