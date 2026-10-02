// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { ManagedLinearConnection } from './api'

const api = vi.hoisted(() => ({
  getManagedProject: vi.fn(),
  listManagedLinearConnections: vi.fn(),
  createManagedLinearConnection: vi.fn(),
  setManagedLinearCredentials: vi.fn(),
  authorizeManagedLinearConnection: vi.fn(),
  disconnectManagedLinearConnection: vi.fn(),
  displayManagedAgentName: (agent: { id: string; name?: string }) =>
    agent.name || agent.id,
}))
vi.mock('./api', () => api)

// Linear's authorization page opens in this tab; the test only records where.
const assign = vi.fn()

const { ManagedProjectLinear } = await import('./Linear')

const project = {
  project: {
    id: 'prj_1',
    slug: 'linear-agent',
    name: 'linear-agent',
    environments: [
      {
        name: 'development',
        agentId: 'coder',
        activeDeploymentId: 'dep_dev',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
      { name: 'production', updatedAt: '2026-10-02T00:00:00.000Z' },
    ],
    agents: [{ id: 'coder', name: 'Coder' }],
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  },
}

const WEBHOOK_URL = 'https://hooks.example.test/v1/webhooks/linear/lc_1/tok'
const CREATE_APP_URL =
  'https://linear.app/settings/api/applications/new?name=Patch'
const AUTHORIZE_URL = 'https://linear.app/oauth/authorize?client_id=client-id'

function connection(
  overrides: Partial<ManagedLinearConnection> = {},
): ManagedLinearConnection {
  return {
    id: 'lc_1',
    projectId: 'prj_1',
    environment: 'development',
    agentId: 'coder',
    name: 'Patch',
    status: 'pending',
    webhookUrl: WEBHOOK_URL,
    createAppUrl: CREATE_APP_URL,
    health: {
      state: 'awaiting_credentials',
      message: 'Create the app in Linear, then paste its credentials.',
    },
    revision: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${label}`)
  return match
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

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function input(id: string): HTMLInputElement {
  const element = document.body.querySelector(`#${id}`)
  if (!(element instanceof HTMLInputElement))
    throw new Error(`Input not found: ${id}`)
  return element
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="search">{location.search}</span>
}

describe('ManagedProjectLinear', () => {
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
    for (const fn of Object.values(api)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset()
    }
    assign.mockReset()
    vi.spyOn(window.location, 'assign').mockImplementation(assign)
    api.getManagedProject.mockResolvedValue(project)
    api.listManagedLinearConnections.mockResolvedValue([])
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  function render(
    path = '/projects/prj_1/connections?environment=development',
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <ManagedProjectLinear projectId="prj_1" />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
  }

  const text = () => container.textContent ?? ''
  const body = () => document.body.textContent ?? ''

  it('shows one row per environment', async () => {
    render()
    await settle(() => text().includes('Create Linear agent'), 'the rows')
    expect(text()).toContain('development · Coder')
    expect(text()).toContain(
      'Deploy an agent to production to connect it to Linear.',
    )
    expect(api.listManagedLinearConnections).toHaveBeenCalledWith('prj_1')
  })

  it('walks name → create app → credentials → authorize, keeping secrets out of every cache', async () => {
    render()
    await settle(() => text().includes('Create Linear agent'), 'the rows')
    act(() => button(container, 'Create Linear agent').click())
    await settle(
      () => document.body.querySelector('#managed-linear-name') !== null,
      'the dialog',
    )

    // A name Linear would refuse is caught before any request.
    act(() => typeInto(input('managed-linear-name'), 'Linear helper'))
    expect(body()).toContain(
      'Linear does not allow app names that contain "Linear". Choose another name.',
    )
    expect(button(document.body, 'Create').disabled).toBe(true)

    act(() => typeInto(input('managed-linear-name'), 'Patch'))
    api.createManagedLinearConnection.mockResolvedValue({
      connectionId: 'lc_1',
      webhookUrl: WEBHOOK_URL,
      createAppUrl: CREATE_APP_URL,
      connection: connection({
        webhookUrl: undefined,
        createAppUrl: undefined,
      }),
    })
    act(() => button(document.body, 'Create').click())
    await settle(
      () => body().includes('Open Linear to create the app'),
      'the create-app step',
    )
    expect(api.createManagedLinearConnection).toHaveBeenCalledWith({
      projectId: 'prj_1',
      environment: 'development',
      agentId: 'coder',
      name: 'Patch',
    })
    const link = [...document.body.querySelectorAll('a')].find((anchor) =>
      anchor.textContent?.includes('Open Linear to create the app'),
    )
    expect(link?.getAttribute('href')).toBe(CREATE_APP_URL)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(body()).toContain('that is the agent’s name in Linear')
    // The webhook URL carries a token: masked until revealed.
    expect(body()).not.toContain(WEBHOOK_URL)

    act(() => button(document.body, 'I created the app').click())
    await settle(
      () =>
        document.body.querySelector('#managed-linear-client-secret') !== null,
      'the credentials step',
    )
    expect(input('managed-linear-client-secret').type).toBe('password')
    expect(input('managed-linear-signing-secret').type).toBe('password')
    act(() => {
      typeInto(input('managed-linear-client-id'), 'client-id')
      typeInto(input('managed-linear-client-secret'), 'client-secret-value')
      typeInto(input('managed-linear-signing-secret'), 'signing-secret-value')
    })
    api.setManagedLinearCredentials.mockResolvedValue(
      connection({
        clientId: 'client-id',
        health: {
          state: 'awaiting_authorization',
          message: 'Authorize the app in Linear to finish setup.',
        },
      }),
    )
    act(() => button(document.body, 'Save credentials').click())
    await settle(
      () => body().includes('Credentials saved'),
      'the authorize step',
    )
    expect(api.setManagedLinearCredentials).toHaveBeenCalledWith('lc_1', {
      clientId: 'client-id',
      clientSecret: 'client-secret-value',
      signingSecret: 'signing-secret-value',
    })
    expect(body()).toContain('A Linear workspace admin must approve the app.')

    const caches = [
      ...client
        .getMutationCache()
        .getAll()
        .map((mutation) => JSON.stringify(mutation.state)),
      ...client
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.state)),
    ].join('\n')
    expect(caches).not.toContain('client-secret-value')
    expect(caches).not.toContain('signing-secret-value')
    expect(body()).not.toContain('client-secret-value')

    api.authorizeManagedLinearConnection.mockResolvedValue({
      authorizeUrl: AUTHORIZE_URL,
      expiresAt: '2026-10-02T00:10:00.000Z',
    })
    act(() => button(document.body, 'Authorize in Linear').click())
    await settle(() => assign.mock.calls.length > 0, 'the redirect')
    expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL)
  })

  it('refuses to navigate to an authorization link that is not Linear’s', async () => {
    api.listManagedLinearConnections.mockResolvedValue([
      connection({
        clientId: 'client-id',
        health: { state: 'awaiting_authorization', message: '' },
      }),
    ])
    api.authorizeManagedLinearConnection.mockResolvedValue({
      authorizeUrl: 'https://evil.example/oauth/authorize',
      expiresAt: '2026-10-02T00:10:00.000Z',
    })
    render()
    await settle(() => text().includes('Ready to authorize'), 'the row')
    act(() => button(container, 'Authorize in Linear').click())
    await settle(
      () => api.authorizeManagedLinearConnection.mock.calls.length > 0,
      'the request',
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(assign).not.toHaveBeenCalled()
  })

  it('continues a pending setup from the create-app step', async () => {
    api.listManagedLinearConnections.mockResolvedValue([connection()])
    render()
    await settle(() => text().includes('Setup in progress'), 'the row')
    act(() => button(container, 'Continue setup').click())
    await settle(
      () => body().includes('Open Linear to create the app'),
      'the create-app step',
    )
    expect(api.createManagedLinearConnection).not.toHaveBeenCalled()
  })

  it('reports an existing connection instead of creating a second', async () => {
    api.createManagedLinearConnection.mockRejectedValue(
      new ApiError(
        'This agent already has a Linear connection in this environment. Disconnect it before creating another.',
        409,
        'linear_already_connected',
      ),
    )
    render()
    await settle(() => text().includes('Create Linear agent'), 'the rows')
    act(() => button(container, 'Create Linear agent').click())
    await settle(
      () => document.body.querySelector('#managed-linear-name') !== null,
      'the dialog',
    )
    act(() => typeInto(input('managed-linear-name'), 'Patch'))
    act(() => button(document.body, 'Create').click())
    await settle(
      () => document.body.querySelector('#managed-linear-name') === null,
      'the dialog to close',
    )
    expect(api.listManagedLinearConnections.mock.calls.length).toBeGreaterThan(
      1,
    )
  })

  it('shows health and the last event time once sessions arrive', async () => {
    api.listManagedLinearConnections.mockResolvedValue([
      connection({
        status: 'connected',
        clientId: 'client-id',
        verifiedAt: '2026-10-02T01:00:00.000Z',
        lastEventAt: '2026-10-02T01:00:00.000Z',
        health: {
          state: 'receiving',
          message: 'First session received',
          lastEventAt: '2026-10-02T01:00:00.000Z',
        },
      }),
    ])
    render()
    await settle(() => text().includes('First session received'), 'the row')
    expect(text()).toContain('Last event')
  })

  it('shows the outcome brought back from Linear and clears it from the URL', async () => {
    api.listManagedLinearConnections.mockResolvedValue([
      connection({
        clientId: 'client-id',
        verificationError: 'authorization_denied',
        health: { state: 'awaiting_authorization', message: '' },
      }),
    ])
    render(
      '/projects/prj_1/connections?environment=development&linear=denied&connection=lc_1',
    )
    await settle(
      () => container.querySelector('[role="status"]') !== null,
      'the banner',
    )
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Authorization was declined',
    )
    await settle(
      () =>
        container.querySelector('[data-testid="search"]')?.textContent ===
        '?environment=development',
      'the URL to be cleared',
    )
    await settle(
      () => text().includes('Authorization did not finish'),
      'the row',
    )
    act(() =>
      (
        container.querySelector(
          'button[aria-label="Dismiss"]',
        ) as HTMLButtonElement
      ).click(),
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('disconnects only after confirmation', async () => {
    api.listManagedLinearConnections.mockResolvedValue([
      connection({
        status: 'connected',
        clientId: 'client-id',
        health: {
          state: 'waiting_for_first_delegation',
          message: 'Waiting for the first delegation',
        },
      }),
    ])
    api.disconnectManagedLinearConnection.mockResolvedValue({
      connection: connection({ status: 'disconnected' }),
      revoked: true,
    })
    render()
    await settle(
      () => text().includes('Waiting for the first delegation'),
      'the row',
    )
    act(() => button(container, 'Disconnect').click())
    await settle(() => body().includes('Disconnect Patch?'), 'the confirmation')
    expect(api.disconnectManagedLinearConnection).not.toHaveBeenCalled()
    const dialog = document.body.querySelector(
      '[role="alertdialog"]',
    ) as HTMLElement
    act(() => button(dialog, 'Disconnect').click())
    await settle(
      () => api.disconnectManagedLinearConnection.mock.calls.length > 0,
      'the disconnect',
    )
    expect(api.disconnectManagedLinearConnection).toHaveBeenCalledWith('lc_1')
  })
})
