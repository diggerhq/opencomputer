import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { DeployApp } from '@/api/client'
import AgentNew from './AgentNew'

const repoId = 'repo_0123456789abcdef01234567'
const agentId = 'agt_0123456789abcdef01234567'

function renderLinkedRepository() {
  const app: DeployApp = {
    installed: true,
    install_url: null,
    configure_url: 'https://github.com/settings/installations/1',
    account: 'example',
    repository_selection: 'selected',
    repositories: [
      {
        id: repoId,
        full_name: 'example/flue-starter',
        default_branch: 'main',
        private: false,
        linked_sources: [
          {
            path: '',
            production_ref: 'main',
            status: 'active',
            agent: { id: agentId, name: 'Support triage' },
          },
        ],
      },
    ],
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['deploy-app'], app)

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/agents/new',
            state: {
              repositoryImport: {
                repo: repoId,
                path: '',
                productionRef: 'main',
              },
            },
          },
        ]}
      >
        <Routes>
          <Route path="/agents/new" element={<AgentNew />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('repository import conflict discovery', () => {
  it('marks a linked root before review and offers open or confirmed unlink', () => {
    const markup = renderLinkedRepository()

    expect(markup).toMatch(/is linked to.*Support triage/s)
    expect(markup).toContain('Change repository')
    expect(markup).not.toContain('Search repositories')
    expect(markup).toContain('Repository root already linked')
    expect(markup).toContain(`href="/agents/${agentId}"`)
    expect(markup).toContain('Unlink repository')
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Review agent<\/button>/,
    )
  })
})
