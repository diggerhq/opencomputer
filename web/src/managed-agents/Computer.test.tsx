// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  createComputer: vi.fn(),
  getComputerSessions: vi.fn(),
  startComputerSlackInstall: vi.fn(),
  unlinkComputerSlack: vi.fn(),
  moveComputerSlackHere: vi.fn(),
  dismissComputerSlackAlreadyLinked: vi.fn(),
}))
vi.mock('./computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-api')>()),
  ...computerApi,
}))
const projectsApi = vi.hoisted(() => ({
  getManagedProjects: vi.fn(),
  archiveManagedProject: vi.fn(),
  restoreManagedProject: vi.fn(),
  addManagedGitHubConnection: vi.fn(),
}))
vi.mock('./api', () => projectsApi)

const { default: ComputerPage } = await import('./Computer')
const { AuthContext } = await import('@/hooks/useAuth')
const authWith = (computerEnabled: boolean) =>
  ({
    user: {
      id: 'u1',
      email: 'a@b.c',
      orgId: 'org_1',
      durableSessionsEnabled: false,
      infrastructureEnabled: false,
      computerEnabled,
    },
    loading: false,
    error: null,
    switchOrg: async () => {},
    refreshUser: async () => {},
  }) as const
const { default: ProjectsHome } = await import('./Home')

const empty = {
  computer: null,
  slack: { installed: false },
  github: { connected: false, installations: [] },
  plan: 'free' as const,
}
const provisioning = {
  ...empty,
  computer: {
    state: 'provisioning' as const,
    connected: false,
    vcpus: 2,
    memoryGiB: 8,
    diskGiB: 128,
    lastError: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
  },
}

const onboarded = {
  ...provisioning,
  computer: {
    ...provisioning.computer,
    state: 'ready' as const,
    connected: true,
  },
  slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
  github: {
    connected: true,
    installations: [{ id: '42', accountLogin: 'acme' }],
  },
}
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString()
const liveSession = {
  key: 'C1:1.1',
  title: 'Fix the flaky checkout test',
  channelId: 'C1',
  threadTs: '1.1',
  ownerSlackUserId: 'U1',
  status: 'busy' as const,
  updatedAt: minutesAgo(2),
  slackUrl: 'https://acme.slack.com/archives/C1/p11',
}
const doneSession = {
  ...liveSession,
  key: 'C1:1.0',
  title: 'Explain the billing flow',
  threadTs: '1.0',
  status: 'idle' as const,
  updatedAt: minutesAgo(90),
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

function Location() {
  const location = useLocation()
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  )
}

describe('Computer page', () => {
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
    for (const fn of [
      ...Object.values(computerApi),
      ...Object.values(projectsApi),
    ]) {
      fn.mockReset()
    }
    computerApi.getComputerSessions.mockResolvedValue([])
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  function render(url: string) {
    act(() => {
      root.render(
        <AuthContext.Provider value={authWith(true)}>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[url]}>
              <Routes>
                <Route index element={<ProjectsHome />} />
                <Route path="computer" element={<ComputerPage />} />
              </Routes>
              <Location />
            </MemoryRouter>
          </QueryClientProvider>
        </AuthContext.Provider>,
      )
    })
  }

  const location = () =>
    container.querySelector('[data-testid="location"]')?.textContent

  it('does not create the computer on a visit: installing Slack brings it to life', async () => {
    computerApi.getComputer.mockResolvedValue(empty)
    computerApi.createComputer.mockResolvedValue(provisioning)
    computerApi.startComputerSlackInstall.mockReturnValue(new Promise(() => {}))

    render('/computer')
    await settle(
      () => container.textContent?.includes('Set up your computer') === true,
      'setup',
    )

    expect(container.textContent).toContain('Step 1 of 3')
    // Before Slack there is no computer to report on, and no pitch.
    expect(container.textContent).not.toContain('Not set up yet')
    expect(container.textContent).not.toContain('Setting up')
    expect(container.textContent).not.toContain('Lives in Slack')
    // One call to action: the current step's.
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Add OpenComputer to Slack')
    const invite = [...current.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add to Slack',
    )
    expect(invite).toBeDefined()
    expect(container.querySelectorAll('button')).toHaveLength(1)
    // The later steps are named, not offered yet.
    expect(container.textContent).toContain('Connect GitHub')
    expect(container.textContent).toContain('Give it a first task')
    // Projects are a side door.
    expect(container.querySelector('a[href="/new"]')?.textContent).toContain(
      'Set it up on OpenComputer infrastructure',
    )
    expect(container.querySelector('footer')?.textContent).toContain(
      'Building your own agent?',
    )
    expect(container.textContent).not.toMatch(/vCPU|GiB/)
    expect(container.textContent).not.toMatch(/azure|region|instance/i)

    // Nothing is created however long the page stays open.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(computerApi.createComputer).not.toHaveBeenCalled()

    act(() => invite!.click())
    await settle(
      () => computerApi.startComputerSlackInstall.mock.calls.length === 1,
      'Slack install started',
    )
  })

  it('creates the computer when Slack is installed but it is still missing', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...empty,
      slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    })
    computerApi.createComputer.mockResolvedValue({
      ...provisioning,
      slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    })

    render('/computer')
    await settle(
      () => container.textContent?.includes('Setting up') === true,
      'provisioning computer',
    )
    expect(computerApi.createComputer).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Step 2 of 3')
  })

  it('does not create a computer the organization already has', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer')
    await settle(
      () => container.textContent?.includes('Setting up') === true,
      'computer status',
    )
    expect(computerApi.createComputer).not.toHaveBeenCalled()
  })

  it('cleans the Slack return query once handled', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...provisioning,
      slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    })

    render('/computer?slack=connected')
    await settle(() => location() === '/computer', 'clean URL')
    await settle(
      () => container.textContent?.includes('Acme') === true,
      'linked workspace',
    )
    expect(
      container.querySelector('button[aria-label="Connection options"]'),
    ).not.toBeNull()
  })

  it('welcomes someone whose Slack workspace is already another organization', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer?slack=error&reason=team_already_linked&notified=1')
    await settle(() => location() === '/computer', 'clean URL')
    await settle(
      () =>
        container.textContent?.includes('Your team is already here.') === true,
      'already-linked panel',
    )
    const panel = container.querySelector(
      'section[aria-labelledby="already-linked-title"]',
    )!
    expect(panel.textContent).toContain(
      "We've messaged the person who set it up in Slack to invite you.",
    )
    expect(panel.textContent).toContain('menu at the top left')
    // One way forward at a time: no second Add to Slack beside the panel's.
    expect(panel.querySelectorAll('button')).toHaveLength(1)
    expect(container.textContent).toContain('Use a different workspace')
    expect(container.textContent).not.toContain('Add to Slack')
    expect(container.textContent).not.toContain("Couldn't connect Slack")

    act(() =>
      (
        panel.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
      ).click(),
    )
    expect(container.textContent).not.toContain('Your team is already here.')
    expect(location()).toBe('/computer')
  })

  it('lets the person who set the workspace up elsewhere move it here, and keeps saying so after a reload', async () => {
    const refused = {
      ...empty,
      slack: {
        installed: false,
        alreadyLinked: { teamName: 'Acme', notified: false, canMove: true },
      },
    }
    computerApi.getComputer.mockResolvedValue(refused)
    computerApi.moveComputerSlackHere.mockResolvedValue({
      ...provisioning,
      slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    })

    // No query string: the status alone says it.
    render('/computer')
    await settle(
      () =>
        container.textContent?.includes(
          'Acme is in your other organization.',
        ) === true,
      'move panel',
    )
    const panel = container.querySelector(
      'section[aria-labelledby="already-linked-title"]',
    )!
    expect(panel.textContent).not.toContain('Ask a teammate')
    act(() =>
      (
        [...panel.querySelectorAll('button')].find(
          (button) => button.textContent === 'Move it here',
        ) as HTMLButtonElement
      ).click(),
    )
    await settle(
      () => document.body.querySelector('[role="alertdialog"]') !== null,
      'the confirmation',
    )
    const dialog = document.body.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Move Acme here?')
    act(() =>
      (
        [...dialog.querySelectorAll('button')].find(
          (button) => button.textContent === 'Move it here',
        ) as HTMLButtonElement
      ).click(),
    )
    await settle(
      () =>
        !container.textContent?.includes('Acme is in your other organization.'),
      'panel gone once moved',
    )
    expect(computerApi.moveComputerSlackHere).toHaveBeenCalledTimes(1)
  })

  it('dismisses a refused install for good', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...provisioning,
      slack: {
        installed: false,
        alreadyLinked: { teamName: 'Acme', notified: true, canMove: false },
      },
    })
    computerApi.dismissComputerSlackAlreadyLinked.mockResolvedValue(undefined)

    render('/computer')
    await settle(
      () =>
        container.textContent?.includes('Your team is already here.') === true,
      'already-linked panel',
    )
    expect(container.textContent).not.toContain('Move it here')
    act(() =>
      (
        container.querySelector(
          'section[aria-labelledby="already-linked-title"] button[aria-label="Dismiss"]',
        ) as HTMLButtonElement
      ).click(),
    )
    expect(container.textContent).not.toContain('Your team is already here.')
    expect(computerApi.dismissComputerSlackAlreadyLinked).toHaveBeenCalledTimes(
      1,
    )
  })

  it('keeps a failed Slack install on the page until dismissed', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer?slack=error&reason=oauth_failed')
    await settle(() => location() === '/computer', 'clean URL')
    await settle(
      () =>
        container.querySelector(
          'section[aria-labelledby="slack-install-failed-title"]',
        ) !== null,
      'install-failed panel',
    )
    const panel = container.querySelector(
      'section[aria-labelledby="slack-install-failed-title"]',
    )!
    expect(panel.getAttribute('role')).toBe('alert')
    expect(panel.textContent).toContain('Slack is not connected')
    expect(panel.textContent).toContain(
      "Slack didn't confirm the install. Try again.",
    )
    expect(panel.textContent).toContain('Try again')

    act(() =>
      (
        panel.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
      ).click(),
    )
    expect(container.textContent).not.toContain('Slack is not connected')
  })

  it('asks for a teammate when nobody could be messaged', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer?slack=error&reason=team_already_linked&notified=0')
    await settle(
      () =>
        container.textContent?.includes('Ask a teammate who uses it') === true,
      'already-linked panel without a notified owner',
    )
    expect(container.textContent).not.toContain("We've messaged")
    await settle(() => location() === '/computer', 'clean URL')
  })

  it('sends an organization without projects to its computer', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([])
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/')
    await settle(() => location() === '/computer', 'redirect to /computer')
  })

  it('lists the work, live first, once onboarded', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([
      doneSession,
      liveSession,
    ])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Fix the flaky') === true,
      'sessions',
    )

    const list = container.querySelector(
      'section[aria-labelledby="computer-sessions"]',
    )!
    const rows = [...list.querySelectorAll('tbody tr')].map(
      (row) => row.textContent,
    )
    expect(rows[0]).toContain('Fix the flaky checkout test')
    expect(rows[0]).toContain('Working')
    expect(rows[0]).toContain('2 min ago')
    expect(rows[1]).toContain('Explain the billing flow')
    expect(rows[1]).toContain('1 hr ago')
    expect(list.textContent).toContain('1 working now')
    expect(
      list
        .querySelector('a[href="https://acme.slack.com/archives/C1/p11"]')
        ?.getAttribute('aria-label'),
    ).toBe('Open in Slack')
    expect(container.textContent).toContain('Online')
    expect(container.textContent).toContain('Acme')
    expect(container.textContent).toContain('acme')
    expect(container.querySelector('a[href="/new"]')).not.toBeNull()

    // No setup, no chatter; specs never appear.
    expect(container.textContent).not.toContain('Set up your computer')
    expect(container.textContent).not.toContain('Add to Slack')
    expect(container.textContent).not.toContain('in flight')
    expect(container.textContent).not.toMatch(/vCPU|GiB/)
  })

  it('keeps a resting computer and the upgrade visible once onboarded', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      computer: { ...onboarded.computer, state: 'parked', connected: false },
    })
    computerApi.getComputerSessions.mockResolvedValue([doneSession])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Sleeping') === true,
      'resting header',
    )
    expect(container.querySelector('a[href="/billing"]')?.textContent).toBe(
      'Upgrade to keep it awake',
    )
  })

  it('keeps the setup page until GitHub is connected too', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      github: { connected: false, installations: [] },
    })
    computerApi.getComputerSessions.mockResolvedValue([liveSession])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 3') === true,
      'setup',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Connect GitHub')
    // Slack is done: where it is, and the way out.
    expect(container.textContent).toContain('In Acme')
    // Unlinking stays behind a menu, never a button in plain view.
    expect(container.textContent).not.toContain('Unlink')
    expect(
      container.querySelector('button[aria-label="Connection options"]'),
    ).not.toBeNull()
    expect(container.textContent).not.toContain('Live now')
  })

  it('finishes setup with the first mention in Slack', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 3 of 3') === true,
      'last setup step',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Give it a first task')
    expect(current.textContent).toContain('@OpenComputer why is the')
    expect(current.textContent).toContain('Waiting for its first task')
    expect(
      current.querySelector('a[href="https://app.slack.com/client/T1"]')
        ?.textContent,
    ).toContain('Open Slack')
    expect(container.textContent).toContain('Repositories in acme')
    expect(container.textContent).not.toContain('Live now')
  })
  it('opens a DM with the app when the bot is known', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      slack: { ...onboarded.slack, botUserId: 'UBOT' },
    })
    computerApi.getComputerSessions.mockResolvedValue([])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 3 of 3') === true,
      'last setup step',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(
      current.querySelector('a[href="slack://user?team=T1&id=UBOT"]')
        ?.textContent,
    ).toContain('Message OpenComputer')
    expect(
      current.querySelector('a[href="https://app.slack.com/client/T1"]')
        ?.textContent,
    ).toBe('Open Slack in the browser')
    // More asks to try beside the steps.
    expect(
      container.querySelector('aside[aria-label="About your computer"]')
        ?.textContent,
    ).toContain('More to try')
  })
})
