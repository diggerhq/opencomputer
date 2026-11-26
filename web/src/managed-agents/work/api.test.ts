import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRepositories, putRepository, workRetryDelay } from './api'
import { ApiError } from '@/api/errors'

afterEach(() => vi.unstubAllGlobals())

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
    expect(await getRepositories()).toEqual([
      { ...installations[0], nextPage: null },
    ])
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/managed-agents/computer/work/repositories',
    )
  })

  it('reads every page of an installation, then sorts them together', async () => {
    const repo = (id: number, pushedAt: string | null) => ({
      id,
      owner: 'acme',
      name: `r${id}`,
      private: false,
      defaultBranch: 'main',
      pushedAt,
    })
    const installation = {
      id: '1',
      accountLogin: 'acme',
      accountType: 'Organization',
      settingsUrl:
        'https://github.com/organizations/acme/settings/installations/41',
      truncated: false,
      problem: null,
      problemMessage: null,
    }
    const page = (repositories: unknown[], nextPage: number | null) =>
      new Response(
        JSON.stringify({
          installations: [{ ...installation, repositories, nextPage }],
        }),
        { status: 200 },
      )
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page([repo(1, '2026-01-01T00:00:00Z')], 2))
      .mockResolvedValueOnce(page([repo(2, null)], 3))
      .mockResolvedValueOnce(page([repo(3, '2026-11-01T00:00:00Z')], null))
    vi.stubGlobal('fetch', fetch)
    const [all] = await getRepositories()
    expect(all.repositories.map((r) => r.id)).toEqual([3, 1, 2])
    expect(fetch.mock.calls.map((c) => c[0] as string)).toEqual([
      '/api/managed-agents/computer/work/repositories',
      '/api/managed-agents/computer/work/repositories?installation=1&page=2',
      '/api/managed-agents/computer/work/repositories?installation=1&page=3',
    ])
  })
})

describe('retry delay', () => {
  const unavailable = (retryAfterMs: unknown) =>
    new ApiError('Not yet', 503, 'unavailable', {
      code: 'unavailable',
      retryAfterMs,
    })

  it('waits as long as a 503 asks', () => {
    expect(workRetryDelay(0, unavailable(5_000))).toBe(5_000)
    expect(workRetryDelay(1, unavailable(5_000))).toBe(5_000)
  })

  it('keeps what the server asks between 1 s and 60 s', () => {
    expect(workRetryDelay(0, unavailable(10))).toBe(1_000)
    expect(workRetryDelay(0, unavailable(600_000))).toBe(60_000)
  })

  it('backs off as usual without a retryAfterMs', () => {
    expect(workRetryDelay(0, new ApiError('Down', 500))).toBe(1_000)
    expect(workRetryDelay(1, new ApiError('Down', 500))).toBe(2_000)
    expect(workRetryDelay(1, unavailable('soon'))).toBe(2_000)
    expect(workRetryDelay(2, new Error('offline'))).toBe(4_000)
  })
})
