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
import type { AuthUser } from '@/hooks/useAuth'
const authWith = (
  computerEnabled: boolean,
  onboardingExperience?: AuthUser['onboardingExperience'],
) =>
  ({
    user: {
      id: 'u1',
      email: 'a@b.c',
      orgId: 'org_1',
      computerEnabled,
      onboardingExperience,
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
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  function render(
    url: string,
    experience?: AuthUser['onboardingExperience'],
    computerEnabled = true,
  ) {
    act(() => {
      root.render(
        <AuthContext.Provider value={authWith(computerEnabled, experience)}>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[url]}>
              <Routes>
                <Route index element={<ProjectsHome />} />
                <Route path="getting-started" element={<ProjectsHome />} />
                <Route path="automations" element={<ProjectsHome list />} />
                <Route path="computer" element={<ComputerPage />} />
                <Route path="computer/sessions/:id" element={<div />} />
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

  const existingProject = {
    id: 'project_1',
    slug: 'support',
    name: 'Support',
    environments: [],
    agents: [],
    createdAt: '2026-10-27T10:00:00Z',
    updatedAt: '2026-10-27T10:00:00Z',
  }

  it.each(['/', '/getting-started'])(
    'sends existing workspaces into Computer setup from %s',
    async (url) => {
      projectsApi.getManagedProjects.mockResolvedValue([existingProject])
      computerApi.getComputer.mockResolvedValue(empty)
      render(url, 'computer')
      await settle(() => location() === '/computer', 'Computer override')
      await settle(
        () => container.textContent?.includes('Set up your computer') === true,
        'setup',
      )
      expect(computerApi.createComputer).not.toHaveBeenCalled()
      expect(projectsApi.getManagedProjects).not.toHaveBeenCalled()
    },
  )

  it('can reach Computer setup even when the project service fails', async () => {
    projectsApi.getManagedProjects.mockRejectedValue(new Error('unavailable'))
    computerApi.getComputer.mockResolvedValue(empty)
    render('/', 'computer')
    await settle(() => location() === '/computer', 'Computer override')
    expect(projectsApi.getManagedProjects).not.toHaveBeenCalled()
  })

  it('preserves explicit automation access with the Computer override', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([existingProject])
    render('/automations', 'computer')
    await settle(
      () => container.textContent?.includes('Support') === true,
      'project list',
    )
    expect(location()).toBe('/automations')
    expect(projectsApi.getManagedProjects).toHaveBeenCalledWith()
    expect(projectsApi.getManagedProjects).toHaveBeenCalledWith({
      archived: true,
    })
  })

  it('can select Automations for an empty workspace without looping', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([])
    render('/', 'automations')
    await settle(
      () => container.textContent?.includes('No automations yet') === true,
      'empty list',
    )
    expect(location()).toBe('/automations')
  })

  it('preserves default routing for existing workspaces when the override is cleared', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([existingProject])
    render('/', null)
    await settle(
      () => container.textContent?.includes('Support') === true,
      'project list',
    )
    expect(location()).toBe('/')
  })

  it('does not bypass the Computer availability gate', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([existingProject])
    render('/', 'computer', false)
    await settle(
      () => container.textContent?.includes('Support') === true,
      'project list',
    )
    expect(location()).toBe('/')
  })

  it('does not create the computer on a visit: GitHub comes first', async () => {
    computerApi.getComputer.mockResolvedValue(empty)
    computerApi.createComputer.mockResolvedValue(provisioning)

    render('/computer')
    await settle(
      () => container.textContent?.includes('Set up your computer') === true,
      'setup',
    )

    expect(container.textContent).toContain('Step 1 of 2')
    // Before the first session or Slack there is no computer to report on,
    // and no pitch.
    expect(container.textContent).not.toContain('Not set up yet')
    expect(container.textContent).not.toContain('Setting up')
    expect(container.textContent).not.toContain('Lives in Slack')
    // One call to action, the current step's, and a way past it.
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Connect GitHub')
    expect(
      [...container.querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['Connect GitHub', 'Skip for now'])
    // The last step is named, not offered yet.
    expect(container.textContent).toContain('Add OpenComputer to Slack')
    expect(container.querySelector('textarea')).toBeNull()
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
  })

  it('moves on to the first task when GitHub is skipped, and remembers it', async () => {
    computerApi.getComputer.mockResolvedValue(empty)

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 1 of 2') === true,
      'GitHub step',
    )
    const skip = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Skip for now',
    )!
    act(() => skip.click())
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
      'start step',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Add OpenComputer to Slack')
    expect(container.textContent).toContain('Skipped for now')
    expect(localStorage.getItem('computer.setup.githubSkipped')).toBe('1')
    // Still nothing created: the first session does that.
    expect(computerApi.createComputer).not.toHaveBeenCalled()

    // A reload keeps the skip.
    act(() => root.unmount())
    root = createRoot(container)
    client.clear()
    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
      'start step after reload',
    )
  })

  it('leads with Slack, the web only on request, when Slack is not in', async () => {
    localStorage.setItem('computer.setup.githubSkipped', '1')
    computerApi.getComputer.mockResolvedValue(empty)
    computerApi.startComputerSlackInstall.mockReturnValue(new Promise(() => {}))

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
      'start step',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Add OpenComputer to Slack')
    expect(current.textContent).toContain('Coding is more fun with your team')
    // The text box waits to be asked for, so Slack stays the way in.
    expect(current.querySelector('textarea')).toBeNull()
    expect(current.textContent).toContain('Prefer to start on the web?')
    expect(current.textContent).toContain('Not a Slack admin?')
    // Nothing to wait for in Slack yet.
    expect(current.textContent).not.toContain('Waiting for its first task')
    const invite = [...current.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add to Slack',
    )!
    act(() => invite.click())
    await settle(
      () => computerApi.startComputerSlackInstall.mock.calls.length === 1,
      'Slack install started',
    )
    expect(computerApi.createComputer).not.toHaveBeenCalled()
  })

  it('starts the first task here, waiting while the computer comes to life', async () => {
    localStorage.setItem('computer.setup.githubSkipped', '1')
    computerApi.getComputer.mockResolvedValue(empty)
    // The first answer says the computer is starting; the second waits.
    let answer: (response: Response) => void = () => {}
    const answers = [
      Promise.resolve(
        Response.json(
          {
            error: {
              type: 'computer_unavailable',
              message: 'Your computer is starting.',
              retryAfterMs: 0,
            },
          },
          { status: 503 },
        ),
      ),
      new Promise<Response>((resolve) => {
        answer = resolve
      }),
    ]
    const starts: (RequestInit | undefined)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (url !== '/api/managed-agents/computer/sessions') {
        return Promise.resolve(Response.json({}, { status: 404 }))
      }
      starts.push(init)
      return answers[starts.length - 1]
    })

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
      'start step',
    )
    const web = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Prefer to start on the web?'),
    )!
    act(() => web.click())
    const field = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="First task"]',
    )!
    const start = () =>
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Start',
      )!
    expect(start().disabled).toBe(true)
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(field, '  Why is checkout flaky?  ')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(start().disabled).toBe(false)
    act(() => start().click())

    await settle(() => starts.length === 2, 'retried start')
    await settle(
      () => container.textContent?.includes('Starting your computer.') === true,
      'starting the computer',
    )
    for (const init of starts) {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({
        input: 'Why is checkout flaky?',
      })
    }

    answer(
      Response.json({
        session: {
          id: 'ses_1',
          title: null,
          status: 'starting',
          archived: false,
          owner: null,
          origin: { type: 'api' },
          settings: { model: null, effort: null, mode: null },
          activeTurnId: null,
          asks: [],
          lastText: null,
          lastSeq: 0,
          createdAt: '2026-11-18T10:00:00.000Z',
          lastActiveAt: null,
        },
      }),
    )
    await settle(
      () => location() === '/computer/sessions/ses_1',
      'the new session',
    )
    expect(computerApi.createComputer).not.toHaveBeenCalled()
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
      () => container.textContent?.includes('Creating') === true,
      'provisioning computer',
    )
    expect(computerApi.createComputer).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Step 1 of 2')
  })

  it('does not create a computer the organization already has', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer')
    await settle(
      () => container.textContent?.includes('Creating') === true,
      'computer status',
    )
    expect(computerApi.createComputer).not.toHaveBeenCalled()
  })

  it('cleans the Slack return query once handled', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([doneSession])

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
    expect(panel.textContent).toContain(
      'Or connect a different Slack workspace',
    )
    expect(panel.textContent).toContain('Install Slack app')
    expect(container.textContent).not.toContain("Couldn't connect Slack")

    act(() =>
      (
        panel.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
      ).click(),
    )
    expect(container.textContent).not.toContain('Your team is already here.')
    expect(location()).toBe('/computer')
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
      () => container.textContent?.includes('Step 1 of 2') === true,
      'setup',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Connect GitHub')
    expect(current.textContent).toContain('Skip for now')
    // Unlinking Slack is never a button in plain view.
    expect(container.textContent).not.toContain('Unlink')
    expect(container.textContent).not.toContain('Live now')
  })

  it('finishes setup with the first mention in Slack', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
      'last setup step',
    )
    const current = container.querySelector('li[aria-current="step"]')!
    expect(current.textContent).toContain('Give it its first task')
    // In Slack; the web only on request.
    expect(current.querySelector('textarea')).toBeNull()
    expect(current.textContent).toContain('Prefer to start on the web?')
    expect(current.textContent).toContain('@OpenComputer why is the')
    expect(current.textContent).toContain('Waiting for its first task')
    expect(current.textContent).not.toContain('Add to Slack')
    expect(
      current.querySelector('a[href="https://app.slack.com/client/T1"]')
        ?.textContent,
    ).toBe('Open Slack')
    expect(container.textContent).toContain('Repositories in acme')
    expect(container.textContent).not.toContain('Live now')
  })
  it('shows the first task landing, live, once it has waited for it', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
      'last setup step',
    )

    computerApi.getComputerSessions.mockResolvedValue([
      { ...liveSession, updatedAt: minutesAgo(0) },
    ])
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['managed-computer'] })
    })
    const panel = () =>
      container.querySelector('section[aria-labelledby="first-task-title"]')
    await settle(() => panel() !== null, 'first task')
    expect(panel()!.textContent).toContain("It's on your first task")
    expect(panel()!.textContent).toContain('Fix the flaky checkout test')
    expect(panel()!.textContent).toContain('just now')
    expect(
      panel()!.querySelector('a[href="https://acme.slack.com/archives/C1/p11"]')
        ?.textContent,
    ).toBe('Open the thread')
    // Nothing to dismiss while it works.
    expect(panel()!.querySelector('button[aria-label="Dismiss"]')).toBeNull()

    computerApi.getComputerSessions.mockResolvedValue([
      { ...liveSession, status: 'idle' },
    ])
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['managed-computer'] })
    })
    await settle(
      () => panel()?.textContent?.includes('It answered') === true,
      'first task answered',
    )
    act(() => {
      panel()!
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
        .click()
    })
    expect(panel()).toBeNull()
  })

  it('leaves a finished first task out of a later visit', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([doneSession])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Explain the billing') === true,
      'sessions',
    )
    expect(
      container.querySelector('section[aria-labelledby="first-task-title"]'),
    ).toBeNull()
  })

  it('shows a new computer coming to life during setup', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      computer: {
        ...onboarded.computer,
        state: 'provisioning',
        connected: false,
        createdAt: minutesAgo(1),
      },
    })

    render('/computer')
    const boot = () =>
      container.querySelector('[role="status"][aria-label^="Your computer"]')
    await settle(() => boot() !== null, 'boot progress')
    expect(boot()!.getAttribute('aria-label')).toBe('Your computer: Creating')
    expect(boot()!.textContent).toContain('Starting')
    expect(boot()!.textContent).toMatch(/1:0\d/)

    computerApi.getComputer.mockResolvedValue(onboarded)
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['managed-computer'] })
    })
    await settle(
      () => boot()?.getAttribute('aria-label') === 'Your computer: Online',
      'online',
    )
    // Done: no clock left running.
    expect(boot()!.textContent).not.toMatch(/\d:\d\d/)
  })

  it('opens a DM with the app when the bot is known', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      slack: { ...onboarded.slack, botUserId: 'UBOT' },
    })
    computerApi.getComputerSessions.mockResolvedValue([])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Step 2 of 2') === true,
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

  it('nudges toward Slack once set up without it', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      slack: { installed: false },
    })
    computerApi.getComputerSessions.mockResolvedValue([doneSession])
    computerApi.startComputerSlackInstall.mockReturnValue(new Promise(() => {}))

    render('/computer')
    await settle(
      () => container.textContent?.includes('Explain the billing') === true,
      'sessions',
    )
    expect(container.textContent).not.toContain('Set up your computer')
    const nudge = container.querySelector(
      'section[aria-label="Connect Slack"]',
    )!
    expect(nudge.textContent).toContain('Coding is more fun with your team')
    // Only what is connected is listed.
    const header = container.querySelector('header')!
    expect(header.textContent).toContain('GitHub')
    expect(header.textContent).not.toContain('Slack')
    act(() =>
      [...nudge.querySelectorAll('button')]
        .find((button) => button.textContent === 'Add to Slack')!
        .click(),
    )
    await settle(
      () => computerApi.startComputerSlackInstall.mock.calls.length === 1,
      'Slack install started',
    )
  })

  it('leaves the Slack nudge out once Slack is in', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([doneSession])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Explain the billing') === true,
      'sessions',
    )
    expect(
      container.querySelector('section[aria-label="Connect Slack"]'),
    ).toBeNull()
  })
})
