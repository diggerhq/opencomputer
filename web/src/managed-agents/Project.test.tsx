// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

const api = vi.hoisted(() => ({
  getManagedProject: vi.fn(),
}))
vi.mock('./api', () => api)
vi.mock('./Detail', () => ({
  default: ({ agentId }: { agentId: string }) => (
    <div data-testid="detail">agent:{agentId}</div>
  ),
}))

const { default: ProjectDetail } = await import('./Project')

const now = new Date().toISOString()
const project = {
  project: {
    id: 'project_1',
    slug: 'support',
    name: 'Support',
    environments: [{ name: 'development', updatedAt: now }],
    agents: [{ id: 'agent_1', name: 'Support agent' }],
    createdAt: now,
    updatedAt: now,
  },
}

describe('ProjectDetail', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    api.getManagedProject.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    queryClient.clear()
    container.remove()
  })

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/projects/project_1']}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
  }

  async function flush() {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('keeps rendering the cached project when a background poll fails', async () => {
    queryClient.setQueryData(['managed-project', 'project_1'], project)
    api.getManagedProject.mockRejectedValue(new ApiError('Unauthorized', 401))
    render()

    await act(async () => {
      await queryClient
        .refetchQueries({ queryKey: ['managed-project', 'project_1'] })
        .catch(() => undefined)
    })
    await flush()

    expect(
      queryClient.getQueryState(['managed-project', 'project_1'])?.status,
    ).toBe('error')
    expect(container.textContent).toContain('agent:agent_1')
    expect(container.textContent).not.toContain('Project not found')
  })

  it('shows not found only for a 404 with nothing cached', async () => {
    api.getManagedProject.mockRejectedValue(new ApiError('Not found', 404))
    render()
    await flush()

    expect(container.textContent).toContain('Project not found')
  })

  it('offers a retry instead of not found when the first load fails', async () => {
    api.getManagedProject.mockRejectedValue(
      new ApiError('Service unavailable', 503),
    )
    render()
    await flush()

    expect(container.textContent).toContain("Couldn't load this project")
    expect(container.textContent).toContain('Retry')
    expect(container.textContent).not.toContain('Project not found')
  })
})
