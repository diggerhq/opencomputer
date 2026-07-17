import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { APIKey, DeployApp } from '@/api/client'
import { GettingStarted } from './Dashboard'

function renderGettingStarted(path = '/') {
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
  queryClient.setQueryData(['credentials'], [])

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <GettingStarted />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('getting started', () => {
  it('shows three self-explanatory directions and defaults to GitHub', () => {
    const markup = renderGettingStarted()

    expect(markup).toContain('Agent from GitHub')
    expect(markup).toContain('Agent from a prompt')
    expect(markup).toContain('Build with the API')
    expect(markup).toContain('Durable sessions &amp; sandboxes.')
    expect(markup).toMatch(/id="start-tab-github"[^>]*aria-selected="true"/)
    expect(markup).toContain('example/flue-starter')
    expect(markup).toContain('Choose repository')
    expect(markup).not.toContain('API key ready')
    expect(markup).not.toContain(
      'Create a durable agent from its system prompt',
    )
    expect(markup).not.toContain('Get started')
    expect(markup).not.toContain('free credits')
    expect(markup).not.toContain('Claude Opus')
    expect(markup).not.toContain('Analyze a CSV')
  })

  it('keeps both API paths concise and puts durable sessions first', () => {
    const markup = renderGettingStarted('/?start=api')

    expect(markup).toContain('API key ready')
    expect(markup).toContain('Sandboxes')
    expect(markup).toContain('Durable agent sessions')
    expect(markup).toContain('Sandbox.create()')
    expect(markup).toContain('oc.sessions.create')
    expect(markup).not.toContain('oc.agents.create')
    expect(markup).toContain('Open sessions quickstart')
    expect(markup).toContain('Open sandbox quickstart')
    expect(markup).toContain('Start and steer a durable agent run.')
    expect(markup).toContain('Run commands in an isolated computer.')
    expect(markup.indexOf('oc.sessions.create')).toBeLessThan(
      markup.indexOf('Sandbox.create()'),
    )
  })

  it('offers direct prompt-based agent creation as a peer direction', () => {
    const markup = renderGettingStarted('/?start=prompt')

    expect(markup).toContain('Define the agent')
    expect(markup).toContain('Create a durable agent from its system prompt')
    expect(markup).toContain('Instructions')
    expect(markup).toContain('Runtime')
    expect(markup).toContain('Create agent')
    expect(markup).not.toContain('Choose repository')
  })
})
