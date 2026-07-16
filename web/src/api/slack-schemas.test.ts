import { describe, expect, it } from 'vitest'
import {
  ManagedSlackAuthorizeResponseSchema,
  ManagedSlackConnectionSchema,
} from './schemas'

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
})
