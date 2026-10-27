// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { ComputerAgent } from './computer-api'

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  createComputer: vi.fn(),
  getComputerSessions: vi.fn(),
  startComputerSlackInstall: vi.fn(),
  unlinkComputerSlack: vi.fn(),
  connectClaudeSubscription: vi.fn(),
  disconnectClaudeSubscription: vi.fn(),
  resumeClaudeSubscription: vi.fn(),
  setAgentChoice: vi.fn(),
  createConnectCode: vi.fn(),
  disconnectCodexSubscription: vi.fn(),
}))
vi.mock('./computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-api')>()),
  ...computerApi,
}))
vi.mock('./api', () => ({
  addManagedGitHubConnection: vi.fn(),
  claimManagedAgentChannelIdentity: vi.fn(),
  disconnectManagedAgentConnection: vi.fn(),
  displayManagedAgentName: (agent: { id: string }) => agent.id,
  getManagedAgentConnections: vi.fn(() => Promise.resolve([])),
  getManagedAgents: vi.fn(() => Promise.resolve([])),
  getManagedGitHubConnections: vi.fn(() =>
    Promise.resolve({ connections: [] }),
  ),
  linkManagedAgentConnection: vi.fn(),
}))
const capture = vi.hoisted(() => vi.fn())
vi.mock('posthog-js', () => ({ default: { capture } }))
const notify = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))
vi.mock('@/lib/errors', () => notify)

const { default: ComputerPage } = await import('./Computer')
const { default: ConnectionsPage } = await import('./Connections')
const { AuthContext } = await import('@/hooks/useAuth')
// Subscriptions are managed on Connections (work 083).
const CONNECTIONS = '/managed-agents/connections'
const auth = {
  user: {
    id: 'u1',
    email: 'a@b.c',
    orgId: 'org_1',
    durableSessionsEnabled: false,
    infrastructureEnabled: false,
    computerEnabled: true,
  },
} as never

const TOKEN = `sk-ant-oat01-${'a'.repeat(40)}`
const CODE = 'oc_7KQM2XP94HTRWN3F'
const CODE_2 = 'oc_0J5V8D1ZGB6CY4AE'
const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString()
const fresh: ComputerAgent = {
  choice: null,
  linked: false,
  subscription: null,
  managedModel: 'Claude Opus 5.5',
}
// The rollout gate: blue names the harnesses this computer can run.
const withCodex: ComputerAgent = { ...fresh, harnesses: ['claude', 'codex'] }
const subscription = (
  health: NonNullable<ComputerAgent['subscription']>['health'],
) => ({ provider: 'claude' as const, health, setAt: '2026-10-22T10:00:00Z' })
const empty = {
  computer: null,
  slack: { installed: false },
  github: { connected: false, installations: [] },
  plan: 'free' as const,
}
const onboarded = {
  computer: {
    state: 'ready' as const,
    connected: true,
    vcpus: 2,
    memoryGiB: 8,
    diskGiB: 128,
    lastError: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
  },
  slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
  github: { connected: true, installations: [{ id: '1', accountLogin: 'a' }] },
  plan: 'free' as const,
}
const session = {
  key: 'C1:1.1',
  title: 'A task',
  channelId: 'C1',
  threadTs: '1.1',
  ownerSlackUserId: 'U1',
  status: 'idle' as const,
  updatedAt: new Date().toISOString(),
  slackUrl: 'https://acme.slack.com/archives/C1/p11',
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

describe('choosing the coding agent', () => {
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
    for (const fn of Object.values(computerApi)) fn.mockReset()
    capture.mockReset()
    notify.notifySuccess.mockReset()
    computerApi.getComputerSessions.mockResolvedValue([])
    computerApi.createConnectCode.mockResolvedValue({
      code: CODE,
      expiresAt: inTenMinutes(),
    })
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  const text = () => document.body.textContent ?? ''
  const field = () =>
    container.querySelector<HTMLInputElement>('input[type="password"]')!
  const button = (label: string) =>
    [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label,
    )

  async function show(status: object, until: string, path = '/computer') {
    computerApi.getComputer.mockResolvedValue(status)
    if ('slack' in status && (status.slack as { installed: boolean }).installed)
      computerApi.getComputerSessions.mockResolvedValue([session])
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={path === CONNECTIONS ? auth : null}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="computer" element={<ComputerPage />} />
                <Route
                  path="managed-agents/connections"
                  element={<ConnectionsPage />}
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>,
      )
    })
    await settle(() => text().includes(until), until)
  }

  // A button in one subscription's row on the Models card.
  const rowButton = (row: string, label: string) =>
    [
      ...document.body.querySelectorAll(`section[aria-label="${row}"] button`),
    ].find((b) => b.textContent?.trim() === label) as
      | HTMLButtonElement
      | undefined

  const providerRadio = (provider: string) =>
    container.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${provider}"]`,
    )!

  async function openSubscriptionMenu(name: string) {
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Manage ${name} subscription"]`,
    )!
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await settle(
      () => document.querySelector('[role="menu"]') !== null,
      'subscription menu',
    )
  }

  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === label,
    )!

  function openPaste() {
    act(() => button('Or paste a token')!.click())
  }

  const command = () =>
    [...document.body.querySelectorAll('code')]
      .map((code) => code.textContent ?? '')
      .find((value) => value.startsWith('npx '))

  function paste(value: string) {
    const input = field()
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('paste', { bubbles: true }))
    })
  }

  function submit() {
    act(() => {
      field().form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
  }

  it('comes first, with a paste form that never keeps the token', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    expect(text()).toContain('Step 1 of 4')
    expect(text()).toContain('Bring your own subscription.')
    expect(text()).toContain(
      'No subscription? Your trial includes $10 of model credits.',
    )
    expect(text()).toContain('Runs Claude Opus 5.5 on our credits.')
    expect(text()).toContain('Claude Code on its own machine')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_shown')
    openPaste()
    const input = field()
    expect(input.getAttribute('autocomplete')).toBe('off')

    // Once sent, the token is nowhere the page could show or keep it: not
    // the field, not the mutation's state, not react-query's cache (which
    // would hold a mutation's variables for minutes).
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      verified: true,
      via: 'pool',
    })
    paste(TOKEN)
    submit()
    expect(field().value).toBe('')
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(computerApi.connectClaudeSubscription).toHaveBeenCalledWith(TOKEN)
    const mutations = client.getMutationCache().getAll()
    expect(mutations.length).toBeGreaterThan(0)
    for (const mutation of mutations) {
      expect(JSON.stringify(mutation.state)).not.toContain(TOKEN)
      expect(mutation.state.variables).toBeUndefined()
    }
    expect(JSON.stringify(capture.mock.calls)).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)
  })

  it('refuses a token of the wrong shape on paste, before sending it', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    openPaste()
    paste('sk-ant-api03-nope')
    expect(text()).toContain("That's not a setup token. It starts with")
    submit()
    expect(computerApi.connectClaudeSubscription).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_failed', {
      code: 'computer_agent_token_format',
    })
  })

  it('joins a token the terminal wrapped, and says when one is cut off', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    openPaste()
    paste('sk-ant-oat01-short')
    expect(text()).toContain('That token looks cut off.')
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      verified: true,
      via: 'pool',
    })
    paste(`  ${TOKEN.slice(0, 25)}\n    ${TOKEN.slice(25)}  `)
    expect(text()).not.toContain('cut off')
    submit()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(computerApi.connectClaudeSubscription).toHaveBeenCalledWith(TOKEN)
  })

  it('says a rejected token did not work, and empties the field', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockRejectedValue(
      new ApiError('x', 422, 'computer_agent_token_rejected'),
    )
    openPaste()
    paste(TOKEN)
    submit()
    expect(field().value).toBe('')
    await settle(() => text().includes("That token didn't work"), 'rejected')
    expect(computerApi.connectClaudeSubscription).toHaveBeenCalledWith(TOKEN)
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_failed', {
      code: 'computer_agent_token_rejected',
    })
    expect(capture).not.toHaveBeenCalledWith(
      'computer.setup.agent_chosen',
      expect.anything(),
    )
  })

  it('re-reads the page when the server could not be reached', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    const reads = computerApi.getComputer.mock.calls.length
    computerApi.connectClaudeSubscription.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    )
    openPaste()
    paste(TOKEN)
    submit()
    await settle(() => text().includes("Couldn't reach the server"), 'neutral')
    expect(text()).not.toContain('Failed to fetch')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_failed', {
      code: 'unknown',
    })
    // The status is read again: the write may have landed.
    await settle(
      () => computerApi.getComputer.mock.calls.length > reads,
      're-read',
    )
    expect(text()).toContain('Step 1 of 4')
  })

  it("shows the edge's copy when someone else connected one", async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockRejectedValue(
      new ApiError(
        'Someone else already connected a subscription for this organization.',
        409,
        'computer_agent_already_connected',
      ),
    )
    openPaste()
    paste(TOKEN)
    submit()
    await settle(
      () => text().includes('Someone else already connected'),
      'already connected',
    )
  })

  it('moves on to Slack once a token is verified', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      verified: true,
      via: 'pool',
    })
    openPaste()
    paste(TOKEN)
    submit()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(text()).toContain('Claude Code · your subscription')
    expect(notify.notifySuccess).toHaveBeenCalledWith(
      'Claude Code is connected.',
    )
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_chosen', {
      choice: 'claude',
    })
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_connected', {
      provider: 'claude',
      verified: true,
      via: 'pool',
    })
  })

  it('keeps the previous selection after a failed switch and allows retry', async () => {
    const codex = {
      provider: 'codex' as const,
      health: 'ok' as const,
      setAt: '2026-10-22T10:00:00Z',
    }
    const both = {
      ...withCodex,
      choice: 'claude' as const,
      linked: true,
      subscription: subscription('ok'),
      subscriptions: { claude: subscription('ok'), codex },
    }
    await show({ ...onboarded, agent: both }, 'Models', CONNECTIONS)
    const error = new Error('Connection interrupted')
    computerApi.setAgentChoice.mockRejectedValueOnce(error)
    act(() => providerRadio('codex').click())
    await settle(
      () => notify.notifyError.mock.calls.some((call) => call[1] === error),
      'switch failed',
    )
    await settle(() => !providerRadio('codex').disabled, 'retry available')
    expect(providerRadio('claude').checked).toBe(true)
    expect(providerRadio('codex').checked).toBe(false)
    computerApi.setAgentChoice.mockResolvedValueOnce({
      ...both,
      choice: 'codex',
      subscription: codex,
    })
    act(() => providerRadio('codex').click())
    await settle(() => providerRadio('codex').checked, 'retry succeeded')
  })

  it('requires a connection before an agent can be selected', async () => {
    await show(
      {
        ...onboarded,
        agent: {
          ...withCodex,
          linked: true,
          choice: 'claude',
          subscription: subscription('ok'),
        },
      },
      'Models',
      CONNECTIONS,
    )
    expect(providerRadio('codex').disabled).toBe(true)
    expect(rowButton('Codex', 'Connect')).toBeDefined()
    act(() => providerRadio('codex').click())
    expect(computerApi.setAgentChoice).not.toHaveBeenCalled()
  })

  it('says an unchecked token is saved', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: {
        ...fresh,
        choice: 'claude',
        subscription: subscription('unchecked'),
      },
      verified: false,
      via: 'none',
    })
    openPaste()
    paste(TOKEN)
    submit()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(notify.notifySuccess).toHaveBeenCalledWith(
      "Saved. We'll check it when your computer starts.",
    )
  })

  it('waits for the check rather than giving up on it', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    openPaste()
    paste(TOKEN)
    submit()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(text()).toContain('Checking…')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(text()).toContain('Still checking…')
  })

  const card = (name: string) =>
    [...container.querySelectorAll('[role="radio"]')].find((radio) =>
      radio.textContent?.includes(name),
    ) as HTMLButtonElement
  const codexCard = () => card('Codex')
  const claudeCard = () => card('Claude')

  // The person comes back to the tab from the terminal or the browser.
  function refocus() {
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
  }

  it('shows one command for Claude Code first, the paste form second', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command')
    expect(command()).toBe(
      `npx -y @opencomputer/cli model connect claude --code ${CODE}`,
    )
    // One line, scrolled sideways when narrow, never broken mid-word.
    const row = [...document.body.querySelectorAll('code')].find((c) =>
      c.textContent?.startsWith('npx '),
    )!
    expect(row.className).toContain('whitespace-nowrap')
    expect(row.className).not.toContain('break-all')
    expect(text()).toContain(
      'Run this in a terminal; it opens Claude to sign in.',
    )
    expect(text()).toContain('Waiting for you to sign in…')
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(button('Or paste a token')).toBeDefined()
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
  })

  it('connects Codex with one command and moves on once signed in', async () => {
    await show({ ...empty, agent: withCodex }, 'Choose your coding agent')
    computerApi.setAgentChoice.mockResolvedValue({
      ...withCodex,
      choice: 'codex',
    })
    act(() => codexCard().click())
    await settle(() => command()?.includes(' codex ') === true, 'codex command')
    expect(command()).toBe(
      `npx -y @opencomputer/cli model connect codex --code ${CODE}`,
    )
    expect(text()).toContain(
      'Run this in a terminal; it opens ChatGPT to sign in.',
    )
    expect(text()).toContain('Codex on its own machine')
    expect(button('Or paste a token')).toBeUndefined()
    expect(computerApi.setAgentChoice).toHaveBeenCalledWith('codex')
    // One code for both cards: switching does not mint another.
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
    await settle(
      () =>
        capture.mock.calls.some(
          ([event, props]) =>
            event === 'computer.setup.agent_chosen' &&
            (props as { choice: string }).choice === 'codex',
        ),
      'codex chosen',
    )

    computerApi.getComputer.mockResolvedValue({
      ...empty,
      agent: {
        ...withCodex,
        choice: 'codex',
        subscription: {
          provider: 'codex',
          health: 'unchecked',
          setAt: '2026-10-22T10:00:00Z',
          plan: 'plus',
        },
      },
    })
    refocus()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(text()).toContain('Codex · your ChatGPT plan')
    expect(notify.notifySuccess).toHaveBeenCalledWith('Codex is connected.')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_connected', {
      provider: 'codex',
      verified: false,
      via: 'command',
    })
    // A used code is never offered again.
    expect(window.localStorage.length).toBe(0)
  })

  it('waits quickly for the sign-in while the tab is in view', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    computerApi.getComputer.mockResolvedValue({ ...empty, agent: fresh })
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={null}>
            <MemoryRouter initialEntries={['/computer']}>
              <Routes>
                <Route path="computer" element={<ComputerPage />} />
                <Route
                  path="managed-agents/connections"
                  element={<ConnectionsPage />}
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(command()).toBeDefined()
    const reads = computerApi.getComputer.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(computerApi.getComputer.mock.calls.length).toBeGreaterThan(reads)
  })

  it('stops renewing and waiting in a tab left open, until asked again', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    })
    let minted = 0
    computerApi.createConnectCode.mockImplementation(() =>
      Promise.resolve({
        code: `${CODE}${minted++}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    )
    computerApi.getComputer.mockResolvedValue({ ...empty, agent: fresh })
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={null}>
            <MemoryRouter initialEntries={['/computer']}>
              <Routes>
                <Route path="computer" element={<ComputerPage />} />
                <Route
                  path="managed-agents/connections"
                  element={<ConnectionsPage />}
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(command()).toBeDefined()
    // An hour with nobody acting: renewed for half an hour, then left.
    for (let i = 0; i < 60; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
    expect(computerApi.createConnectCode.mock.calls.length).toBeLessThanOrEqual(
      4,
    )
    expect(text()).toContain('This command expired.')
    expect(text()).not.toContain('Waiting for you to sign in')
    const reads = computerApi.getComputer.mock.calls.length
    const mints = computerApi.createConnectCode.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000)
    })
    // Coming back to the tab mints nothing either.
    refocus()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(computerApi.createConnectCode.mock.calls.length).toBe(mints)
    // Only the page's own slow poll (every 30 s) is left.
    expect(
      computerApi.getComputer.mock.calls.length - reads,
    ).toBeLessThanOrEqual(61)
    expect(computerApi.createConnectCode.mock.calls.length).toBe(mints)
    // Asked again: a fresh command, and the wait is back.
    act(() => button('Get a new command')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(computerApi.createConnectCode.mock.calls.length).toBe(mints + 1)
    expect(text()).toContain('Waiting for you to sign in')
  })

  it('renews an expired code without saying it expired', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    })
    let release: (() => void) | undefined
    let minted = 0
    computerApi.createConnectCode.mockImplementation(() => {
      const code = {
        code: `${CODE}${minted++}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }
      // The first mint lands at once, the renewal when released.
      return minted === 1
        ? Promise.resolve(code)
        : new Promise((resolve) => {
            release = () => resolve(code)
          })
    })
    computerApi.getComputer.mockResolvedValue({ ...empty, agent: fresh })
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={null}>
            <MemoryRouter initialEntries={['/computer']}>
              <Routes>
                <Route path="computer" element={<ComputerPage />} />
                <Route
                  path="managed-agents/connections"
                  element={<ConnectionsPage />}
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(command()).toContain(`${CODE}0`)
    // Past the code's expiry, with the renewal still on its way.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 2_000)
    })
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(2)
    expect(text()).not.toContain('This command expired.')
    expect(text()).toContain('Works once, for 10 minutes.')
    await act(async () => {
      release?.()
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(command()).toContain(`${CODE}1`)
    expect(text()).not.toContain('This command expired.')
  })

  it('keeps the command across a reload, and gives a new one on request', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command')
    // A reload: a new page, the same tab.
    act(() => root.unmount())
    client.clear()
    root = createRoot(container)
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command again')
    expect(command()).toContain(CODE)
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)

    computerApi.createConnectCode.mockResolvedValue({
      code: CODE_2,
      expiresAt: inTenMinutes(),
    })
    act(() => button('Get a new command')!.click())
    await settle(() => command()?.includes(CODE_2) === true, 'new command')
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(2)
  })

  it('drops a stored code a sign-in already used while no tab watched', async () => {
    window.localStorage.setItem(
      'opencomputer.computer.connect-code::',
      JSON.stringify({
        code: 'oc_SPENT00000000000',
        expiresAt: inTenMinutes(),
        mintedAt: Date.parse('2026-10-22T09:59:00Z'),
      }),
    )
    await show(
      {
        ...empty,
        agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      },
      'Add OpenComputer to Slack',
    )
    act(() => button('Change')!.click())
    await settle(() => command() !== undefined, 'command')
    expect(command()).toContain(CODE)
    expect(command()).not.toContain('SPENT')
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
  })

  it('mints a new command once the code expires', async () => {
    computerApi.createConnectCode
      .mockResolvedValueOnce({
        code: CODE,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      })
      .mockResolvedValue({ code: CODE_2, expiresAt: inTenMinutes() })
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await settle(() => command()?.includes(CODE_2) === true, 'renewed')
  })

  it('says why no command could be had, and tries again', async () => {
    computerApi.createConnectCode.mockRejectedValueOnce(
      new ApiError(
        "Connecting a subscription isn't available yet. Try again shortly.",
        404,
        'not_found',
      ),
    )
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(
      () => text().includes("Connecting a subscription isn't available yet."),
      'mint error',
    )
    // The paste form still works.
    expect(button('Or paste a token')).toBeDefined()
    act(() => button('Try again')!.click())
    await settle(() => command() !== undefined, 'command')
  })

  it('lands on the step again with Codex chosen, Codex selected', async () => {
    await show(
      { ...empty, agent: { ...withCodex, choice: 'codex' } },
      'Choose your coding agent',
    )
    expect(text()).toContain('Step 1 of 4')
    await settle(() => command()?.includes(' codex ') === true, 'codex command')
    expect(computerApi.setAgentChoice).not.toHaveBeenCalled()
  })

  describe('where this computer cannot run Codex yet', () => {
    it.each([
      ['an older backend that names none', fresh],
      ['a computer that runs Claude only', { ...fresh, harnesses: ['claude'] }],
    ])('only records Codex on %s', async (_, agent: ComputerAgent) => {
      await show({ ...empty, agent }, 'Choose your coding agent')
      await settle(() => command() !== undefined, 'claude command')
      computerApi.setAgentChoice.mockResolvedValue({
        ...agent,
        choice: 'codex',
      })
      act(() => codexCard().click())
      await settle(
        () => text().includes("Codex is coming. We'll let you know."),
        'coming line',
      )
      expect(computerApi.setAgentChoice).toHaveBeenCalledWith('codex')
      expect(command()).toBeUndefined()
      expect(text()).not.toContain('it opens ChatGPT to sign in')
      // The Claude command was minted for the first card; Codex mints none.
      expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
    })

    it('lands on the coming line with Codex chosen, and mints nothing', async () => {
      await show(
        { ...empty, agent: { ...fresh, choice: 'codex' } },
        "Codex is coming. We'll let you know.",
      )
      expect(command()).toBeUndefined()
      expect(computerApi.createConnectCode).not.toHaveBeenCalled()
      expect(computerApi.setAgentChoice).not.toHaveBeenCalled()
    })

    it('offers only Claude Code on the agent card', async () => {
      await show(
        {
          ...onboarded,
          agent: { ...fresh, choice: 'credits', linked: true },
        },
        'Models',
        CONNECTIONS,
      )
      expect(rowButton('Claude Code', 'Connect')).toBeDefined()
      expect(rowButton('Codex', 'Connect')).toBeUndefined()
      expect(text()).toContain("Coming soon. We'll let you know.")
    })
  })

  it('drives the cards from the harnesses, Claude included', async () => {
    await show(
      { ...empty, agent: { ...fresh, harnesses: ['codex'] } },
      "Claude Code is coming. We'll let you know.",
    )
    expect(computerApi.createConnectCode).not.toHaveBeenCalled()
    expect(button('Or paste a token')).toBeUndefined()
    computerApi.setAgentChoice.mockResolvedValue({
      ...fresh,
      harnesses: ['codex'],
      choice: 'codex',
    })
    act(() => codexCard().click())
    await settle(() => command()?.includes(' codex ') === true, 'codex command')
    expect(text()).not.toContain('is coming')
    // Back to the Claude card: the interest is recorded, as Codex's is.
    computerApi.setAgentChoice.mockResolvedValue({
      ...fresh,
      harnesses: ['codex'],
      choice: 'claude',
    })
    act(() => claudeCard().click())
    await settle(
      () => text().includes("Claude Code is coming. We'll let you know."),
      'coming line',
    )
    expect(computerApi.setAgentChoice).toHaveBeenLastCalledWith('claude')
  })

  it('offers Codex on the agent card where this computer can run it', async () => {
    await show(
      {
        ...onboarded,
        agent: { ...withCodex, choice: 'credits', linked: true },
      },
      'Models',
      CONNECTIONS,
    )
    expect(rowButton('Claude Code', 'Connect')).toBeDefined()
    act(() => rowButton('Codex', 'Connect')!.click())
    await settle(() => command()?.includes(' codex ') === true, 'codex command')
  })

  it('starts on free credits', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.setAgentChoice.mockResolvedValue({
      ...fresh,
      choice: 'credits',
    })
    act(() => button('Use OpenComputer credits')!.click())
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(computerApi.setAgentChoice).toHaveBeenCalledWith('credits')
    expect(computerApi.disconnectClaudeSubscription).not.toHaveBeenCalled()
    expect(text()).toContain('Claude Opus 5.5 · OpenComputer credits')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_chosen', {
      choice: 'credits',
    })
  })

  it('offers all three ways in the Change dialog, and switches to credits', async () => {
    await show(
      {
        ...empty,
        agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      },
      'Add OpenComputer to Slack',
    )
    expect(text()).toContain('Claude Code · your subscription')
    act(() => button('Change')!.click())
    await settle(() => text().includes('Your coding agent'), 'dialog')
    expect(text()).toContain('Now on Claude Code · your subscription.')
    expect(document.body.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(text()).toContain('Codex')
    await settle(() => command() !== undefined, 'command')
    openPaste()
    expect(button('Replace token')).toBeDefined()
    expect(text()).toContain('Switch to OpenComputer credits.')
    expect(text()).toContain('Disconnects Claude Code')
    // Free credits behind a subscription: disconnect, then record the choice.
    computerApi.disconnectClaudeSubscription.mockResolvedValue(undefined)
    computerApi.setAgentChoice.mockResolvedValue({
      ...fresh,
      choice: 'credits',
    })
    act(() => button('Use OpenComputer credits')!.click())
    await settle(
      () => computerApi.setAgentChoice.mock.calls.length === 1,
      'credits choice',
    )
    expect(computerApi.disconnectClaudeSubscription).toHaveBeenCalledTimes(1)
    await settle(() => !text().includes('Your coding agent'), 'dialog closed')
    await settle(
      () => text().includes('Claude Opus 5.5 · OpenComputer credits'),
      'credits row',
    )
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_chosen', {
      choice: 'credits',
    })
  })

  it('shows the health of a token that stopped working, with Resume', async () => {
    await show(
      {
        ...onboarded,
        agent: {
          ...fresh,
          choice: 'claude',
          linked: true,
          linkedSlackUser: { id: 'U1', name: 'maya', teamName: 'Acme' },
          subscription: subscription('invalid'),
        },
      },
      'Models',
      CONNECTIONS,
    )
    expect(text()).toContain('This token stopped working.')
    expect(text()).toContain('For @maya in Acme')
    expect(text()).not.toContain('@U1')
    await openSubscriptionMenu('Claude Code')
    expect(menuItem('Replace')).toBeDefined()
    act(() => menuItem('Disconnect').click())
    await settle(
      () => text().includes('Disconnect Claude Code?'),
      'disconnect confirmation',
    )
    expect(computerApi.disconnectClaudeSubscription).not.toHaveBeenCalled()
    act(() => button('Cancel')!.click())
    await settle(
      () => !text().includes('Disconnect Claude Code?'),
      'cancel disconnect',
    )
    computerApi.resumeClaudeSubscription.mockResolvedValue({
      ...fresh,
      choice: 'claude',
      linked: true,
      subscription: subscription('ok'),
    })
    act(() => button('Resume')!.click())
    await settle(() => text().includes('Connected'), 'resumed')
  })

  it('shows a row for each subscription, and switches which runs threads', async () => {
    const codex = {
      provider: 'codex' as const,
      health: 'ok' as const,
      setAt: '2026-10-22T10:00:00Z',
      plan: 'plus',
    }
    const both = {
      ...withCodex,
      choice: 'claude' as const,
      linked: true,
      subscription: subscription('ok'),
      subscriptions: { claude: subscription('ok'), codex },
    }
    await show({ ...onboarded, agent: both }, 'Models', CONNECTIONS)
    expect(providerRadio('claude').checked).toBe(true)
    expect(providerRadio('codex').checked).toBe(false)
    let resolveSwitch!: (agent: ComputerAgent) => void
    computerApi.setAgentChoice.mockImplementation(
      () =>
        new Promise<ComputerAgent>((resolve) => {
          resolveSwitch = resolve
        }),
    )
    act(() => providerRadio('codex').click())
    await settle(() => providerRadio('codex').disabled, 'switching')
    expect(providerRadio('claude').disabled).toBe(true)
    expect(providerRadio('claude').checked).toBe(true)
    expect(providerRadio('codex').checked).toBe(false)
    act(() =>
      resolveSwitch({
        ...both,
        choice: 'codex',
        subscription: codex,
      }),
    )
    await settle(() => providerRadio('codex').checked, 'codex selected')
    expect(providerRadio('claude').checked).toBe(false)
    expect(providerRadio('claude').disabled).toBe(false)
    expect(computerApi.setAgentChoice).toHaveBeenCalledWith('codex')
    expect(notify.notifySuccess).toHaveBeenCalledWith(
      'Codex runs your threads now.',
    )
  })

  it('says an unchecked token is saved on the card', async () => {
    await show(
      {
        ...onboarded,
        agent: {
          ...fresh,
          choice: 'claude',
          linked: true,
          subscription: subscription('unchecked'),
        },
      },
      'Models',
      CONNECTIONS,
    )
    expect(text()).toContain("Saved. We'll check it when your computer starts.")
    expect(button('Resume')).toBeUndefined()
  })

  it('links someone not linked to Slack with a code', async () => {
    await show(
      { ...onboarded, agent: { ...fresh, choice: 'credits' } },
      'Models',
      CONNECTIONS,
    )
    await settle(() => text().includes(`!link ${CODE}`), 'link command')
    expect(computerApi.createConnectCode).toHaveBeenCalledWith('link')
    expect(text()).toContain('Or connect from Slack: !claude connect')
    expect(container.querySelector('input[type="password"]')).toBeNull()

    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      agent: {
        ...fresh,
        choice: 'credits',
        linked: true,
        linkedSlackUser: { id: 'U1', name: 'maya', teamName: 'Acme' },
      },
    })
    refocus()
    await settle(
      () => rowButton('Claude Code', 'Connect') !== undefined,
      'connect card',
    )
    expect(notify.notifySuccess).toHaveBeenCalledWith(
      'Linked to your Slack account.',
    )
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith('computer.agent.link_shown')
    expect(capture).toHaveBeenCalledWith('computer.agent.linked')
    // A used code is never offered again.
    expect(Object.keys(window.localStorage)).toEqual([])
  })

  it('sums the agent up on the page, and sends changes to Connections', async () => {
    await show(
      { ...onboarded, agent: { ...fresh, choice: 'credits' } },
      'Your agent',
    )
    expect(text()).toContain(
      'Link your Slack account to use your own subscription.',
    )
    const link = () =>
      container.querySelector<HTMLAnchorElement>(
        'section[aria-labelledby="computer-agent"] a',
      )!
    expect(link().textContent).toBe('Link Slack')
    expect(link().getAttribute('href')).toBe(CONNECTIONS)
    expect(computerApi.createConnectCode).not.toHaveBeenCalled()
  })

  it('is not there for an older backend', async () => {
    await show(empty, 'Add OpenComputer to Slack')
    expect(text()).toContain('Step 1 of 3')
    expect(text()).not.toContain('Choose your coding agent')
  })
})
