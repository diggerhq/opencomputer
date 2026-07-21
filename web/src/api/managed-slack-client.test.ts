import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getManagedSlackConnection } from './client'
import { mockFetch } from './mock'

afterEach(() => vi.unstubAllGlobals())

describe('managed Slack missing-resource handling', () => {
  it('maps a real API 404 to no managed connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 })),
      ),
    )

    await expect(
      getManagedSlackConnection('agt_aaaaaaaaaaaaaaaaaaaaaaaa'),
    ).resolves.toBeNull()
  })

  it('does not swallow an unrelated status-bearing Error', async () => {
    const transportError = Object.assign(new Error('Proxy failed'), {
      status: 404,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(transportError)),
    )

    await expect(
      getManagedSlackConnection('agt_aaaaaaaaaaaaaaaaaaaaaaaa'),
    ).rejects.toBe(transportError)
  })

  it('uses the same ApiError contract in preview mocks', () => {
    expect(() =>
      mockFetch('/v3/agents/agt_aaaaaaaaaaaaaaaaaaaaaaaa/slack/managed'),
    ).toThrow(ApiError)
  })
})
