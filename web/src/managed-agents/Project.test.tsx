import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import ProjectDetail from './Project'

const now = new Date().toISOString()
const overview = {
  project: {
    id: 'project_1',
    slug: 'support',
    name: 'Support',
    environments: [{ name: 'development', updatedAt: now }],
    agents: [{ id: 'agent_1', name: 'Support agent' }],
    createdAt: now,
    updatedAt: now,
  },
  sessions: [],
  deployments: [],
  connections: [],
  channels: [],
}

function renderProject(input: { data?: unknown; error?: Error }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity },
    },
  })
  const query = queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: ['managed-project', 'project_1'] })
  if (input.data !== undefined) query.setData(input.data)
  if (input.error) {
    query.setState({
      status: 'error',
      error: input.error,
      fetchStatus: 'idle',
      errorUpdateCount: 1,
    })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/project_1']}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('project detail availability', () => {
  it('keeps the last loaded project on screen when a poll fails', () => {
    const markup = renderProject({
      data: overview,
      error: new ApiError('Unauthorized', 401),
    })

    expect(markup).toContain('Support agent')
    expect(markup).not.toContain('Project not found')
    expect(markup).not.toContain('temporarily unavailable')
  })

  it('reports a missing project only on 404', () => {
    const markup = renderProject({ error: new ApiError('not found', 404) })

    expect(markup).toContain('Project not found')
    expect(markup).toContain('Back to projects')
  })

  it('offers a retry when the project cannot be loaded for another reason', () => {
    const markup = renderProject({ error: new TypeError('Failed to fetch') })

    expect(markup).toContain('temporarily unavailable')
    expect(markup).toContain('Try again')
    expect(markup).not.toContain('Project not found')
  })
})
