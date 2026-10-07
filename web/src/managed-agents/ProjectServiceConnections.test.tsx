// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getManagedAgentConnections: vi.fn(),
  listManagedProjectServiceConnections: vi.fn(),
  attachManagedProjectServiceConnection: vi.fn(),
  detachManagedProjectServiceConnection: vi.fn(),
}))
vi.mock('./api', () => api)

const { ManagedProjectServiceConnections } =
  await import('./ProjectServiceConnections')

const linear = {
  id: 'conn_linear',
  kind: 'tool' as const,
  provider: 'linear',
  label: 'linear',
  agentId: '',
  alias: '',
  displayName: 'OpenComputer',
  scopes: ['read', 'write'],
  status: 'connected',
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
}

const gmail = {
  id: 'conn_gmail',
  kind: 'tool' as const,
  provider: 'google',
  label: 'support',
  agentId: '',
  alias: '',
  displayName: 'support@example.com',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  status: 'connected',
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
}

const linearAttachment = {
  projectId: 'prj_1',
  service: 'linear',
  provider: 'linear',
  label: 'linear',
  connectionId: linear.id,
  connection: linear,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
}

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return match
}

describe('ManagedProjectServiceConnections', () => {
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
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    for (const fn of Object.values(api)) fn.mockReset()
    api.getManagedAgentConnections.mockResolvedValue([linear, gmail])
    api.listManagedProjectServiceConnections.mockResolvedValue([
      linearAttachment,
    ])
    api.attachManagedProjectServiceConnection.mockResolvedValue({
      ...linearAttachment,
      service: 'gmail',
      provider: 'google',
      label: 'support',
      connectionId: gmail.id,
      connection: gmail,
    })
    api.detachManagedProjectServiceConnection.mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ManagedProjectServiceConnections projectId="prj_1" />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
  }

  it('shows attached and available accounts and attaches explicitly', async () => {
    render()
    await settle(
      () => container.textContent?.includes('support@example.com') === true,
      'service connection rows',
    )

    expect(container.textContent).toContain('OpenComputer')
    expect(button(container, 'Detach')).toBeDefined()
    act(() => button(container, 'Attach').click())

    await settle(
      () => api.attachManagedProjectServiceConnection.mock.calls.length === 1,
      'attach request',
    )
    expect(api.attachManagedProjectServiceConnection).toHaveBeenCalledWith({
      projectId: 'prj_1',
      connectionId: 'conn_gmail',
    })
  })

  it('confirms detach without removing the account connection', async () => {
    render()
    await settle(
      () => container.textContent?.includes('OpenComputer') === true,
      'attached connection',
    )
    act(() => button(container, 'Detach').click())
    await settle(
      () =>
        document.body.textContent?.includes('underlying OAuth account') ===
        true,
      'detach confirmation',
    )
    act(() => button(document.body, 'Detach connection').click())

    await settle(
      () => api.detachManagedProjectServiceConnection.mock.calls.length === 1,
      'detach request',
    )
    expect(api.detachManagedProjectServiceConnection).toHaveBeenCalledWith({
      projectId: 'prj_1',
      connectionId: 'conn_linear',
    })
  })

  it('links to account connections when none exist', async () => {
    api.getManagedAgentConnections.mockResolvedValue([])
    api.listManagedProjectServiceConnections.mockResolvedValue([])
    render()
    await settle(
      () => container.textContent?.includes('No connected accounts') === true,
      'empty state',
    )
    const link = [...container.querySelectorAll('a')].find(
      (candidate) => candidate.textContent?.trim() === 'Add account connection',
    )
    expect(link?.getAttribute('href')).toBe('/connections')
  })
})
