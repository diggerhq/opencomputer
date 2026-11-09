import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { APIKey } from '@/api/client'
import { GettingStarted } from './Dashboard'

function renderGettingStarted(path = '/') {
  const keys: APIKey[] = [
    {
      id: 'key_0123456789abcdef01234567',
      orgId: 'org_0123456789abcdef01234567',
      keyPrefix: 'osb_example',
      name: 'Default',
      scopes: [],
      createdAt: '2026-07-17T00:00:00.000Z',
    },
  ]
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['api-keys'], keys)

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <GettingStarted />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('getting started', () => {
  it('shows the API key without the retired sandbox quickstart', () => {
    const markup = renderGettingStarted()

    expect(markup).toContain('API key ready')
    expect(markup).not.toContain('Sandbox.create()')
    expect(markup).not.toContain('sandbox quickstart')
  })
})
