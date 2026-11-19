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
  getClosedItems: vi.fn(),
  getItem: vi.fn(),
  getHistory: vi.fn(),
  getRepository: vi.fn(),
  putRepository: vi.fn(),
  getRepositories: vi.fn(),
}))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  ...workApi,
}))

const { Board } = await import('./Board')
const { ItemView } = await import('./Item')
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
  workApi.getClosedItems.mockResolvedValue({ items: [], nextCursor: null })
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
              <Route path="/computer/work" element={<Board />} />
              <Route path="/computer/work/:number" element={<ItemView />} />
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
}

// Flushes until nothing is loading (the repository setting loads in two
// steps: the choice, then the picker's list).
async function settle() {
  await flush()
  for (let i = 0; i < 50 && container.querySelector('[role="status"]'); i++) {
    await flush()
  }
  await flush()
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function column(title: string) {
  const el = container.querySelector(`section[aria-label="${title}"]`)
  if (!el) throw new Error(`no column ${title}`)
  return el
}
const titles = (el: Element) =>
  [...el.querySelectorAll('article h3 a')].map((a) => a.textContent)

function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('board', () => {
  const items = [
    makeItem({ number: 1, title: 'Mine, quiet', mine: true }),
    makeItem({
      number: 2,
      title: 'Mine, needs me',
      mine: true,
      updatedAt: minutesAgo(600),
      attention: { state: 'needs_you', name: null, since: minutesAgo(30) },
    }),
    makeItem({
      number: 3,
      title: 'Theirs, waiting',
      updatedAt: minutesAgo(10),
      attention: { state: 'waiting_on', name: 'Maya', since: minutesAgo(180) },
    }),
    makeItem({
      number: 4,
      title: 'Mine, done',
      mine: true,
      readyToClose: true,
      warnings: ['A Left item has no checkbox.'],
    }),
  ]

  it('shows my items in their columns, needing me first', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    workApi.getClosedItems.mockResolvedValue({
      items: [
        makeItem({
          number: 5,
          title: 'Closed lately',
          stage: 'closed',
          mine: true,
          closedAt: minutesAgo(60),
          closedBy: 'Igor',
        }),
        makeItem({
          number: 6,
          title: 'Closed long ago',
          stage: 'closed',
          mine: true,
          closedAt: minutesAgo(30 * 24 * 60),
        }),
      ],
      nextCursor: null,
    })
    await render('/computer/work')
    expect(titles(column('In progress'))).toEqual([
      'Mine, needs me',
      'Mine, quiet',
    ])
    expect(titles(column('Ready to close'))).toEqual(['Mine, done'])
    expect(titles(column('Closed'))).toEqual(['Closed lately'])
    expect(column('Closed').textContent).toContain('Closed by Igor')
    expect(column('In progress').textContent).toContain('needs you')
    expect(
      container.querySelector('[aria-label^="The doc has a problem"]'),
    ).not.toBeNull()
  })

  it('shows everyone, with others waiting in grey words', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    await render('/computer/work?tab=everyone')
    expect(titles(column('In progress'))).toEqual([
      'Mine, needs me',
      'Theirs, waiting',
      'Mine, quiet',
    ])
    expect(column('In progress').textContent).toContain('waiting on Maya · 3h')
  })

  it('filters by text and by tag from the address', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([
        makeItem({ number: 1, title: 'Billing', tags: ['billing'] }),
        makeItem({ number: 2, title: 'Docs', tags: ['docs'] }),
      ]),
    )
    await render('/computer/work?tab=everyone&tag=docs')
    expect(titles(column('In progress'))).toEqual(['Docs'])
    act(() => root.unmount())
    root = createRoot(container)
    await render('/computer/work?tab=everyone&q=bill')
    expect(titles(column('In progress'))).toEqual(['Billing'])
  })

  it('points to Everyone when I own nothing', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([makeItem({ number: 3, title: 'Theirs' })]),
    )
    await render('/computer/work')
    expect(container.textContent).toContain('You own no items')
    click(
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Everyone' && b.getAttribute('role') !== 'tab',
      ),
    )
    await flush()
    expect(titles(column('In progress'))).toEqual(['Theirs'])
  })

  it('explains what an item is before a repository is set', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([], { repository: null, head: null, asOf: null }),
    )
    workApi.getRepository.mockResolvedValue(null)
    await render('/computer/work')
    expect(container.textContent).toContain('An item is a working doc')
    expect(container.textContent).toContain('Knowledge repository')
    expect(workApi.getClosedItems).not.toHaveBeenCalled()
  })

  it('reads a 404 as not available yet', async () => {
    workApi.getOpenItems.mockRejectedValue(new ApiError('Not found', 404))
    await render('/computer/work')
    expect(container.textContent).toContain('The board is not available yet')
  })

  it('names the repository it reads, quietly linked to its setting', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    await render('/computer/work')
    expect(
      container.querySelector('a[href="/computer#work-repository"]')
        ?.textContent,
    ).toBe('acme/knowledge')
  })

  it('chooses the first repository in place, then loads', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([], { repository: null, head: null, asOf: null }),
    )
    workApi.getRepositories.mockResolvedValue([acme])
    workApi.putRepository.mockResolvedValue(repository)
    await render('/computer/work')
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    click(container.querySelector('button[aria-label="Select knowledge"]'))
    await settle()
    // No confirmation for a first choice.
    expect(workApi.putRepository).toHaveBeenCalledTimes(1)
    expect(column('In progress')).toBeTruthy()
  })

  it('sends a repository problem to settings', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage(items, {
        repository: {
          ...repository,
          problem: 'access_denied',
          problemMessage: 'GitHub refused access to the repository.',
        },
      }),
    )
    await render('/computer/work')
    expect(container.textContent).toContain(
      'Cannot read acme/knowledge. GitHub refused access to the repository.',
    )
    expect(container.textContent).not.toContain('access_denied')
    expect(
      container.querySelector('a[href="/computer#work-repository"]')
        ?.textContent,
    ).toBe('Settings')
  })

  it('shows no time where the last change or the closing is not known', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([
        makeItem({
          number: 7,
          title: 'Unknown age',
          mine: true,
          updatedAt: null,
        }),
      ]),
    )
    workApi.getClosedItems.mockResolvedValue({
      items: [
        makeItem({
          number: 8,
          title: 'Closed, details unknown',
          stage: 'closed',
          mine: true,
          updatedAt: null,
          closedAt: null,
          closedBy: null,
        }),
      ],
      nextCursor: null,
    })
    await render('/computer/work?older=1')
    const open = column('In progress').querySelector('article')!
    expect(open.textContent).not.toMatch(/no change in|\d+d|Jan/)
    expect(open.querySelector('[title]')).toBeNull()
    const done = column('Closed').querySelector('article')!
    expect(done.textContent).toContain('Closed')
    expect(done.textContent).not.toContain('Closed by')
  })

  it('offers no Close or Reopen yet', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    await render('/computer/work')
    const words = [...container.querySelectorAll('button')].map(
      (b) => b.textContent,
    )
    expect(words).not.toContain('Close')
    expect(words).not.toContain('Reopen')
  })
})

describe('item page', () => {
  const item = makeItem({
    number: 12,
    title: 'Usage billing',
    owner: { email: 'igor@example.com', name: 'Igor', id: 'usr_1' },
    author: { email: 'maya@example.com', name: 'Maya', id: null },
    tags: ['billing'],
    sessions: [
      { id: 'cs_1', title: 'Meter minutes', ownerName: 'Igor', status: 'idle' },
    ],
    pullRequests: [
      {
        url: 'https://github.com/acme/app/pull/41',
        state: 'merged',
        title: 'Meter',
      },
    ],
  })

  it('renders the doc under a header, with details beside it', async () => {
    workApi.getItem.mockResolvedValue({
      item,
      body: '---\nnumber: 12\n---\n# Usage billing\n\n## Why\n\nBecause.',
    })
    await render('/computer/work/12')
    expect(container.querySelector('h1')?.textContent).toBe('12Usage billing')
    expect(container.querySelector('article h2')?.textContent).toBe('Why')
    expect(container.textContent).toContain('started by Maya')
    expect(container.textContent).not.toContain('number: 12')
    expect(
      container.querySelector('a[href="/computer/sessions/cs_1"]')?.textContent,
    ).toBe('Meter minutes')
    expect(container.textContent).toContain('Igor · idle')
    expect(container.textContent).toContain('#41 Meter')
    expect(container.textContent).toContain('merged')
    expect(workApi.getHistory).not.toHaveBeenCalled()
  })

  it('says when an item has no owner', async () => {
    workApi.getItem.mockResolvedValue({
      item: { ...item, owner: null },
      body: 'x',
    })
    await render('/computer/work/12')
    expect(container.querySelector('header')?.textContent).toContain('no owner')
  })

  it('shows just "closed" when who and when are not known', async () => {
    workApi.getItem.mockResolvedValue({
      item: {
        ...item,
        stage: 'closed',
        updatedAt: null,
        closedAt: null,
        closedBy: null,
      },
      body: 'x',
    })
    await render('/computer/work/12')
    const header = container.querySelector('header')!.textContent
    expect(header).toContain('Closed')
    expect(header).toContain('closed')
    expect(header).not.toContain('closed by')
    expect(header).not.toContain('changed')
  })

  it('shows no change time on an open item before it is known', async () => {
    workApi.getItem.mockResolvedValue({
      item: { ...item, updatedAt: null },
      body: 'x',
    })
    await render('/computer/work/12')
    expect(container.querySelector('header')!.textContent).not.toContain(
      'changed',
    )
  })

  it('lists the changes on the History tab', async () => {
    workApi.getItem.mockResolvedValue({ item, body: 'x' })
    workApi.getHistory.mockResolvedValue({
      revisions: [
        {
          sha: 'abcdef1234567',
          url: 'https://github.com/acme/knowledge/commit/abcdef1',
          at: minutesAgo(5),
          authorName: 'Computer for Igor',
          summary: 'Record the price question',
          sessionId: 'cs_9',
        },
      ],
      nextCursor: null,
    })
    await render('/computer/work/12?tab=history')
    expect(workApi.getHistory).toHaveBeenCalledWith(12, undefined)
    expect(container.textContent).toContain('Record the price question')
    expect(container.textContent).toContain('Computer for Igor')
    expect(
      container.querySelector('a[href="/computer/sessions/cs_9"]'),
    ).not.toBeNull()
    expect(
      container.querySelector(
        'a[href="https://github.com/acme/knowledge/commit/abcdef1"]',
      )?.textContent,
    ).toContain('abcdef1')
  })

  it('says when there is no such item, with a way back', async () => {
    workApi.getItem.mockRejectedValue(
      new ApiError('No such item.', 404, 'item_not_found'),
    )
    await render('/computer/work/123')
    expect(container.textContent).toContain('No item 123')
    const back = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Back to the board',
    )
    expect(back?.getAttribute('href')).toBe('/computer/work')
  })

  it('reads any other 404 as not available yet', async () => {
    workApi.getItem.mockRejectedValue(new ApiError('Not found', 404))
    await render('/computer/work/99')
    expect(container.textContent).toContain('The board is not available yet')
    expect(container.textContent).not.toContain('No item')
  })
})

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

function rows() {
  return [...container.querySelectorAll('ul[aria-label="Repositories"] li')]
    .map((li) => li.querySelector('.font-medium')?.textContent)
    .filter(Boolean)
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

  it('lists what GitHub grants, in the order the server sends', async () => {
    workApi.getRepository.mockResolvedValue(null)
    await render('/computer')
    expect(rows()).toEqual(['app', 'knowledge', 'website'])
    expect(container.querySelector('[aria-label="Private"]')).not.toBeNull()
    expect(container.textContent).toContain('5 min ago')
    // One installation: no account select.
    expect(container.querySelector('#work-repo-account')).toBeNull()
    const access = [...container.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Adjust GitHub App access'),
    )
    expect(access?.getAttribute('href')).toBe(acme.settingsUrl)
    expect(access?.getAttribute('target')).toBe('_blank')
  })

  it('filters by name as you type', async () => {
    workApi.getRepository.mockResolvedValue(null)
    await render('/computer')
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search repositories"]',
    )!
    type(search, 'WEB')
    expect(rows()).toEqual(['website'])
    type(search, 'nothing')
    expect(container.textContent).toContain('No repository matches')
  })

  it('saves a selected repository on its default branch', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.putRepository.mockResolvedValue({
      ...repository,
      name: 'website',
      branch: 'trunk',
    })
    await render('/computer')
    click(container.querySelector('button[aria-label="Select website"]'))
    await flush()
    expect(workApi.putRepository).toHaveBeenCalledWith({
      installationId: '1',
      owner: 'acme',
      name: 'website',
      branch: 'trunk',
    })
  })

  it('marks the current choice on Change, and Cancel goes back', async () => {
    workApi.getRepository.mockResolvedValue(repository)
    await render('/computer')
    expect(workApi.getRepositories).not.toHaveBeenCalled()
    click(
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Change',
      ),
    )
    await settle()
    const knowledge = [
      ...container.querySelectorAll('ul[aria-label="Repositories"] li'),
    ].find((li) => li.textContent?.includes('knowledge'))!
    expect(knowledge.textContent).toContain('Selected')
    expect(knowledge.querySelector('button')).toBeNull()
    click(
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Cancel',
      ),
    )
    expect(container.querySelector('ul[aria-label="Repositories"]')).toBeNull()
  })

  it('says when GitHub could not list, with a way to try again', async () => {
    workApi.getRepository.mockResolvedValue(null)
    workApi.getRepositories.mockRejectedValue(
      new ApiError('GitHub is unavailable', 503),
    )
    await render('/computer')
    expect(container.textContent).toContain(
      'Could not load the repositories from GitHub.',
    )
    workApi.getRepositories.mockResolvedValue([acme])
    click(
      [...container.querySelectorAll('button')].find(
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
  })

  it('confirms before switching from a set repository', async () => {
    workApi.getRepository.mockResolvedValue(repository)
    workApi.getOpenItems.mockResolvedValue(openPage([]))
    workApi.putRepository.mockResolvedValue({ ...repository, name: 'app' })
    await render('/computer')
    click(button('Change'))
    await settle()
    click(container.querySelector('button[aria-label="Select app"]'))
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
    expect(
      container.querySelector('a[href="https://github.com/acme/knowledge"]')
        ?.textContent,
    ).toBe('acme/knowledge')
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
    expect(button('Change')).toBeUndefined()
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

  it('says the branch is gone and offers Change', async () => {
    withProblem('branch_not_found')
    await render('/computer')
    expect(container.textContent).toContain('The main branch is gone.')
    expect(button('Change')).toBeTruthy()
    expect(workApi.getRepositories).not.toHaveBeenCalled()
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
