// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { ManagedAgentChannel } from './api'
import { slackSetupAnchorId } from './slack-setup'

const api = vi.hoisted(() => ({
  startManagedAgentSlack: vi.fn(),
  completeManagedAgentSlack: vi.fn(),
  bindManagedAgentSlackDestination: vi.fn(),
  disconnectManagedAgentSlack: vi.fn(),
}))
vi.mock('./api', () => api)

// Imported after the mock so the component sees the fakes.
const { ManagedSlackWizard } = await import('./SlackWizard')

const BLOCKED =
  'Manual completion is blocked: cancel the automated setup for this connection, then generate a new manifest (Reconnect) before entering credentials.'
const CHANGED =
  'This connection changed while the request was in flight. Reload the page to see its current state before trying again.'
const ACTIVE =
  'A Slack setup is already in progress for this agent and environment. Resume it instead of starting another.'

// A connection whose events are rejected: the wizard offers Edit credentials,
// which starts at the details step without a manifest round trip.
const connection: ManagedAgentChannel = {
  id: 'channel_1',
  channel: 'slack',
  channelId: 'slack',
  agentId: 'coder',
  alias: 'development',
  appId: 'A1',
  appName: 'Patch',
  verificationError: 'signing_secret_mismatch',
  status: 'pending',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
  destinations: [],
  agents: ['coder'],
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

describe('ManagedSlackWizard blocked manual completion', () => {
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
    api.completeManagedAgentSlack.mockReset()
    api.completeManagedAgentSlack.mockRejectedValue(
      new ApiError(BLOCKED, 409, 'slack_manual_completion_blocked'),
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  // `null` renders the wizard with no connection at all.
  function render(
    connectionsHref?: string,
    current: ManagedAgentChannel | null = connection,
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ManagedSlackWizard
              agentId="coder"
              alias="development"
              agentName="Coder"
              connection={current ?? undefined}
              connectionsHref={connectionsHref}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
  }

  async function saveCredentials() {
    act(() => button(container, 'Edit credentials').click())
    await settle(
      () => document.body.querySelector('#managed-slack-secret') !== null,
      'the details step',
    )
    act(() =>
      typeInto(
        document.body.querySelector(
          '#managed-slack-secret',
        ) as HTMLInputElement,
        'signing-secret',
      ),
    )
    act(() => button(document.body, 'Next: install').click())
    await settle(
      () => document.body.querySelector('#managed-slack-token') !== null,
      'the install step',
    )
    act(() =>
      typeInto(
        document.body.querySelector('#managed-slack-token') as HTMLInputElement,
        'xoxb-token',
      ),
    )
    act(() => button(document.body, 'Save credentials').click())
    await settle(
      () => document.body.querySelector('[role="alert"]') !== null,
      'the blocked state',
    )
  }

  it('shows the blocked message and scrolls to the automated setup on the page', async () => {
    const anchor = document.createElement('div')
    anchor.id = slackSetupAnchorId({
      agentId: 'coder',
      alias: 'development',
      channelId: undefined,
    })
    const scrollIntoView = vi.fn()
    anchor.scrollIntoView = scrollIntoView
    document.body.append(anchor)
    render()

    await saveCredentials()
    expect(api.completeManagedAgentSlack).toHaveBeenCalledTimes(1)
    const alert = document.body.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain(BLOCKED)

    act(() => button(alert, 'Show the automated setup').click())
    await settle(
      () => document.body.querySelector('#managed-slack-token') === null,
      'the dialog to close',
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('links to Connections when the automated setup is on another tab', async () => {
    render('/projects/prj_1/connections?environment=development')

    await saveCredentials()
    const alert = document.body.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain(BLOCKED)
    const link = alert.querySelector('a') as HTMLAnchorElement
    expect(link.textContent?.trim()).toBe('Open Connections')
    expect(link.getAttribute('href')).toBe(
      '/projects/prj_1/connections?environment=development',
    )
    expect(
      [...alert.querySelectorAll('button')].some(
        (element) => element.textContent?.trim() === 'Show the automated setup',
      ),
    ).toBe(false)
  })

  it('shows a connection that changed under the manual create and refreshes what the page knows', async () => {
    api.startManagedAgentSlack.mockReset()
    api.startManagedAgentSlack.mockRejectedValue(
      new ApiError(CHANGED, 409, 'slack_connection_changed'),
    )
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(undefined, null)

    act(() => button(container, 'Connect Slack').click())
    await settle(
      () => document.body.querySelector('#managed-slack-app-name') !== null,
      'the create step',
    )
    act(() => button(document.body, 'Generate Slack manifest').click())
    await settle(
      () => document.body.querySelector('[role="alert"]') !== null,
      'the changed state',
    )
    expect(api.startManagedAgentSlack).toHaveBeenCalledTimes(1)
    const alert = document.body.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain(CHANGED)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['managed-agent-channels'],
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['managed-slack-setup'],
    })
  })

  it('shows an active automated setup inline on the manifest step and the credential step, pointing at its card', async () => {
    const active = () =>
      new ApiError(ACTIVE, 409, 'slack_setup_active', { setupId: 'setup_9' })
    const anchor = document.createElement('div')
    anchor.id = slackSetupAnchorId({
      agentId: 'coder',
      alias: 'development',
      channelId: undefined,
    })
    const scrollIntoView = vi.fn()
    anchor.scrollIntoView = scrollIntoView
    document.body.append(anchor)
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    // Manifest step, no connection yet.
    api.startManagedAgentSlack.mockReset()
    api.startManagedAgentSlack.mockRejectedValue(active())
    render(undefined, null)
    act(() => button(container, 'Connect Slack').click())
    await settle(
      () => document.body.querySelector('#managed-slack-app-name') !== null,
      'the create step',
    )
    act(() => button(document.body, 'Generate Slack manifest').click())
    await settle(
      () => document.body.querySelector('[role="alert"]') !== null,
      'the active notice on the manifest step',
    )
    let alert = document.body.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain(ACTIVE)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['managed-agent-channels'],
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['managed-slack-setup'],
    })
    act(() => button(alert, 'Show the automated setup').click())
    await settle(
      () => document.body.querySelector('#managed-slack-app-name') === null,
      'the dialog to close',
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // Credential step, pending connection.
    act(() => root.unmount())
    root = createRoot(container)
    document.body.replaceChildren(container, anchor)
    invalidate.mockClear()
    api.completeManagedAgentSlack.mockReset()
    api.completeManagedAgentSlack.mockRejectedValue(active())
    render()
    await saveCredentials()
    alert = document.body.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain(ACTIVE)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['managed-slack-setup'],
    })
    act(() => button(alert, 'Show the automated setup').click())
    await settle(
      () => document.body.querySelector('#managed-slack-token') === null,
      'the dialog to close',
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })
})
