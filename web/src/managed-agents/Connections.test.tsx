// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  startComputerSlackInstall: vi.fn(),
  unlinkComputerSlack: vi.fn(),
}))
vi.mock('./computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-api')>()),
  ...computerApi,
}))
const api = vi.hoisted(() => ({
  addManagedGitHubConnection: vi.fn(),
  claimManagedAgentChannelIdentity: vi.fn(),
  disconnectManagedAgentConnection: vi.fn(),
  displayManagedAgentName: (agent: { id: string }) => agent.id,
  getManagedAgentConnections: vi.fn(),
  getManagedAgents: vi.fn(),
  getManagedGitHubConnections: vi.fn(),
  linkManagedAgentConnection: vi.fn(),
}))
vi.mock('./api', () => api)

const { default: ConnectionsPage } = await import('./Connections')
const { AuthContext } = await import('@/hooks/useAuth')
const auth = {
  user: {
    id: 'u1',
    email: 'a@b.c',
    orgId: 'org_1',
    infrastructureEnabled: false,
    computerEnabled: true,
  },
  loading: false,
  error: null,
  switchOrg: async () => {},
  refreshUser: async () => {},
} as const

const installation = {
  id: 'ghc_1',
  githubInstallationId: 7,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all' as const,
  state: 'active' as const,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
}

const linearAccount = {
  id: 'conn_1',
  kind: 'tool',
  provider: 'linear',
  label: 'linear',
  agentId: 'email-triage',
  alias: 'default',
  displayName: 'Acme Linear',
  scopes: [],
  status: 'connected',
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
}

let root: Root | undefined
let container: HTMLDivElement

async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/managed-agents/connections']}>
            <ConnectionsPage />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
  })
  for (let tick = 0; tick < 3; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  computerApi.getComputer.mockResolvedValue({
    computer: null,
    slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    github: { connected: true, installations: [] },
    plan: 'free',
  })
  api.getManagedGitHubConnections.mockResolvedValue({
    connections: [installation],
    app: { slug: 'opencomputerdev' },
  })
  api.getManagedAgents.mockResolvedValue([{ id: 'email-triage' }])
  api.getManagedAgentConnections.mockResolvedValue([linearAccount])
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('Connections', () => {
  it('shows the organization Slack app and GitHub accounts', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Acme')
    // Unlinking is a plain row action, not tucked into a menu.
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Unlink',
      ),
    ).toBe(true)
    expect(text).toContain('acme')
    expect(text).toContain('All repositories')
    const configure = container.querySelector<HTMLAnchorElement>(
      'a[href*="/settings/installations/"]',
    )
    expect(configure?.href).toBe(
      'https://github.com/organizations/acme/settings/installations/7',
    )
  })

  it('lists every other service, connected or not, below Slack and GitHub', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text.indexOf('Other accounts')).toBeGreaterThan(
      text.indexOf('GitHub'),
    )
    const section = container.querySelector(
      'section[aria-label="Other accounts"]',
    )
    const sectionText = section?.textContent ?? ''
    for (const service of [
      'Gmail',
      'Google Calendar',
      'Google Drive',
      'Google Sheets',
      'Linear',
    ]) {
      expect(sectionText).toContain(service)
    }
    expect(sectionText).toContain('Not connected')
    expect(sectionText).toContain('Acme LinearAlias linear · email-triage')
    const buttons = [...(section?.querySelectorAll('button') ?? [])].map(
      (button) => button.textContent,
    )
    expect(buttons.filter((label) => label === 'Connect')).toHaveLength(4)
    expect(buttons).toContain('Add account')
    expect(buttons).toContain('Remove')
  })

  it('connects a service in a new window, named after the service', async () => {
    const authorizationWindow = {
      opener: null,
      document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() },
      close: vi.fn(),
    }
    vi.spyOn(window, 'open').mockReturnValue(
      authorizationWindow as unknown as Window,
    )
    api.linkManagedAgentConnection.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
    })
    await render()
    const section = container.querySelector(
      'section[aria-label="Other accounts"]',
    )
    const connect = [...(section?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Connect',
    )
    await act(async () => {
      connect?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.linkManagedAgentConnection).toHaveBeenCalledWith(
      'gmail',
      'gmail',
    )
    expect(authorizationWindow.location.replace).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/auth',
    )
  })
})
