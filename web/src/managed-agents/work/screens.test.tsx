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
  getSessionItems: vi.fn(),
}))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  ...workApi,
}))

const { Board } = await import('./Board')
const { ItemView } = await import('./Item')
const { KnowledgeRepositorySection } = await import('./KnowledgeRepository')
const { SessionWork } = await import('./SessionWork')

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
              <Route
                path="/computer/sessions/cs_7"
                element={<SessionWork id="cs_7" />}
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

  it('says what the board is and offers the repository before one is set', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([], { repository: null, head: null, asOf: null }),
    )
    workApi.getRepository.mockResolvedValue(null)
    workApi.getRepositories.mockResolvedValue([acme])
    await render('/computer/work')
    const text = container.textContent
    expect(text).toContain('The work your team and its agents have in progress')
    expect(text).toContain('Each card is a markdown file in a git repository')
    expect(text).toContain('The one repository where that work is written down')
    expect(currentStep()).toBe('Choose a repository')
    expect(trigger()?.textContent).toContain('Select a repository')
    expect(button('Connect GitHub')).toBeUndefined()
    expect(workApi.getClosedItems).not.toHaveBeenCalled()
  })

  it('asks to connect GitHub first when nothing is connected', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([], { repository: null, head: null, asOf: null }),
    )
    workApi.getRepositories.mockResolvedValue([])
    await render('/computer/work')
    expect(container.textContent).toContain(
      'The work your team and its agents have in progress',
    )
    expect(currentStep()).toBe('Connect GitHub')
    expect(button('Connect GitHub')).toBeTruthy()
    expect(trigger()).toBeNull()
  })

  it('shows how to track a first item when the repository has none', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage([]))
    await render('/computer/work')
    expect(container.textContent).toContain(
      'Nothing is tracked in acme/knowledge yet',
    )
    expect(currentStep()).toBe('Track a first item')
    expect(
      container.querySelector('a[href="/computer/sessions/new"]')?.textContent,
    ).toBe('Start a session')
    const github = container.querySelector<HTMLAnchorElement>(
      'a[href^="https://github.com/acme/knowledge/new/main?"]',
    )
    expect(github?.textContent).toContain('Or add a file to work/ on GitHub')
    // No lanes, tabs or filter while there is nothing to show.
    expect(
      container.querySelector('section[aria-label="In progress"]'),
    ).toBeNull()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(
      container.querySelector('a[href="/settings#work-repository"]')
        ?.textContent,
    ).toBe('acme/knowledge')
  })

  it('says the first read is going on, without the getting-started steps', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage([], { building: true }))
    await render('/computer/work')
    expect(container.textContent).toContain(
      'Reading acme/knowledge for the first time',
    )
    expect(currentStep()).toBeNull()
    expect(container.textContent).not.toContain('Start a session')
    // The header names the repository, linked to its setting.
    expect(
      container.querySelector('a[href="/settings#work-repository"]')
        ?.textContent,
    ).toBe('acme/knowledge')
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
      container.querySelector('a[href="/settings#work-repository"]')
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
    await openPicker()
    click(option('knowledge'))
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
      container.querySelector('a[href="/settings#work-repository"]')
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

  it('folds dormant cards under a quiet toggle, per lane', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([
        makeItem({ number: 1, title: 'Active' }),
        makeItem({ number: 2, title: 'Quiet one', active: false }),
        makeItem({ number: 3, title: 'Quiet two', active: false }),
        makeItem({
          number: 4,
          title: 'Quiet, done',
          active: false,
          readyToClose: true,
        }),
      ]),
    )
    await render('/computer/work?tab=everyone')
    expect(titles(column('In progress'))).toEqual(['Active'])
    expect(column('In progress').querySelector('h2')?.textContent).toContain(
      '1',
    )
    const toggle = [...column('In progress').querySelectorAll('button')].find(
      (b) => b.textContent === 'Dormant(2)',
    )
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(titles(column('Ready to close'))).toEqual([])
    expect(column('Ready to close').textContent).toContain('Dormant(1)')
    click(toggle)
    await settle()
    expect(titles(column('In progress'))).toEqual([
      'Active',
      'Quiet one',
      'Quiet two',
    ])
    // The other lane stays folded.
    expect(titles(column('Ready to close'))).toEqual([])
  })

  it("shows the owner by name, quieter when it comes from commits, and links the item's sessions", async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([
        makeItem({
          number: 1,
          title: 'Declared',
          owner: {
            email: 'maya@example.com',
            name: 'Maya Chen',
            id: 'usr_2',
            source: 'declared',
          },
          sessions: [
            { id: 'cs_7', title: 'Fix it', ownerName: 'Maya', status: 'idle' },
          ],
        }),
        makeItem({
          number: 2,
          title: 'Derived',
          owner: {
            email: 'sam@example.com',
            name: 'Sam',
            id: null,
            source: 'derived',
          },
        }),
      ]),
    )
    await render('/computer/work?tab=everyone')
    const cards = column('In progress').querySelectorAll('article')
    expect(cards[0].textContent).toContain('Maya Chen')
    expect(cards[0].querySelector('[title="Maya Chen"]')).not.toBeNull()
    expect(
      cards[1].querySelector('[title="Sam · From recent commits"]'),
    ).not.toBeNull()
    const link = cards[0].querySelector('a[href="/computer/sessions/cs_7"]')
    expect(link?.getAttribute('title')).toBe('Fix it · Maya · idle')
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
    owner: {
      email: 'igor@example.com',
      name: 'Igor',
      id: 'usr_1',
      source: 'declared',
    },
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

  it('says when the owner comes from recent commits', async () => {
    workApi.getItem.mockResolvedValue({
      item: { ...item, owner: { ...item.owner!, source: 'derived' } },
      body: 'x',
    })
    await render('/computer/work/12')
    expect(container.querySelector('header')?.textContent).toContain(
      'Igor(from recent commits)',
    )
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

describe('session header', () => {
  it('links the items the session worked on, two by name and a count', async () => {
    workApi.getSessionItems.mockResolvedValue([
      makeItem({ number: 114, title: 'Work tracking' }),
      makeItem({ number: 7, title: 'Billing' }),
      makeItem({ number: 9, title: 'Docs' }),
    ])
    await render('/computer/sessions/cs_7')
    expect(workApi.getSessionItems).toHaveBeenCalledWith('cs_7')
    const links = [...document.body.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/computer/work/114',
      '/computer/work/7',
    ])
    expect(links[0].textContent).toBe('Work:114Work tracking')
    expect(links[0].getAttribute('title')).toBe('Work item 114: Work tracking')
    expect(document.body.textContent).toContain('+1')
  })

  it('shows nothing when the session named no item or Work cannot answer', async () => {
    workApi.getSessionItems.mockResolvedValue([])
    await render('/computer/sessions/cs_7')
    expect(document.body.querySelector('a')).toBeNull()
    workApi.getSessionItems.mockRejectedValue(
      new ApiError('Work is unavailable.', 503, 'unavailable'),
    )
    await render('/computer/sessions/cs_7')
    expect(document.body.querySelector('a')).toBeNull()
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

// The current step's label (its number is drawn, hidden from readers).
const currentStep = () =>
  container.querySelector('[aria-current="step"]')?.lastElementChild
    ?.textContent ?? null

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
