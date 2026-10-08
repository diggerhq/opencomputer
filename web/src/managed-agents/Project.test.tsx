// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getManagedProject: vi.fn() }))
vi.mock('./api', () => api)
vi.mock('./Detail', () => ({ default: () => <div>Agent detail</div> }))
vi.mock('./Settings', () => ({
  ManagedProjectSettings: () => <div>Project settings</div>,
}))
vi.mock('./ProjectServiceConnections', () => ({
  ManagedProjectServiceConnections: ({ projectId }: { projectId: string }) => (
    <div>Shared connections for {projectId}</div>
  ),
}))

const { default: ProjectDetail } = await import('./Project')

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('ProjectDetail', () => {
  let container: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    api.getManagedProject.mockReset().mockResolvedValue({
      project: {
        id: 'prj_empty',
        slug: 'empty',
        name: 'Empty project',
        environmentMode: 'single',
        environments: [
          {
            name: 'default',
            updatedAt: '2026-10-07T00:00:00.000Z',
          },
        ],
        agents: [],
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
      },
      sessions: [],
      deployments: [],
      connections: [],
      channels: [],
      schedules: [],
      schema: {},
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
  })

  it('keeps project service connections reachable before the first agent', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/projects/prj_empty/connections']}>
            <Routes>
              <Route
                path="/projects/:projectId/:tab"
                element={<ProjectDetail />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })

    await settle(
      () =>
        container.textContent?.includes('Shared connections for prj_empty') ===
        true,
      'project connections',
    )
    expect(container.textContent).not.toContain(
      'This project has no agents yet',
    )
  })
})
