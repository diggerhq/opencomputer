// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  attachManagedGitHub: vi.fn(),
  connectManagedGitHub: vi.fn(),
  disconnectManagedGitHub: vi.fn(),
  getManagedGitHubStatus: vi.fn(),
}))
const authorization = vi.hoisted(() => ({
  launchAuthorizationWindow: vi.fn(),
}))

vi.mock('./api', () => api)
vi.mock('./authorization-window', () => authorization)

const { ManagedProjectGitHub } = await import('./GitHub')
const { githubConnectionDetails, githubConnectionLabel } =
  await import('./github-connection')

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('ManagedProjectGitHub', () => {
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
    api.getManagedGitHubStatus.mockReset().mockResolvedValue({
      environments: [
        { environment: 'development', state: 'not_connected' },
        { environment: 'production', state: 'not_connected' },
      ],
      connections: [],
      app: { slug: 'opencomputer-app' },
    })
    api.connectManagedGitHub.mockReset().mockResolvedValue({
      installUrl: 'https://github.com/apps/opencomputer-app/installations/new',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
    })
    authorization.launchAuthorizationWindow
      .mockReset()
      .mockImplementation(async (authorizationUrl: () => Promise<string>) => {
        await authorizationUrl()
      })
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  it('starts a project-scoped installation for the current environment', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <ManagedProjectGitHub
            projectId="prj_rufus"
            environment="development"
          />
        </QueryClientProvider>,
      )
    })
    await settle(
      () => container.textContent?.includes('Add GitHub connection') === true,
      'GitHub connection action',
    )
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Add GitHub connection'),
    )
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Add GitHub connection button not found')
    }

    act(() => button.click())
    await settle(
      () => api.connectManagedGitHub.mock.calls.length === 1,
      'project-scoped GitHub connect request',
    )

    expect(api.connectManagedGitHub).toHaveBeenCalledWith({
      projectId: 'prj_rufus',
      environments: ['development'],
    })
  })

  it('keeps installation metadata secondary to the account name', () => {
    const connection = {
      accountLogin: 'diggerhq',
      githubInstallationId: 164620985,
      repositorySelection: 'selected' as const,
    }

    expect(githubConnectionLabel(connection)).toBe('diggerhq')
    expect(githubConnectionDetails(connection)).toBe(
      'Selected repositories · Installation 164620985',
    )
  })
})
