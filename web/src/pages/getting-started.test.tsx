import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { APIKey, DeployApp } from '@/api/client'
import { GettingStarted } from './Dashboard'

function renderGettingStarted() {
  const app: DeployApp = {
    installed: true,
    install_url: null,
    configure_url: 'https://github.com/settings/installations/1',
    account: 'example',
    repository_selection: 'selected',
    repositories: [
      {
        id: 'repo_0123456789abcdef01234567',
        full_name: 'example/flue-starter',
        default_branch: 'main',
        private: false,
        linked_sources: [],
      },
    ],
  }
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
  queryClient.setQueryData(['deploy-app'], app)
  queryClient.setQueryData(['api-keys'], keys)

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GettingStarted />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('getting started', () => {
  it('leads with the shared repository flow and keeps both API paths visible', () => {
    const markup = renderGettingStarted()

    expect(markup).toContain('Deploy an agent from GitHub')
    expect(markup).toContain('example/flue-starter')
    expect(markup).toContain('Choose repository')

    expect(markup).toContain('Build with the API')
    expect(markup).toContain('API key ready')
    expect(markup).toContain('Sandboxes')
    expect(markup).toContain('Durable agent sessions')
    expect(markup).toContain('Sandbox.create()')
    expect(markup).toContain('oc.sessions.create')

    expect(markup).not.toContain('free credits')
    expect(markup).not.toContain('Claude Opus')
    expect(markup).not.toContain('Analyze a CSV')
    expect(markup).not.toContain('Build a web app')
  })
})
