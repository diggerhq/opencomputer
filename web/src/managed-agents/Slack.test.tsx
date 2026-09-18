// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type {
  ManagedAgentChannel,
  ManagedAgentDeployment,
  ManagedSlackSetup,
} from './api'

const api = vi.hoisted(() => ({
  getManagedProject: vi.fn(),
  getManagedAgentDeployment: vi.fn(),
  getManagedAgentChannels: vi.fn(),
  findManagedSlackSetup: vi.fn(),
  startManagedSlackSetup: vi.fn(),
  authorizeManagedSlackSetup: vi.fn(),
  cancelManagedSlackSetup: vi.fn(),
  getManagedSlackSetup: vi.fn(),
  startManagedAgentSlack: vi.fn(),
  completeManagedAgentSlack: vi.fn(),
  bindManagedAgentSlackDestination: vi.fn(),
  disconnectManagedAgentSlack: vi.fn(),
  displayManagedAgentName: (agent: { id: string; name?: string }) =>
    agent.name || agent.id,
}))
vi.mock('./api', () => api)

// Slack's consent page opens in this tab; the test only records where.
const assign = vi.fn()

// Imported after the mocks so the component sees the fakes.
const { ManagedProjectSlack } = await import('./Slack')

const project = {
  project: {
    id: 'prj_1',
    slug: 'slack-coder',
    name: 'slack-coder',
    environments: [
      {
        name: 'development',
        agentId: 'coder',
        activeDeploymentId: 'dep_coder',
        updatedAt: '2026-09-17T00:00:00.000Z',
      },
      {
        name: 'production',
        agentId: 'coder',
        activeDeploymentId: 'dep_coder_production',
        updatedAt: '2026-09-17T00:00:00.000Z',
      },
    ],
    agents: [{ id: 'coder', name: 'Coder' }],
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  },
}

// The example's shape: no channel declaration, so the agent gets a dedicated
// app that receives mentions and direct messages.
const dedicatedDeployment: ManagedAgentDeployment = {
  id: 'dep_coder',
  agentId: 'coder',
  alias: 'development',
  channels: [],
  connections: [],
  createdAt: '2026-09-17T00:00:00.000Z',
  memory: [],
  projectDeployment: {
    id: 'pd_1',
    digest: 'digest',
    localAgentId: 'coder',
    agents: [{ localId: 'coder', agentId: 'coder' }],
    resources: { channels: [], channelRegistrations: [], schedules: [] },
  },
}

function setup(overrides: Partial<ManagedSlackSetup> = {}): ManagedSlackSetup {
  return {
    id: 'setup_1',
    requestKey: 'stored_0123456789',
    projectId: 'prj_1',
    agentId: 'coder',
    alias: 'development',
    channelId: 'slack',
    name: 'Patch',
    connectionId: 'channel_1',
    phase: 'prepared',
    actions: ['create', 'cancel'],
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
}

function connection(
  overrides: Partial<ManagedAgentChannel> = {},
): ManagedAgentChannel {
  return {
    id: 'channel_1',
    channel: 'slack',
    channelId: 'slack',
    agentId: 'coder',
    alias: 'development',
    appName: 'Patch',
    teamName: 'Acme',
    status: 'connected',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    destinations: [],
    agents: ['coder'],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function buttons(scope: ParentNode): string[] {
  return [...scope.querySelectorAll('button, a')].map(
    (element) => element.textContent?.trim() ?? '',
  )
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

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="search">{location.search}</span>
}

describe('ManagedProjectSlack', () => {
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
    api.getManagedAgentDeployment.mockResolvedValue(dedicatedDeployment)
    api.getManagedAgentChannels.mockResolvedValue([])
    api.findManagedSlackSetup.mockResolvedValue(null)
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
    environment: 'development' | 'production' = 'development',
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <ManagedProjectSlack projectId="prj_1" environment={environment} />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
  }

  const text = () => container.textContent ?? ''

  it('offers automatic setup for the dedicated app and names the receiving agent', async () => {
    render()
    await settle(() => text().includes('Create Slack bot'), 'the slot')

    expect(text()).toContain('Mentions and direct messages go to Coder')
    expect(buttons(container)).toContain('Set up manually')
    expect(api.findManagedSlackSetup).toHaveBeenCalledWith({
      agentId: 'coder',
      alias: 'development',
      channelId: undefined,
    })
  })

  it('resumes a stored setup after reload from its phase and actions', async () => {
    api.findManagedSlackSetup.mockResolvedValue(
      setup({
        phase: 'app_created',
        app: { id: 'A1', name: 'Patch' },
        actions: ['authorize', 'cancel'],
      }),
    )
    api.authorizeManagedSlackSetup.mockResolvedValue({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize?state=x',
      expiresAt: '2026-09-17T00:10:00.000Z',
    })
    render()
    await settle(() => text().includes('Approve its installation'), 'resume')

    expect(buttons(container)).toContain('Authorize in Slack')
    expect(buttons(container)).toContain('Cancel setup')
    expect(buttons(container)).not.toContain('Create Slack bot')
    expect(api.startManagedSlackSetup).not.toHaveBeenCalled()

    act(() => button(container, 'Authorize in Slack').click())
    await settle(
      () => api.authorizeManagedSlackSetup.mock.calls.length > 0,
      'authorization',
    )
    expect(api.authorizeManagedSlackSetup).toHaveBeenCalledWith('setup_1')
    await settle(() => assign.mock.calls.length > 0, 'navigation')
    expect(assign).toHaveBeenCalledWith(
      'https://slack.com/oauth/v2/authorize?state=x',
    )
  })

  it('submits once per click with one request key, and retries a rejected token under the same key', async () => {
    render()
    await settle(() => text().includes('Create Slack bot'), 'the slot')
    act(() => button(container, 'Create Slack bot').click())
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') !== null,
      'the dialog',
    )
    const tokenInput = document.body.querySelector(
      '#managed-slack-setup-token',
    ) as HTMLInputElement
    const dialog = tokenInput.closest('[role="dialog"]') as HTMLElement
    expect(tokenInput.type).toBe('password')
    const nameInput = dialog.querySelector(
      '#managed-slack-setup-name',
    ) as HTMLInputElement
    expect(nameInput.value).toBe('Coder')
    act(() => typeInto(nameInput, 'Patch'))
    act(() => typeInto(tokenInput, 'xoxe.xoxp-first'))

    const first = deferred<ManagedSlackSetup>()
    api.startManagedSlackSetup.mockReturnValueOnce(first.promise)
    const form = tokenInput.closest('form')!
    act(() => button(dialog, 'Create Slack bot').click())
    await settle(
      () => api.startManagedSlackSetup.mock.calls.length === 1,
      'the first submit',
    )
    // A second submit while the first is in flight does nothing.
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(api.startManagedSlackSetup).toHaveBeenCalledTimes(1)
    expect(button(dialog, 'Creating…').disabled).toBe(true)

    const firstCall = api.startManagedSlackSetup.mock.calls[0][0] as {
      requestKey: string
      configurationToken: string
      name: string
    }
    expect(firstCall.requestKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(firstCall).toMatchObject({
      agentId: 'coder',
      alias: 'development',
      name: 'Patch',
      configurationToken: 'xoxe.xoxp-first',
    })

    await act(async () => {
      first.resolve(
        setup({
          requestKey: firstCall.requestKey,
          error: {
            code: 'slack_configuration_token_invalid',
            message: 'invalid_auth',
            recoverable: true,
            at: '2026-09-17T00:01:00.000Z',
          },
        }),
      )
      await first.promise
    })
    await settle(
      () =>
        dialog.textContent?.includes(
          'Slack rejected the configuration token',
        ) ?? false,
      'the rejection',
    )
    expect(assign).not.toHaveBeenCalled()
    expect(api.authorizeManagedSlackSetup).not.toHaveBeenCalled()
    expect(tokenInput.value).toBe('')

    api.startManagedSlackSetup.mockResolvedValueOnce(
      setup({
        requestKey: firstCall.requestKey,
        phase: 'app_created',
        app: { id: 'A1', name: 'Patch' },
        actions: ['authorize', 'cancel'],
      }),
    )
    api.authorizeManagedSlackSetup.mockResolvedValue({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize?state=fresh',
      expiresAt: '2026-09-17T00:12:00.000Z',
    })
    act(() => typeInto(tokenInput, 'xoxe.xoxp-second'))
    act(() => button(dialog, 'Try another token').click())
    await settle(() => assign.mock.calls.length > 0, 'the consent page')
    expect(api.startManagedSlackSetup).toHaveBeenCalledTimes(2)
    const secondCall = api.startManagedSlackSetup.mock.calls[1][0] as {
      requestKey: string
      configurationToken: string
    }
    expect(secondCall.requestKey).toBe(firstCall.requestKey)
    expect(secondCall.configurationToken).toBe('xoxe.xoxp-second')
    expect(api.authorizeManagedSlackSetup).toHaveBeenCalledWith('setup_1')
    expect(assign).toHaveBeenCalledWith(
      'https://slack.com/oauth/v2/authorize?state=fresh',
    )
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') === null,
      'the dialog to close',
    )
    expect(text()).toContain('Approve its installation')
  })

  it('renders a specific next action for each error state', async () => {
    const cases: Array<{
      setup: ManagedSlackSetup
      title: string
      offered: string[]
      withheld: string[]
      once?: string[]
    }> = [
      {
        setup: setup({
          error: {
            code: 'slack_configuration_token_expired',
            message: 'token_expired',
            recoverable: true,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'The configuration token expired',
        offered: ['Try another token', 'Cancel setup'],
        withheld: ['Authorize in Slack', 'Retry'],
      },
      {
        setup: setup({
          actions: ['cancel', 'manual'],
          error: {
            code: 'slack_manifest_rejected',
            message: 'Slack rejected the app manifest.',
            recoverable: false,
            pointer: '/oauth_config/scopes/bot',
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'Slack rejected the app manifest',
        offered: ['Cancel setup', 'Set up manually'],
        withheld: ['Try another token', 'Create Slack bot', 'Retry'],
        once: ['Set up manually'],
      },
      {
        setup: setup({ phase: 'creating', actions: [] }),
        title: 'Creating the Slack app…',
        offered: [],
        withheld: ['Create Slack bot', 'Cancel setup', 'Retry'],
      },
      {
        setup: setup({
          phase: 'creation_uncertain',
          actions: ['manual', 'cancel'],
          error: {
            code: 'slack_creation_uncertain',
            message: 'timeout',
            recoverable: false,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'The result of app creation was lost',
        offered: ['Open your Slack apps', 'Set up manually', 'Cancel setup'],
        once: ['Set up manually'],
        withheld: [
          'Create Slack bot',
          'Try another token',
          'Retry',
          'Authorize in Slack',
        ],
      },
      {
        setup: setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          actions: ['authorize', 'cancel'],
          error: {
            code: 'slack_authorization_denied',
            message: 'access_denied',
            recoverable: true,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'Installation was declined',
        offered: ['Authorize again', 'Cancel setup'],
        withheld: ['Create Slack bot'],
      },
      {
        setup: setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          actions: ['authorize', 'cancel'],
          error: {
            code: 'slack_scope_missing',
            message: 'missing chat:write',
            recoverable: true,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'A declared permission is missing',
        offered: ['Authorize again'],
        withheld: ['Create Slack bot'],
      },
      {
        setup: setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          workspace: { id: 'T1', name: 'Acme' },
          actions: ['authorize', 'cancel'],
          error: {
            code: 'slack_workspace_mismatch',
            message: 'team mismatch',
            recoverable: true,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'Installed to a different workspace',
        offered: ['Authorize again'],
        withheld: [],
      },
      {
        setup: setup({
          phase: 'app_created',
          app: { id: 'A1', name: 'Patch' },
          actions: ['manual'],
          error: {
            code: 'slack_setup_superseded',
            message: 'superseded',
            recoverable: false,
            at: '2026-09-17T00:00:00.000Z',
          },
        }),
        title: 'This setup no longer owns the connection',
        offered: ['Set up manually', 'Create Slack bot'],
        withheld: ['Authorize again', 'Authorize in Slack', 'Cancel setup'],
        once: ['Set up manually'],
      },
      {
        setup: setup({ phase: 'exchanging', actions: [] }),
        title: 'Confirming the installation…',
        offered: [],
        withheld: ['Authorize in Slack', 'Cancel setup'],
      },
    ]
    for (const testCase of cases) {
      client.clear()
      api.findManagedSlackSetup.mockResolvedValue(testCase.setup)
      render()
      await settle(() => text().includes(testCase.title), testCase.title)
      const offered = buttons(container)
      for (const label of testCase.offered) expect(offered).toContain(label)
      for (const label of testCase.withheld)
        expect(offered).not.toContain(label)
      for (const label of testCase.once ?? []) {
        expect(
          offered.filter((text) => text === label),
          label,
        ).toHaveLength(1)
      }
      if (testCase.setup.phase === 'creation_uncertain') {
        expect(text()).toContain('Check your Slack app list')
        expect(
          [...container.querySelectorAll('a')].some(
            (anchor) => anchor.href === 'https://api.slack.com/apps',
          ),
        ).toBe(true)
      }
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('shows the outcome brought back from Slack and clears it from the URL', async () => {
    api.findManagedSlackSetup.mockResolvedValue(
      setup({
        phase: 'app_created',
        app: { id: 'A1', name: 'Patch' },
        actions: ['authorize', 'cancel'],
        error: {
          code: 'slack_authorization_denied',
          message: 'access_denied',
          recoverable: true,
          at: '2026-09-17T00:00:00.000Z',
        },
      }),
    )
    render(
      '/projects/prj_1/connections?environment=development&slack=authorization_denied&setup=setup_1',
    )
    await settle(
      () => container.querySelector('[role="status"]') !== null,
      'the banner',
    )
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Installation was declined',
    )
    await settle(
      () =>
        container.querySelector('[data-testid="search"]')?.textContent ===
        '?environment=development',
      'the URL to be cleared',
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

  it('keeps connected credentials distinct from the first received message', async () => {
    api.getManagedAgentChannels.mockResolvedValue([connection()])
    render()
    await settle(
      () => text().includes('Waiting for the first message'),
      'waiting',
    )
    expect(text()).toContain('invite @Patch')
    expect(buttons(container)).not.toContain('Create Slack bot')
    expect(buttons(container)).toContain('Disconnect')
    expect(api.findManagedSlackSetup).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    client.clear()
    api.getManagedAgentChannels.mockResolvedValue([
      connection({ verifiedAt: '2026-09-17T00:05:00.000Z' }),
    ])
    render()
    await settle(
      () => text().includes('Listening for Slack events'),
      'verified',
    )
    expect(text()).not.toContain('Waiting for the first message')
  })

  it('offers a fresh setup when the lookup returns a connected record but the slot is not connected', async () => {
    // After Disconnect the platform still answers the last, connected setup.
    api.findManagedSlackSetup.mockResolvedValue(
      setup({
        phase: 'connected',
        app: { id: 'A1', name: 'Patch' },
        workspace: { id: 'T1', name: 'Acme' },
        actions: [],
      }),
    )
    render()
    await settle(() => text().includes('Create Slack bot'), 'a fresh offer')
    expect(text()).not.toContain('Slack app installed')

    act(() => button(container, 'Create Slack bot').click())
    await settle(
      () => document.body.querySelector('#managed-slack-setup-name') !== null,
      'the dialog',
    )
    const nameInput = document.body.querySelector(
      '#managed-slack-setup-name',
    ) as HTMLInputElement
    expect(nameInput.readOnly).toBe(false)
    const tokenInput = document.body.querySelector(
      '#managed-slack-setup-token',
    ) as HTMLInputElement
    act(() => typeInto(tokenInput, 'xoxe.xoxp-new'))
    api.startManagedSlackSetup.mockResolvedValueOnce(
      setup({ phase: 'creating' }),
    )
    act(() =>
      button(
        tokenInput.closest('[role="dialog"]') as HTMLElement,
        'Create Slack bot',
      ).click(),
    )
    await settle(
      () => api.startManagedSlackSetup.mock.calls.length === 1,
      'the submit',
    )
    const input = api.startManagedSlackSetup.mock.calls[0][0] as {
      requestKey: string
    }
    expect(input.requestKey).not.toBe('stored_0123456789')
  })

  it('sends one request for two submits in the same task, and one authorize for two clicks', async () => {
    render()
    await settle(() => text().includes('Create Slack bot'), 'the slot')
    act(() => button(container, 'Create Slack bot').click())
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') !== null,
      'the dialog',
    )
    const tokenInput = document.body.querySelector(
      '#managed-slack-setup-token',
    ) as HTMLInputElement
    act(() => typeInto(tokenInput, 'xoxe.xoxp-first'))
    const pending = deferred<ManagedSlackSetup>()
    api.startManagedSlackSetup.mockReturnValueOnce(pending.promise)
    const form = tokenInput.closest('form') as HTMLFormElement
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    await settle(
      () => api.startManagedSlackSetup.mock.calls.length > 0,
      'the submit',
    )
    expect(api.startManagedSlackSetup).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve(setup({ phase: 'creating', actions: [] }))
      await pending.promise
    })
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') === null,
      'the dialog to close',
    )

    act(() => root.unmount())
    root = createRoot(container)
    client.clear()
    api.findManagedSlackSetup.mockResolvedValue(
      setup({
        phase: 'app_created',
        app: { id: 'A1', name: 'Patch' },
        actions: ['authorize', 'cancel'],
      }),
    )
    const authorizing = deferred<{
      authorizationUrl: string
      expiresAt: string
    }>()
    api.authorizeManagedSlackSetup.mockReturnValueOnce(authorizing.promise)
    render()
    await settle(() => text().includes('Authorize in Slack'), 'resume')
    act(() => {
      button(container, 'Authorize in Slack').click()
      button(container, 'Authorize in Slack').click()
    })
    await settle(
      () => api.authorizeManagedSlackSetup.mock.calls.length > 0,
      'the authorize call',
    )
    expect(api.authorizeManagedSlackSetup).toHaveBeenCalledTimes(1)
    await act(async () => {
      authorizing.resolve({
        authorizationUrl: 'https://slack.com/oauth/v2/authorize?state=once',
        expiresAt: '2026-09-17T00:10:00.000Z',
      })
      await authorizing.promise
    })
    await settle(() => assign.mock.calls.length > 0, 'navigation')
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('shows a retryable error when the lookup fails, and manual-only when automatic setup is unavailable', async () => {
    api.findManagedSlackSetup.mockRejectedValueOnce(
      new ApiError(
        'Automatic Slack setup is not available right now.',
        503,
        'slack_setup_unavailable',
      ),
    )
    render()
    await settle(
      () => text().includes('Automatic setup is not available'),
      'the unavailable state',
    )
    expect(buttons(container)).not.toContain('Create Slack bot')
    expect(buttons(container)).not.toContain('Try again')
    expect(buttons(container)).toContain('Set up manually')

    act(() => root.unmount())
    root = createRoot(container)
    client.clear()
    api.findManagedSlackSetup.mockReset()
    api.findManagedSlackSetup
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(null)
    render()
    await settle(() => buttons(container).includes('Try again'), 'the error')
    expect(buttons(container)).not.toContain('Create Slack bot')
    act(() => button(container, 'Try again').click())
    await settle(() => text().includes('Create Slack bot'), 'the retry')
  })

  it('keeps the created setup visible when opening Slack fails', async () => {
    render()
    await settle(() => text().includes('Create Slack bot'), 'the slot')
    act(() => button(container, 'Create Slack bot').click())
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') !== null,
      'the dialog',
    )
    const tokenInput = document.body.querySelector(
      '#managed-slack-setup-token',
    ) as HTMLInputElement
    act(() => typeInto(tokenInput, 'xoxe.xoxp-first'))
    const created = setup({
      phase: 'app_created',
      app: { id: 'A1', name: 'Patch' },
      actions: ['authorize', 'cancel'],
    })
    api.startManagedSlackSetup.mockResolvedValueOnce(created)
    api.findManagedSlackSetup.mockResolvedValue(created)
    api.authorizeManagedSlackSetup.mockRejectedValueOnce(
      new Error('authorize failed'),
    )
    const lookups = api.findManagedSlackSetup.mock.calls.length
    act(() =>
      button(
        tokenInput.closest('[role="dialog"]') as HTMLElement,
        'Create Slack bot',
      ).click(),
    )
    await settle(
      () => document.body.textContent?.includes('authorize failed') ?? false,
      'the error',
    )
    await settle(
      () => text().includes('Approve its installation'),
      'the created app on the row',
    )
    await settle(
      () => api.findManagedSlackSetup.mock.calls.length > lookups,
      'the lookup to be refreshed',
    )
  })

  it('clears an unknown return result from the URL without announcing it', async () => {
    render(
      '/projects/prj_1/connections?environment=development&slack=bogus&setup=s',
    )
    await settle(
      () =>
        container.querySelector('[data-testid="search"]')?.textContent ===
        '?environment=development',
      'the URL to be cleared',
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('leaves no configuration token in the mutation cache', async () => {
    render()
    await settle(() => text().includes('Create Slack bot'), 'the slot')
    act(() => button(container, 'Create Slack bot').click())
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') !== null,
      'the dialog',
    )
    const tokenInput = document.body.querySelector(
      '#managed-slack-setup-token',
    ) as HTMLInputElement
    act(() => typeInto(tokenInput, 'xoxe.xoxp-secret-token'))
    api.startManagedSlackSetup.mockResolvedValueOnce(
      setup({
        error: {
          code: 'slack_configuration_token_invalid',
          message: 'invalid_auth',
          recoverable: true,
          at: '2026-09-17T00:01:00.000Z',
        },
      }),
    )
    act(() =>
      button(
        tokenInput.closest('[role="dialog"]') as HTMLElement,
        'Create Slack bot',
      ).click(),
    )
    await settle(
      () =>
        document.body.textContent?.includes(
          'Slack rejected the configuration token',
        ) ?? false,
      'the rejection',
    )
    expect(api.startManagedSlackSetup).toHaveBeenCalledWith(
      expect.objectContaining({ configurationToken: 'xoxe.xoxp-secret-token' }),
    )
    const states = client
      .getMutationCache()
      .getAll()
      .map((mutation) => JSON.stringify(mutation.state))
    expect(states.join('\n')).not.toContain('xoxe.xoxp-secret-token')
  })

  it('shows the cancellation message on a cancelled setup and offers a fresh start', async () => {
    api.findManagedSlackSetup.mockResolvedValue(
      setup({
        phase: 'app_created',
        app: { id: 'A1', name: 'Patch' },
        actions: ['authorize', 'cancel'],
      }),
    )
    const message =
      "This Slack setup was cancelled. The Slack app may still appear in your workspace's app list and can be removed there."
    api.cancelManagedSlackSetup.mockResolvedValue(
      setup({
        phase: 'cancelled',
        app: { id: 'A1', name: 'Patch' },
        actions: [],
        error: {
          code: 'slack_setup_cancelled',
          message,
          recoverable: false,
          at: '2026-09-18T08:00:00.000Z',
        },
      }),
    )
    render()
    await settle(() => buttons(container).includes('Cancel setup'), 'resume')
    act(() => button(container, 'Cancel setup').click())
    await settle(
      () => document.body.querySelector('[role="alertdialog"]') !== null,
      'the confirmation',
    )
    act(() =>
      button(
        document.body.querySelector('[role="alertdialog"]') as HTMLElement,
        'Cancel setup',
      ).click(),
    )
    await settle(
      () => text().includes('Setup cancelled'),
      'the cancelled state',
    )
    expect(api.cancelManagedSlackSetup).toHaveBeenCalledWith('setup_1')
    expect(text()).toContain(message)
    expect(buttons(container)).toContain('Create Slack bot')
    expect(buttons(container)).not.toContain('Authorize in Slack')
    expect(buttons(container)).not.toContain('Cancel setup')
  })

  it('drops a cancellation confirmation when the environment changes', async () => {
    api.findManagedSlackSetup.mockImplementation(
      (target: { alias: 'development' | 'production' }) =>
        Promise.resolve(
          setup({
            id: `setup_${target.alias}`,
            alias: target.alias,
            phase: 'app_created',
            app: { id: 'A1', name: 'Patch' },
            actions: ['authorize', 'cancel'],
          }),
        ),
    )
    api.cancelManagedSlackSetup.mockResolvedValue(
      setup({ phase: 'cancelled', actions: [] }),
    )
    // Both environments were visited before: nothing loads in between.
    client.setQueryData(
      ['managed-agent-deployment', 'dep_coder_production'],
      dedicatedDeployment,
    )
    client.setQueryData(
      ['managed-agent-deployment', 'dep_coder'],
      dedicatedDeployment,
    )
    render(undefined, 'development')
    await settle(
      () => buttons(container).includes('Cancel setup'),
      'development',
    )
    act(() => button(container, 'Cancel setup').click())
    await settle(
      () => document.body.querySelector('[role="alertdialog"]') !== null,
      'the confirmation',
    )

    // Back navigation to the other environment: same panel, new scope.
    render(undefined, 'production')
    await settle(
      () =>
        api.findManagedSlackSetup.mock.calls.some(
          (call: unknown[]) =>
            (call[0] as { alias: string }).alias === 'production',
        ),
      'the production lookup',
    )
    await settle(
      () => buttons(container).includes('Cancel setup'),
      'production',
    )
    const stale = document.body.querySelector('[role="alertdialog"]')
    if (stale) act(() => button(stale as HTMLElement, 'Cancel setup').click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(api.cancelManagedSlackSetup).not.toHaveBeenCalled()
  })

  it('freezes the bot name once a request key has been used', async () => {
    render()
    await settle(() => text().includes('Create Slack bot'), 'the slot')
    act(() => button(container, 'Create Slack bot').click())
    await settle(
      () => document.body.querySelector('#managed-slack-setup-token') !== null,
      'the dialog',
    )
    const tokenInput = document.body.querySelector(
      '#managed-slack-setup-token',
    ) as HTMLInputElement
    const nameInput = document.body.querySelector(
      '#managed-slack-setup-name',
    ) as HTMLInputElement
    const dialog = tokenInput.closest('[role="dialog"]') as HTMLElement
    act(() => typeInto(nameInput, 'Patch'))
    act(() => typeInto(tokenInput, 'xoxe.xoxp-first'))
    const first = deferred<ManagedSlackSetup>()
    api.startManagedSlackSetup.mockReturnValueOnce(first.promise)
    act(() => button(dialog, 'Create Slack bot').click())
    await settle(
      () => api.startManagedSlackSetup.mock.calls.length === 1,
      'the first submit',
    )
    // The intent is fixed from here on: an edit attempt changes nothing.
    act(() => typeInto(nameInput, 'Patched'))
    expect(nameInput.value).toBe('Patch')
    expect(nameInput.readOnly).toBe(true)

    const firstCall = api.startManagedSlackSetup.mock.calls[0][0] as {
      requestKey: string
      name: string
    }
    await act(async () => {
      first.resolve(
        setup({
          requestKey: firstCall.requestKey,
          // The platform normalised the name; that is the intent from now on.
          name: 'Patch Bot',
          error: {
            code: 'slack_configuration_token_invalid',
            message: 'invalid_auth',
            recoverable: true,
            at: '2026-09-17T00:01:00.000Z',
          },
        }),
      )
      await first.promise
    })
    await settle(
      () =>
        dialog.textContent?.includes(
          'Slack rejected the configuration token',
        ) ?? false,
      'the rejection',
    )
    expect(nameInput.value).toBe('Patch Bot')
    act(() => typeInto(nameInput, 'Other'))
    expect(nameInput.value).toBe('Patch Bot')
    api.startManagedSlackSetup.mockResolvedValueOnce(
      setup({
        requestKey: firstCall.requestKey,
        phase: 'creating',
        actions: [],
      }),
    )
    act(() => typeInto(tokenInput, 'xoxe.xoxp-second'))
    act(() => button(dialog, 'Try another token').click())
    await settle(
      () => api.startManagedSlackSetup.mock.calls.length === 2,
      'the retry',
    )
    expect(api.startManagedSlackSetup.mock.calls[1][0]).toMatchObject({
      requestKey: firstCall.requestKey,
      name: 'Patch Bot',
      configurationToken: 'xoxe.xoxp-second',
    })
  })

  it('offers a fresh setup on a superseded record, whether connected or cancelled', async () => {
    for (const phase of ['connected', 'cancelled'] as const) {
      client.clear()
      api.findManagedSlackSetup.mockResolvedValue(
        setup({
          phase,
          app: { id: 'A1', name: 'Patch' },
          workspace: { id: 'T1', name: 'Acme' },
          actions: ['manual'],
          error: {
            code: 'slack_setup_superseded',
            message: 'superseded',
            recoverable: false,
            at: '2026-09-18T08:00:00.000Z',
          },
        }),
      )
      render()
      await settle(
        () => text().includes('This setup no longer owns the connection'),
        `the ${phase} superseded note`,
      )
      const offered = buttons(container)
      expect(offered, phase).toContain('Create Slack bot')
      expect(
        offered.filter((label) => label === 'Set up manually'),
        phase,
      ).toHaveLength(1)
      expect(offered, phase).not.toContain('Cancel setup')
      expect(offered, phase).not.toContain('Authorize in Slack')
      expect(text(), phase).not.toContain('Slack app installed')

      act(() => button(container, 'Create Slack bot').click())
      await settle(
        () => document.body.querySelector('#managed-slack-setup-name') !== null,
        'the dialog',
      )
      const nameInput = document.body.querySelector(
        '#managed-slack-setup-name',
      ) as HTMLInputElement
      expect(nameInput.readOnly, phase).toBe(false)
      act(() => root.unmount())
      root = createRoot(container)
      document.body.replaceChildren(container)
    }
  })
})
