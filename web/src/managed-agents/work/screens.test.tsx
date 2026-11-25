// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { AuthContext, type AuthContextValue } from '@/hooks/useAuth'
import { makeItem, minutesAgo } from './fixtures'

const workApi = vi.hoisted(() => ({
  getOpenItems: vi.fn(),
  getRepository: vi.fn(),
  putRepository: vi.fn(),
  getRepositories: vi.fn(),
}))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  ...workApi,
}))

const { KnowledgeRepositorySection } = await import('./KnowledgeRepository')

const repository = {
  installationId: '1',
  owner: 'acme',
  name: 'knowledge',
  branch: 'main',
  problem: null,
}
const openPage = (items: ReturnType<typeof makeItem>[], over = {}) => ({
  etag: '"h1"',
  page: {
    repository,
    head: 'abc',
    asOf: new Date().toISOString(),
    building: false,
    items,
    ...over,
  },
})

const auth: AuthContextValue = {
  user: {
    id: 'usr_1',
    email: 'a@example.com',
    orgId: 'org_1',
    computerEnabled: true,
  },
  loading: false,
  error: null,
  switchOrg: async () => {},
  refreshUser: async () => {},
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function render(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root.render(
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route
                path="/computer"
                element={<KnowledgeRepositorySection id="work-repository" />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
  })
  await settle()
  return client
}

// Flushes until nothing is loading (the repository setting loads in two
// steps: the choice, then the picker's list, which is in a popover outside
// the container).
async function settle() {
  await flush()
  for (
    let i = 0;
    i < 50 && document.body.querySelector('[role="status"]');
    i++
  ) {
    await flush()
  }
  await flush()
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}


const granted = (
  name: string,
  pushedAt: string | null,
  over: Record<string, unknown> = {},
) => ({
  id: name.length,
  owner: 'acme',
  name,
  private: false,
  defaultBranch: 'main',
  pushedAt,
  ...over,
})
const acme = {
  id: '1',
  accountLogin: 'acme',
  accountType: 'Organization',
  settingsUrl:
    'https://github.com/organizations/acme/settings/installations/41',
  repositories: [
    granted('app', minutesAgo(5), { private: true }),
    granted('knowledge', minutesAgo(180)),
    granted('website', minutesAgo(4000), { defaultBranch: 'trunk' }),
  ],
  truncated: false,
  problem: null,
  problemMessage: null,
}

const trigger = () =>
  container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')

async function openPicker() {
  click(trigger())
  await settle()
}

// The options of the open picker, by name (it portals to the body).
const options = () => [...document.body.querySelectorAll('[role="option"]')]
const rows = () =>
  options().map((o) => o.querySelector('.truncate')?.textContent)
const option = (name: string) =>
  options().find((o) => o.querySelector('.truncate')?.textContent === name)
const search = () =>
  document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Search repositories"]',
  )!

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

function type(el: HTMLInputElement, value: string) {
  act(() => {
    // Through the prototype's setter, so React sees a change.
    Reflect.set(HTMLInputElement.prototype, 'value', value, el)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('repository picker', () => {
  beforeEach(() => {
    workApi.getRepositories.mockResolvedValue([acme])
  })

  it('shows Select a repository, and lists what GitHub grants on open', async () => {
    workApi.getRepository.mockResolvedValue(null)
    await render('/computer')
    expect(trigger()?.textContent).toContain('Select a repository')
    await openPicker()
    expect(rows()).toEqual(['app', 'knowledge', 'website'])
    expect(document.activeElement).toBe(search())
    expect(
      option('app')?.querySelector('[aria-label="Private"]'),
    ).not.toBeNull()
    expect(option('app')?.textContent).toContain('5 min ago')
    // One installation: no account headings, one access link.
    expect(
      document.body.querySelector('[role="group"]')?.textContent,
    ).not.toContain('acme/')
    const access = [...document.body.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Adjust GitHub App access'),
    )
    expect(access?.getAttribute('href')).toBe(acme.settingsUrl)
    expect(access?.getAttribute('target')).toBe('_blank')
  })

  it('groups by account when several installations grant', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.getRepositories.mockResolvedValue([
      acme,
      {
        ...acme,
        id: '2',
        accountLogin: 'acme-labs',
        repositories: [],
        problem: 'installation_suspended',
        problemMessage: 'The installation is suspended.',
      },
    ])
    await render('/computer')
    await openPicker()
    const groups = [...document.body.querySelectorAll('[role="group"]')]
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'acme',
      'acme-labs',
    ])
    expect(groups[1].textContent).toContain('The installation is suspended.')
  })

  it('filters by name as you type', async () => {
    workApi.getRepository.mockResolvedValue(null)
    await render('/computer')
    await openPicker()
    type(search(), 'WEB')
    expect(rows()).toEqual(['website'])
    type(search(), 'nothing')
    expect(document.body.textContent).toContain('No repository matches')
  })

  it('saves a clicked repository on its default branch, without asking', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.putRepository.mockResolvedValue({
      ...repository,
      name: 'website',
      branch: 'trunk',
    })
    await render('/computer')
    await openPicker()
    click(option('website'))
    await flush()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(workApi.putRepository).toHaveBeenCalledWith({
      installationId: '1',
      owner: 'acme',
      name: 'website',
      branch: 'trunk',
    })
  })

  it('chooses with the arrow keys and Enter', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.putRepository.mockResolvedValue(repository)
    await render('/computer')
    await openPicker()
    key(search(), 'ArrowDown')
    expect(search().getAttribute('aria-activedescendant')).toBe(
      option('knowledge')?.id,
    )
    key(search(), 'Enter')
    await flush()
    expect(options()).toEqual([])
    expect(workApi.putRepository).toHaveBeenCalledWith({
      installationId: '1',
      owner: 'acme',
      name: 'knowledge',
      branch: 'main',
    })
  })

  it('reads the list only when wanted, and checks the current one', async () => {
    workApi.getRepository.mockResolvedValue(repository)
    await render('/computer')
    expect(workApi.getRepositories).not.toHaveBeenCalled()
    expect(trigger()?.textContent).toContain('acme/knowledge')
    await openPicker()
    expect(option('knowledge')?.getAttribute('aria-selected')).toBe('true')
    expect(option('app')?.getAttribute('aria-selected')).toBe('false')
    // The same one again changes nothing.
    click(option('knowledge'))
    await flush()
    expect(workApi.putRepository).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('says when GitHub could not list, with a way to try again', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.getRepositories.mockRejectedValue(
      new ApiError('GitHub is unavailable', 503),
    )
    await render('/computer')
    await openPicker()
    expect(document.body.textContent).toContain('Could not load repositories')
    workApi.getRepositories.mockResolvedValue([acme])
    click(
      [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === 'Try again',
      ),
    )
    await settle()
    expect(rows()).toEqual(['app', 'knowledge', 'website'])
  })

  it('asks to connect GitHub when no installation grants anything', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.getRepositories.mockResolvedValue([])
    await render('/computer')
    expect(button('Connect GitHub')).toBeTruthy()
    expect(trigger()).toBeNull()
  })

  it('confirms before switching from a set repository', async () => {
    workApi.getRepository.mockResolvedValue(repository)
    workApi.getOpenItems.mockResolvedValue(openPage([]))
    workApi.putRepository.mockResolvedValue({ ...repository, name: 'app' })
    await render('/computer')
    await openPicker()
    click(option('app'))
    await flush()
    expect(workApi.putRepository).not.toHaveBeenCalled()
    const dialog = document.body.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Switch the board to acme/app?')
    expect(dialog.textContent).toContain(
      'Nothing is deleted or changed in either repository',
    )
    click(
      [...dialog.querySelectorAll('button')].find(
        (b) => b.textContent === 'Switch',
      ),
    )
    await settle()
    expect(workApi.putRepository).toHaveBeenCalledWith({
      installationId: '1',
      owner: 'acme',
      name: 'app',
      branch: 'main',
    })
  })
})

function button(text: string) {
  return [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )
}

describe('knowledge repository section', () => {
  beforeEach(() => {
    workApi.getRepositories.mockResolvedValue([acme])
    workApi.getOpenItems.mockResolvedValue(
      openPage(items(), { head: '9f2c1a7e4b3d', asOf: minutesAgo(2) }),
    )
  })
  const items = () => [makeItem({ number: 1, title: 'One' })]
  const withProblem = (problem: string, problemMessage: string | null = null) =>
    workApi.getRepository.mockResolvedValue({
      ...repository,
      problem,
      problemMessage,
    })

  it('shows the repository, its branch and how fresh the reading is', async () => {
    workApi.getRepository.mockResolvedValue(repository)
    await render('/computer')
    expect(container.querySelector('section#work-repository')).not.toBeNull()
    expect(trigger()?.textContent).toContain('acme/knowledge')
    expect(
      container
        .querySelector('a[href="https://github.com/acme/knowledge"]')
        ?.getAttribute('aria-label'),
    ).toBe('Open acme/knowledge on GitHub')
    expect(container.textContent).toContain('main')
    expect(container.textContent).toContain(
      'Up to date · read 2 min ago at 9f2c1a7',
    )
    // The installations are read only when choosing.
    expect(workApi.getRepositories).not.toHaveBeenCalled()
  })

  it('says when the first read is still going', async () => {
    workApi.getRepository.mockResolvedValue(repository)
    workApi.getOpenItems.mockResolvedValue(
      openPage([], { building: true, asOf: null }),
    )
    await render('/computer')
    expect(container.textContent).toContain(
      'Reading the working docs for the first time',
    )
  })

  it('offers Reconnect GitHub when the installation is gone', async () => {
    withProblem('installation_removed')
    await render('/computer')
    expect(container.textContent).toContain(
      'The GitHub installation is not connected to this organization.',
    )
    expect(button('Reconnect GitHub')).toBeTruthy()
    expect(button('Choose another repository')).toBeTruthy()
    expect(container.textContent).not.toContain('installation_removed')
  })

  it('offers GitHub App access and another repository when it is not granted', async () => {
    withProblem('repository_not_found')
    await render('/computer')
    expect(
      [...container.querySelectorAll('a')]
        .find((a) => a.textContent === 'Adjust GitHub App access')
        ?.getAttribute('href'),
    ).toBe(acme.settingsUrl)
    click(button('Choose another repository'))
    await settle()
    expect(rows()).toEqual(['app', 'knowledge', 'website'])
  })

  it('says the branch is gone, and choosing it again saves it', async () => {
    withProblem('branch_not_found')
    workApi.putRepository.mockResolvedValue(repository)
    await render('/computer')
    expect(container.textContent).toContain('The main branch is gone.')
    expect(workApi.getRepositories).not.toHaveBeenCalled()
    click(button('Choose again'))
    await settle()
    click(option('knowledge'))
    await flush()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(workApi.putRepository).toHaveBeenCalledWith({
      installationId: '1',
      owner: 'acme',
      name: 'knowledge',
      branch: 'main',
    })
  })
})

describe('knowledge repository section, not available', () => {
  it('says so quietly while the Work API is not there', async () => {
    workApi.getRepository.mockRejectedValue(new ApiError('Not found', 404))
    await render('/computer')
    expect(container.textContent).toContain(
      'Tracked work is not available here yet.',
    )
  })
})
