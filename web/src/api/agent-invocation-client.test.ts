import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentHook,
  getAgentHooks,
  revokeAgentHook,
} from './client'

const agentId = 'agt_0123456789abcdef01234567'

afterEach(() => vi.unstubAllGlobals())

describe('Hook management dashboard client', () => {
  it('parses copy-once creation and secret-free list responses', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (path.includes('?')) {
        return Promise.resolve(Response.json({ data: [], next_cursor: null }))
      }
      return Promise.resolve(
        Response.json(
          {
            hook: {
              id: 'hk_0123456789abcdef01234567',
              agent_id: agentId,
              name: 'grafana-prod',
              status: 'active',
              secret_last4: 'xYz0',
              revoked_reason: null,
              expires_at: null,
              created_at: '2026-07-22T00:00:00.000Z',
            },
            hook_url: 'https://agent.test/hooks/secret',
          },
          { status: 201 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const created = await createAgentHook(agentId, { name: 'grafana-prod' })
    expect(created.hook_url).toBe('https://agent.test/hooks/secret')
    await expect(getAgentHooks(agentId)).resolves.toEqual({
      data: [],
      next_cursor: null,
    })
  })

  it('revokes without expecting a response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    )

    await expect(
      revokeAgentHook(agentId, 'hk_0123456789abcdef01234567'),
    ).resolves.toBeUndefined()
  })
})
