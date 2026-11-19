import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getOpenItems,
  getRepositories,
  keepOpenItems,
  putRepository,
  type OpenItemsPoll,
} from './api'

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

    expect(await getOpenItems('"h1"')).toEqual({
      notModified: true,
      asOf: null,
    })
    const init = fetch.mock.calls[1][1] as RequestInit
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe(
      '"h1"',
    )
  })

  it('reads Work-As-Of on a 200 and on a 304', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...page, asOf: 'body' }), {
          status: 200,
          headers: { ETag: '"h1"', 'Work-As-Of': '2026-11-19T10:00:00Z' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: { 'Work-As-Of': '2026-11-19T10:15:00Z' },
        }),
      )
    vi.stubGlobal('fetch', fetch)

    const first = (await getOpenItems(null)) as OpenItemsPoll
    expect(first.page.asOf).toBe('2026-11-19T10:00:00Z')
    const next = await getOpenItems('"h1"')
    expect(next).toEqual({ notModified: true, asOf: '2026-11-19T10:15:00Z' })

    const kept = keepOpenItems(first, next)
    expect(kept.etag).toBe('"h1"')
    expect(kept.page.items).toBe(first.page.items)
    expect(kept.page.asOf).toBe('2026-11-19T10:15:00Z')
    // A 304 without the header keeps everything as it was.
    expect(keepOpenItems(first, { notModified: true, asOf: null })).toBe(first)
  })
})

describe('preview mock of the poll', () => {
  it('answers 304 with Work-As-Of when the ETag still matches', async () => {
    const { workOpenItemsResponse } = await import('@/api/mock-work')
    const first = workOpenItemsResponse(null)
    expect(first.status).toBe(200)
    const etag = first.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('Work-As-Of')).toBeTruthy()
    const again = workOpenItemsResponse(etag)
    expect(again.status).toBe(304)
    expect(again.headers.get('Work-As-Of')).toBeTruthy()
    expect(workOpenItemsResponse('"other"').status).toBe(200)
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

describe('repositories the installations grant', () => {
  it('reads them for the picker', async () => {
    const installations = [
      {
        id: '1',
        accountLogin: 'acme',
        accountType: 'Organization',
        settingsUrl:
          'https://github.com/organizations/acme/settings/installations/41',
        repositories: [
          {
            id: 7,
            owner: 'acme',
            name: 'knowledge',
            private: true,
            defaultBranch: 'main',
            pushedAt: null,
          },
        ],
        truncated: false,
        problem: null,
        problemMessage: null,
      },
    ]
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ installations }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetch)
    expect(await getRepositories()).toEqual(installations)
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/managed-agents/computer/work/repositories',
    )
  })
})
