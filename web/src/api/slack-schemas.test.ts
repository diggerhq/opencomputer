import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeManagedSlack } from './client'
import {
  ManagedSlackAuthorizeResponseSchema,
  ManagedSlackConnectionSchema,
  ManagedSlackWorkspaceConnectionListSchema,
} from './schemas'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('managed Slack response schemas', () => {
  it('accepts the browser-safe active connection', () => {
    const result = ManagedSlackConnectionSchema.parse({
      mode: 'managed',
      status: 'active',
      workspace: { id: 'T1', name: 'Acme' },
      app: { id: 'A1', handle: 'OpenComputer' },
      open_url: 'https://slack.com/app_redirect?app=A1&team=T1',
      connected_at: '2026-07-16T18:00:00Z',
    })

    expect(result.status).toBe('active')
    expect(JSON.stringify(result)).not.toContain('xoxb-')
  })

  it('accepts owner-scoped workspace claims without credentials', () => {
    const result = ManagedSlackWorkspaceConnectionListSchema.parse({
      data: [
        {
          mode: 'managed',
          status: 'active',
          workspace: { id: 'T1', name: 'Acme' },
          app: { id: 'A1', handle: 'OpenComputer' },
          open_url: 'https://slack.com/app_redirect?app=A1&team=T1',
          connected_at: '2026-07-16T18:00:00Z',
          agent: { id: 'agt_1', name: 'Support triage' },
        },
      ],
    })

    expect(result.data[0]?.agent.name).toBe('Support triage')
    expect(JSON.stringify(result)).not.toContain('xoxb-')
  })

  it('accepts only the fixed managed OAuth start shape', () => {
    expect(
      ManagedSlackAuthorizeResponseSchema.parse({
        mode: 'managed',
        status: 'pending',
        authorize_url: 'https://slack.com/oauth/v2/authorize?state=opaque',
        expires_at: '2026-07-16T18:10:00Z',
      }),
    ).toMatchObject({ mode: 'managed', status: 'pending' })

    expect(() =>
      ManagedSlackAuthorizeResponseSchema.parse({
        mode: 'byo',
        status: 'active',
        authorize_url: 'https://example.test',
        expires_at: '2026-07-16T18:10:00Z',
      }),
    ).toThrow()
  })

  it('sends the exact deployment as structured OAuth return context', async () => {
    let captured: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        captured = init
        return Promise.resolve(
          Response.json({
            mode: 'managed',
            status: 'pending',
            authorize_url: 'https://slack.com/oauth/v2/authorize?state=opaque',
            expires_at: '2026-07-16T18:10:00Z',
          }),
        )
      }),
    )

    await authorizeManagedSlack('agt_example', 'dep_first')

    expect(captured?.method).toBe('POST')
    expect(captured?.body).toEqual(expect.any(String))
    expect(JSON.parse(captured?.body as string)).toEqual({
      return_deployment_id: 'dep_first',
    })
  })

  it('accepts an idempotent active response from authorize', () => {
    expect(
      ManagedSlackAuthorizeResponseSchema.parse({
        mode: 'managed',
        status: 'active',
        workspace: { id: 'T1', name: 'Acme' },
        app: { id: 'A1', handle: 'OpenComputer' },
        open_url: 'https://slack.com/app_redirect?app=A1&team=T1',
        connected_at: '2026-07-16T18:10:00Z',
      }),
    ).toMatchObject({ mode: 'managed', status: 'active' })
  })
})
